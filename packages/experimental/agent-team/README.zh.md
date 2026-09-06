---
description: "在一个会话中运行一个小型具名 agent 团队：成员之间的持久消息与共享任务板，供组合实验性 Team 插件的部署方阅读。"
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-agent-team

[English](README.md) | 中文

## 概述

`dsh-experimental-agent-team` 把一个编码会话变成一个小型工作团队：会话中的 agent 成为 Lead，创建具名 teammate 处理委派的工作，与它们交换持久消息，并在公共任务板上跟踪共享任务。消息与任务状态能挺过崩溃、reload 与中断，因此离线的 teammate 会在恢复后收到排队的消息。它本身不提供任何工具——请挂载兄弟包 `dsh-experimental-tool-agent-team`，让模型能够创建 teammate、给它们发消息并使用任务板。它是实验性的：不进入正式发布、不承诺稳定性，并且需要持久会话存储才能激活。

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

当一个 agent 应该在自己的工作目录中运行一支小型具名助手团队、且消息与任务状态需要挺过崩溃与重启时，把本包加入组合。它本身不带工具：请与 `@deepseek-ai/dsh-experimental-tool-agent-team` 一起挂载，让模型能够创建 teammate、给它们发消息并使用任务板。

### 何时选择

当多个 agent 必须在同一个共享工作区协作、且 roster、消息与任务状态需要挺过崩溃与重启时，选择它。当 teammate 需要独立工作目录、多个进程需要协调同一支团队、或任务 owner 需要自动释放时，请不要选择——这些都不受支持。团队功能需要持久会话存储才能激活。

### 最小工作配置

<a id="smallest-working-setup"></a>

对现有组合的最小增量是持久会话存储加两个 Team 包：

```yaml
# smallest team setup — durable storage plus both Team packages
- name: '@deepseek-ai/dsh-session-persistence-jsonl'
- name: '@deepseek-ai/dsh-experimental-agent-team'
- name: '@deepseek-ai/dsh-experimental-tool-agent-team'
```

工具安装后，模型会按请求完成其余工作——例如先「创建一个名为 reviewer 的 teammate 检查 diff」，再「把变更摘要发给 reviewer」。所有限制都是可选的，并在启动时校验：

| 字段 | 默认值 | 含义 |
|---|---|---|
| `maxMembers` | `8` | 一支团队最多可创建的 teammate 数，包括失败的 |
| `maxTasks` | `256` | 任务板上最多的活动任务数 |
| `maxPendingMessagesPerMember` | `64` | 单个成员最多可排队的消息数 |
| `maxMessageBytes` | `65,536` | 单条发送消息的最大尺寸 |
| `maxProfileBytes` | `131,072` | 单个规范外部 Profile 快照的最大 UTF-8 尺寸 |
| `maxEvidenceItems` | `1,000` | 单个外部 evidence 页面最多的规范化条目数 |
| `maxEvidenceBytes` | `65,536` | 单个规范化外部 evidence 页面的最大 UTF-8 尺寸 |
| `disposalTimeoutMs` | `5,000` | provider-native cleanup 收到中止信号前的宽限期；之后仍等待实际结算 |

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-experimental-agent-team)是每个受支持字段及其 JSDoc 的穷尽式真源。

<a id="teammates"></a>

### Teammate

请 Lead 创建 teammate：给它一个唯一的小写名字（例如 `reviewer`）并描述其职责。teammate 可以 fresh 启动（不携带 Lead 对话的任何记忆），也可以作为 fork 启动（继承 Lead 已完成的轮次）；创建请求决定用哪种。teammate 名字是永久的——即使创建失败的 teammate 也保留其名字，任何名字都不会被复用。

宿主可以用规范化的 child 级 LLM provider、model 和 reasoning-effort options 固定 teammate 路由。Agent Teams 会把这些 options 原样传给 continuation manager，同时记录请求路由和解析进 child descriptor 的路由；如果任何显式请求字段发生变化，就会拒绝创建。descriptor 继续作为冷恢复的权威来源，因此之后的 Lead 路由或部署默认路由都不能替换固定路由。

