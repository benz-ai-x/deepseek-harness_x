# Agent Note: 持久外部 teammate 运行时

Status: implemented

[English](2026-09-03-durable-external-teammate-runtimes.md) | 中文

## Problem

[最初的 Agent Teams 决策](../feature/2026-08-05-agent-teams.zh.md)把每个 teammate 都建模为可继续的 DSH child Session。这保留了 DSH 的对话与 Activation 语义，但无法表达由外部 agent 系统拥有持久 native session、策略执行、证据或评估生命周期的情况。若把这类工作路由到一次性 subagent，多 turn 与重启之间的精确身份就会丢失。

Agent Teams 必须继续让 Lead 日志作为 member、mailbox 顺序与 task owner 的权威来源，同时不能持久化 provider 进程、凭据、现有 Team event 之外的 prompt 或 provider-native 状态。它还必须区分临时 provider 缺席与 member 失败，并在 provider Fiber 或 Team service 被移除时结清每个已接受的 native 资源。

## Decision

一个 roster member 只选择一个有类型的运行时分支。既有 DSH 分支仍是可继续的直接 child；external 分支存储一个分离的 `externalRuntime` 关联，其中包含调用方生成的 launch id、规范请求指纹、精确 requirements，以及仅在 native 接受后写入的 provider opaque runtime handle。launch id 与 native handle 都是非空且最多 200 UTF-8 字节的字符串；它们没有词法 identifier 语法，因此路径或 Unicode 等 provider 值会按原字节保持 opaque。

Host 通过 `ctx.agentTeams.registerTeammateRuntimeProvider()` 在 owner Fiber 上注册外部实现。注册项发布分离的身份与 capability metadata，以及 create、resume、deliver、interrupt、evidence、evaluation、presence 和 dispose 操作。Agent Teams 会在预留 roster 名字或发送工作之前校验所请求的 context、Profile policy 与运行 capability。只有同时具备 Hook 强制执行与规范 evidence 时才能声明精确调用审批；ask Hook 拥有一个稳定 Profile policy id，approval evidence 必须保留该 policy 以及相同不可变的原生 call 与 approval 身份。完整规范化 Profile 只穿过 Host seam；provider 凭据、进程对象、native 状态与 evidence payload 都不会进入 Team 日志。

运行能力标记保持彼此正交。`full-collaboration` 证明完整的耐久 Team 参与契约；若 provider 没有发布并绑定全部六项有界原生成员操作，注册会拒绝该声明，其余生命周期由必需的 create、resume、delivery、interrupt、dispose 与终态结果路径覆盖。`workspace-write` 独立证明 runtime 可以修改分配给它的 workspace，但绝不授予权限，也不会越过有效 sandbox 与 Profile tool policy。因此，只读 runtime 可以如实提供完整协作，而不声称拥有写入权限。

目录描述提供方支持的能力，而不是每个历史原生会话已安装的工具。create 和 resume 结果可以证明精确已接受句柄的 `memberOperations`。注册表在实时在线状态旁拥有这份冻结子集，范围仅限于仍接受操作的提供方世代。roster 公开它，但不持久化，也不授予权限。仅在线状态更新保留证明；resume 替换证明，脱离挂载则移除证明。省略的证明保持未知，不继承目录或已退役世代的结论。

创建流程会先记录并 flush provisioning 关联，再调用选定 provider。provider 必须持久接受初始工作并返回一个稳定 native handle，Agent Teams 才会记录 active member。重复相同 launch/member 身份必须返回同一 handle；为另一身份复用 handle，或在 resume 时更改 handle，都会隔离该 provider generation。registry 会校验 provider 返回的持久 handle；被拒绝的结果仍归 cleanup 所有，因此即使已接受的 handle 无效，也会被精确 dispose。

外部 mailbox 投递使用持久 Team message id 与精确 provider/native handle。它不再具有 `quiet`/`wakeup` 选择器：与当前所有 Agent Teams 消息相同，它遵循单一 Steer 契约，provider 在保持 target-local 顺序的同时把消息持久准入为下一个 native turn。provider 在 Team 记录 delivered 前返回稳定 native turn id。runtime delivery、interrupt、presence、evidence 与 disposal 都只通过已记录的精确 native handle 路由，不会回退到 DSH 或一次性 provider。四种 Team event payload 继续固定为 version 2；external correlation 扩展当前 pre-release 结构，而严格 replay 会拒绝 version 1。evidence 可以包含规范 approval 事实与完整当前 pending 集合，但绝不包含拟议参数；只有精确 runtime 报告 `running` 时非空 pending 集合才有效，且重启后不会推断未匹配的 ask 仍为 pending。隔离 evaluation 是独立且由 Lead 拥有的操作：它要求 fresh context、分离 Profile、只读 sandbox、无审批、有界资源，以及包含于 provider 已发布 tool inventory 的唯一 allowlist。provider 在独立 native handle 上把调用方拥有的 evaluation id 与声明 input 运行到规范 outcome。Agent Teams 会在该精确 handle 仍挂载时调用可选的调用方耐久 commit，再于公开操作 settle 前在 `finally` 中释放它。evaluation 绝不创建 roster identity、生产 workspace、transcript 或 activation。可复用 provider conformance suite 为实现固定了幂等 create 与 deliver、调用方取消、重启 resume、evidence、evaluation、精确 interrupt 与精确 dispose 行为。

