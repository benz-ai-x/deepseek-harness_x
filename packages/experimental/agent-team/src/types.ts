/** Public Agent Teams identities, durable records, and service request values. */

import type { ReasoningEffortId } from '@deepseek-ai/dsh-llm/brand'
import type { ContentBlock } from '@deepseek-ai/dsh-llm/types'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type {
  TeamId,
  TeamMessageCursor,
  TeamMessageId,
  TeamMessageRequestId,
  TeamNativeOperationId,
  TeamTaskId,
  TeammateLaunchRequestId,
  TeammateRuntimeHandle,
  TeammateRuntimeTurnId,
  TeammateRuntimeToolCallId,
} from './brand.ts'

export type {
  TeamId,
  TeamMessageCursor,
  TeamMessageId,
  TeamMessageRequestId,
  TeamNativeOperationId,
  TeamTaskId,
  TeammateEvaluationHandle,
  TeammateEvaluationId,
  TeammateLaunchRequestId,
  TeammateRuntimeEvidenceCursor,
  TeammateRuntimeEvidenceId,
  TeammateRuntimeApprovalId,
  TeammateRuntimeHandle,
  TeammateRuntimeToolCallId,
  TeammateRuntimeTurnId,
} from './brand.ts'

/** Profile behavior a durable external teammate runtime can enforce. */
export type TeammateProfileCapability =
  | 'persona'
  | 'mission'
  | 'context'
  | 'memory'
  | 'tool-policy'
  | 'hooks'

/** Operational guarantees a durable external teammate runtime can prove. */
export type TeammateRuntimeCapability =
  /** Complete durable Team messaging, task, wait, interrupt, resume, and terminal-result participation. */
  | 'full-collaboration'
  /** The runtime can mutate its assigned workspace subject to the separately enforced sandbox and tool policy. */
  | 'workspace-write'
  | 'exact-call-approval'
  | 'sandbox'
  | 'evaluation'
  | 'evidence'
  | 'usage'

/** One enabled, bounded context or curated-memory fragment passed to a provider. */
export interface TeammateRuntimeProfileTextBlock {
  readonly id: string
  readonly title: string
  readonly content: string
}

/** Tool inheritance policy a durable provider must enforce for one launch. */
export interface TeammateRuntimeToolPolicy {
  readonly mode: 'inherit' | 'allow' | 'deny'
  readonly names: readonly string[]
}

/** Declarative hook point supported by the external teammate Profile seam. */
export type TeammateRuntimeHookPoint = 'session-start' | 'before-step' | 'before-tool' | 'after-tool'

/** One enabled declarative Profile hook passed without executable code. */
export interface TeammateRuntimeProfileHook {
  /** Stable Profile-owned policy identity; required for exact-call approval hooks. */
  readonly id?: string
  readonly point: TeammateRuntimeHookPoint
  readonly effect: 'context' | 'deny' | 'ask'
  readonly matcher?: string
  readonly text: string
}

/** Detached launch-time policy semantics a durable provider accepts immutably. */
export interface TeammateRuntimeProfileSnapshot {
  readonly persona: string
  readonly mission: string
  readonly context: readonly TeammateRuntimeProfileTextBlock[]
  readonly memory: readonly TeammateRuntimeProfileTextBlock[]
  readonly toolPolicy: TeammateRuntimeToolPolicy
  readonly hooks: readonly TeammateRuntimeProfileHook[]
}

/** Exact capability demand checked before a provider receives work. */
export interface TeammateRuntimeRequirements {
  readonly contextMode: 'fresh' | 'fork'
  readonly profileCapabilities: readonly TeammateProfileCapability[]
  readonly runtimeCapabilities: readonly TeammateRuntimeCapability[]
}

/** Team operations available through a native member's authorized channel. */
export type NativeMemberOperationName = 'members.list' | 'tasks.list' | 'tasks.get' | 'messages.send' | 'tasks.update' | 'wait'

/** Detached provider metadata safe for local catalogs and diagnostics. */
export interface TeammateRuntimeMetadata {
  readonly id: string
  readonly displayName: string
  readonly contextModes: readonly ('fresh' | 'fork')[]
  readonly profileCapabilities: readonly TeammateProfileCapability[]
  readonly runtimeCapabilities: readonly TeammateRuntimeCapability[]
  /** Team operations implemented by the provider's bounded native tool channel. */
  readonly memberOperations?: readonly NativeMemberOperationName[]
  /** Sorted provider-native evaluation inventory: at most 256 unique identifiers of at most 128 UTF-8 bytes. */
  readonly evaluationTools?: readonly string[]
}

