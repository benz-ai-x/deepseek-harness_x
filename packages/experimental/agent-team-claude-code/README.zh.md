---
description: "面向源码检出 Agent Teams 部署的持久 Claude Code Agent SDK 后端，提供稳定原生 Session、精确恢复、有界证据与失败关闭的只读执行。"
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-agent-team-claude-code

[English](README.md) | 中文

## 概述

`dsh-experimental-agent-team-claude-code` 把包内锁定的 Claude Agent SDK 注册为 Agent Teams 的持久 external-agent Runtime Backend。一个 Digital Employee 拥有一个确定性的 Claude Code Session id。重复启动收敛到同一 Session，Team 消息成为恢复后的后续轮次，新 Host 进程恢复同一份原生 transcript。本适配器是私有、实验性、仅供源码检出使用的包，不是一次性的 `@deepseek-ai/dsh-subagent-claude-code` provider。

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

在已经提供 Agent Teams 与 subprocess service 的本地源码组合中挂载这个 Host 包。它不会注册模型工具；只有 external teammate 启动指名其 provider id 时 Agent Teams 才会选择它，默认 id 为 `claude-code`。

```yaml
- id: subprocess-local
  name: '@deepseek-ai/dsh-subprocess-local'
- id: agent-team
  name: '@deepseek-ai/dsh-experimental-agent-team'
- id: agent-team-claude-code
  name: '@deepseek-ai/dsh-experimental-agent-team-claude-code'
  config:
    sandbox: read-only
```

### 资格判定

只有 `@anthropic-ai/claude-agent-sdk` 恰好为 `0.3.241`、其 manifest 标识 Claude Code `2.1.241`，且匹配平台的包内载荷包含可执行原生产品时，才会注册。本适配器支持 SDK 声明的 Linux glibc 与 musl、macOS、Windows x64/arm64 载荷。它绝不从 `PATH` 解析 `claude`；产品不可用时只报告不含安装路径的有界原因。

### 配置

| 字段 | 默认值 | 含义 |
|---|---|---|
| `providerName` | `claude-code` | 稳定的 Agent Teams Runtime Backend id；多个挂载实例必须使用不同 id |
| `cwd` | Host 进程 cwd | 解析为绝对路径并固定给本实例所有原生 Session 的工作区根目录 |
| `model` | Claude 原生默认值 | 新建与恢复轮次使用的可选部署方固定模型 |
| `sandbox` | `read-only` | 固定约束标记；拒绝其他所有值 |
| `disposeGraceMs` | `3000` | 精确终止子进程树时使用的宽限 |
| `maxEvidenceItems` | `512` | 每个已附着 Session 最多保留的规范化证据事实数 |

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-experimental-agent-team-claude-code)是受支持字段与源 JSDoc 的穷尽式真源。

### 支持的 teammate 约定

后端只接受 `fresh` 上下文和非空文本工作。首个原生 prompt 会强制 persona、mission、启用的 context 块与精选 memory。运行时元数据只声明 sandbox 强制、有界 evidence 与 usage 发生事实。Profile tool policy、Profile Hook、父上下文 fork、exact-call approval 和 evaluation 均不声明，因此 Agent Teams 会在启动前拒绝这些要求。

每个轮次都会禁用文件系统 settings、skills、plugins 与环境 MCP server。原生工具集固定为 `Read`、`Glob`、`Grep`；交互 permission、elicitation 与 dialog 请求会被拒绝。SDK sandbox 不可用时失败关闭，禁止写入、禁止读取配置工作区之外的内容、禁止 unsandboxed command，并且不给 sandbox command 网络 allowlist。Profile 无法削弱这些部署方拥有的值。

### 持久性与恢复

适配器根据 provider id、launch request id 与预留 Team member id 派生 UUID Session id。首个 prompt 包含经过哈希的 launch marker 和不可变 Profile 快照。后续 Host 会先在 SDK 拥有的 transcript 中校验该 marker，再附着 handle。已有 Session 如果没有预期 marker，会被判为身份冲突，绝不会成为恢复候选。

每条 Team delivery 都携带由持久 message id 派生的哈希 marker。重试会扫描原生 transcript，并在不再次查询 Claude 的情况下返回同一确定性 Team turn id。Delivery 准入会在每个 Session 内于原生查询前串行化，因此并发消息无法启动重叠 Query。新 delivery 使用 Agent SDK 的 `resume` 选项和原 Session id，因此对话历史留在原生产品中，不会在 DSH 内重建。

每个活跃原生轮次只有一个受管理 Claude Code 进程。SDK transport 保持官方实现；只有进程创建与终止映射到 `ctx.subprocess`。调用方取消会保持生效，直到 SDK 发布匹配的 Session 身份。runtime interruption 会关闭精确活跃 Query、中止其 controller、终止其进程树，且无法影响其他 Session。

### 证据与诊断

Evidence 只包含固定形状的 turn outcome、规范化 `read`/`glob`/`grep` 工具发生事实、permission denial 和 usage 发生事实。原始 prompt、模型输出、reasoning、工具参数、原生 summary、凭据、文件系统路径、token 总数、登录状态、stderr 与 SDK payload 都不会复制到 evidence 或 Team persistence。达到 `maxEvidenceItems` 后丢弃最旧事实。

