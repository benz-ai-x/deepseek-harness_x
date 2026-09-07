# Agent Teams

English | [中文](agent-team.zh.md)

Types shared by the experimental implicit-root Team domain, model tools, and host adapters. The [Agent Teams Agent Note](../../.agents/notes/implemented/feature/2026-08-05-agent-teams.md) owns identity, runtime placement, mailbox, task, and shared-checkout decisions; the [Team Steer messaging Agent Note](../../.agents/notes/implemented/simplification/2026-08-30-team-send-message-steer.md) owns message scheduling; the [durable human message request Agent Note](../../.agents/notes/implemented/architecture/2026-09-07-durable-human-team-message-requests.md) owns Lead-authored idempotency and reply correlation. This page records the literal durable forms from [`packages/experimental/agent-team/src/types.ts`](../../packages/experimental/agent-team/src/types.ts).

## Identity and roster

`TeamId` is the root `SessionId` under a distinct [brand](core.md#branded-ids). `TeamTaskId` is Team-local and monotonically allocated as `task-<n>`; `TeamMessageId` is globally random. A teammate's reserved member id remains its persistent Team identity, while `name` is an immutable model/UI label. The DSH branch uses that id for its child Session; the external branch uses it only as a stable correlation to a provider-native session.

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

Every member starts in `provisioning` and reaches exactly one terminal roster phase, `active` or `failed`. A DSH member retains an immutable `requestedRoute`; its `resolvedRoute` comes from the accepted child continuation descriptor and must preserve every explicit requested field. An external member retains `externalRuntime` instead and cannot carry either DSH route field. Runtime `running`/`idle`/`inactive` status is derived separately and never rewrites this record.

## Durable runtime placement

An external provider declares only context modes and capabilities it can enforce. Agent Teams validates the complete demand before it reserves a roster identity or sends work to that provider; one-shot subagent providers are not a fallback. Exact-call approval requires both Hook enforcement and normalized evidence, and each ask Hook carries a stable Profile-owned policy id that must correlate to the same immutable native call and approval identities.

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

`launchRequestId` makes identical creation retries idempotent, while `requestFingerprint` rejects reuse with different normalized input. The provider returns `nativeHandle` only after it durably accepts initial work; when observable, the same acknowledgement carries `initialTurnId`, which is retained as the canonical native correlation. An external member cannot become `active` before the opaque runtime identity is recorded. Provider process objects, credentials, prompts, evidence payloads, and native session state do not enter the Team log.

The exact live Lead may read a bounded normalized evidence page for an active external teammate. Agent Teams resolves the roster-owned native handle internally, so the caller cannot redirect inspection to an unrelated runtime. Only stable turn/tool/approval identities, normalized outcomes, timestamps, pending approval correlations, and provider-reported token counters may cross this seam; raw prompts, replies, proposed tool arguments/results, files, environment values, credentials, and provider payloads remain excluded. A non-empty pending set is accepted only while that exact runtime reports `running`; an unmatched ask is never inferred to be pending.

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

Provider registration belongs to the calling Fiber. Removal closes admission, cancels and settles that provider's work, removes its process-local handles, and leaves other providers untouched. A persisted external member becomes unavailable and inactive without changing its durable identity; the same provider id can later resume its exact native handle without creating a replacement.

<a id="native-member-authorization"></a>

## Native member authorization

The Team owner delivers `NativeMemberGrant` only to the current provider after durable member acceptance or verified resume. Its captured identity never comes from model arguments. Registration, handle, or exact Lead disposal and inactive native presence permanently revoke that grant; evaluations receive no production grant. The [authorization decision](../../.agents/notes/implemented/architecture/2026-09-05-native-team-member-grants.md) owns rationale, and the [package contract](../../packages/experimental/agent-team/README.md#teammates) owns query limits and cursor semantics.

Native messages, task changes and terminal results share the [atomic receipt decision](../../.agents/notes/implemented/architecture/2026-09-06-durable-native-team-operations.md). One required payload-4 message/task event records the mutation with its `TeamNativeOperationId` receipt; projection version 6 reconstructs both and its compact message index, with explicit payload-3 message and payload-2 readers. Task receipts retain validated input and a compact original acceptance. [Native task rules](../../.agents/notes/implemented/architecture/2026-09-06-native-task-operation-receipts.md) explain replay before CAS and observation-only waits.

`turns.recover` is a Host-only grant reader rather than an advertised model operation. After current-grant checks, it serializes against the Team journal, flushes the Lead Session, and returns a detached current view containing only the granted member's launch correlation, inbound delivery ids, and committed settlement outcome and intentional text. It excludes incoming message text and every sibling or other-Team fact, and it emits no Team activity. Pages use a numeric offset, default to 10 items, accept 1 to 100, and retain stable identities so adapters can de-duplicate items if concurrent appends shift later pages.

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

## Durable mailbox

The Lead Session first stores the complete queued message. A DSH target receipt is acknowledged only after its pending inbox item or recorded user message is durable; an external receipt is acknowledged after its provider returns the stable native turn identity. Either way, queued-minus-delivered is the recovery mailbox.

The exact live Lead can additionally submit a human-authored message with a caller-owned request id, explicit active recipient, literal text, and optional prior message from the same Team. The sender and Team never come from request data. `(Team, sender Session, request id)` identifies one immutable input: matching retries replay the original submission, while changed recipient, text, or reply correlation conflicts without appending a fact. A new request atomically stores its message and receipt in required `team/message/request-committed@1` before Team-owned delivery begins. Caller cancellation owns only pre-acceptance work; the returned submission is separate from the current `pending` or `delivered` stage.

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

Raw mailbox snapshots remain Host-only. Projection version 7 also retains request receipts and each message identity, queue sequence and time, and optional delivery sequence and time. Older version-6 checkpoints rebuild from their logs; old queued messages remain readable without request or reply metadata, while unsupported future event versions fail closed. The exact live Lead can read that index as bounded newest-first metadata after a Session flush. A request accepts 1 through 100 rows and defaults to 20. Optional member, direction, and delivery filters are normalized into an opaque committed cursor. That cursor fixes the Team, filters, and upper sequence bound; a continuation stays inside the same committed window even when newer messages arrive. Malformed, future, cross-Team, mismatched-query, stale-caller, forged-caller, and forged-participant inputs are rejected.

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

The metadata page never contains message content. On-demand detail must name a message exposed by its committed cursor. Intentional text is returned as literal text, images become detached media type, byte-size, and dimensions, and reasoning, tool, or custom blocks become `omitted`. Completeness reports whether anything was lost or the original content is unavailable. Delivery remains only the Host-proven mailbox stage: `pending`, `delivered`, and `unknown` do not claim that a person read the message or completed related work. These reads append no event and emit no Team activity.

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

Every message attempts Steer delivery. A human-authored reply adds only the durable original message id to the delivery prefix; it does not duplicate the original content. A running DSH target receives it at the nearest step boundary, an idle target starts a turn, and an inactive teammate cold-resumes. Its Session keeps message identity and sender attribution on both the pending inbox item and the eventual user message. An external target receives the same durable mailbox item through its provider-native handle and returns an idempotent native turn correlation before Agent Teams records delivery. Scheduling is not stored in the durable record because callers cannot select another mode.

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

## Shared task DAG

Every task event stores a complete snapshot. `revision` is the compare-and-set value and increments by one per mutation. `blockedBy` edges must name non-deleted tasks and keep the graph acyclic. `writeScopes` are normalized advisory path prefixes rather than locks.

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

`pending` is unstarted or released, `in_progress` carries an owner, `completed` satisfies blockers, and `deleted` is a retained tombstone. Views add owner name, readiness, and write-scope overlap warnings without changing the durable snapshot.

## Replay

`foldTeam()` replays one root Session into the roster, task board, queued-minus-delivered mailbox, immutable human request receipts, and compact message index that Team operations read. It selects records by `TeamId`, so events inherited by an ordinary fork retain the ancestor id and never enter the new root's state. Session event `seq` and `time` remain the ordering and timing record; Team snapshots do not duplicate them. Roster and task reads reach callers as views. Raw mailbox snapshots remain internal to delivery and recovery, while the Lead reader returns detached metadata and explicitly sanitized on-demand detail. The package [README](../../packages/experimental/agent-team/README.md) owns operation, authorization, recovery, and limit behavior.

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

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

Types: [Agent](core.md)

Source: [`packages/experimental/agent-team/src/index.ts`](../../packages/experimental/agent-team/src/index.ts)
<!-- END GENERATED cordis-surface -->
