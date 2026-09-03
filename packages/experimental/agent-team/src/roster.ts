/** Team membership, continuable-child provisioning, and roster-owned teardown. */

import { createHash, randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { Agent, AgentOptions } from '@deepseek-ai/dsh-agent'
import type { MessageId } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { foldSubagentDescriptor } from '@deepseek-ai/dsh-subagent'
import type { ContinuableStart, ContinuableSubagentDescriptorData } from '@deepseek-ai/dsh-subagent'
import { TeamId as toTeamId, TeammateLaunchRequestId as toTeammateLaunchRequestId } from './brand.ts'
import { errorMessage, TeamError } from './error.ts'
import type { TeamJournal } from './journal.ts'
import type { TeamRuntimeLifecycle } from './lifecycle.ts'
import { readPersistedSession } from './persisted.ts'
import type { TeamState } from './projection.ts'
import { messageAccepted } from './session-message.ts'
import { TeammateRuntimeError } from './teammate-runtime.ts'
import type {
  SpawnTeammateResult,
  TeamId,
  TeamMemberExternalRuntimeSnapshot,
  TeamMemberSnapshot,
  TeamMemberRouteSnapshot,
  TeamMemberView,
} from './types.ts'
import type {
  SpawnContinuableTeammateRequest,
  SpawnExternalTeammateRequest,
  SpawnTeammateRequest,
  TeammateRuntimeRegistry,
} from './service-types.ts'
import { requiredText } from './validation.ts'

const MEMBER_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u

/** Retain only the route fields whose durable meaning is owned by Agent Teams. */
function routeSnapshot(options: AgentOptions | undefined): TeamMemberRouteSnapshot {
  return {
    ...options?.provider === undefined ? {} : { provider: options.provider },
    ...options?.model === undefined ? {} : { model: options.model },
    ...options?.reasoningEffort === undefined ? {} : { reasoningEffort: options.reasoningEffort },
  }
}

/** Read the exact resolved route recorded by a continuable descriptor. */
function descriptorRoute(descriptor: ContinuableSubagentDescriptorData): TeamMemberRouteSnapshot {
  return {
    ...descriptor.agentProvider === undefined ? {} : { provider: descriptor.agentProvider },
    ...descriptor.agentModel === undefined ? {} : { model: descriptor.agentModel },
    ...descriptor.agentReasoningEffort === undefined
      ? {}
      : { reasoningEffort: descriptor.agentReasoningEffort },
  }
}

/** Whether every explicitly requested route field was preserved after resolution. */
function routePreserved(requested: TeamMemberRouteSnapshot | undefined, resolved: TeamMemberRouteSnapshot): boolean {
  return (requested?.provider === undefined || requested.provider === resolved.provider)
    && (requested?.model === undefined || requested.model === resolved.model)
    && (requested?.reasoningEffort === undefined || requested.reasoningEffort === resolved.reasoningEffort)
}

/** Deterministic JSON independent from object insertion order. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`
  }
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key =>
      `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

/** Canonical retry identity for external creation without retaining prompt text. */
function externalRequestFingerprint(
  name: string,
  description: string,
  initialWork: SpawnExternalTeammateRequest['prompt'],
  context: SpawnExternalTeammateRequest['context'],
  provider: string,
  requirements: TeamMemberExternalRuntimeSnapshot['requirements'],
  profile: SpawnExternalTeammateRequest['runtime']['profile'],
): string {
  return createHash('sha256').update(canonicalJson({
    name,
    description,
    prompt: initialWork,
    context,
    provider,
    profile,
    requirements,
  }), 'utf8').digest('hex')
}

function snapshotExternalRuntime(
  launchRequestId: SpawnExternalTeammateRequest['runtime']['launchRequestId'],
  name: string,
  description: string,
  initialWork: SpawnExternalTeammateRequest['prompt'],
  context: SpawnExternalTeammateRequest['context'],
  provider: string,
  requirements: TeamMemberExternalRuntimeSnapshot['requirements'],
  profile: SpawnExternalTeammateRequest['runtime']['profile'],
): TeamMemberExternalRuntimeSnapshot {
  return {
    kind: 'external-agent',
    launchRequestId,
    requestFingerprint: externalRequestFingerprint(
      name,
      description,
      initialWork,
      context,
      provider,
      requirements,
      profile,
    ),
    requirements: structuredClone(requirements),
  }
}

function hasExternalRuntime(
  member: TeamMemberSnapshot,
): member is TeamMemberSnapshot & { readonly externalRuntime: TeamMemberExternalRuntimeSnapshot } {
  return member.externalRuntime !== undefined
}

/** Caller identity inside one implicit Team. */
export interface TeamMembership {
  readonly root: Agent
  readonly id: TeamId
  readonly role: 'lead' | 'teammate'
  readonly name: string
}

/**
 * Resolve one active Team member by model-facing name, including the Lead pseudo-row.
 * @param root - exact live Team Lead.
 * @param state - current Team state.
 * @param rawName - candidate member name.
 * @returns resolved durable id and normalized name.
 */
export function resolveActiveMember(
  root: Agent,
  state: TeamState,
  rawName: string,
): { id: SessionId; name: string } {
  const name = rawName.trim()
  if (name === 'lead') return { id: root.id, name }
  const member = state.members.find(candidate => candidate.name === name)
  if (member === undefined || member.phase !== 'active') {
    throw new TeamError(`active teammate "${name}" not found`, 'TEAM_MEMBER_NOT_FOUND')
  }
  return { id: member.id, name }
}

/** Owns Team identities and the lifecycle of rostered continuable children. */
export class TeamRoster {
  private readonly inFlightCreations = new Set<Promise<unknown>>()

  /**
   * @param ctx - Team service context with Agent, Session, persistence, and subagent services.
   * @param journal - authoritative Lead-log transaction owner.
   * @param lifecycle - shared Team runtime admission cutoff.
   * @param maxMembers - maximum immutable roster entries per Team.
   */
  constructor(
    private readonly ctx: Context,
    private readonly journal: TeamJournal,
    private readonly lifecycle: TeamRuntimeLifecycle,
    private readonly teammateRuntimes: TeammateRuntimeRegistry,
    private readonly maxMembers: number,
  ) {}

  /**
   * Resolve one exact live Agent's Team role.
   * @param agent - exact live Agent used as the authority credential.
   * @returns its root, Team identity, role, and model-facing name.
   */
  membership(agent: Agent): TeamMembership {
    const membership = this.tryMembership(agent)
    if (membership === undefined) {
      throw new TeamError(`agent "${agent.id}" is not a member of an active Agent Team`, 'TEAM_NOT_MEMBER')
    }
    return membership
  }

  /**
   * Resolve a caller without throwing for scoped installation and lifecycle observers.
   * @param agent - candidate exact live Agent.
   * @returns Team membership, or undefined for non-Team subagents and stale identities.
   */
  tryMembership(agent: Agent): TeamMembership | undefined {
    if (this.ctx.agents.get(agent.id) !== agent) return undefined
    try {
      const parentId = agent.session.header.parentSession
      if (parentId !== undefined) {
        const root = this.ctx.agents.get(parentId)
        if (root !== undefined) {
          const member = this.journal.state(root).members.find(candidate => candidate.id === agent.id)
          if (member?.phase === 'active' || member?.phase === 'provisioning') {
            return { root, id: toTeamId(root.id), role: 'teammate', name: member.name }
          }
          // A direct child outside the durable roster is not a teammate. Ordinary
          // host forks are independent roots; subagent descriptors distinguish
          // provider-owned workers that must not receive a nested Team identity.
          if (this.subagentDescriptor(agent)) return undefined
          return { root: agent, id: toTeamId(agent.id), role: 'lead', name: 'lead' }
        }
      }
      // A continuation can briefly outlive its parent during child-first teardown.
      // Do not reinterpret that durable child as a new implicit root Team. A host-
      // resumed ordinary fork has no descriptor in its own suffix and remains a
      // valid new root whose inherited Team records stay outside its projected Team state.
      if (this.subagentDescriptor(agent)) return undefined
      return { root: agent, id: toTeamId(agent.id), role: 'lead', name: 'lead' }
    } catch {
      // This method is used by lifecycle observers and teardown discovery. A
      // malformed durable stream is surfaced by authoritative Team operations;
      // the non-throwing probe must not veto unrelated Agent lifecycle edges.
      return undefined
    }
  }

  /**
   * List the runtime-enriched roster visible to one Team member.
   * @param membership - exact caller membership resolved by this roster.
   * @returns Lead and teammate rows in creation order.
   */
  list(membership: TeamMembership): TeamMemberView[] {
    const { root } = membership
    const state = this.journal.state(root)
    const result: TeamMemberView[] = [{
      id: root.id,
      name: 'lead',
      role: 'lead',
      status: root.status,
      ...root.options.model === undefined ? {} : { model: root.options.model },
      diagnostics: [],
    }]
    for (const member of state.members) {
      result.push(this.memberView(member))
    }
    return result
  }

  /**
   * Find exact active Teams whose durable roster uses one external provider.
   * @param providerId - Stable provider identity to match.
   * @returns active Team identities with at least one matching external member.
   */
  teamIdsForExternalProvider(providerId: string): readonly TeamId[] {
    const roots = new Map<TeamId, Agent>()
    for (const agent of this.ctx.agents.list()) {
      const membership = this.tryMembership(agent)
      if (membership !== undefined) roots.set(membership.id, membership.root)
    }
    const result: TeamId[] = []
    for (const [teamId, root] of roots) {
      try {
        if (this.journal.state(root).members.some(member =>
          member.provider === providerId && member.externalRuntime !== undefined)) {
          result.push(teamId)
        }
      } catch {
        // Topology observation must not turn a malformed unrelated Team into a provider failure.
      }
    }
    return result
  }

  /**
   * Create one named durable teammate through its selected typed runtime.
   * @param caller - exact live Lead Agent.
   * @param request - DSH-continuable or external runtime placement and caller cancellation through initial-work durability.
   * @returns the active roster row with its resolved DSH route or provider-native handle.
   */
  async spawn(caller: Agent, request: SpawnTeammateRequest): Promise<SpawnTeammateResult> {
    if (this.lifecycle.disposed) throw new TeamError('Agent Teams service is disposing', 'TEAM_DISPOSED')
    const operation = this.spawnAdmitted(caller, request)
    this.inFlightCreations.add(operation)
    try {
      return await operation
    } finally {
      this.inFlightCreations.delete(operation)
    }
  }

  /**
   * Return admitted creation operations captured for ordered disposal.
   * @returns detached snapshot ordered only by Set insertion.
   */
  pendingCreations(): readonly Promise<unknown>[] {
    return [...this.inFlightCreations]
  }

  /**
   * Reconcile provisioning state when one Team member Session starts.
   * @param agent - newly started exact live Agent.
   * @param signal - shared runtime cancellation.
   */
  async recoverFor(agent: Agent, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    const membership = this.tryMembership(agent)
    if (membership?.role === 'lead') {
      await this.reconcileProvisioning(membership.root, signal)
      await this.resumeExternalMembers(membership.root, signal)
    }
  }

  /**
   * Interrupt one live teammate turn without clearing its pending inbox.
   * @param caller - exact live Lead Agent.
   * @param targetName - durable teammate name.
   * @returns the target status sampled before cancellation.
   */
  interrupt(caller: Agent, targetName: string): { previousStatus: 'running' | 'idle' | 'inactive' } {
    const membership = this.membership(caller)
    if (membership.role !== 'lead') throw new TeamError('only the Team Lead can interrupt teammates', 'TEAM_LEAD_REQUIRED')
    const state = this.journal.state(membership.root)
    const target = resolveActiveMember(membership.root, state, targetName)
    if (target.id === membership.root.id) throw new TeamError('the Team Lead cannot interrupt itself', 'TEAM_INVALID_TARGET')
    const member = state.members.find(candidate => candidate.id === target.id)
    if (member?.externalRuntime?.nativeHandle !== undefined) {
      return this.teammateRuntimes.interrupt(member.provider, {
        nativeHandle: member.externalRuntime.nativeHandle,
      })
    }
    const live = this.ctx.agents.get(target.id)
    if (live === undefined) return { previousStatus: 'inactive' }
    const previousStatus = live.status
    this.ctx.subagents.interrupt(target.id, { kind: 'ancestor', agent: caller })
    return { previousStatus }
  }

  /**
   * Group exact live roster children by their current Lead for runtime teardown.
   * @returns each live Lead and the roster child ids currently in the Agent registry.
   */
  liveChildrenByRoot(): Map<Agent, SessionId[]> {
    const teams = new Map<Agent, SessionId[]>()
    for (const agent of this.ctx.agents.list()) {
      const rootId = agent.session.header.parentSession
      if (rootId === undefined) continue
      const root = this.ctx.agents.get(rootId)
      if (root === undefined
        || !this.journal.state(root).members.some(member => member.id === agent.id)) continue
      const children = teams.get(root) ?? []
      children.push(agent.id)
      teams.set(root, children)
    }
    return teams
  }

  /**
   * Release exact teammate Activations through the continuation lifecycle owner.
   * @param root - exact live Team Lead authorizing release.
   * @param childIds - selected roster child ids.
   */
  async stopTeammates(root: Agent, childIds: readonly SessionId[]): Promise<void> {
    await this.ctx.subagents.drainContinuableChildren(root, childIds)
  }

  /** Perform one creation admitted before the Team runtime disposal cutoff. */
  private async spawnAdmitted(
    caller: Agent,
    request: SpawnTeammateRequest,
  ): Promise<SpawnTeammateResult> {
    const membership = this.membership(caller)
    if (membership.role !== 'lead') {
      throw new TeamError('only the Team Lead can create teammates', 'TEAM_LEAD_REQUIRED')
    }
    const signal = AbortSignal.any([request.signal, this.lifecycle.signal])
    signal.throwIfAborted()
    const root = membership.root
    const name = this.memberName(request.name)
    const description = requiredText(request.description, 'description', 200)
    const context = request.context
    const externalRuntime = request.runtime
    const provider = requiredText(
      externalRuntime === undefined ? request.provider : externalRuntime.provider,
      'provider',
      200,
    )
    let requestedExternal: TeamMemberExternalRuntimeSnapshot | undefined
    let requestedExternalProfile: SpawnExternalTeammateRequest['runtime']['profile'] | undefined
    let requestedExternalInitialWork: SpawnExternalTeammateRequest['prompt'] | undefined
    if (externalRuntime !== undefined) {
      const initialWork = structuredClone(request.prompt)
      const launchRequestId = toTeammateLaunchRequestId(externalRuntime.launchRequestId)
      const validated = this.teammateRuntimes.validateLaunch(
        provider,
        externalRuntime.requirements,
        externalRuntime.profile,
      )
      const requirements = validated.requirements
      if (requirements.contextMode !== context) {
        throw new TeammateRuntimeError(
          'external teammate context does not match its runtime requirements',
          'TEAM_RUNTIME_CAPABILITY_MISMATCH',
        )
      }
      requestedExternal = snapshotExternalRuntime(
        launchRequestId,
        name,
        description,
        initialWork,
        context,
        provider,
        requirements,
        validated.profile,
      )
      requestedExternalProfile = validated.profile
      requestedExternalInitialWork = initialWork
    }
    const member = await this.journal.transact(root.id, async (): Promise<TeamMemberSnapshot> => {
      const state = this.journal.state(root)
      if (requestedExternal !== undefined) {
        const replay = state.members.find(candidate =>
          candidate.externalRuntime?.launchRequestId === requestedExternal.launchRequestId)
        if (replay !== undefined) {
          if (replay.name !== name
            || replay.description !== description
            || replay.provider !== provider
            || replay.context !== context
            || replay.externalRuntime?.requestFingerprint !== requestedExternal.requestFingerprint) {
            throw new TeammateRuntimeError(
              'external launch identity was already used with different normalized input',
              'TEAM_RUNTIME_IDENTITY_CONFLICT',
            )
          }
          return replay
        }
      }
      if (state.members.some(member => member.name === name)) {
        throw new TeamError(`teammate name "${name}" was already used in this Team`, 'TEAM_MEMBER_NAME_TAKEN')
      }
      if (state.members.length >= this.maxMembers) {
        throw new TeamError(`Team member limit ${this.maxMembers} reached`, 'TEAM_MEMBER_LIMIT')
      }
      const reserved: TeamMemberSnapshot = {
        id: brandString<SessionId>(randomUUID()),
        name,
        description,
        provider,
        context,
        ...(requestedExternal === undefined
          ? { requestedRoute: routeSnapshot(request.agentOptions) }
          : { externalRuntime: requestedExternal }),
        phase: 'provisioning',
      }
      await this.journal.appendAndFlush(root, 'team/member', {
        version: 2,
        teamId: toTeamId(root.id),
        member: reserved,
      })
      return reserved
    })

    if (requestedExternal !== undefined) {
      /* v8 ignore next -- the same external request created the immutable reservation above. */
      if (!hasExternalRuntime(member)) {
        throw new TeamError('external teammate reservation lost its runtime identity', 'TEAM_PROVISIONING_CONFLICT')
      }
      /* v8 ignore next -- external validation above always captures the canonical Profile snapshot. */
      if (requestedExternalProfile === undefined) {
        throw new TeamError('external teammate lost its validated Profile policy', 'TEAM_PROVISIONING_CONFLICT')
      }
      /* v8 ignore next -- the external branch captures initial work with its validated Profile. */
      if (requestedExternalInitialWork === undefined) {
        throw new TeamError('external teammate lost its initial-work snapshot', 'TEAM_PROVISIONING_CONFLICT')
      }
      return await this.spawnExternal(root, member, requestedExternalInitialWork, requestedExternalProfile, signal)
    }
    return await this.spawnContinuable(root, member, request as SpawnContinuableTeammateRequest, signal)
  }

  /** Complete one provider-native creation after the permanent name is reserved. */
  private async spawnExternal(
    root: Agent,
    member: TeamMemberSnapshot & { readonly externalRuntime: TeamMemberExternalRuntimeSnapshot },
    initialWork: SpawnExternalTeammateRequest['prompt'],
    profile: SpawnExternalTeammateRequest['runtime']['profile'],
    signal: AbortSignal,
  ): Promise<SpawnTeammateResult> {
    if (member.phase === 'active') return { member: this.memberView(member) }
    if (member.phase === 'failed') {
      throw new TeamError(`teammate "${member.name}" provisioning already failed`, 'TEAM_PROVISIONING_CONFLICT')
    }
    const external = member.externalRuntime
    const result = await this.teammateRuntimes.create(member.provider, {
      launchRequestId: external.launchRequestId,
      memberId: member.id,
      memberName: member.name,
      description: member.description,
      initialWork,
      profile,
      requirements: external.requirements,
      signal,
    })
    const active = {
      ...member,
      externalRuntime: {
        ...external,
        nativeHandle: result.nativeHandle,
        ...(result.turnId === undefined ? {} : { initialTurnId: result.turnId }),
      },
      phase: 'active' as const,
    } satisfies TeamMemberSnapshot
    // Provider completion is the durable initial-work acceptance point. The
    // caller signal no longer owns the terminal roster commit after this line.
    const settledPhase = await this.settleProvisioning(root, active)
    if (settledPhase === 'failed') {
      const conflict = new TeamError(
        `teammate "${member.name}" was reconciled as failed while external creation was in progress`,
        'TEAM_PROVISIONING_CONFLICT',
      )
      try {
        await this.teammateRuntimes.dispose(member.provider, {
          kind: 'runtime',
          nativeHandle: result.nativeHandle,
          signal: this.lifecycle.signal,
        })
      } catch (cleanupError: unknown) {
        throw new AggregateError([conflict, cleanupError], 'external provisioning conflict cleanup failed')
      }
      throw conflict
    }
    return { member: this.memberView(active) }
  }

  /** Complete the existing DSH continuable-child creation path. */
  private async spawnContinuable(
    root: Agent,
    member: TeamMemberSnapshot,
    request: SpawnContinuableTeammateRequest,
    signal: AbortSignal,
  ): Promise<SpawnTeammateResult> {
    const childId = member.id
    const name = member.name
    const description = member.description

    let started: ContinuableStart
    let resolvedRoute: TeamMemberRouteSnapshot
    try {
      started = await this.ctx.subagents.startContinuable({
        childId,
        provider: request.provider,
        label: description,
        request: {
          prompt: request.prompt,
          parent: root,
          ...request.agentOptions === undefined ? {} : { agentOptions: request.agentOptions },
        },
        signal,
      })
      await this.checkpointInitialPrompt(childId, started.messageId, signal)
      // Durable initial acceptance transfers cancellation ownership from the
      // launch caller to Agent Teams. Only Team disposal may cancel the
      // descriptor correlation and terminal roster commit that follow.
      resolvedRoute = await this.resolveStartedRoute(childId, member.provider, this.lifecycle.signal)
      if (!routePreserved(member.requestedRoute, resolvedRoute)) {
        throw new TeamError(
          `teammate "${name}" resolved a different provider, model, or reasoning effort than requested`,
          'TEAM_RUNTIME_ROUTE_MISMATCH',
        )
      }
    } catch (error: unknown) {
      const failed: TeamMemberSnapshot = {
        ...member,
        phase: 'failed',
        error: errorMessage(error),
      }
      try {
        const phase = await this.settleProvisioning(root, failed)
        await this.stopTeammates(root, [childId])
        if (phase === 'active') {
          throw new TeamError(
            `teammate "${name}" became active while its creator reported failure`,
            'TEAM_PROVISIONING_CONFLICT',
            { cause: error },
          )
        }
      } catch (recordError: unknown) {
        throw new AggregateError([error, recordError], 'teammate creation and durable failure recording both failed')
      }
      throw error
    }
    const active = {
      ...member,
      resolvedRoute,
      phase: 'active' as const,
    } satisfies TeamMemberSnapshot
    // Once the continuation accepted its first prompt, it is a real child. If
    // this checkpoint fails, keep the in-memory active edge instead of inventing
    // an impossible active -> failed transition; restart reconciliation covers
    // the provisioning-only durable prefix.
    const settledPhase = await this.settleProvisioning(root, active)
    if (settledPhase === 'failed') {
      const conflict = new TeamError(
        `teammate "${name}" was reconciled as failed while creation was in progress`,
        'TEAM_PROVISIONING_CONFLICT',
      )
      try {
        await this.stopTeammates(root, [childId])
      } catch (cleanupError: unknown) {
        /* v8 ignore next -- requires the independently tested HMR settlement conflict and cleanup failure together. */
        throw new AggregateError([conflict, cleanupError], 'provisioning conflict cleanup failed')
      }
      throw conflict
    }
    return { member: this.memberView(active) }
  }

  /** Flush the accepted initial inbox item before the Lead can commit `active`. */
  private async checkpointInitialPrompt(
    childId: SessionId,
    messageId: MessageId,
    signal: AbortSignal,
  ): Promise<void> {
    while (true) {
      signal.throwIfAborted()
      const session = this.ctx.sessions.get(childId)
      if (session === undefined) {
        const stored = await readPersistedSession(this.ctx.sessionPersistence, childId, signal)
        const suffix = stored.events.slice(stored.inheritedEventCount)
        if (messageAccepted(suffix, message => message.id === messageId)) return
        throw new TeamError(
          `teammate "${childId}" initial prompt was not durably accepted`,
          'TEAM_PROVISIONING_CONFLICT',
        )
      }

      const progress = Promise.withResolvers<undefined>()
      // Abort can win while the durability flush is still pending; mark the
      // later-awaited rejection handled without changing its eventual result.
      void progress.promise.catch(() => undefined)
      const stopEvent = this.ctx.on('session/event', (candidate) => {
        if (candidate === session) progress.resolve(undefined)
      })
      const stopDisposed = this.ctx.on('session/disposed', (candidate) => {
        if (candidate === session) progress.resolve(undefined)
      })
      const onAbort = (): void => {
        const reason: unknown = signal.reason
        progress.reject(reason instanceof Error
          ? reason
          : new TeamError(`teammate creation aborted: ${errorMessage(reason)}`, 'TEAM_DISPOSED'))
      }
      signal.addEventListener('abort', onAbort, { once: true })
      try {
        signal.throwIfAborted()
        await this.ctx.sessions.flush(session)
        const suffix = session.snapshotEvents(session.inheritedEventCount)
        if (messageAccepted(suffix, message => message.id === messageId)) return
        if (this.ctx.sessions.get(childId) !== session) continue
        await progress.promise
      } finally {
        signal.removeEventListener('abort', onAbort)
        stopDisposed()
        stopEvent()
      }
    }
  }

  /** Settle provisioning-only members from their independently durable child Sessions. */
  private async reconcileProvisioning(root: Agent, signal: AbortSignal): Promise<void> {
    const provisioning = this.journal.state(root).members.filter(member => member.phase === 'provisioning')
    for (const member of provisioning) {
      signal.throwIfAborted()
      if (hasExternalRuntime(member)) {
        await this.reconcileExternalProvisioning(root, member, signal)
        continue
      }
      // A live child means creation is still completing in this process. Its
      // creator owns the terminal member edge.
      if (this.ctx.agents.get(member.id) !== undefined) continue
      let phase: 'active' | 'failed' = 'failed'
      let failure = 'provisioning did not leave a resumable child Session'
      let resolvedRoute: TeamMemberRouteSnapshot | undefined
      try {
        const loaded = await readPersistedSession(this.ctx.sessionPersistence, member.id, signal)
        const suffix = loaded.events.slice(loaded.inheritedEventCount)
        const descriptor = foldSubagentDescriptor(suffix)
        const acceptedInitialPrompt = messageAccepted(suffix, message => message.source.kind === 'user')
        if (loaded.header.parentSession === root.id
          && descriptor?.mode === 'continuable'
          && descriptor.provider === member.provider
          && routePreserved(member.requestedRoute, descriptorRoute(descriptor))
          && acceptedInitialPrompt) {
          phase = 'active'
          resolvedRoute = descriptorRoute(descriptor)
        } else {
          failure = 'persisted child Session does not match the provisioned continuation'
        }
      } catch (error: unknown) {
        failure = `child Session recovery failed: ${errorMessage(error)}`
      }
      signal.throwIfAborted()
      await this.journal.transact(root.id, async () => {
        signal.throwIfAborted()
        const current = this.journal.state(root).members.find(candidate => candidate.id === member.id)
        if (current?.phase !== 'provisioning') return
        const settled: TeamMemberSnapshot = {
          ...current,
          phase,
          ...resolvedRoute === undefined ? {} : { resolvedRoute },
          ...phase === 'failed' ? { error: failure } : {},
        }
        await this.journal.appendAndFlush(root, 'team/member', {
          version: 2,
          teamId: toTeamId(root.id),
          member: settled,
        })
      })
    }
  }

  /** Recover an externally accepted launch by stable identity without creating a substitute. */
  private async reconcileExternalProvisioning(
    root: Agent,
    member: TeamMemberSnapshot & { readonly externalRuntime: TeamMemberExternalRuntimeSnapshot },
    signal: AbortSignal,
  ): Promise<void> {
    const external = member.externalRuntime
    let resumed
    try {
      resumed = await this.teammateRuntimes.resume(member.provider, {
        launchRequestId: external.launchRequestId,
        memberId: member.id,
        requirements: external.requirements,
        signal,
      })
    } catch (error: unknown) {
      if (error instanceof TeammateRuntimeError && error.code === 'TEAM_RUNTIME_UNAVAILABLE') return
      throw error
    }
    if (resumed === undefined) return
    signal.throwIfAborted()
    await this.journal.transact(root.id, async () => {
      signal.throwIfAborted()
      const current = this.journal.state(root).members.find(candidate => candidate.id === member.id)
      if (current?.phase !== 'provisioning') return
      /* v8 ignore next -- the projection makes external runtime identity immutable after the provisioning record. */
      if (current.externalRuntime === undefined) return
      await this.journal.appendAndFlush(root, 'team/member', {
        version: 2,
        teamId: toTeamId(root.id),
        member: {
          ...current,
          externalRuntime: {
            ...current.externalRuntime,
            nativeHandle: resumed.nativeHandle,
            ...(resumed.turnId === undefined ? {} : { initialTurnId: resumed.turnId }),
          },
          phase: 'active',
        },
      })
    })
  }

  /** Reattach active external members when their provider or Team service returns. */
  private async resumeExternalMembers(root: Agent, signal: AbortSignal): Promise<void> {
    const members = this.journal.state(root).members.filter(member =>
      member.phase === 'active' && member.externalRuntime?.nativeHandle !== undefined)
    for (const member of members) {
      signal.throwIfAborted()
      const external = member.externalRuntime
      const nativeHandle = external?.nativeHandle
      /* v8 ignore next -- the filtered member set contains only external runtimes with native handles. */
      if (external === undefined || nativeHandle === undefined) continue
      try {
        await this.teammateRuntimes.resume(member.provider, {
          launchRequestId: external.launchRequestId,
          memberId: member.id,
          nativeHandle,
          requirements: external.requirements,
          signal,
        })
      } catch (error: unknown) {
        if (!(error instanceof TeammateRuntimeError) || error.code !== 'TEAM_RUNTIME_UNAVAILABLE') throw error
      }
    }
  }

  /** Build one runtime-enriched member row from its durable snapshot. */
  private memberView(member: TeamMemberSnapshot): TeamMemberView {
    const live = this.ctx.agents.get(member.id)
    const externalPresence = member.externalRuntime?.nativeHandle === undefined
      ? undefined
      : this.teammateRuntimes.runtimePresence(member.provider, member.externalRuntime.nativeHandle)
    return {
      id: member.id,
      name: member.name,
      role: 'teammate',
      status: member.phase === 'failed'
        ? 'failed'
        : member.phase === 'provisioning'
          ? 'provisioning'
          : externalPresence ?? live?.status ?? 'inactive',
      description: member.description,
      provider: member.provider,
      context: member.context,
      ...member.requestedRoute === undefined ? {} : { requestedRoute: { ...member.requestedRoute } },
      ...member.resolvedRoute === undefined ? {} : { resolvedRoute: { ...member.resolvedRoute } },
      ...member.externalRuntime === undefined
        ? {}
        : { externalRuntime: structuredClone(member.externalRuntime) },
      ...member.resolvedRoute?.model === undefined ? {} : { model: member.resolvedRoute.model },
      diagnostics: member.error === undefined ? [] : [member.error],
    }
  }

  /** Load and correlate the continuable descriptor committed for one started child. */
  private async resolveStartedRoute(
    childId: SessionId,
    provider: string,
    signal: AbortSignal,
  ): Promise<TeamMemberRouteSnapshot> {
    signal.throwIfAborted()
    const session = this.ctx.sessions.get(childId)
    let suffix
    if (session === undefined) {
      const inspected = await readPersistedSession(this.ctx.sessionPersistence, childId, signal)
      suffix = inspected.events.slice(inspected.inheritedEventCount)
    } else {
      suffix = session.ownEvents()
    }
    const descriptor = foldSubagentDescriptor(suffix)
    if (descriptor?.mode !== 'continuable' || descriptor.provider !== provider) {
      throw new TeamError(
        `teammate "${childId}" continuation descriptor does not match its provisioned provider`,
        'TEAM_PROVISIONING_CONFLICT',
      )
    }
    return descriptorRoute(descriptor)
  }

  /** Validate a never-reused model-facing teammate name. */
  private memberName(value: string): string {
    if (!MEMBER_NAME.test(value) || value.length > 64 || value === 'lead') {
      throw new TeamError(
        'teammate name must be lower-kebab-case, at most 64 characters, and not "lead"',
        'TEAM_INVALID_MEMBER_NAME',
      )
    }
    return value
  }

  /** Append one terminal provisioning edge unless recovery already settled it. */
  private async settleProvisioning(
    root: Agent,
    terminal: TeamMemberSnapshot,
  ): Promise<'active' | 'failed'> {
    return this.journal.transact(root.id, async () => {
      const current = this.journal.state(root).members.find(member => member.id === terminal.id)
      /* v8 ignore next 3 -- the append-only provisioning event is committed by this operation before settlement. */
      if (current === undefined) {
        throw new TeamError(`provisioned teammate "${terminal.id}" disappeared`, 'TEAM_PROVISIONING_CONFLICT')
      }
      if (current.phase !== 'provisioning') return current.phase
      await this.journal.appendAndFlush(root, 'team/member', {
        version: 2,
        teamId: toTeamId(root.id),
        member: terminal,
      })
      return terminal.phase === 'active' ? 'active' : 'failed'
    })
  }

  /** Whether a Session's own suffix identifies a provider-owned subagent child. */
  private subagentDescriptor(agent: Agent): boolean {
    return foldSubagentDescriptor(agent.session.snapshotEvents(agent.session.inheritedEventCount)) !== undefined
  }
}
