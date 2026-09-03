# Agent Note: 持久 Codex teammate 运行时

Status: implemented

[English](2026-09-03-durable-codex-teammate-runtime.md) | 中文

## Problem

[持久外部 teammate 运行时](../architecture/2026-09-03-durable-external-teammate-runtimes.zh.md)让 Agent Teams 能在多个 turn 与 Host 重启之间保留 provider-native 身份，但它不会自动让一次性产品集成具有持久性。既有 [Codex subagent 后端](2026-08-04-claude-code-and-codex-subagent-backends.zh.md)刻意为一个自包含结果创建临时线程与进程。若把它复用于 Digital Employee，每个 mailbox item 都会丢弃 native history、制造新身份，并使精确 resume 与 interruption 无法实现。

Codex 实现还必须区分符合资格的原生 App Server 与仅存在的包名，让部署 sandbox 权威强于 Profile 请求，并在不把原生 prompt、凭据、路径、登录状态或协议载荷写入 Team log 或浏览器值的前提下公开有用运行状态。进程失败与插件移除必须不留下 attached process，同时只保留精确恢复所需的持久关联。

## Decision

`@deepseek-ai/dsh-experimental-agent-team-codex` 是私有 Host 插件，也是持久 teammate provider contract 的首个产品实现。只有包内 `@openai/codex` wrapper 与匹配的可执行平台载荷版本恰好为 `0.149.1` 时，它才会注册。它绝不从 `PATH` 解析宿主 `codex`，绝不把一次性 provider 当作 fallback，并且报告不符合资格时不包含安装路径。

每个已附着 employee 拥有一个包内 `codex app-server --stdio` 进程与一个非临时原生线程。初始化会启用 App Server experimental API。适配器根据 provider、launch 与已预留 member 身份计算 SHA-256 幂等键，通过 `project/create` 发送它，并使用 Codex 返回的不透明 project id 完成线程发现、启动与恢复。Codex 生成的线程 id 是稳定 teammate runtime handle；线程、project、持久模式或有效策略变化时，适配器会拒绝，而不会接受 replacement。

provider 只支持 fresh context。它把 persona、mission、启用的 context 块与精选 memory 作为原生 developer instruction 强制执行，并只接受非空文本工作。它不声明 Profile tool-policy 或 Hook 强制、exact-call approval 或 evaluation。要求这些 capability 的启动会在进程开始前被 Agent Teams 拒绝。部署配置固定为 `read-only` 或 `workspace-write`，二者都强制原生 `approvalPolicy: never` 与 `networkAccess: false`。适配器校验 Codex 的有效响应并拒绝更宽权限。原生 approval、permission、用户输入与 elicitation 请求会收到无人值守拒绝，未知请求则使 connection 失败。

launch 与 mailbox 幂等性使用调用方拥有的 id 作为原生 client message id。重复 launch 会找到已记录的初始 id，不会再提交一个初始 turn。重复 Team delivery 返回其已记录的原生 turn id。connection 一次只接纳一个 turn，把通知关联到精确线程与 turn，在 `turn/start` 建立 id 前保留早到终态，并拒绝身份不匹配。Team mailbox 串行化提供有序投递；重叠的直接 provider admission 会失败关闭。

provider 保留有界内存 evidence 窗口，其中只包含规范化 turn outcome、tool kind 与 outcome，以及 usage 发生事实。确定性 evidence id 会替换原生 id。prompt、消息文本、工具参数与输出、命令、路径、凭据、登录状态、token 总数、stderr 和原始协议值绝不会进入 evidence 或 Team persistence。跨越 provider contract 的失败只包含固定生命周期阶段与类型化 Team runtime code；原生 cause 留在内部。

App Server 退出时会移除 live attachment 并发出 inactive presence，同时保留 launch 到 handle 的关联。下一次 delivery 或 Host replay 会启动新 App Server，并对该精确 handle 调用 `thread/resume`。协议流失败也会先终止故障进程，再允许修复。正常 runtime disposal 会移除关联。Provider Fiber disposal 会关闭 admission、打断精确活跃 turn、关闭 transport、终止并等待每个所拥有的进程树、清空 evidence 与 delivery 索引并移除注册。并发 disposal 共享一个 settlement，独立 cleanup failure 以 aggregate 保持可见。

## Alternatives considered

**为每个 turn 调用一次性 Codex provider。** 拒绝，因为临时 run 无法保留原生对话身份、去重 mailbox turn、在 Host 重启后恢复或打断精确当前 turn。

**解析任意已安装的 `codex` 可执行文件。** 拒绝，因为包名或宿主二进制不能证明锁定的 App Server 协议与匹配原生载荷。精确包资格判定让 eligibility 可确定，并使 runtime closure 保持本地。

**为恢复持久化原生 transcript 或协议载荷。** 拒绝，因为 Codex 拥有其线程状态，Team log 拥有协调。复制产品状态会产生第二个 history owner 并暴露敏感原生值；恢复改用不透明 handle。

**允许 Profile 请求或原生 prompt 扩大 sandbox 权限。** 拒绝，因为 confinement 属于部署配置。不支持的 Profile policy 会在启动前失败，有效原生策略不匹配则会在附着前失败。

**通过 prompt 模拟并声明 capability。** 拒绝，因为 prompt 文本无法强制 tool allowlist、Hook、精确 approval 或隔离 evaluation 生命周期。capability metadata 只包含适配器可验证的行为。

**把真实产品 canary 当作正确性套件。** 拒绝，因为产品执行比确定性协议 peer 更慢，且无法穷尽分支。canary 证明锁定发行物兼容性，fake 则拥有完整生命周期与失败语义。

## Consequences

Agent Teams 可以托管由 Codex 支持的 Digital Employee，其原生身份与对话可跨 Host 重启存活，而无需在 DSH 中存储原生 transcript。稳定 launch 与 delivery id 防止重复原生工作，精确 handle 路由防止静默替换。部署继续拥有 sandbox 权威，浏览器可见 Team 状态保持有界且不含原生 secret。

后端是私有、仅供源码检出使用的实现，并耦合到单一 Codex 协议基线。升级 Codex 必须重新验证 wrapper 与平台载荷、协议字段、有效策略响应、重启行为和真实产品 canary。严格无人值守策略不提供人工 approval 或启用网络的模式。Codex answer 与 reasoning 留在原生线程；Team consumer 得到 presence、mailbox acceptance 与粗粒度净化 evidence，而不是镜像 transcript。

## Testing

包内确定性 App Server peer 覆盖 eligibility、spawn 前 capability 拒绝、非临时创建、project 与 thread 身份、launch 与 delivery replay、多 turn、早到与不匹配通知、拒绝 server request、sandbox 校验、有界 evidence、interruption、crash 与 protocol repair、cancellation、并发 cleanup、cleanup failure、registration removal，以及逐文件四项全覆盖。包内 production-Loader 组合会在源码与构建产物两种模式下、不启动 Codex 地验证注册、精确 capability metadata 与 Fiber 移除。构建产物模式保持 workspace paths 禁用；只有相对 TypeScript 测试 driver 会在 Node 二进制缺少原生类型剥离时回退到本包自有的 tsx hook。可选真实产品 canary 让锁定 App Server 连接 loopback Responses fixture，创建一个线程，释放完整 Host，在另一个 Host 中恢复同一不透明 handle，并完成第二个 turn。Ultra 源码 Profile 验证私有 dependency closure。
