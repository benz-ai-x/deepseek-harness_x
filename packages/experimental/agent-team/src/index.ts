/** Agent Teams service façade over roster, mailbox, task, and runtime lifecycle owners. */

import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-session-persistence'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { TeamActivity } from './activity.ts'
import { TeamId } from './brand.ts'
import { errorMessage, TeamError } from './error.ts'
import { TeamJournal } from './journal.ts'
import { TeamRuntimeLifecycle } from './lifecycle.ts'
import { TeamMailbox } from './mailbox.ts'
import { teamProjectionDefinition } from './projection.ts'
import { resolveActiveMember, TeamRoster } from './roster.ts'
import type { TeamMembership } from './roster.ts'
import { TeamTaskBoard } from './task-board.ts'
import { createNativeMemberGrant } from './native-member-operations.ts'
import { TeammateRuntimeRegistryHost } from './teammate-runtime.ts'
import type {
  Config,
  CreateTeamTaskRequest,
  SendTeamMessageRequest,
  SendTeamMessageResult,
  SpawnTeammateResult,
  TeamMemberView,
  TeamMemberSnapshot,
  TeamTaskId,
  TeamTaskMutationResult,
  TeamTaskView,
  TeamView,
  TeamWaitResult,
  UpdateTeamTaskRequest,
} from './types.ts'
import type {
  SpawnTeammateRequest,
  TeammateEvaluationCreateRequest,
  TeammateEvaluationCreateResult,
  TeammateRuntimeEvidenceRequest,
  TeammateRuntimeEvidenceResult,
  TeammateRuntimeProvider,
  TeammateRuntimeRegistration,
} from './service-types.ts'

export type * from './types.ts'
export type {
  NativeMemberGrant,
  NativeMemberOperationResult,
  TeammateRuntimeMemberOperationsRequest,
  ExternalTeammateRuntimeLaunch,
  SpawnContinuableTeammateRequest,
  SpawnExternalTeammateRequest,
  SpawnTeammateRequest,
  TeammateEvaluationCreateRequest,
  TeammateEvaluationCreateResult,
  TeammateEvaluationEnvironment,
  TeammateEvaluationFixture,
  TeammateEvaluationTerminal,
  TeammateRuntimeCreateRequest,
  TeammateRuntimeCreateResult,
  TeammateRuntimeDeliverRequest,
  TeammateRuntimeDeliverResult,
  TeammateRuntimeDisposeRequest,
  TeammateRuntimeEvidenceItem,
  TeammateRuntimeEvidenceRequest,
  TeammateRuntimeEvidenceResult,
  TeammateRuntimeInterruptRequest,
  TeammateRuntimeInterruptResult,
  TeammateRuntimePendingApproval,
  TeammateRuntimePresenceEvent,
  TeammateRuntimeProvider,
  TeammateRuntimeRegistration,
  TeammateRuntimeResumeRequest,
} from './service-types.ts'
export type { TeamMembership } from './roster.ts'
export {
  TeamId,
  TeamMessageId,
  TeamNativeOperationId,
  TeamTaskId,
  TeammateEvaluationId,
  TeammateEvaluationHandle,
  TeammateLaunchRequestId,
  TeammateRuntimeHandle,
  TeammateRuntimeEvidenceCursor,
  TeammateRuntimeEvidenceId,
  TeammateRuntimeApprovalId,
  TeammateRuntimeTurnId,
  TeammateRuntimeToolCallId,
} from './brand.ts'
export { TeamError } from './error.ts'
export { TeammateRuntimeError } from './teammate-runtime.ts'
export { mountTeammateRuntimeProvider } from './runtime-provider-mount.ts'
export type {
  RuntimeCatalogOwnerService,
  RuntimeCatalogRegistration,
} from './runtime-provider-mount.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    agentTeams: TeamService
  }
}

const DEFAULT_MAX_MEMBERS = 8
const DEFAULT_MAX_TASKS = 256
const DEFAULT_MAX_PENDING_MESSAGES = 64
const DEFAULT_MAX_MESSAGE_BYTES = 65_536
const DEFAULT_MAX_PROFILE_BYTES = 131_072
const DEFAULT_MAX_EVIDENCE_ITEMS = 1_000
const DEFAULT_MAX_EVIDENCE_BYTES = 65_536
const DEFAULT_DISPOSAL_TIMEOUT_MS = 5_000

/** Validate one positive safe-integer deployment limit. */
function positiveLimit(name: string, value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TeamError(`${name} must be a positive safe integer`, 'TEAM_INVALID_CONFIG')
  }
  return value
}

