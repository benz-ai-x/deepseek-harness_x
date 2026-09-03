/** Host-only Agent Teams service request values. */

import type { AgentOptions } from '@deepseek-ai/dsh-agent'
import type { ContentBlock, TokenUsage } from '@deepseek-ai/dsh-llm/types'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type {
  TeamMessageId,
  TeammateEvaluationId,
  TeammateEvaluationHandle,
  TeammateLaunchRequestId,
  TeammateRuntimeHandle,
  TeammateRuntimeEvidenceCursor,
  TeammateRuntimeEvidenceId,
  TeammateRuntimeMetadata,
  TeammateRuntimeProfileSnapshot,
  TeammateRuntimeRequirements,
  TeammateRuntimeTurnId,
} from './types.ts'

/** Fields shared by DSH-continuable and durable external teammate creation. */
interface SpawnTeammateRequestBase {
  readonly name: string
  readonly description: string
  readonly prompt: ContentBlock[]
  readonly context: 'fresh' | 'fork'
  /** Caller cancellation until the initial work is durable; Team lifecycle cancellation afterward. */
  readonly signal: AbortSignal
}

/** Request to provision one DSH-continuable teammate under the caller's Team. */
export interface SpawnContinuableTeammateRequest extends SpawnTeammateRequestBase {
  readonly provider: string
  /** Normalized per-child options passed unchanged to the continuable manager. */
  readonly agentOptions?: AgentOptions
  readonly runtime?: undefined
}

/** Durable external placement selected for one teammate launch. */
export interface ExternalTeammateRuntimeLaunch {
  readonly kind: 'external-agent'
  readonly provider: string
  readonly launchRequestId: TeammateLaunchRequestId
  readonly profile: TeammateRuntimeProfileSnapshot
  readonly requirements: TeammateRuntimeRequirements
}

/** Request to provision one provider-native durable teammate. */
export interface SpawnExternalTeammateRequest extends SpawnTeammateRequestBase {
  readonly runtime: ExternalTeammateRuntimeLaunch
  readonly provider?: never
  readonly agentOptions?: never
}

/** Typed teammate-runtime boundary; one branch is never substituted for the other. */
export type SpawnTeammateRequest = SpawnContinuableTeammateRequest | SpawnExternalTeammateRequest

/** Provider call that durably accepts the initial work for one reserved Team member. */
export interface TeammateRuntimeCreateRequest {
  readonly launchRequestId: TeammateLaunchRequestId
  readonly memberId: SessionId
  readonly memberName: string
  readonly description: string
  readonly initialWork: readonly ContentBlock[]
  readonly profile: TeammateRuntimeProfileSnapshot
  readonly requirements: TeammateRuntimeRequirements
  readonly signal: AbortSignal
}

/** Stable native identity returned only after initial work is durably accepted. */
export interface TeammateRuntimeCreateResult {
  readonly nativeHandle: TeammateRuntimeHandle
  /** Stable provider-native identity of the accepted initial-work turn, when observable. */
  readonly turnId?: TeammateRuntimeTurnId
  readonly presence: 'running' | 'idle'
}

/** Provider request to recover one previously accepted logical employee. */
export interface TeammateRuntimeResumeRequest {
  readonly launchRequestId: TeammateLaunchRequestId
  readonly memberId: SessionId
  readonly nativeHandle?: TeammateRuntimeHandle
  readonly requirements: TeammateRuntimeRequirements
  readonly signal: AbortSignal
}

/** One durable Team mailbox item routed to an exact provider-native handle. */
export interface TeammateRuntimeDeliverRequest {
  readonly nativeHandle: TeammateRuntimeHandle
  readonly deliveryId: TeamMessageId
  readonly senderId: SessionId
  readonly senderName: string
  readonly content: readonly ContentBlock[]
  readonly signal: AbortSignal
}

/** Stable native turn correlation returned after durable delivery acceptance. */
export interface TeammateRuntimeDeliverResult {
  readonly turnId: TeammateRuntimeTurnId
  readonly presence: 'running' | 'idle'
}

/** Provider-originated presence edge for one exact attached native runtime. */
export interface TeammateRuntimePresenceEvent {
  readonly nativeHandle: TeammateRuntimeHandle
  readonly presence: 'running' | 'idle' | 'inactive'
}

/** Exact-handle interrupt request; provider lookup never uses display identity. */
export interface TeammateRuntimeInterruptRequest {
  readonly nativeHandle: TeammateRuntimeHandle
}

/** Runtime state sampled immediately before an interrupt is admitted. */
export interface TeammateRuntimeInterruptResult {
  readonly previousStatus: 'running' | 'idle' | 'inactive'
}

/** One bounded normalized native fact; raw prompts and provider payloads are excluded. */
export interface TeammateRuntimeEvidenceItem {
  readonly id: TeammateRuntimeEvidenceId
  readonly kind: 'turn' | 'tool' | 'usage' | 'diagnostic'
  readonly timestamp: number
  readonly turnId?: TeammateRuntimeTurnId
  readonly name?: string
  readonly outcome?: 'completed' | 'cancelled' | 'blocked' | 'failed' | 'interrupted' | 'unknown'
  /** Latest provider-reported cumulative counters for this turn; repeated rows are snapshots, not deltas. */
  readonly usage?: Readonly<TokenUsage>
}