跨越 provider seam 的错误只包含固定生命周期阶段与类型化 Agent Teams code。原始 SDK 与 subprocess 错误文本会在分类后丢弃。原生 transcript 查询值只用于身份校验，不由适配器保留。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | Config、Session 身份、Query 生命周期、恢复、evidence 与 Fiber 清理 |
| [`src/process.ts`](src/process.ts) | 从官方 SDK spawn 请求到共享 subprocess owner 的映射 |
| [`src/product.ts`](src/product.ts) | 精确 SDK/原生版本资格判定与包内可执行文件解析 |
| [`tests/agent-team-claude-code.spec.ts`](tests/agent-team-claude-code.spec.ts) | 覆盖身份、轮次、恢复、策略、证据与清理的确定性 SDK fake |
| [`tests/real-product.canary.spec.ts`](tests/real-product.canary.spec.ts) | 可选的真实 Agent SDK 启动/重启/恢复 canary |

### 所有权

Claude Code 拥有自己的 Session transcript；Agent Teams 拥有 roster 与 mailbox 持久性。本适配器只在内存中保留已附着 Session handle、delivery 关联、presence 与有界规范化 evidence，不创建第二份 transcript store。

Provider 注册归本包 Fiber 所有。释放会关闭接纳、打断活跃 Query、等待每棵受管理进程树、清空内存索引、发出 inactive presence 并移除注册。它刻意不删除 SDK 拥有的 Session，因为 Host 重启必须能够恢复它。显式 Team runtime removal 会分离同一组资源。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [Agent Teams 包](../agent-team/README.zh.md)——持久 roster、mailbox、Runtime Backend seam 与能力校验。
- [Agent Teams 子系统](../../../docs/subsystems/agent-team.zh.md)——Host service 类型与所有权边界。
- [一次性 Claude Code provider](../../subagent/subagent-claude-code/README.zh.md)——刻意采用非持久运行的兄弟集成。
- [生成配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-experimental-agent-team-claude-code)——从源 JSDoc 生成的穷尽式字段列表。

-----

<a id="model-experience"></a>
## 模型体验

### 原生 Digital Employee

#### 模型看到什么

首个原生轮次会收到 Digital Employee persona、mission、启用的 context、精选 memory 与初始文本工作。后续已接受 Team 消息成为同一 Claude Code Session 中的 user turn。模型只能在部署工作区内使用 `Read`、`Glob` 与 `Grep`，并且没有交互审批通道。

#### Token 影响

Claude Code 拥有原生 token 计量。适配器只记录 usage 已发生，不会把数值或原生内容复制到 Team log。

#### KV Cache 影响

轮次恢复同一个原生 Session，因此 cache 行为属于 Claude Code 与所选模型。Host 重启会校验并重新附着 Session，而不是通过 DSH 重放其内容。

### Lead 与 Team 表面

#### 模型看到什么

Lead 会看到普通 Agent Teams roster 状态与 mailbox 接纳结果。本包不会把 Claude answer、reasoning、工具 payload、stderr 或 transcript 内容桥接进 DSH Session。Evidence 查询只公开上文描述的有界事实。

#### Token 影响

后端不会向 DSH context 添加模型工具 schema 或原生 transcript。只有周边 Agent Teams 工具与消息影响 Lead token。

#### KV Cache 影响

Agent Teams 追加 roster 与 mailbox 关联，不会改写 Lead 更早的对话前缀。原生 Claude cache 状态与其分离。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **私有实验性源码包**——它不进入官方发布，且不承诺兼容性。
- **单一锁定产品基线**——只有 Agent SDK `0.3.241` 与 Claude Code `2.1.241` 符合资格。
- **仅 fresh 上下文**——不支持父 Session fork。
- **部分 Profile 表面**——拒绝 tool policy 与 Hook；支持 persona、mission、context 与 memory。
- **无 exact-call approval 或 evaluation**——这些能力属于后续独立 roadmap 工作。
- **固定只读权限**——不提供 workspace-write 或启用网络的模式。
- **无 answer bridge**——原生 response 留在 Claude Code；Team 表面只公开状态与净化 evidence。
- **通过 transcript 扫描修复重试**——delivery replay 检查 SDK 拥有的 transcript，其边界由原生 SDK read operation 决定，而不是 DSH 侧 delivery journal。
- **真实 canary 使用已配置 Claude 访问**——启用它可能消耗模型额度并要求有效原生登录；默认跳过。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者验证——点击展开</summary>

正常运行确定性正确性测试。只有在使用专门测试账号时，才启用独立门控的产品 canary：

```sh
pnpm exec vitest run packages/experimental/agent-team-claude-code/tests/agent-team-claude-code.spec.ts
DSH_CLAUDE_AGENT_SDK_CANARY=1 pnpm exec vitest run packages/experimental/agent-team-claude-code/tests/real-product.canary.spec.ts
```

Canary 会创建一个真实原生 Session、释放 Host、在另一 Host 中恢复同一 handle、运行第二轮，并在结束后删除该精确测试 Session。确定性 SDK fake 仍是覆盖完整分支的正确性门禁。

</details>

**运行时不变式：** 不发布运行时不变式 companion；provider 注册与每个活跃 Query/进程树都由同一个 Fiber 生命周期拥有并移除。
