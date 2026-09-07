# Agent Teams

[English](agent-team.md) | 中文

实验性隐式 Root Team 领域、模型工具与宿主适配器共享的类型。[Agent Teams Agent Note](../../.agents/notes/implemented/feature/2026-08-05-agent-teams.zh.md)负责身份、运行时放置、mailbox、task 与共享 checkout 决策；[Team Steer 消息 Agent Note](../../.agents/notes/implemented/simplification/2026-08-30-team-send-message-steer.zh.md)负责消息调度；[持久人类消息请求 Agent Note](../../.agents/notes/implemented/architecture/2026-09-07-durable-human-team-message-requests.zh.md)负责人类 Lead 发送的幂等性与回复关联。本页记录 [`packages/experimental/agent-team/src/types.ts`](../../packages/experimental/agent-team/src/types.ts) 中的字面持久形式。

## 身份与 roster

`TeamId` 是具有独立[品牌](core.zh.md#branded-ids)的 Root `SessionId`。`TeamTaskId` 在 Team 内按 `task-<n>` 单调分配；`TeamMessageId` 是全局随机值。teammate 的预留 member id 始终是其持久 Team 身份，`name` 是不可变的模型／UI 标签。DSH 分支把该 id 用作 child Session；外部分支只把它作为 provider-native session 的稳定关联。

```ts type-equiv
/** Provider, model, and optional reasoning selection retained for one teammate. */
interface TeamMemberRouteSnapshot {
  readonly provider?: string
  readonly model?: string
  readonly reasoningEffort?: ReasoningEffortId
}
```

```ts type-equiv
/** Whole durable value written on every teammate lifecycle change. */
interface TeamMemberSnapshot {
  readonly id: SessionId
  readonly name: string
  readonly description: string
  readonly provider: string
  readonly context: 'fresh' | 'fork'
  readonly requestedRoute?: TeamMemberRouteSnapshot
  readonly resolvedRoute?: TeamMemberRouteSnapshot
  readonly externalRuntime?: TeamMemberExternalRuntimeSnapshot
  readonly phase: TeamMemberPhase
  readonly error?: string
}
```

每个 member 都从 `provisioning` 开始，并且只到达一个终态 roster phase：`active` 或 `failed`。DSH member 保留不可变的 `requestedRoute`；其 `resolvedRoute` 来自已接受 child 的 continuation descriptor，并且必须保留每个显式请求字段。external member 改为保留 `externalRuntime`，不能携带任一 DSH 路由字段。运行时 `running`／`idle`／`inactive` 状态单独派生，绝不会重写该记录。

## 持久运行时放置

external provider 只声明它能够强制执行的 context mode 与 capability。Agent Teams 在预留 roster 身份或向 provider 发送工作前验证完整需求；one-shot subagent provider 不作为回退。精确调用审批同时要求 Hook 强制执行与规范 evidence，每个 ask Hook 都携带由 Profile 拥有的稳定策略 id，并必须关联到相同不可变的原生 call 与 approval 身份。

运行时能力是彼此独立的证明。`full-collaboration` 表示 provider 实现完整的耐久 Team 契约：双向 mailbox 投递、全部有界原生成员操作（`members.list`、`tasks.list`、`tasks.get`、`messages.send`、`tasks.update` 与 `wait`）、终态结果结算、精确中断、精确 handle 恢复与释放。若六项原生操作及其 grant binder 不完整，注册会拒绝该声明。`workspace-write` 单独表示 runtime 可以修改分配给它的 workspace；该标记本身不授予权限，实际写入仍受有效 sandbox 与 Profile tool policy 约束。因此，只读 runtime 可以支持完整协作而不声明 workspace 写入。

```ts type-equiv
/** Exact capability demand checked before a provider receives work. */
interface TeammateRuntimeRequirements {
  readonly contextMode: 'fresh' | 'fork'
  readonly profileCapabilities: readonly TeammateProfileCapability[]
  readonly runtimeCapabilities: readonly TeammateRuntimeCapability[]
}
```

```ts type-equiv
/** Durable provider correlation retained with one external roster member. */
interface TeamMemberExternalRuntimeSnapshot {
  readonly kind: 'external-agent'
  readonly launchRequestId: TeammateLaunchRequestId
  readonly requestFingerprint: string
  readonly requirements: TeammateRuntimeRequirements
  readonly nativeHandle?: TeammateRuntimeHandle
  readonly initialTurnId?: TeammateRuntimeTurnId
}
```

`launchRequestId` 让相同创建重试保持幂等，`requestFingerprint` 则拒绝用不同规范化输入复用该身份。provider 只有在持久接受初始工作后才返回 `nativeHandle`；若可以观察，同一 acknowledgement 还会携带 `initialTurnId`，并将其保留为规范原生关联。在记录不透明 runtime 身份前，external member 不能变为 `active`。provider process object、credential、prompt、evidence payload 与原生 session 状态不会进入 Team 日志。

精确的 live Lead 可以读取 active external teammate 的有界规范 evidence page。Agent Teams 在内部解析 roster 所有的 native handle，因此调用方不能把检查重定向到无关 runtime。只有稳定 turn/tool/approval 身份、规范结果、时间戳、pending approval 关联和 provider 报告的 token 计数可以跨越该接缝；原始 prompt、reply、拟议 tool argument/result、文件、环境值、credential 与 provider payload 始终被排除。只有该精确 runtime 报告 `running` 时才接受非空 pending 集合；不会从未匹配的 ask 推断 pending 状态。

```ts type-equiv
/** Request for a bounded evidence window owned by one native runtime. */
interface TeammateRuntimeEvidenceRequest {
  readonly nativeHandle: TeammateRuntimeHandle
  readonly cursor?: TeammateRuntimeEvidenceCursor
  readonly limit: number
  readonly signal: AbortSignal
}
```

```ts type-equiv
/** One provider-proven still-live exact approval correlation, independent of evidence pagination. */
interface TeammateRuntimePendingApproval {
  readonly turnId: TeammateRuntimeTurnId
  readonly approvalId: TeammateRuntimeApprovalId
  readonly callId: TeammateRuntimeToolCallId
}
```

```ts type-equiv
/** Detached evidence page correlated to its exact native runtime. */
interface TeammateRuntimeEvidenceResult {
  readonly nativeHandle: TeammateRuntimeHandle
  readonly items: readonly TeammateRuntimeEvidenceItem[]
  /** Complete current pending set; an omitted set is empty and never inferred from an unmatched ask. */
  readonly pendingApprovals?: readonly TeammateRuntimePendingApproval[]
  readonly nextCursor?: TeammateRuntimeEvidenceCursor
  readonly complete: boolean
}
```

provider 注册归调用方 Fiber 所有。移除操作会关闭准入、取消并等待该 provider 的工作、移除其进程内 handle，且不影响其他 provider。持久 external member 会在不改变持久身份的情况下变为不可用且不驻留；同一 provider id 之后可以恢复完全相同的原生 handle，而不会创建替代项。

<a id="native-member-authorization"></a>

## 原生成员授权

Team 所有者只在持久成员接受或验证恢复后，向当前 provider 交付 `NativeMemberGrant`。捕获的身份绝不来自模型参数。注册、handle 或精确 Lead 释放、原生进程离线时永久撤销该 grant；评测不会获得生产 grant。[授权决策](../../.agents/notes/implemented/architecture/2026-09-05-native-team-member-grants.zh.md)记录理由，[包契约](../../packages/experimental/agent-team/README.zh.md#teammates)定义查询上限和 cursor 语义。

原生消息、任务变化和终态结果共享[原子回执决策](../../.agents/notes/implemented/architecture/2026-09-06-durable-native-team-operations.zh.md)。必需的 payload-4 消息／任务事件将变更与其 `TeamNativeOperationId` 回执一起记录；projection version 7 重建两者和精简消息索引，并明确保留 payload-3 消息和 payload-2 读取分支。任务回执保留已校验输入和精简的原始接受结果。[原生任务规则](../../.agents/notes/implemented/architecture/2026-09-06-native-task-operation-receipts.zh.md)说明先于 CAS 的重放及只观察变化的等待。

`turns.recover` 是 Host-only grant reader，不是发布给模型的操作。当前 grant 校验通过后，它与 Team journal 串行执行、flush Lead Session，并返回分离的当前视图，其中只包含获授权成员的 launch 关联、入站 delivery id，以及已提交结算的结果和有意文本。它排除入站消息文本与所有同级成员或其他 Team 的事实，也不发布 Team 活动。页面使用数字 offset，默认包含 10 项，允许 1 至 100 项，并保留稳定身份，以便并发追加移动后续页面时由适配器对条目去重。

```ts type-equiv
/** Trusted provider correlation supplied separately from model tool arguments. */
type NativeMemberOperationSource =
  | { readonly kind: 'tool'; readonly turnId: TeammateRuntimeTurnId; readonly callId: TeammateRuntimeToolCallId }
  | { readonly kind: 'settlement'; readonly turnId: TeammateRuntimeTurnId }
```

```ts type-equiv
/** Terminal outcome reported by the provider for one accepted native work turn. */
type NativeMemberTurnOutcome = 'completed' | 'failed' | 'interrupted'
```

```ts type-equiv
/** Replayable durable acceptance; queued does not report delivery or work completion. */
type NativeMemberMessageResult =
  | {
    readonly ok: true
    readonly operation: 'messages.send'
    readonly value: { readonly messageId: TeamMessageId; readonly status: 'queued' }
  }
  | {
    readonly ok: true
    readonly operation: 'turns.settle'
    readonly value: { readonly messageId: TeamMessageId; readonly status: 'queued'; readonly outcome: NativeMemberTurnOutcome }
  }
```

```ts type-equiv
/** Provider-correlated acceptance retained in the authoritative Team projection. */
interface TeamNativeOperationReceiptBase {
  readonly id: TeamNativeOperationId
  readonly memberId: SessionId
  readonly provider: string
  readonly nativeHandle: TeammateRuntimeHandle
  readonly source: NativeMemberOperationSource
  readonly inputFingerprint: string
}
```

```ts type-equiv
/** Original acceptance of a native mailbox operation. */
interface TeamNativeMessageReceipt extends TeamNativeOperationReceiptBase {
  readonly result: NativeMemberMessageResult
}
```

```ts type-equiv
/** Validated task transition selected by one native member call. */
interface NativeMemberTaskRequest extends UpdateTeamTaskRequest {
  readonly operation: 'tasks.update'
}
```

```ts type-equiv
/** Compact original acceptance; full task details remain available through task reads. */
interface NativeMemberTaskResult {
  readonly ok: true
  readonly operation: 'tasks.update'
  readonly value: { readonly task: Pick<TeamTaskView, 'id' | 'revision' | 'status' | 'ownerName' | 'ready'> }
}
```

```ts type-equiv
/** Task input and result retained together for replay validation. */
interface TeamNativeTaskReceipt extends TeamNativeOperationReceiptBase {
  readonly request: NativeMemberTaskRequest
  readonly result: NativeMemberTaskResult
}
```

```ts type-equiv
/** Native acceptance retained in the authoritative Team projection. */
type TeamNativeOperationReceipt = TeamNativeMessageReceipt | TeamNativeTaskReceipt
```

```ts type-equiv
/** Member-owned work identities and previously committed terminal text, without incoming prompts. */
type NativeMemberRecoveryItem =
  | { readonly kind: 'launch'; readonly launchRequestId: TeammateLaunchRequestId; readonly turnId?: TeammateRuntimeTurnId }
  | { readonly kind: 'delivery'; readonly deliveryId: TeamMessageId }
  | { readonly kind: 'settlement'; readonly turnId: TeammateRuntimeTurnId; readonly outcome: NativeMemberTurnOutcome; readonly text: string }
```

```ts type-equiv
/** Bounded query result or durable acceptance from an authorized native Team operation. */
type NativeMemberOperationResult =
  | NativeMemberMessageResult
  | NativeMemberTaskResult
  | { readonly ok: true; readonly operation: 'turns.recover'; readonly value: { readonly items: readonly NativeMemberRecoveryItem[]; readonly nextOffset?: number } }
  | { readonly ok: true; readonly operation: 'wait'; readonly value: TeamWaitResult }
  | { readonly ok: true; readonly operation: 'members.list'; readonly value: { readonly members: readonly TeamMemberView[] } }
  | { readonly ok: true; readonly operation: 'tasks.list'; readonly value: { readonly tasks: readonly TeamTaskView[]; readonly nextCursor?: TeamTaskId } }
  | { readonly ok: true; readonly operation: 'tasks.get'; readonly value: { readonly task: TeamTaskView } }
  | { readonly ok: false; readonly error: { readonly code: string; readonly message: string; readonly currentRevision?: number } }
```

```ts type-equiv
/** Nonserializable authority delivered only to the current native provider. */
interface NativeMemberGrant {
  readonly identity: Readonly<{ teamId: TeamId; memberId: SessionId; provider: string; nativeHandle: TeammateRuntimeHandle }>
  readonly signal: AbortSignal
  /**
   * Operate as the granted member; model arguments never select caller authority.
   * @param input - untrusted JSON request validated by the Team owner.
   * @param signal - cancellation for this invocation.
   * @param source - trusted native turn and call identity, required for durable mutations.
   * @returns a bounded query, durable acceptance receipt, or stable refusal.
   */
  execute(input: unknown, signal: AbortSignal, source?: NativeMemberOperationSource): Promise<NativeMemberOperationResult>
}
```

```ts type-equiv
/** Provider binding after durable identity acceptance and current-generation verification. */
interface TeammateRuntimeMemberOperationsRequest {
  readonly nativeHandle: TeammateRuntimeHandle
  readonly grant: NativeMemberGrant
}
```

## 持久 mailbox

Lead Session 首先存储完整 queued message。DSH target 只有在 pending inbox 条目或已记录用户消息完成持久化后才写入 acknowledgement；external target 则在 provider 返回稳定 native turn identity 后确认。两种情况下，queued-minus-delivered 都构成恢复 mailbox。

精确的存活 Lead 还可以用调用方拥有的 request id、明确的 active 接收者、字面正文和可选的同 Team 既有消息，提交一条人类编写的消息。发送者与 Team 永远不来自请求数据。`(Team, sender Session, request id)` 标识一份不可变输入：输入相同的重试重放原 submission，接收者、正文或回复关联变化则冲突且不追加事实。新请求在 Team 所有的投递开始前，以必需的 `team/message/request-committed@1` 原子保存消息与回执。调用方取消只拥有接受前工作；返回的 submission 与当前 `pending`／`delivered` 阶段相互分离。

```ts type-equiv
/** One peer message retained until its target Session records it. */
interface TeamMessageSnapshot {
  readonly id: TeamMessageId
  readonly senderId: SessionId
  readonly senderName: string
  readonly targetId: SessionId
  readonly content: ContentBlock[]
}
```

```ts type-equiv
/** Browser-authored Team message input; Host authority supplies the sender. */
interface SubmitTeamMessageRequest {
  readonly requestId: TeamMessageRequestId
  readonly recipientId: SessionId
  readonly text: string
  readonly replyTo?: TeamMessageId
}
```

```ts type-equiv
/** Durable acceptance returned for every replay of one matching request. */
interface TeamMessageSubmission {
  readonly requestId: TeamMessageRequestId
  readonly messageId: TeamMessageId
  readonly status: 'accepted'
}
```

```ts type-equiv
/** Request correlation retained atomically with one human-authored message. */
interface TeamMessageRequestReceipt {
  readonly requestId: TeamMessageRequestId
  readonly senderId: SessionId
  readonly inputFingerprint: string
  readonly replyTo?: TeamMessageId
  readonly result: TeamMessageSubmission
}
```

```ts type-equiv
/** Accepted submission and current Host-proven delivery stage. */
interface SubmitTeamMessageValue {
  readonly submission: TeamMessageSubmission
  readonly delivery: TeamMessageDelivery
}
```

```ts type-equiv
/** Browser message mutation result with request conflicts kept distinct from other Team rejections. */
type SubmitTeamMessageResult =
  | { readonly ok: true; readonly value: SubmitTeamMessageValue }
  | {
    readonly ok: false
    readonly error: {
      readonly code: 'team-message-request-conflict' | 'team-rejected'
      readonly message: string
    }
  }
```

原始 mailbox snapshot 仅留在 Host 内部。Projection version 7 还保留请求回执、每条消息的身份、入队序号与时间，以及可选的投递序号与时间。旧 version-6 checkpoint 会从原日志重建；旧 queued 消息仍可在没有 request／reply 元数据时读取，不支持的未来事件版本则安全失败。精确的存活 Lead 可以在 Session flush 后，以有界、从新到旧的方式读取该索引的元数据。请求允许 1 到 100 行，默认为 20。可选的成员、方向与投递过滤条件会被规范化并写入不透明 committed cursor。该 cursor 固定 Team、过滤条件与序号上界；即使有新消息到达，continuation 仍停留在同一个已提交窗口内。格式错误、未来、跨 Team、查询不匹配、陈旧调用方、伪造调用方与伪造参与者输入都会被拒绝。

```ts type-equiv
/** Direction of a persisted message relative to the selected Team member. */
type TeamMessageDirection = 'sent' | 'received'
```

```ts type-equiv
/** Host-proven delivery stage; unknown is reserved for clients that cannot obtain a current fact. */
type TeamMessageDelivery =
  | { readonly stage: 'pending' }
  | { readonly stage: 'delivered'; readonly deliveredAt: number }
  | { readonly stage: 'unknown' }
```

```ts type-equiv
/** Detached Team participant identity shown in a message result. */
interface TeamMessageParticipant {
  readonly id: SessionId
  readonly name: string
}
```

```ts type-equiv
/** Metadata-only row for one persisted Team message. */
interface TeamMessageSummary {
  readonly id: TeamMessageId
  /** Human submission identity when this message originated in the Team message center. */
  readonly requestId?: TeamMessageRequestId
  /** Earlier message explicitly associated with this reply. */
  readonly replyTo?: TeamMessageId
  readonly sender: TeamMessageParticipant
  readonly recipient: TeamMessageParticipant
  /** Unix epoch milliseconds from the durable queue event. */
  readonly sentAt: number
  readonly delivery: TeamMessageDelivery
}
```

```ts type-equiv
/** Filters applied to one committed Team-message window. */
interface TeamMessageFilters {
  /** Retained Team participant selected by durable Session identity. */
  readonly memberId?: SessionId
  /** Relative to memberId; omitted memberId with a direction is invalid. */
  readonly direction?: TeamMessageDirection
  readonly delivery?: TeamMessageDelivery['stage']
}
```

```ts type-equiv
/** Bounded newest-first query for persisted Team-message metadata. */
interface ListTeamMessagesRequest {
  readonly filters?: TeamMessageFilters
  readonly cursor?: TeamMessageCursor
  /** Page size from 1 through 100; defaults to 20. */
  readonly limit?: number
}
```

```ts type-equiv
/** One complete committed metadata page and its stable continuation identities. */
interface TeamMessagePage {
  readonly items: TeamMessageSummary[]
  readonly committedCursor: TeamMessageCursor
  readonly nextCursor?: TeamMessageCursor
  readonly complete: true
}
```

元数据页绝不包含消息内容。按需详情必须指定由其 committed cursor 暴露的消息。intentional text 以字面文本返回；图片变成脱离原对象的媒体类型、字节数和尺寸；reasoning、tool 或 custom block 变成 `omitted`。Completeness 明确指出是否有内容损失，或原始内容是否不可用。Delivery 只表示 Host 证实的 mailbox 阶段：`pending`、`delivered` 和 `unknown` 都不声称有人已读消息或已完成相关工作。这些读取不会追加 event，也不会发出 Team activity。

```ts type-equiv
/** Browser-safe intentional content retained from one message block. */
type TeamMessageContentPart =
  | { readonly type: 'text'; readonly text: string }
  | {
    readonly type: 'image'
    readonly mediaType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'
    readonly bytes: number
    readonly width: number
    readonly height: number
  }
  | { readonly type: 'omitted' }
```

```ts type-equiv
/** Sanitized content result with explicit loss reporting. */
interface TeamMessageContent {
  readonly completeness: 'complete' | 'partial' | 'unavailable'
  readonly omittedCount: number
  readonly parts: TeamMessageContentPart[]
}
```

```ts type-equiv
/** On-demand detail request bound to the committed list window that exposed it. */
interface GetTeamMessageRequest {
  readonly messageId: TeamMessageId
  readonly committedCursor: TeamMessageCursor
}
```

```ts type-equiv
/** Metadata plus browser-safe intentional content for one persisted Team message. */
interface TeamMessageDetail extends TeamMessageSummary {
  readonly content: TeamMessageContent
}
```

每条消息都会尝试 Steer 投递。人类编写的回复只会把原消息的持久 id 加入投递前缀，不复制原消息正文。running DSH target 在最近的步骤边界收到消息，idle target 启动一个轮次，inactive teammate 则冷恢复。其 Session 会在 pending inbox 条目和最终用户消息上保留消息身份与发送者归因。external target 通过 provider-native handle 接收同一持久 mailbox item，并在 Agent Teams 记录 delivery 前返回幂等 native turn correlation。调用方不能选择其他模式，因此持久记录不存储调度方式。

```ts type-equiv
/** Source retained by the target Session for durable mailbox de-duplication. */
interface TeamMessageSource {
  readonly kind: 'team-message'
  readonly teamId: TeamId
  readonly messageId: TeamMessageId
  readonly senderId: SessionId
  readonly senderName: string
}
```

## 共享任务 DAG

每条 task event 都存储完整快照。`revision` 是 compare-and-set 值，每次变更递增 1。`blockedBy` edge 必须指向未删除任务，并维持无环图。`writeScopes` 是规范化的提示性路径前缀，不是锁。

```ts type-equiv
/** Whole durable task snapshot; every mutation increments {@link revision}. */
interface TeamTaskSnapshot {
  readonly id: TeamTaskId
  readonly revision: number
  readonly subject: string
  readonly description: string
  readonly status: TeamTaskStatus
  readonly ownerId?: SessionId
  readonly blockedBy: TeamTaskId[]
  readonly writeScopes: string[]
}
```

`pending` 表示尚未开始或已经释放，`in_progress` 携带 owner，`completed` 满足 blocker，`deleted` 是保留的 tombstone。view 会添加 owner name、readiness 和 write-scope 重叠警告，但不会改变持久快照。

## 回放

`foldTeam()` 把一个 Root Session 回放成 Team 操作所读取的 roster、任务板、queued-minus-delivered mailbox、不可变人类请求回执与精简消息索引。它按 `TeamId` 选取记录，因此普通 fork 继承的 event 保留 ancestor id，绝不会进入新 Root 的状态。Session event 的 `seq` 与 `time` 继续负责顺序和时间记录，Team snapshot 不再重复保存它们。roster 与 task 读取以 view 形式到达调用方。原始 mailbox snapshot 仍只供投递与恢复内部使用，而 Lead reader 返回脱离原对象的元数据及经过明确净化的按需详情。包 [README](../../packages/experimental/agent-team/README.zh.md)负责 operation、authorization、recovery 和限制行为。

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.zh.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxagentteams--teamservice"></a>

### `ctx.agentTeams` — `TeamService`

Agent Teams service backed by the exact live Lead Session log.

```ts cordis-catalog
/**
 * Resolve one exact live Agent's Team role.
 * @param agent - exact live Agent used as the authority credential.
 * @returns its root, Team identity, role, and model-facing name.
 */
membership(agent: Agent): TeamMembership

/**
 * List the runtime-enriched roster visible to one Team member.
 * @param agent - exact live Team member.
 * @returns Lead and teammate rows in creation order.
 */
listMembers(agent: Agent): TeamMemberView[]

/**
 * Create one named durable teammate through its selected typed runtime.
 * @param caller - exact live Lead Agent.
 * @param request - DSH-continuable or external runtime placement and caller cancellation through initial-work durability.
 * @returns the active roster row with its resolved DSH route or provider-native handle.
 */
async spawnTeammate(caller: Agent, request: SpawnTeammateRequest): Promise<SpawnTeammateResult>

/**
 * Register one complete durable external teammate provider on the calling Fiber.
 * @param provider - provider operations and detached capability metadata.
 * @returns an async disposer with atomic same-id replacement.
 */
registerTeammateRuntimeProvider(provider: TeammateRuntimeProvider): TeammateRuntimeRegistration

/**
 * Queue one durable peer message, then attempt immediate delivery.
 * @param caller - exact live sending Team member.
 * @param request - target name, content, and pre-queue cancellation.
 * @returns durable message identity and immediate-delivery observation.
 */
async sendMessage(caller: Agent, request: SendTeamMessageRequest): Promise<SendTeamMessageResult>

/**
 * Submit one idempotent human-authored message as the exact live Team Lead.
 * @param caller - exact live Team Lead that Host resolved from the request session.
 * @param request - caller-owned request identity, explicit recipient, text, and optional reply.
 * @param signal - cancellation owned by the caller until a new request is durably accepted.
 * @returns original acceptance and current delivery stage.
 */
async submitMessage( caller: Agent, request: SubmitTeamMessageRequest, signal: AbortSignal, ): Promise<SubmitTeamMessageValue>

/**
 * Read one bounded metadata page from a fixed committed Team-message window.
 * @param caller - exact live Team Lead.
 * @param request - filters, page size, and optional stable continuation.
 * @returns message metadata without message content.
 */
async listMessages(caller: Agent, request: ListTeamMessagesRequest): Promise<TeamMessagePage>

/**
 * Read sanitized intentional content for one message in a committed window.
 * @param caller - exact live Team Lead.
 * @param request - message identity and its committed list cursor.
 * @returns message metadata and browser-safe content.
 */
async getMessage(caller: Agent, request: GetTeamMessageRequest): Promise<TeamMessageDetail>

/**
 * Read bounded normalized evidence for one exact external teammate.
 * @param caller - exact live Lead Agent used as the authority credential.
 * @param targetName - active provider-native teammate name.
 * @param request - bounded evidence cursor, limit, and caller cancellation.
 * @returns provider-normalized facts correlated to the roster-owned native handle.
 */
async readTeammateRuntimeEvidence( caller: Agent, targetName: string, request: Omit<TeammateRuntimeEvidenceRequest, 'nativeHandle'>, ): Promise<TeammateRuntimeEvidenceResult>

/**
 * Run one isolated provider-native evaluation for an exact live Team Lead.
 * @param caller - exact live Team Lead that owns the operation.
 * @param providerId - registered provider selected for the isolated run.
 * @param request - fresh context, detached Profile, input, confinement, and cancellation.
 * @param commit - optional durable-result callback invoked while the exact handle is still attached.
 * @returns the completed detached result, only after exact-handle release in finally.
 */
async runTeammateEvaluation( caller: Agent, providerId: string, request: TeammateEvaluationCreateRequest, commit?: (result: TeammateEvaluationCreateResult) => void | Promise<void>, ): Promise<TeammateEvaluationCreateResult>

/**
 * Create one unowned pending task in the Team Lead log.
 * @param caller - exact live Team member creating the task.
 * @param request - task text, blockers, and advisory write scopes.
 * @returns the revision-one task view.
 */
async createTask(caller: Agent, request: CreateTeamTaskRequest): Promise<TeamTaskView>

/**
 * Return one task, including a deleted tombstone.
 * @param caller - exact live Team member reading the task.
 * @param id - Team-local task identity.
 * @returns the latest task value and derived readiness diagnostics.
 */
getTask(caller: Agent, id: TeamTaskId): TeamTaskView

/**
 * List current non-deleted tasks in numeric creation order.
 * @param caller - exact live Team member reading the board.
 * @returns detached current task views.
 */
listTasks(caller: Agent): TeamTaskView[]

/**
 * Compare-and-set one authorized task transition.
 * @param caller - exact live Team member authorizing the mutation.
 * @param request - task identity, expected revision, action, and action fields.
 * @returns the committed next task revision.
 */
async updateTask(caller: Agent, request: UpdateTeamTaskRequest): Promise<TeamTaskView>

/**
 * Wait for the next Team-domain or member-status change.
 * @param caller - exact live Team member waiting for activity.
 * @param timeoutMs - bounded wait duration from ten seconds through one hour.
 * @param signal - caller cancellation for the wait only.
 * @returns one observed change or a timeout result.
 */
async waitForChange(caller: Agent, timeoutMs: number, signal: AbortSignal): Promise<TeamWaitResult>

/**
 * Interrupt one live teammate turn without clearing its pending inbox.
 * @param caller - exact live Lead Agent.
 * @param targetName - durable teammate name.
 * @returns the target status sampled before cancellation.
 */
interrupt(caller: Agent, targetName: string): { previousStatus: 'running' | 'idle' | 'inactive' }

/**
 * Resolve a caller without throwing, used by scoped-tool installation and observers.
 * @param agent - candidate exact live Agent.
 * @returns Team membership, or undefined for non-Team subagents and stale identities.
 */
tryMembership(agent: Agent): TeamMembership | undefined

/**
 * Read the current roster and non-deleted task board through the generated Remote API.
 * @param agent - exact live Team member used as the authority credential.
 * @returns detached current roster and task views.
 */
@Remote('view') remoteView(agent: Agent): TeamView

/**
 * Read persisted message metadata through the generated Remote API.
 * @param agent - exact live Team Lead used as the authority credential.
 * @param request - bounded committed message query.
 * @returns metadata page with stable cursors and no message body.
 */
@Remote('listMessages') remoteListMessages(agent: Agent, request: ListTeamMessagesRequest): Promise<TeamMessagePage>

/**
 * Read one sanitized persisted message through the generated Remote API.
 * @param agent - exact live Team Lead used as the authority credential.
 * @param request - stable message identity and committed query cursor.
 * @returns safe intentional content with explicit completeness.
 */
@Remote('getMessage') remoteGetMessage(agent: Agent, request: GetTeamMessageRequest): Promise<TeamMessageDetail>

/**
 * Submit or replay one Lead-authored message through the generated Remote API.
 * @param agent - exact live Team Lead resolved by Host rather than supplied as message data.
 * @param request - stable human request and explicit Team recipient.
 * @param signal - transport cancellation before durable acceptance.
 * @returns accepted submission with current delivery, or a stable Team rejection.
 */
@Remote('sendMessage') remoteSendMessage( agent: Agent, request: SubmitTeamMessageRequest, signal: AbortSignal, ): Promise<SubmitTeamMessageResult>

/**
 * Create one shared task through the generated Remote API.
 * @param agent - exact live Team member creating the task.
 * @param request - task text, blockers, and advisory write scopes.
 * @returns the revision-one task or a typed Team rejection.
 */
@Remote('createTask') remoteCreateTask(agent: Agent, request: CreateTeamTaskRequest): Promise<TeamTaskMutationResult>

/**
 * Apply one task mutation and preserve Team rejections as business results.
 * @param agent - exact live Team member authorizing the mutation.
 * @param request - task identity, expected revision, action, and action fields.
 * @returns the committed task or a typed Team rejection.
 */
@Remote('updateTask') remoteUpdateTask(agent: Agent, request: UpdateTeamTaskRequest): Promise<TeamTaskMutationResult>
```

Types: [Agent](core.zh.md)

Source: [`packages/experimental/agent-team/src/index.ts`](../../packages/experimental/agent-team/src/index.ts)
<!-- END GENERATED cordis-surface -->
