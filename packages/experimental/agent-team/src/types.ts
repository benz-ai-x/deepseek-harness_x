/** Public Agent Teams identities, durable records, and service request values. */

import type { ReasoningEffortId } from '@deepseek-ai/dsh-llm/brand'
import type { ContentBlock } from '@deepseek-ai/dsh-llm/types'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type {
  TeamId,
  TeamMessageId,
  TeamTaskId,
  TeammateLaunchRequestId,
  TeammateRuntimeHandle,
  TeammateRuntimeTurnId,
} from './brand.ts'

export type {
  TeamId,
  TeamMessageId,
  TeamTaskId,
  TeammateEvaluationHandle,
  TeammateEvaluationId,
  TeammateLaunchRequestId,
  TeammateRuntimeEvidenceCursor,
  TeammateRuntimeEvidenceId,
  TeammateRuntimeHandle,
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
  readonly point: TeammateRuntimeHookPoint
  readonly effect: 'context' | 'deny'
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

/** Detached provider metadata safe for local catalogs and diagnostics. */
export interface TeammateRuntimeMetadata {
  readonly id: string
  readonly displayName: string
  readonly contextModes: readonly ('fresh' | 'fork')[]
  readonly profileCapabilities: readonly TeammateProfileCapability[]
  readonly runtimeCapabilities: readonly TeammateRuntimeCapability[]
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