provider 注册归调用 Fiber 所有。移除时先关闭新准入、中止已准入工作并等待其 settlement，再停止 presence observer，并在注册消失前 dispose 每个 attached runtime 与 evaluation handle。cleanup 使用 abort deadline 请求取消，但仍等待真实 quiescence；超时不会被报告为成功 disposal。其他 provider id 保持可用。provider 缺席时，已持久 member 仍保持 active，只派生为 unavailable/inactive 运行状态。重新注册相同 provider id 会 resume 已记录 native handle 与 queued mailbox work，不会创建 replacement。

公开 testkit、TypeScript SDK notification snapshot、Python 单文件 runtime snapshot 与真实 headless Agent Teams profile 组合投影相同的 `team/member.externalRuntime` 结构。这些表面只暴露持久关联，绝不暴露 provider secret。

## Alternatives considered

**从当前提供方元数据推断已有成员的工具。** 拒绝，因为不可变原生会话在提供方升级后可能保留旧工具集。独立持久化工具清单同样会宣称可恢复性，而缺少已安装工具查询的提供方无法独立验证它。进程内接受事实保留这种不确定性，不改变原生身份或 Team 格式。

**把外部 agent 建模为可继续 DSH child。** 拒绝，因为这会让 DSH 看似拥有实际属于另一运行时的 conversation 与 Activation，也无法保持该运行时的精确 native 身份。

**每个 turn 使用一次性 subagent provider。** 拒绝，因为相互独立的 run 无法提供稳定 native 身份、幂等 mailbox 投递、精确 interrupt 或 cold resume。

**在 Team event 中持久化 provider 状态或凭据。** 拒绝，因为 Lead 日志拥有可移植协调事实，而不拥有 provider 实现状态或 secret；只有有界且分离的关联可持久化。

**provider 消失时让 member 失败或替换 member。** 拒绝，因为注册只是进程内 availability，而 member 与 native session 可能仍然持久；重新挂接必须使用相同 provider id 与精确 handle。

**把 abort deadline 当作 cleanup 完成。** 拒绝，因为 provider work 或 disposal 尚未 settle 就返回会违反 Fiber removal，并可能泄漏已接受 native runtime。

**在没有原生关联 evidence 时信任精确调用 capability 标记。** 拒绝，因为仅有标记无法证明审批覆盖了拟议调用，也无法证明 waiting 状态仍然存活；缺失或畸形关联必须封闭失败并隔离该 provider generation。

**通过 active 生产 teammate 执行 evaluation。** 拒绝，因为候选运行可能继承生产 conversation 或 workspace 状态、修改运行资源，并使已提交结果无法证明来自哪次隔离 native execution。

## Consequences

Agent Teams 包除了 DSH continuation 集成外，现在还拥有有类型的 provider registry。provider 作者必须实现完整持久契约，并通过 conformance suite 证明。active external member 在 provider 重新注册前可能 unavailable/inactive，恢复延迟由该 provider 承担。

Lead 日志仍可检查且不含 secret，但不能独立重建 native 状态。因此恢复依赖能精确解析已持久 launch/member/handle tuple 的 provider。畸形 approval 或 pending 关联会隔离 provider generation；pending approval 状态是进程内存活 evidence，而不是可恢复事实。隔离违反契约的 generation，可能让该 provider 上所有 member 暂时不可用，直到 cleanup 与显式 replacement 完成。

每次 evaluation 都会消耗 fresh provider-native execution resource，且 provider 必须发布它能约束的有界 tool inventory。需要持久 evidence 的调用方必须在 commit callback 内写入；callback 失败会使操作失败，但仍不能泄漏 evaluation handle。API 不会持久化 evaluation output，也不会把 evaluation 成功与 activation 耦合。

## Testing

注册表回归验证精确句柄隔离、分离的操作数组、在线状态与投递及中断时的保留、resume 时证明移除、同 id 替换和资源释放。Ultra 消费方回归覆盖冷恢复时不可变的历史 Codex 工具以及新线程已确认的工具；真实认证原生验收仍不属于这些确定性检查。

Package test 覆盖 capability preflight、不完整 full-collaboration 声明的拒绝、分离 Profile 传递、精确调用审批 capability gate、approval 与 pending 关联、opaque UTF-8 身份、request 与 handle 冲突、跨冷 Host 重启的两个 turn、provider 消失与精确重挂接、queued delivery、presence、evidence、fresh-context evaluation 约束、有界 tool inventory、commit-before-dispose 顺序、取消所有权转移、quarantine、同 id replacement 与 quiescent cleanup。provider conformance suite 会针对可 reopen 的持久 fixture 重复验证可移植契约。headless 组合与两种 SDK 投影固定公开 event shape，并验证 `externalRuntime` 只包含有界持久关联数据。
