---
description: "面向源码检出 Agent Teams 部署的持久 Codex App Server 后端，提供原生持久线程、精确恢复、有界证据与失败关闭的本地执行。"
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-agent-team-codex

[English](README.md) | 中文

## 概述

`dsh-experimental-agent-team-codex` 把符合资格的本地 Codex 安装注册为 Agent Teams 的持久 external-agent Runtime Backend。一个 Digital Employee 拥有一个非临时 Codex 线程和稳定的不透明原生 handle。重复启动会收敛到同一线程，Team 消息成为后续轮次，新 Host 进程则通过 Codex App Server 的 `thread/resume` 协议恢复精确 handle。本适配器是私有、实验性、仅供源码检出使用的包。它与 `@deepseek-ai/dsh-subagent-codex` 不同：一次性提供方创建临时运行，绝不会替代本持久后端。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

在已提供 Agent Teams 与 subprocess service 的本地源码组合中挂载本包。适配器不会注册模型工具；只有 external teammate 启动指名其 provider id 时 Agent Teams 才会选择它，默认 id 为 `codex`。

### 何时选择

当一个 Codex employee 必须在多条 Team 消息或 Host 重启之间保留原生对话与身份时，选择本后端。当每次委派都是返回一个最终答案的独立任务时，选择 `@deepseek-ai/dsh-subagent-codex`。若 Profile 要求父上下文 fork、tool allowlist、Hook、逐次调用 approval、evaluation、网络访问或镜像原生 transcript，则不要选择本后端。

```yaml
- id: subprocess-local
  name: '@deepseek-ai/dsh-subprocess-local'
- id: agent-team
  name: '@deepseek-ai/dsh-experimental-agent-team'
- id: agent-team-codex
  name: '@deepseek-ai/dsh-experimental-agent-team-codex'
  config:
    sandbox: read-only
```

### 资格判定

只有包内锁定的 `@openai/codex` wrapper 版本恰好为 `0.149.1`，且匹配的平台载荷包含可执行原生产品时，才会发生注册。不支持的平台、不匹配的 wrapper 或缺失的载荷会让后端保持不可用，并只产生有界原因。探针绝不会公开安装路径。安装一次性 Codex subagent 提供方不会让本 Runtime Backend 获得资格。

### 配置

| 字段 | 默认值 | 含义 |
|---|---|---|
| `providerName` | `codex` | 稳定的 Agent Teams Runtime Backend id；多个挂载实例必须使用不同 id |
| `cwd` | Host 进程 cwd | 解析为绝对路径并由本实例所有原生线程共享的工作区路径 |
| `model` | Codex 原生设置 | 在线程启动与恢复时发送的可选固定模型覆盖 |
| `env` | `{}` | 经 subprocess seam 传给子进程的显式环境 |
| `sandbox` | `read-only` | 部署方拥有的约束：`read-only` 或 `workspace-write` |
| `disposeGraceMs` | `3000` | 精确终止子进程树时使用的宽限 |
| `maxEvidenceItems` | `512` | 每个已附着线程最多保留的规范化证据事实数 |

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-experimental-agent-team-codex)是每个受支持字段及其源 JSDoc 的穷尽式真源。

两种 sandbox 模式都强制 `networkAccess: false` 与 `approvalPolicy: never`。适配器会校验 Codex 返回的有效策略；若 Codex 报告了更宽权限，则在发布 runtime 前失败。teammate Profile 无法削弱部署设置。

### 支持的 teammate 约定

后端只接受 `fresh` 初始上下文与非空文本工作。它如实声明支持 persona、mission、启用的 context 块和精选 memory 块；运行能力只声明 sandbox 强制、规范化 evidence、usage 发生事实与精确 interruption。

它不声明 tool-policy 强制、Profile Hooks、父上下文 fork、exact-call approval 或 evaluation handle。要求其中任一能力的启动会在 Codex 启动前被 Agent Teams 拒绝。原生 approval、permission、用户输入与 elicitation 请求会在无人工参与时被拒绝；未知请求让协议失败关闭。

### 持久性与恢复

创建先以由 launch/member 派生的确定性幂等键取得 Codex project，再查找或创建一个非临时原生线程。Codex 生成的线程 id 是 teammate 的不透明 handle。重复启动会恢复已记录的初始 client id，不会再次提交初始轮次；稳定 Team message id 同样会恢复其原生 turn id。

正常 Host 关闭会终止所拥有的 App Server 进程树，但不会删除 Codex 持久线程。Agent Teams 重放 member 时，本适配器启动新的 App Server 并恢复该精确线程 id。进程或协议流失败会把 member 标记为 inactive、退役故障进程，并只保留下次精确 handle 修复所需的关联。原生身份缺失或冲突会失败，不会创建替代品。

### 证据与诊断

证据只包含固定形状的 turn、tool kind 与 usage 发生事实。原生 id 会转换为确定性 evidence id；不会保留原始 prompt、工具参数、命令文本、输出、凭据、文件系统路径、登录状态、token 数或协议载荷。达到 `maxEvidenceItems` 后丢弃最旧事实。跨越 provider seam 的错误只包含固定生命周期阶段和类型化 Agent Teams code，原生错误内容保留在 Host 本地。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | Config、最小 App Server connection、持久 provider、证据、恢复与 Fiber 清理 |
| [`src/product.ts`](src/product.ts) | 精确 wrapper/平台资格判定和包内可执行文件解析 |
| [`tests/agent-team-codex.spec.ts`](tests/agent-team-codex.spec.ts) | 覆盖身份、策略、轮次、修复、证据与清理的确定性协议 fake |
| [`tests/real-product.canary.spec.ts`](tests/real-product.canary.spec.ts) | 使用本地 Responses fixture 的可选真实 App Server 启动/重启/恢复 canary |

