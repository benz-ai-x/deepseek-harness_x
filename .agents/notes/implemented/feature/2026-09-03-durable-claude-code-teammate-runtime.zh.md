# Agent Note: 持久 Claude Code teammate runtime

Status: implemented

[English](2026-09-03-durable-claude-code-teammate-runtime.md) | 中文

## 问题

[持久 external teammate runtime](../architecture/2026-09-03-durable-external-teammate-runtimes.zh.md)可以跨轮次与 Host 重启保留 provider 原生身份，但现有 [Claude Code subagent 后端](2026-08-04-claude-code-and-codex-subagent-backends.zh.md)刻意采用一次性运行。若为 Digital Employee 重复调用该 provider，会创建互不相关的 Session、丢失原生对话状态，并使启动与 mailbox 重试产生歧义。

资格判定必须证明一个精确的官方 SDK/原生产品组合，而不是只看到 `claude` 命令。部署约束必须始终强于 Profile 请求。恢复、evidence、诊断与浏览器可见 Team 值不得把原生 prompt、模型输出、工具 payload、凭据、路径、登录状态或 transcript 内容复制进 DSH。取消与 Fiber 释放仍必须让精确的受管理进程树静止。

## 决策

`@deepseek-ai/dsh-experimental-agent-team-claude-code` 是通过 `@anthropic-ai/claude-agent-sdk@0.3.241` 及其 Claude Code `2.1.241` 平台载荷实现持久 teammate provider 约定的私有 Host plugin。只有精确 SDK manifest、原生版本、受支持平台包、文件以及 POSIX 可执行位全部符合资格时才注册。适配器只解析包内可执行文件，绝不回退到 `PATH` 或一次性 provider。

Provider 根据 provider、launch request 与预留 member 身份派生合法 UUID Session id。首轮通过 SDK `sessionId` 选项提供该 id，后续每轮通过 `resume` 提供。首个 prompt 包含 SHA-256 launch marker，以及 persona、mission、启用的 context、精选 memory 与初始工作。Host 重放使用 `getSessionInfo` 与 `getSessionMessages`，只有 Session 与 marker 都一致才附着。已占用但不含该 marker 的 id 属于身份冲突。

每条 Team 消息会获得由稳定 message id 派生的 SHA-256 marker 和确定性 Team turn id。重试从 SDK 拥有的 transcript 中找到 marker，并在不再次发起原生 query 的情况下返回同一 turn。Delivery 准入会在每个 Session 内于原生查询前串行化，且每次 delivery 都会等待精确前序 turn。每个活跃 turn 只有一个官方 SDK Query 与一棵由 `ctx.subprocess` 拥有的进程树；idle Session 保留原生 transcript 状态，但不保留子进程。

后端只支持 fresh context、非空文本工作、persona、mission、context 与 memory。它不声明 Profile tool policy、Hook、exact-call approval 或 evaluation。每个 Query 都会禁用文件系统 settings、skills、plugins 与环境 MCP server，把工具固定为 `Read`、`Glob`、`Grep`，拒绝交互 permission 与 elicitation 路径，并应用失败关闭的只读 sandbox，不允许 unsandboxed command，也不给网络 allowlist。配置不暴露更弱模式。

Provider 只保留有界规范化 turn outcome、read/glob/grep 发生事实、permission denial 与 usage 发生事实。原生 id 被确定性 evidence id 替代。产品与进程故障跨 seam 时只包含固定生命周期阶段和类型化 Team runtime code；原始错误文本会在分类后丢弃。Transcript 值只用于 marker 检查，随后丢弃。

Interrupt 只会中止并关闭精确活跃 Query，并终止其受管理进程树。已接纳 turn 失败后，Session 回到 idle，后续可从原生持久状态 `resume` 修复；接纳前失败会移除未发布 attachment。Runtime 与 provider disposal 共享活跃 turn 结算，清空本地索引和 evidence，发出 inactive presence，并保留 SDK 拥有的 Session 供 Host 重启恢复。Cordis 在同一 Fiber 上拥有注册移除。

## 考虑过的替代方案

**复用一次性 Claude Code subagent。** 否决，因为它禁用持久性，也不公开稳定 Session resume 约定。

**让 SDK 生成 Session id。** 否决，因为若 Host 在原生接纳与 Team 发布之间崩溃，幂等启动重试将没有确定性身份可用。

**在 DSH 中持久化 prompt、response 或第二份 transcript。** 否决，因为 Claude Code 已拥有原生 transcript；复制会造成相互竞争的历史权威和敏感数据表面。

**加载用户/项目 settings 或 Profile 选择的工具。** 否决，因为 settings、plugins、MCP server 与 prompt 级策略可能扩大权限，或让两个相同启动产生不同执行。未支持的能力请求会在 Query 创建前失败。

**通过 prompt 约定声明 approval 或 evaluation。** 否决，因为文本无法强制逐次调用决策或隔离 evaluation 生命周期。这些能力留作显式后续工作。

**保留一个长期 streaming Query。** 否决，因为持久身份属于已持久化 Session；每轮一个进程可以提供精确 subprocess 所有权、有界 idle 资源占用，并通过官方 resume API 直接修复崩溃。

## 后果

Agent Teams 可以托管原生身份与对话跨 Host 重启存续的 Claude Code Digital Employee，而无需在 DSH 中保存原生 transcript。稳定 launch 与 delivery marker 防止重复原生工作，精确 handle 约束 interruption，固定策略阻止 Profile 权限升级。Idle employee 不拥有进程。

后端是私有、仅供源码检出使用的包，并与一个 SDK/原生基线耦合。升级时必须重新验证 manifest、平台载荷、Session API、Query 选项、sandbox 语义与真实产品 canary。它只提供 fresh context 与固定只读工具，不提供 answer bridge、exact-call approval 或 evaluation。原生账号设置仍由 Claude Code 负责。

## 测试

确定性 SDK fake 覆盖精确产品资格、UUID 身份、launch 与 delivery replay、并发 delivery 串行化、准入失败重试、多轮 resume、Host 重启、碰撞拒绝、spawn 前能力检查、固定 Query 策略、环境净化、marker 遍历边界、evidence 规范化与分页、取消、精确 handle interruption、附着前关闭、进程与 teardown 故障、并发 disposal、注册移除，以及四轴逐文件 100% coverage。生产 Loader 测试使用空 `PATH` 校验源码与构建库注册及 Fiber 移除。可选真实产品 canary 使用已配置 Claude 访问创建 Session、释放 Host、在另一 Host 中恢复同一 handle、运行第二轮，并删除该精确 canary Session。