/** Request for a bounded evidence window owned by one native runtime. */
export interface TeammateRuntimeEvidenceRequest {
  readonly nativeHandle: TeammateRuntimeHandle
  readonly cursor?: TeammateRuntimeEvidenceCursor
  readonly limit: number
  readonly signal: AbortSignal
}

/** Detached evidence page correlated to its exact native runtime. */
export interface TeammateRuntimeEvidenceResult {
  readonly nativeHandle: TeammateRuntimeHandle
  readonly items: readonly TeammateRuntimeEvidenceItem[]
  readonly nextCursor?: TeammateRuntimeEvidenceCursor
  readonly complete: boolean
}

/** Request for a fresh provider-native evaluation runtime. */
export interface TeammateEvaluationCreateRequest {
  readonly evaluationId: TeammateEvaluationId
  readonly profile: TeammateRuntimeProfileSnapshot
  readonly requirements: TeammateRuntimeRequirements
  readonly input: readonly ContentBlock[]
  readonly signal: AbortSignal
}

/** Identity of one provider-owned isolated evaluation runtime. */
export interface TeammateEvaluationCreateResult {
  readonly evaluationHandle: TeammateEvaluationHandle
}

/** Exact provider-owned resource released by one dispose operation. */
export type TeammateRuntimeDisposeRequest =
  | {
    readonly kind: 'runtime'
    readonly nativeHandle: TeammateRuntimeHandle
    readonly signal: AbortSignal
  }
  | {
    readonly kind: 'evaluation'
    readonly evaluationHandle: TeammateEvaluationHandle
    readonly signal: AbortSignal
  }

/** Host-only operation surface for durable external teammate runtimes. */
export interface TeammateRuntimeRegistry {
  snapshot(): readonly TeammateRuntimeMetadata[]
  available(providerId: string): boolean
  validate(providerId: string, requirements: TeammateRuntimeRequirements): TeammateRuntimeRequirements
  validateLaunch(
    providerId: string,
    requirements: TeammateRuntimeRequirements,
    profile: TeammateRuntimeProfileSnapshot,
  ): { readonly requirements: TeammateRuntimeRequirements; readonly profile: TeammateRuntimeProfileSnapshot }
  runtimePresence(providerId: string, nativeHandle: TeammateRuntimeHandle): 'running' | 'idle' | 'inactive'
  create(providerId: string, request: TeammateRuntimeCreateRequest): Promise<TeammateRuntimeCreateResult>
  resume(
    providerId: string,
    request: TeammateRuntimeResumeRequest,
  ): Promise<TeammateRuntimeCreateResult | undefined>
  deliver(providerId: string, request: TeammateRuntimeDeliverRequest): Promise<TeammateRuntimeDeliverResult>
  interrupt(providerId: string, request: TeammateRuntimeInterruptRequest): TeammateRuntimeInterruptResult
  evidence(providerId: string, request: TeammateRuntimeEvidenceRequest): Promise<TeammateRuntimeEvidenceResult>
  createEvaluationHandle(
    providerId: string,
    request: TeammateEvaluationCreateRequest,
  ): Promise<TeammateEvaluationCreateResult>
  dispose(providerId: string, request: TeammateRuntimeDisposeRequest): Promise<void>
}

/** Host-only durable external runtime provider contract. */
export interface TeammateRuntimeProvider extends TeammateRuntimeMetadata {
  create(request: TeammateRuntimeCreateRequest): Promise<TeammateRuntimeCreateResult>
  resume(request: TeammateRuntimeResumeRequest): Promise<TeammateRuntimeCreateResult | undefined>
  deliver(request: TeammateRuntimeDeliverRequest): Promise<TeammateRuntimeDeliverResult>
  interrupt(request: TeammateRuntimeInterruptRequest): TeammateRuntimeInterruptResult
  /** Required when an accepted operation can remain running after its result settles. */
  onPresenceChanged?(listener: (event: TeammateRuntimePresenceEvent) => void): () => void
  evidence?(request: TeammateRuntimeEvidenceRequest): Promise<TeammateRuntimeEvidenceResult>
  createEvaluationHandle?(request: TeammateEvaluationCreateRequest): Promise<TeammateEvaluationCreateResult>
  dispose(request: TeammateRuntimeDisposeRequest): Promise<void>
}

/** Effect-owned provider registration with atomic same-id replacement. */
export interface TeammateRuntimeRegistration {
  (): Promise<void>
  /** Whether this logical registration's current generation still accepts operations. */
  available(): boolean
  /** Canonical detached metadata for this logical registration's current generation. */
  metadata(): TeammateRuntimeMetadata
  /** Observe availability edges, including fail-closed provider quarantine. */
  onAvailabilityChanged(listener: () => void): () => void
  replace(provider: TeammateRuntimeProvider): Promise<void>
}