### 协议与身份

每个已附着原生线程拥有一个受 Fiber 约束的 App Server 子进程和一个 JSON-RPC 行传输。初始化会显式启用 experimental API。`project/create` 接收由 provider、launch 与 member 身份计算的 SHA-256 幂等键；后续线程操作始终使用 Codex 返回的不透明 project id。线程启动要求 `ephemeral: false`。恢复会在附着 session 前校验线程、project、持久性、approval、sandbox 类型与禁用网络。

connection 一次只接纳一个原生轮次。早到的终态通知会保留到 `turn/start` 给出权威 turn id，线程或轮次不匹配的通知无法结算其他 employee 的工作。Team mailbox 已按目标串行化即时投递；重叠的直接 provider 调用会在 connection guard 处失败关闭。

### 生命周期

provider 注册与每个已附着进程都归本包 Fiber 所有。释放会关闭接纳、打断精确活跃轮次、关闭传输流、通过 `ctx.subprocess` 终止进程树、等待退出、清空 evidence 与 delivery 索引并移除注册。并发释放共享同一个结算；清理失败会聚合并保持可见，而不会被丢弃。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [Agent Teams 包](../agent-team/README.zh.md)——持久 roster、mailbox、Runtime Backend seam 与能力校验。
- [Agent Teams 子系统](../../../docs/subsystems/agent-team.zh.md)——Host service 类型与所有权边界。
- [一次性 Codex 提供方](../../subagent/subagent-codex/README.zh.md)——刻意采用临时运行的兄弟后端。
- [生成配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-experimental-agent-team-codex)——从源码 JSDoc 生成的穷尽式字段列表。

-----

<a id="model-experience"></a>
## 模型体验

### 原生 Digital Employee

#### 模型看到什么

首个 Codex 轮次会通过原生 `developerInstructions` 字段收到 persona、mission、启用的 context 与精选 memory，以及启动文本工作。后续已接受 Team 消息会成为同一原生线程上的文本轮次。模型在固定部署 sandbox 中看到已配置工作区与 Codex 原生设置；本适配器不提供交互审批通道，也不提供网络访问。

#### Token 影响

Codex 拥有原生线程的 token 计量。适配器只公开 usage update 已发生，不会把 token 数或原生 prompt 复制进 Team log。

#### KV Cache 影响

轮次追加到同一个持久 Codex 线程，因此原生 cache 行为由 Codex 与所选模型控制。Host 重启会恢复该线程，而不是在 DSH 中重建其 transcript。

### Lead 与 Team 表面

#### 模型看到什么

Lead 会看到 teammate 的持久 roster 状态以及 mailbox 已接受或已排队结果。本包不会把 Codex answer、reasoning、commentary、工具载荷、stderr 或工作区 diff 复制进 DSH Session。证据查询只公开上文描述的有界规范化事实。

#### Token 影响

本后端不会向 DSH 模型上下文添加工具 schema 或原生 transcript。只有周边组合选择的普通 Agent Teams 工具结果与消息会影响 Lead token。

#### KV Cache 影响

Agent Teams 以仅追加方式记录 roster 与 mailbox 关联，不会改写 Lead 更早的对话前缀。原生 Codex cache 状态与其分离。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **私有实验性源码包**——它不进入官方发布，且不承诺兼容性。
- **单一锁定产品基线**——只有 `@openai/codex@0.149.1` 及其精确匹配的原生载荷符合资格。
- **仅 fresh 上下文**——不支持父 Session fork。
- **部分 Profile 表面**——拒绝 tool policy 与 Hook；只强制 persona、mission、context 与 memory。
- **无 exact-call approval 或 evaluation**——适配器无人值守，拒绝原生交互请求，也不发布 evaluation handle。
- **无启用网络的 sandbox**——只能选择 read-only 或 workspace-write 文件系统权限，二者都禁用原生网络访问。
- **无 answer bridge**——原生 answer 与 reasoning 留在 Codex；共享 Team 表面公开状态、消息接纳和净化证据，而不是 transcript。
- **进程本地所有权**——每个 provider generation 拥有本地 App Server 进程；不支持一个 Team 的跨进程并发所有权。
- **粗粒度证据**——usage evidence 记录发生事实而非 token 总数，tool evidence 只记录规范化 kind 与 outcome。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者验证——点击展开</summary>

正常运行确定性正确性测试。只有验证包内锁定 App Server 时才启用独立门控的真实产品 canary：

```sh
pnpm exec vitest run packages/experimental/agent-team-codex/tests/agent-team-codex.spec.ts
DSH_CODEX_APP_SERVER_CANARY=1 pnpm exec vitest run packages/experimental/agent-team-codex/tests/real-product.canary.spec.ts
```

canary 使用本地 loopback Responses fixture，创建真实持久线程，释放整个 Host，在新 Host 中恢复同一不透明 handle，并运行第二个轮次。它是协议证据，不是确定性正确性门禁。

</details>

**运行时不变式：** 不发布运行时不变式 companion；provider 注册、原生 connection 与子进程树由同一个 Fiber 生命周期拥有并移除。