/** Agent Teams service backed by the exact live Lead Session log. */
export class TeamService extends TypertRemoteService {
  static inject = ['agents', 'sessions', 'sessionPersistence', 'sessionProjections', 'subagents']

  static Config: z<Config> = z.object({
    maxMembers: z.number().step(1).min(1).default(DEFAULT_MAX_MEMBERS),
    maxTasks: z.number().step(1).min(1).default(DEFAULT_MAX_TASKS),
    maxPendingMessagesPerMember: z.number().step(1).min(1).default(DEFAULT_MAX_PENDING_MESSAGES),
    maxMessageBytes: z.number().step(1).min(1).default(DEFAULT_MAX_MESSAGE_BYTES),
    maxProfileBytes: z.number().step(1).min(1).default(DEFAULT_MAX_PROFILE_BYTES),
    maxEvidenceItems: z.number().step(1).min(1).default(DEFAULT_MAX_EVIDENCE_ITEMS),
    maxEvidenceBytes: z.number().step(1).min(1).default(DEFAULT_MAX_EVIDENCE_BYTES),
    disposalTimeoutMs: z.number().step(1).min(1).default(DEFAULT_DISPOSAL_TIMEOUT_MS),
  })

  /** Validated deployment limits used by every Team operation. */
  private readonly config: Required<Config>