/** Durable provider correlation retained with one external roster member. */
export interface TeamMemberExternalRuntimeSnapshot {
  readonly kind: 'external-agent'
  readonly launchRequestId: TeammateLaunchRequestId
  readonly requestFingerprint: string
  readonly requirements: TeammateRuntimeRequirements
  readonly nativeHandle?: TeammateRuntimeHandle
  readonly initialTurnId?: TeammateRuntimeTurnId
}

/** Durable teammate lifecycle. */
export type TeamMemberPhase = 'provisioning' | 'active' | 'failed'

/** Provider, model, and optional reasoning selection retained for one teammate. */
export interface TeamMemberRouteSnapshot {
  readonly provider?: string
  readonly model?: string
  readonly reasoningEffort?: ReasoningEffortId
}

/** Whole durable value written on every teammate lifecycle change. */
export interface TeamMemberSnapshot {
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

/** Current runtime-enriched roster row. */
export interface TeamMemberView {
  readonly id: SessionId
  readonly name: string
  readonly role: 'lead' | 'teammate'
  readonly status: 'running' | 'idle' | 'inactive' | 'provisioning' | 'failed'
  readonly description?: string
  readonly provider?: string
  readonly context?: 'fresh' | 'fork'
  readonly model?: string
  readonly requestedRoute?: TeamMemberRouteSnapshot
  readonly resolvedRoute?: TeamMemberRouteSnapshot
  readonly externalRuntime?: TeamMemberExternalRuntimeSnapshot
  /**
   * Exact native handle's confirmed operations in the current provider generation.
   * Omitted when unknown or detached; never restored from Team persistence.
   */
  readonly memberOperations?: readonly NativeMemberOperationName[]
  readonly diagnostics: string[]
}

/** Durable task lifecycle. */
export type TeamTaskStatus = 'pending' | 'in_progress' | 'completed' | 'deleted'

/** Whole durable task snapshot; every mutation increments {@link revision}. */
export interface TeamTaskSnapshot {
  readonly id: TeamTaskId
  readonly revision: number
  readonly subject: string
  readonly description: string
  readonly status: TeamTaskStatus
  readonly ownerId?: SessionId
  readonly blockedBy: TeamTaskId[]
  readonly writeScopes: string[]
}

/** Runtime-enriched task view returned to tools and hosts. */
export interface TeamTaskView {
  readonly id: TeamTaskId
  readonly revision: number
  readonly subject: string
  readonly description: string
  readonly status: TeamTaskStatus
  readonly blockedBy: TeamTaskId[]
  readonly writeScopes: string[]
  readonly ownerName?: string
  readonly ready: boolean
  readonly writeScopeWarnings: string[]
}

/** Point-in-time roster and task-board projection returned to browser clients. */
export interface TeamView {
  readonly members: TeamMemberView[]
  readonly tasks: TeamTaskView[]
}

/** One peer message retained until its target Session records it. */
export interface TeamMessageSnapshot {
  readonly id: TeamMessageId
  readonly senderId: SessionId
  readonly senderName: string
  readonly targetId: SessionId
  readonly content: ContentBlock[]
}

/** Direction of a persisted message relative to the selected Team member. */
export type TeamMessageDirection = 'sent' | 'received'

/** Host-proven delivery stage; unknown is reserved for clients that cannot obtain a current fact. */
export type TeamMessageDelivery =
  | { readonly stage: 'pending' }
  | { readonly stage: 'delivered'; readonly deliveredAt: number }
  | { readonly stage: 'unknown' }

/** Detached Team participant identity shown in a message result. */
export interface TeamMessageParticipant {
  readonly id: SessionId
  readonly name: string
}

/** Metadata-only row for one persisted Team message. */
export interface TeamMessageSummary {
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

/** Filters applied to one committed Team-message window. */
export interface TeamMessageFilters {
  /** Retained Team participant selected by durable Session identity. */
  readonly memberId?: SessionId
  /** Relative to memberId; omitted memberId with a direction is invalid. */
  readonly direction?: TeamMessageDirection
  readonly delivery?: TeamMessageDelivery['stage']
}

/** Bounded newest-first query for persisted Team-message metadata. */
export interface ListTeamMessagesRequest {
  readonly filters?: TeamMessageFilters
  readonly cursor?: TeamMessageCursor
  /** Page size from 1 through 100; defaults to 20. */
  readonly limit?: number
}

/** One complete committed metadata page and its stable continuation identities. */
export interface TeamMessagePage {
  readonly items: TeamMessageSummary[]
  readonly committedCursor: TeamMessageCursor
  readonly nextCursor?: TeamMessageCursor
  readonly complete: true
}

/** Browser-safe intentional content retained from one message block. */
export type TeamMessageContentPart =
  | { readonly type: 'text'; readonly text: string }
  | {
    readonly type: 'image'
    readonly mediaType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'
    readonly bytes: number
    readonly width: number
    readonly height: number
  }
  | { readonly type: 'omitted' }

/** Sanitized content result with explicit loss reporting. */
export interface TeamMessageContent {
  readonly completeness: 'complete' | 'partial' | 'unavailable'
  readonly omittedCount: number
  readonly parts: TeamMessageContentPart[]
}

/** On-demand detail request bound to the committed list window that exposed it. */
export interface GetTeamMessageRequest {
  readonly messageId: TeamMessageId
  readonly committedCursor: TeamMessageCursor
}

/** Metadata plus browser-safe intentional content for one persisted Team message. */
export interface TeamMessageDetail extends TeamMessageSummary {
  readonly content: TeamMessageContent
}

/** Trusted provider correlation supplied separately from model tool arguments. */
export type NativeMemberOperationSource =
  | { readonly kind: 'tool'; readonly turnId: TeammateRuntimeTurnId; readonly callId: TeammateRuntimeToolCallId }
  | { readonly kind: 'settlement'; readonly turnId: TeammateRuntimeTurnId }

/** Terminal outcome reported by the provider for one accepted native work turn. */
export type NativeMemberTurnOutcome = 'completed' | 'failed' | 'interrupted'

/** Replayable durable acceptance; queued does not report delivery or work completion. */
export type NativeMemberMessageResult =
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

/** Provider-correlated acceptance retained in the authoritative Team projection. */
export interface TeamNativeOperationReceiptBase {
  readonly id: TeamNativeOperationId
  readonly memberId: SessionId
  readonly provider: string
  readonly nativeHandle: TeammateRuntimeHandle
  readonly source: NativeMemberOperationSource
  readonly inputFingerprint: string
}

/** Original acceptance of a native mailbox operation. */
export interface TeamNativeMessageReceipt extends TeamNativeOperationReceiptBase {
  readonly result: NativeMemberMessageResult
}

/** Validated task transition selected by one native member call. */
export interface NativeMemberTaskRequest extends UpdateTeamTaskRequest {
  readonly operation: 'tasks.update'
}

/** Compact original acceptance; full task details remain available through task reads. */
export interface NativeMemberTaskResult {
  readonly ok: true
  readonly operation: 'tasks.update'
  readonly value: { readonly task: Pick<TeamTaskView, 'id' | 'revision' | 'status' | 'ownerName' | 'ready'> }
}

/** Task input and result retained together for replay validation. */
export interface TeamNativeTaskReceipt extends TeamNativeOperationReceiptBase {
  readonly request: NativeMemberTaskRequest
  readonly result: NativeMemberTaskResult
}

/** Native acceptance retained in the authoritative Team projection. */
export type TeamNativeOperationReceipt = TeamNativeMessageReceipt | TeamNativeTaskReceipt

/** Source retained by the target Session for durable mailbox de-duplication. */
export interface TeamMessageSource {
  readonly kind: 'team-message'
  readonly teamId: TeamId
  readonly messageId: TeamMessageId
  readonly senderId: SessionId
  readonly senderName: string
}

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'team-message': TeamMessageSource
  }
}