宿主也可以通过 `ctx.agentTeams.registerTeammateRuntimeProvider()` 注册耐久外部 teammate provider。provider 只公开分离的上下文、Profile 策略与运行能力元数据；凭据、进程对象和原生载荷始终留在 Host。外部启动携带调用方生成的 launch id 与 Team 已预留的 member id。持久 launch id 与 native handle 是非空、最多 200 UTF-8 字节的 opaque 字符串，不施加词法 identifier 语法。provider 必须先持久接受初始工作并返回一个稳定、不透明的 native handle，roster 才能进入 active；若可观察，其稳定 initial turn id 会与 active member 一起保留。同一启动或 mailbox 重试保持相同原生 runtime 与 turn identity；Agent Teams 绝不替换成一次性 subagent。provider 只有同时提供 Hook 强制执行能力，以及使用稳定 Profile 策略 id、相同不可变原生 call id 与 approval id 的 evidence，才能声明精确调用审批。provider 移除后成员变为 inactive；后续 provider generation 会恢复精确 handle，而不是创建替代品。

支持可选目录属主的 provider 适配器使用 `mountTeammateRuntimeProvider()`，让这个 Host-only 包统一拥有共享属主契约、动态服务世代、注册的恰好一次清理以及 provider 析构顺序。

原生 provider 可以通过自己的工具通道查询成员和任务，并以成员身份发送消息。provider 声明 `memberOperations` 并实现 `bindMemberOperations`；Team 所有者只有在接受持久成员与 native handle 后才交付不可序列化的 grant。恢复先验证原身份，再授予当前访问权。每次调用都以该 teammate 的身份使用现有 roster、task board 或 mailbox；模型参数不能选择 Team、成员、handle 或 Lead 角色。Evaluation handle 不会获得生产 grant。