  private readonly activity: TeamActivity
  private readonly lifecycle: TeamRuntimeLifecycle
  private readonly journal: TeamJournal
  private readonly roster: TeamRoster
  private readonly mailbox: TeamMailbox
  private readonly tasks: TeamTaskBoard
  private readonly inFlightRecoveries = new Set<Promise<void>>()
  /** Host-only durable provider registry used by roster and mailbox routing. */
  private readonly teammateRuntimeRegistry: TeammateRuntimeRegistryHost

  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'agentTeams')
    this.config = {
      maxMembers: positiveLimit('maxMembers', config.maxMembers ?? DEFAULT_MAX_MEMBERS),
      maxTasks: positiveLimit('maxTasks', config.maxTasks ?? DEFAULT_MAX_TASKS),
      maxPendingMessagesPerMember: positiveLimit(
        'maxPendingMessagesPerMember',
        config.maxPendingMessagesPerMember ?? DEFAULT_MAX_PENDING_MESSAGES,
      ),
      maxMessageBytes: positiveLimit('maxMessageBytes', config.maxMessageBytes ?? DEFAULT_MAX_MESSAGE_BYTES),
      maxProfileBytes: positiveLimit('maxProfileBytes', config.maxProfileBytes ?? DEFAULT_MAX_PROFILE_BYTES),
      maxEvidenceItems: positiveLimit(
        'maxEvidenceItems',
        config.maxEvidenceItems ?? DEFAULT_MAX_EVIDENCE_ITEMS,
      ),
      maxEvidenceBytes: positiveLimit(
        'maxEvidenceBytes',
        config.maxEvidenceBytes ?? DEFAULT_MAX_EVIDENCE_BYTES,
      ),
      disposalTimeoutMs: positiveLimit(
        'disposalTimeoutMs',
        config.disposalTimeoutMs ?? DEFAULT_DISPOSAL_TIMEOUT_MS,
      ),
    }

    this.activity = new TeamActivity()
    this.lifecycle = new TeamRuntimeLifecycle(this.config.disposalTimeoutMs)
    this.journal = new TeamJournal(ctx, (root) => { this.activity.notify(TeamId(root.id)) })
    this.teammateRuntimeRegistry = new TeammateRuntimeRegistryHost((providerId) => {
      this.notifyExternalRuntimeTeams(providerId)
      for (const agent of ctx.agents.list()) this.scheduleRecovery(agent)
    }, (providerId) => {
      this.notifyExternalRuntimeTeams(providerId)
    }, (error) => {
      ctx.logger.error(`Agent Teams asynchronous teammate-runtime failure: ${errorMessage(error)}`)
    }, this.lifecycle, this.config.maxProfileBytes, this.config.maxEvidenceItems, this.config.maxEvidenceBytes)
    this.roster = new TeamRoster(
      ctx,
      this.journal,
      this.lifecycle,
      this.teammateRuntimeRegistry,
      this.config.maxMembers,
      (root, member) => { this.bindNativeMember(root, member) },
    )
    this.mailbox = new TeamMailbox(
      ctx,
      this.journal,
      this.roster,
      this.lifecycle,
      this.teammateRuntimeRegistry,
      this.config.maxPendingMessagesPerMember,
      this.config.maxMessageBytes,
    )
    this.tasks = new TeamTaskBoard(this.journal, this.config.maxTasks)

    ctx.on('session/event', (session, event) => { this.mailbox.observeSessionEvent(session, event) })
    ctx.on('agent/session-start', ({ agent }) => { this.scheduleRecovery(agent) })
    ctx.on('agent/disposed', ({ agent }) => { this.teammateRuntimeRegistry.revokeMemberOwner(agent) })
    ctx.on('agent/status', ({ agent }) => {
      const membership = this.roster.tryMembership(agent)
      if (membership !== undefined) this.activity.notify(membership.id)
    })
    ctx.effect(() => {
      const disposeProjection = ctx.root.sessionProjections.register(teamProjectionDefinition)
      return async () => {
        try {
          await this.disposeRuntime()
        } finally {
          disposeProjection()
        }
      }
    }, 'agentTeams.runtimeLifecycle()')
    for (const agent of ctx.agents.list()) this.scheduleRecovery(agent)
  }

  /**
   * Resolve one exact live Agent's Team role.
   * @param agent - exact live Agent used as the authority credential.
   * @returns its root, Team identity, role, and model-facing name.
   */
  membership(agent: Agent): TeamMembership {
    return this.roster.membership(agent)
  }

  private bindNativeMember(root: Agent, member: TeamMemberSnapshot): void {
    const nativeHandle = member.externalRuntime?.nativeHandle
    /* v8 ignore if -- all callers pass the active native snapshot after durable acceptance or verified resume. */
    if (nativeHandle === undefined || member.phase !== 'active') return
    this.teammateRuntimeRegistry.bindMemberOperations(member.provider, nativeHandle, root, (signal, current) => {
      const identity = { teamId: TeamId(root.id), memberId: member.id, provider: member.provider, nativeHandle }
      return createNativeMemberGrant(identity, signal, () => {
        const membership = this.roster.membership(root)
        const actual = this.journal.state(root).members.find(candidate => candidate.id === member.id)
        /* v8 ignore if -- accepted identity is immutable; every ownership cutoff aborts the grant before this fallback. */
        if (!current() || membership.role !== 'lead' || actual?.phase !== 'active'
          || actual.provider !== member.provider || actual.externalRuntime?.nativeHandle !== nativeHandle) {
          throw new TeamError('native member authorization expired', 'TEAM_NATIVE_GRANT_REVOKED')
        }
        return { root, id: identity.teamId, role: 'teammate', name: actual.name }
      }, membership => this.roster.list(membership), this.tasks, this.mailbox)
    })
  }

  /**
   * List the runtime-enriched roster visible to one Team member.
   * @param agent - exact live Team member.
   * @returns Lead and teammate rows in creation order.
   */
  listMembers(agent: Agent): TeamMemberView[] {
    return this.roster.list(this.roster.membership(agent))
  }

  /**
   * Create one named durable teammate through its selected typed runtime.
   * @param caller - exact live Lead Agent.
   * @param request - DSH-continuable or external runtime placement and caller cancellation through initial-work durability.
   * @returns the active roster row with its resolved DSH route or provider-native handle.
   */
  async spawnTeammate(caller: Agent, request: SpawnTeammateRequest): Promise<SpawnTeammateResult> {
    return await this.roster.spawn(caller, request)
  }

  /**
   * Register one complete durable external teammate provider on the calling Fiber.
   * @param provider - provider operations and detached capability metadata.
   * @returns an async disposer with atomic same-id replacement.
   */
  registerTeammateRuntimeProvider(provider: TeammateRuntimeProvider): TeammateRuntimeRegistration {
    return this.teammateRuntimeRegistry.register(this.ctx, provider)
  }

  /**
   * Queue one durable peer message, then attempt immediate delivery.
   * @param caller - exact live sending Team member.
   * @param request - target name, content, and pre-queue cancellation.
   * @returns durable message identity and immediate-delivery observation.
   */
  async sendMessage(caller: Agent, request: SendTeamMessageRequest): Promise<SendTeamMessageResult> {
    return await this.mailbox.send(caller, request)
  }

  /**
   * Read bounded normalized evidence for one exact external teammate.
   * @param caller - exact live Lead Agent used as the authority credential.
   * @param targetName - active provider-native teammate name.
   * @param request - bounded evidence cursor, limit, and caller cancellation.
   * @returns provider-normalized facts correlated to the roster-owned native handle.
   */
  async readTeammateRuntimeEvidence(
    caller: Agent,
    targetName: string,
    request: Omit<TeammateRuntimeEvidenceRequest, 'nativeHandle'>,
  ): Promise<TeammateRuntimeEvidenceResult> {
    const membership = this.roster.membership(caller)
    if (membership.role !== 'lead') {
      throw new TeamError('only the Team Lead can read teammate runtime evidence', 'TEAM_LEAD_REQUIRED')
    }
    const target = resolveActiveMember(membership.root, this.journal.state(membership.root), targetName)
    const member = this.journal.state(membership.root).members.find(candidate => candidate.id === target.id)
    const nativeHandle = member?.externalRuntime?.nativeHandle
    if (member === undefined || nativeHandle === undefined) {
      throw new TeamError(`external teammate "${target.name}" not found`, 'TEAM_MEMBER_NOT_FOUND')
    }
    return await this.teammateRuntimeRegistry.evidence(member.provider, {
      ...request,
      nativeHandle,
    })
  }

  /**
   * Run one isolated provider-native evaluation for an exact live Team Lead.
   * @param caller - exact live Team Lead that owns the operation.
   * @param providerId - registered provider selected for the isolated run.
   * @param request - fresh context, detached Profile, input, confinement, and cancellation.
   * @param commit - optional durable-result callback invoked while the exact handle is still attached.
   * @returns the completed detached result, only after exact-handle release in finally.
   */
  async runTeammateEvaluation(
    caller: Agent,
    providerId: string,
    request: TeammateEvaluationCreateRequest,
    commit?: (result: TeammateEvaluationCreateResult) => void | Promise<void>,
  ): Promise<TeammateEvaluationCreateResult> {
    const membership = this.roster.membership(caller)
    if (membership.role !== 'lead') {
      throw new TeamError('only the Team Lead can run teammate evaluations', 'TEAM_LEAD_REQUIRED')
    }
    let result: TeammateEvaluationCreateResult | undefined
    try {
      result = await this.teammateRuntimeRegistry.createEvaluationHandle(providerId, request)
      await commit?.(result)
      return result
    } finally {
      const completed = result
      if (completed !== undefined) {
        await this.lifecycle.settleWithAbortDeadline(async (signal) => {
          await this.teammateRuntimeRegistry.dispose(providerId, {
            kind: 'evaluation',
            evaluationHandle: completed.evaluationHandle,
            signal,
          })
        })
      }
    }
  }

  /**
   * Create one unowned pending task in the Team Lead log.
   * @param caller - exact live Team member creating the task.
   * @param request - task text, blockers, and advisory write scopes.
   * @returns the revision-one task view.
   */
  async createTask(caller: Agent, request: CreateTeamTaskRequest): Promise<TeamTaskView> {
    return await this.tasks.create(this.roster.membership(caller), request)
  }

  /**
   * Return one task, including a deleted tombstone.
   * @param caller - exact live Team member reading the task.
   * @param id - Team-local task identity.
   * @returns the latest task value and derived readiness diagnostics.
   */
  getTask(caller: Agent, id: TeamTaskId): TeamTaskView {
    return this.tasks.get(this.roster.membership(caller), id)
  }

  /**
   * List current non-deleted tasks in numeric creation order.
   * @param caller - exact live Team member reading the board.
   * @returns detached current task views.
   */
  listTasks(caller: Agent): TeamTaskView[] {
    return this.tasks.list(this.roster.membership(caller))
  }

  /**
   * Compare-and-set one authorized task transition.
   * @param caller - exact live Team member authorizing the mutation.
   * @param request - task identity, expected revision, action, and action fields.
   * @returns the committed next task revision.
   */
  async updateTask(caller: Agent, request: UpdateTeamTaskRequest): Promise<TeamTaskView> {
    return await this.tasks.update(caller, this.roster.membership(caller), request)
  }

  /**
   * Wait for the next Team-domain or member-status change.
   * @param caller - exact live Team member waiting for activity.
   * @param timeoutMs - bounded wait duration from ten seconds through one hour.
   * @param signal - caller cancellation for the wait only.
   * @returns one observed change or a timeout result.
   */
  async waitForChange(caller: Agent, timeoutMs: number, signal: AbortSignal): Promise<TeamWaitResult> {
    const membership = this.roster.membership(caller)
    return await this.activity.wait(membership.id, timeoutMs, signal)
  }

  /**
   * Interrupt one live teammate turn without clearing its pending inbox.
   * @param caller - exact live Lead Agent.
   * @param targetName - durable teammate name.
   * @returns the target status sampled before cancellation.
   */
  interrupt(caller: Agent, targetName: string): { previousStatus: 'running' | 'idle' | 'inactive' } {
    return this.roster.interrupt(caller, targetName)
  }

  /**
   * Resolve a caller without throwing, used by scoped-tool installation and observers.
   * @param agent - candidate exact live Agent.
   * @returns Team membership, or undefined for non-Team subagents and stale identities.
   */
  tryMembership(agent: Agent): TeamMembership | undefined {
    return this.roster.tryMembership(agent)
  }

  /**
   * Read the current roster and non-deleted task board through the generated Remote API.
   * @param agent - exact live Team member used as the authority credential.
   * @returns detached current roster and task views.
   */
  @Remote('view')
  remoteView(agent: Agent): TeamView {
    return {
      members: this.listMembers(agent),
      tasks: this.listTasks(agent),
    }
  }

  /**
   * Create one shared task through the generated Remote API.
   * @param agent - exact live Team member creating the task.
   * @param request - task text, blockers, and advisory write scopes.
   * @returns the revision-one task or a typed Team rejection.
   */
  @Remote('createTask')
  remoteCreateTask(agent: Agent, request: CreateTeamTaskRequest): Promise<TeamTaskMutationResult> {
    return this.taskMutationResult(this.createTask(agent, request))
  }

  /**
   * Apply one task mutation and preserve Team rejections as business results.
   * @param agent - exact live Team member authorizing the mutation.
   * @param request - task identity, expected revision, action, and action fields.
   * @returns the committed task or a typed Team rejection.
   */
  @Remote('updateTask')
  remoteUpdateTask(agent: Agent, request: UpdateTeamTaskRequest): Promise<TeamTaskMutationResult> {
    return this.taskMutationResult(this.updateTask(agent, request))
  }

  /** Preserve Team task rejections while allowing unexpected failures to reject the Remote call. */
  private async taskMutationResult(operation: Promise<TeamTaskView>): Promise<TeamTaskMutationResult> {
    try {
      return { ok: true, value: await operation }
    } catch (error) {
      if (!(error instanceof TeamError)) throw error
      return {
        ok: false,
        error: {
          code: error.code === 'TEAM_TASK_STALE_REVISION' ? 'team-task-conflict' : 'team-rejected',
          message: error.message,
        },
      }
    }
  }

  /** Queue one contained recovery pass after publication has unwound. */
  private scheduleRecovery(agent: Agent): void {
    queueMicrotask(() => {
      if (this.lifecycle.disposed) return
      const operation = this.recoverFor(agent)
      this.inFlightRecoveries.add(operation)
      void operation
        .catch((error: unknown) => {
          if (this.lifecycle.disposed) return
          this.ctx.logger.warn(`Agent Teams recovery for "${agent.id}" failed: ${errorMessage(error)}`)
        })
        .finally(() => { this.inFlightRecoveries.delete(operation) })
    })
  }

  /** Wake only Teams whose visible external-runtime state depends on one provider. */
  private notifyExternalRuntimeTeams(providerId: string): void {
    for (const teamId of this.roster.teamIdsForExternalProvider(providerId)) {
      this.activity.notify(teamId)
    }
  }

  /** Reconcile roster provisioning before retrying that member's pending mailbox. */
  private async recoverFor(agent: Agent): Promise<void> {
    await this.roster.recoverFor(agent, this.lifecycle.signal)
    await this.mailbox.recoverFor(agent, this.lifecycle.signal)
  }

  /** Stop Team-owned live branches and release every waiter before service disposal completes. */
  private async disposeRuntime(): Promise<void> {
    this.lifecycle.close()
    this.activity.close()
    this.teammateRuntimeRegistry.closeAdmission()

    const failures: unknown[] = []
    await this.lifecycle.settle([...this.inFlightRecoveries], failures)
    await this.lifecycle.settle(this.roster.pendingCreations(), failures)
    await this.lifecycle.settle(this.mailbox.pendingDispatches(), failures)
    for (const [root, childIds] of this.roster.liveChildrenByRoot()) {
      try {
        await this.roster.stopTeammates(root, childIds)
      } catch (error: unknown) {
        failures.push(error)
      }
    }
    try {
      await this.teammateRuntimeRegistry.disposeAttached()
    } catch (error: unknown) {
      failures.push(error)
    }
    if (failures.length > 0) throw new AggregateError(failures, 'Agent Teams runtime disposal failed')
  }
}

export default TeamService