/** Team-service deployment limits. */
export interface Config {
  /** Maximum immutable teammate names retained by one Team. */
  readonly maxMembers?: number
  /** Maximum non-deleted tasks retained by one Team. */
  readonly maxTasks?: number
  /** Maximum queued-minus-delivered messages for one target member. */
  readonly maxPendingMessagesPerMember?: number
  /** Maximum UTF-8 bytes in one complete sender-framed delivery. */
  readonly maxMessageBytes?: number
  /** Maximum UTF-8 bytes in one canonical external teammate Profile snapshot. */
  readonly maxProfileBytes?: number
  /** Maximum normalized evidence items in one external-runtime page. */
  readonly maxEvidenceItems?: number
  /** Maximum UTF-8 bytes in one complete normalized external-runtime evidence page. */
  readonly maxEvidenceBytes?: number
  /** Grace period before Team-owned runtime cleanup receives an abort signal. */
  readonly disposalTimeoutMs?: number
}

/** Result after one teammate reaches a durable active or failed edge. */
export interface SpawnTeammateResult {
  readonly member: TeamMemberView
}

/** Input for one durable peer message. */
export interface SendTeamMessageRequest {
  readonly target: string
  readonly content: ContentBlock[]
  readonly signal: AbortSignal
}

/** Result after a peer message enters the durable mailbox. */
export interface SendTeamMessageResult {
  readonly messageId: TeamMessageId
  readonly status: 'accepted' | 'queued'
}