原生操作的完整 JSON 请求最多为 4,096 UTF-8 字节，结果最多为 65,536 字节，包含操作与分页元数据。任务列表默认返回 20 条，允许 1 至 100 条；cursor 标识最后返回的任务，该任务不在当前列表时 cursor 失效。过大的结果返回固定错误而不是不完整 JSON；请请求更小的分页。调用方取消会拒绝本次调用。Lead 释放、handle 释放、原生进程离线或 provider 退役会永久撤销 grant；后续在线状态本身不授予访问权。这些 grant 不提供任务写入、等待、任意 RPC 或 DSH Agent 凭据。[原生成员授权参考](../../../docs/subsystems/agent-team.zh.md#native-member-authorization)定义 Host 类型。

精确的 live Lead 可以对一个 active external teammate 调用 `ctx.agentTeams.readTeammateRuntimeEvidence()`。Agent Teams 会提供 roster 所有的 native handle，并且只返回有界的规范 turn、tool、approval、结果、时间戳与 provider 报告的 usage 事实。approval 事实保留稳定 turn、tool、call、approval 与 Profile 策略身份，但不包含拟议参数；只有精确 runtime 报告 `running` 时，非空 pending 集合才会被接受。prompt、reply、tool argument/result、文件、环境值、credential 与原始 provider payload 绝不会跨越服务边界。

精确的 live Lead 还可以调用 `ctx.agentTeams.runTeammateEvaluation()`，而不创建 roster member 或预留 teammate 名字。每个请求都要求 fresh context 与 evaluation capability，携带分离的 Profile、声明的 input 与文本 fixture，并受限于只读 sandbox、`approval: never`、正数资源上限，以及取自 provider 已发布 evaluation tool inventory 的唯一 allowlist。该 inventory 最多包含 256 个唯一 identifier，每个不超过 128 UTF-8 字节。Agent Teams 会规范化并限制 terminal result、output、evidence、时间戳与身份。可选 commit callback 会在精确 evaluation handle 仍挂载时运行；包括 commit 失败与取消路径在内，该 handle 都会在 API resolve 或 reject 前于 `finally` 中释放。evaluation output 只是临时 runner input，不是 Team transcript 或 activation。

roster 显示每个成员的职责（`lead` 或 `teammate`）与当前状态：`running`、`idle`、`inactive`（存在但未加载的成员）、`provisioning` 或 `failed`。DSH teammate 行公开分离的请求与解析路由快照；外部行只公开耐久 provider 关联和不透明 native handle。未加载的成员会在唤醒后收到其消息。

只有 Lead 可以创建 teammate 或中断它们。

### teammate 之间的消息

任何成员都可以向任何其他成员或 Lead 发送消息。live 成员会立即收到；离线成员的消息会排队，并在其恢复后到达。持久队列和目标接受身份在单 Host 的重试与恢复中保留消息并抑制重复投递。

每条消息都使用 Steer：running target 在最近的步骤边界收到消息，idle target 启动一个轮次，inactive teammate 则冷恢复。发送方始终能看到结果——target inbox 已接受，或在投递暂时不可用时保留为 queued。排队的消息已经安全存储；发送新消息会产生另一项工作。

原生消息调用在模型参数之外携带可信工作轮次和工具调用身份。Team 在一个必需事件中共同保存消息与可重放的接受回执，然后才确认或投递。相同调用以相同规范化输入重试时返回原 queued 回执；改变输入则冲突。queued 记录表达持久接受，不表示已投递或工作完成。provider 的终止结算为每个工作轮次使用独立身份，并通过同一 mailbox 将有意回传的最终文本或失败／中断通知发给 Lead。恢复在验证当前 grant 后重放回执。

### 共享任务板

任何成员都可以添加任务，包含标题、详情、对其他任务的可选依赖，以及可选的文件触及提示。只有其全部依赖完成后，任务才可 claim。

任务有 owner：成员 claim 任务开始工作，完成后标记完成、释放回板或重新打开；Lead 可以把任务分配给任意成员。每次变更都是 compare-and-set：基于过期副本的更新会被拒绝，因此两个成员不会悄悄覆盖彼此的成果。

当两个 in-progress 任务计划触及重叠路径时，文件提示会产生警告——它们绝不阻止任何操作。已删除任务保留在历史中，但从活动列表中消失。

### 等待与中断

成员可以等待下一次团队变化——teammate 的状态、新消息或任务更新——而不必反复轮询；等待只报告是否超时，调用方随后重新读取当前状态。

Lead 可以停止 teammate 的当前轮次，而不会删除其排队的消息；任务归属不变。

### 成功与失败的表现

成功的表现是：teammate 出现在 roster 中、消息报告 `accepted` 或 `queued`、任务 revision 随每次变更递增。可能的失败会以具体错误报告，而不会悄悄破坏状态：发给不存在的成员名字、claim 尚未就绪的任务、用过期 revision 编辑、或超出成员上限创建 teammate。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本节解释服务背后的设计决策并指出实现它们的代码位置；可观察行为已在[使用本包](#use-this-package)中完整说明。

### 设计理念

本服务建立在一个分离与三项承诺之上：

- **持久日志，派生状态。** Lead Session 日志是唯一真源；roster、mailbox 与任务状态每次读取都从中回放。
- **进程内归属。** 所有协作都位于单一进程；保证是重试加去重，绝不是跨进程共识。
- **显式权限。** 每个服务方法都接收精确的 live 调用 `Agent`；只有 Lead 可以 spawn、reassign 或 interrupt。
- **边界大声失败。** 每个限制都是经过校验的部署值，耗尽时报告类型化错误，而不是复用 id 或名字。

[Agent Teams Agent Note](../../../.agents/notes/implemented/feature/2026-08-05-agent-teams.zh.md)负责身份、mailbox、任务与共享 checkout 决策。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：`Config` schema、服务注册、恢复调度 |
| [`src/roster.ts`](src/roster.ts) | Team 身份、路由对账、provisioning、恢复与 roster 拆除 |
| [`src/mailbox.ts`](src/mailbox.ts) | 持久队列、目标本地投递、确认与恢复 |
| [`src/task-board.ts`](src/task-board.ts) | 任务 CAS 命令、DAG 校验与派生视图 |
| [`src/journal.ts`](src/journal.ts) | 串行化的 Lead 日志事务与提交通知 |
| [`src/projection.ts`](src/projection.ts) | 解码并校验 Team 事件的严格回放投影 |
| [`src/activity.ts`](src/activity.ts) | 一次性变更等待者与 dispose 释放 |
| [`src/lifecycle.ts`](src/lifecycle.ts) | 共享准入截止，以及带中止宽限期的静止清理 |
| [`src/teammate-runtime.ts`](src/teammate-runtime.ts) | Fiber 作用域耐久 provider 注册表、能力门禁、精确 handle 路由与清理 |
| [`src/service-types.ts`](src/service-types.ts) | Host-only DSH 与外部 teammate 请求/provider 合约 |
| [`src/invariant.ts`](src/invariant.ts) | 在 append 前回放候选事件的不变式伴生插件 |

### Team 身份与 roster

每个普通运行时 root 都是一个隐式 Team 的 Lead，其 `TeamId` 等于 `SessionId`；不存在创建事件，持久状态从第一条成员、消息或任务记录开始。`spawnTeammate()` 先追加并 flush 一条带请求 child 路由的 `provisioning` 成员记录，再要求配置的 continuation provider 用同一组 options 创建预留 child。launch 调用方拥有初始 inbox 持久化检查点之前的取消权；该条目持久化后，取消所有权转交 Team 生命周期：调用方断开不能中断 descriptor 对账或 roster 终态提交，但 Team dispose 仍可中止。随后服务读取 child descriptor，拒绝发生变化的显式路由，并把解析路由写入 `active` 成员记录。fresh child 不携带 Lead 历史；fork child 只捕获一次 Lead 的已完成 turn 前缀。恢复把未终结的 provisioning 记录对照 child 独立持久化的 Session 进行对账：直接 parent、continuation provider、请求路由、continuable descriptor 都匹配且初始用户消息已记录，才会产生 `active`，其他任何情况都产生 `failed`。如果恢复在同进程竞争中先完成，creator 会接受终态，或报告 `TEAM_PROVISIONING_CONFLICT` 并 drain 该 child。名字由第一条 provisioning 记录保留，且永不复用。

外部分支会在预留成员前校验请求的上下文、Profile 策略、审批、sandbox、evaluation、evidence 与 usage 能力。精确调用审批还要求 Hook 强制执行与规范 evidence；ask Hook 携带稳定 Profile id，畸形 approval 或 pending 关联会隔离 provider generation。该分支记录规范请求指纹和 provider 关联，以 launch id 加预留 member identity 调用 `create()`，并在同一条终态 `active` 快照中写入已校验的 native handle。原生接受前由调用方拥有取消权；接受后由 Team 生命周期拥有 roster 提交。恢复使用已保存的 launch/member/handle 三元组调用 `resume()`；provider 缺失只会令 provisioning 或 active 状态保持且不可用。provider generation 拥有原生 session、evidence、隔离 evaluation handle 与 dispose；Agent Teams 拥有 roster 名字、member id、mailbox 顺序和稳定关联。从 [`@deepseek-ai/dsh-experimental-agent-team/testkit`](src/testkit.ts) 导出的可复用 provider 契约套件，固定了未来实现共同的幂等、取消、evidence、evaluation 与精确释放语义。fixture 必须通过 `armCreateCancellation`、`armDeliveryCancellation`、`reopen`、`assertSingleRuntime`、`assertTurn`、`assertInterrupted` 与 `assertDetached` 安排进行中的 create/delivery 取消、重新打开同一耐久原生存储，并证明单一 runtime identity、稳定 turn、精确中断和完全分离。

### 持久 mailbox

`sendMessage()` 校验 peer 成员关系，追加 `team/message/queued` 并在尝试投递前 flush。目标消息以 `Team message <id> from <name>:` 开头，并在 `TeamMessageSource` 中保留同一 id 与发送者。只有目标 Session 在 pending inbox 或已记录历史中持久持有消息身份后，才会以 `team/message/delivered` 确认投递。即时准入按目标与持久队列顺序串行化；恢复按同一顺序重新投递 queued-minus-delivered 记录。重试前会同时折叠 live 与持久目标 inbox／历史状态，因此 inbox 已接受但模型尚未 claim 时发生崩溃不会复制消息。该保证是进程内重试加 target Session 去重，而不是跨进程 exactly-once 投递。

投递给 Lead 时直接调用 `Agent.steer()`。投递给 DSH teammate 时使用 continuation owner 的 host-only Steer 路径；该路径会保留 Team 发送者 source，同时授权 Lead-to-child edge 并冷恢复 inactive target。sibling 消息绝不会通过公开的相邻 Agent 消息操作伪装成 Lead。对于外部 teammate，同一持久队列会用精确 provider/native handle 与稳定 Team message id 调用 `deliver()`。provider 返回稳定 native turn id 后，Agent Teams 才记录 delivered。provider 缺失时消息继续排队；重新注册并恢复精确 handle 后会重试，且不会回退到一次性调用。

### 共享任务板

任务是完整版本化快照；每次变更都携带 `expectedRevision`，陈旧调用方会收到 `TEAM_TASK_STALE_REVISION`，而不会覆盖更新的值。数字 `task-<n>` id 的后缀必须是安全整数，id 空间耗尽时报告 `TEAM_TASK_LIMIT`，而不是复用最后一个 id。已删除任务作为 tombstone 保留以供回放与维持 id 稳定，但不占用 `maxTasks`，也不出现在 `listTasks()` 中。`writeScopes` 是规范化后的 workspace 相对前缀；视图会对与 in-progress 任务的重叠发出警告，但绝不阻止 claim 或授予写权限。

### 等待与中断

`waitForChange()` 等待注册之后发生的下一条 roster、task、mailbox 或实时状态边，时长从 10 秒到 1 小时，并且只报告是否超时；运行时 dispose 会释放当前等待。取消会保留 Error reason；非 Error reason 则通过 `TEAM_WAIT_ABORTED` 报告。`interrupt()` 仅限 Lead：DSH child 走带 `keepInbox` 的 continuable-subagent 路径，外部 teammate 则使用精确 provider/native handle。两条路径都不释放任务 owner，也不删除持久 mail。

### 持久性模型

Team 事件追加到精确的 live Lead Session，并在操作报告成功或唤醒等待者之前 flush。`team/member`、`team/task`、`team/message/queued`、`team/message/delivered` 与 `team/native-operation/committed` 仅存在于日志：它们从不进入会话表面，因此派生模型历史不受协作记录影响。顺序与时间由 Session event 的 `seq` 与 `time` 负责，快照不重复保存。`./invariant` 伴生插件把每条候选 Team event 对照已提交前缀回放，并在 append 前拒绝非法转换。

### Dispose

dispose 会关闭准入、中止并等待已获准的创建与 mailbox dispatch 事务，再让 continuation owner 释放 roster 中确切的 live direct child 及其后代。每个被移除的外部 provider Fiber 会立即关闭自身准入、移除目录可见性，并只 dispose 该 generation 挂载的 runtime 与 evaluation handle。经过 `disposalTimeoutMs` 宽限期后，provider-native cleanup 会收到中止信号，但 Agent Teams 仍等待它实际结算；该值不是关闭总时限。其他 provider 和 Lead 的非 Team continuable child 不受影响。cleanup 失败会明确暴露。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当包级约定不够用时阅读以下页面。它们从共享子系统类型逐步进入工具表面与设计背后的决策。

- [Agent Teams 子系统](../../../docs/subsystems/agent-team.zh.md)——持久 Team 类型与 `ctx.agentTeams` 服务 API。
- [tool-agent-team 包](../tool-agent-team/README.zh.md)——让模型创建、消息与协调 teammate 的工具。
- [Agent Teams Agent Note](../../../.agents/notes/implemented/feature/2026-08-05-agent-teams.zh.md)——身份、mailbox、任务与共享 checkout 决策。
- [实验包决策](../../../.agents/notes/implemented/architecture/2026-08-18-experimental-agent-teams-packages.zh.md)——位置、发布排除与依赖隔离。

-----

<a id="model-experience"></a>

### 浏览器 Remote

`TeamService` 除了 roster、mailbox、task 与 lifecycle operation，还直接负责生成式 `agentTeams/view`、`agentTeams/createTask` 与 `agentTeams/updateTask` Remote method。`./remote` 导出由 Web UI 挂载的 Client contribution，`./client` 则重新导出可在浏览器 compilation face 中安全使用的 request、view 与 task mutation result type。Typert 在外层 `RemoteResult` 中保留 transport failure；create 与 update rejection 则作为 transport 成功响应中的显式 domain result，其中过期的 update revision 会区分为 task conflict。

## 模型体验

### Peer 消息

#### 模型看到什么

对于 DSH teammate，每条已投递 peer 消息都是用户角色消息。第一个短文本块包含稳定消息 id 与发送者，之后原样附加发送者的内容块。对于外部 teammate，Agent Teams 会把分离的 Profile 快照和初始工作交给 provider `create()`，再把 peer 内容连同稳定的 launch、member、handle、message 与 turn 关联交给 provider `deliver()`。这些输入如何成为原生模型请求和历史由 provider 所有；其对话不会写入 DSH child Session。roster、task 与 mailbox 记录仍仅存在于日志。

#### Token 影响

每次 DSH peer 投递都会把发送者前缀与消息内容加入 target 历史。外部 provider 自行定义初始工作、Profile 策略和投递产生的模型调用与 Token 成本。任务、roster 与路由对账变更不增加 DSH 模型历史 Token；其面向模型的呈现属于 `@deepseek-ai/dsh-experimental-tool-agent-team` 结果。

#### KV Cache 影响

对于 DSH teammate，Peer 消息追加在可复用历史前缀之后；冷恢复会先复用持久对话，再追加尚未投递的消息。外部历史与 KV cache 行为由 provider 定义；Agent Teams 只保留精确恢复与去重所需的稳定 native handle 和 delivery identity。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制说明一支团队目前不能做什么、或何时需要特别运维。它们是当前包约束，不是与其他协作机制的对比。

- **实验原型，无稳定性承诺**——本包为私有、不进入正式发布，孵化期间约定可自由变更。
- **单进程、共享 checkout**——成员共享 cwd，修改立即可见；本包不提供 worktree、远端成员、merge 或文件锁。
- **write scope 仅作提示**——Bash、formatter、代码生成器与直接外部写入可以绕过文件版本检查；Lead 必须协调 owner 并检查最终 diff。
- **扁平且不可变的 roster**——只有 Lead 可以创建直接 teammate；不支持嵌套 Team、重命名、删除或名字复用。
- **不会自动释放 owner**——idle、interrupt、进程退出与工作失败都不会释放任务 owner。
- **mailbox 不保证跨进程 exactly-once**——不支持多个 harness 进程并发操作同一 Team。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

本开发备注是维护者的工作上下文，明确不具权威性。

#### Promotion

promotion 到产品角色组需要按[实验子树规则](../AGENTS.md)审查公共约定、限制、测试证据、发布载荷、运行时依赖与具名稳定 owner。

#### 未来方向

尚未决定的探索方向包括嵌套 Team、自动释放 owner 的策略、跨进程 mailbox 事务，以及通过 worktree 实现文件系统隔离；这些都没有承诺。

</details>