/** Browser-authored Team message input; Host authority supplies the sender. */
export interface SubmitTeamMessageRequest {
  readonly requestId: TeamMessageRequestId
  readonly recipientId: SessionId
  readonly text: string
  readonly replyTo?: TeamMessageId
}

/** Durable acceptance returned for every replay of one matching request. */
export interface TeamMessageSubmission {
  readonly requestId: TeamMessageRequestId
  readonly messageId: TeamMessageId
  readonly status: 'accepted'
}

/** Request correlation retained atomically with one human-authored message. */
export interface TeamMessageRequestReceipt {
  readonly requestId: TeamMessageRequestId
  readonly senderId: SessionId
  readonly inputFingerprint: string
  readonly replyTo?: TeamMessageId
  readonly result: TeamMessageSubmission
}

/** Accepted submission and current Host-proven delivery stage. */
export interface SubmitTeamMessageValue {
  readonly submission: TeamMessageSubmission
  readonly delivery: TeamMessageDelivery
}

/** Browser message mutation result with request conflicts kept distinct from other Team rejections. */
export type SubmitTeamMessageResult =
  | { readonly ok: true; readonly value: SubmitTeamMessageValue }
  | {
    readonly ok: false
    readonly error: {
      readonly code: 'team-message-request-conflict' | 'team-rejected'
      readonly message: string
    }
  }

/** Input for creating one shared task. */
export interface CreateTeamTaskRequest {
  readonly subject: string
  readonly description: string
  readonly blockedBy?: readonly TeamTaskId[]
  readonly writeScopes?: readonly string[]
}

/** Supported task mutation actions. */
export type TeamTaskAction =
  | 'claim'
  | 'release'
  | 'edit'
  | 'set_dependencies'
  | 'complete'
  | 'reopen'
  | 'reassign'
  | 'delete'

/** Compare-and-set mutation of one shared task. */
export interface UpdateTeamTaskRequest {
  readonly taskId: TeamTaskId
  readonly expectedRevision: number
  readonly action: TeamTaskAction
  readonly subject?: string
  readonly description?: string
  readonly blockedBy?: readonly TeamTaskId[]
  readonly writeScopes?: readonly string[]
  readonly owner?: string
}

/** Browser task mutation result with stale revisions kept distinct from other Team rejections. */
export type TeamTaskMutationResult =
  | { readonly ok: true; readonly value: TeamTaskView }
  | {
    readonly ok: false
    readonly error: {
      readonly code: 'team-task-conflict' | 'team-rejected'
      readonly message: string
    }
  }

/** Result of waiting for Team activity. */
export interface TeamWaitResult {
  readonly timedOut: boolean
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** Whole teammate lifecycle value, stored only in the Team Lead Session. */
    'team/member': { version: 2; teamId: TeamId; member: TeamMemberSnapshot }
    /** Whole shared-task value, stored only in the Team Lead Session. */
    'team/task': { version: 2; teamId: TeamId; task: TeamTaskSnapshot }
    /** Durable mailbox enqueue, stored before delivery is attempted. */
    'team/message/queued': { version: 2; teamId: TeamId; message: TeamMessageSnapshot }
    /** Atomic human request acceptance, reply correlation, and mailbox enqueue. */
    'team/message/request-committed': {
      version: 1
      teamId: TeamId
      receipt: TeamMessageRequestReceipt
      message: TeamMessageSnapshot
    }
    /** Atomic native mutation and original receipt, required for recovery. */
    'team/native-operation/committed':
      | { version: 3; teamId: TeamId; receipt: TeamNativeMessageReceipt; message: TeamMessageSnapshot }
      | { version: 4; kind: 'message'; teamId: TeamId; receipt: TeamNativeMessageReceipt; message: TeamMessageSnapshot }
      | { version: 4; kind: 'task'; teamId: TeamId; receipt: TeamNativeTaskReceipt; task: TeamTaskSnapshot }
    /** Durable acknowledgement that the target Session recorded the message. */
    'team/message/delivered': {
      version: 2
      teamId: TeamId
      messageId: TeamMessageId
      targetId: SessionId
      /** Provider-native turn accepted for an external teammate delivery. */
      nativeTurnId?: TeammateRuntimeTurnId
    }
  }
}
