import { afterEach, describe, expect, it, vi } from 'vitest'
import { Buffer } from 'node:buffer'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { SessionId } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SubagentService from '@deepseek-ai/dsh-subagent'
import TeamService, {
  TeamId,
  TeamMessageId,
  TeammateRuntimeError,
  TeammateEvaluationId,
  TeammateEvaluationHandle,
  TeammateLaunchRequestId,
  TeammateRuntimeHandle,
  TeammateRuntimeEvidenceCursor,
  TeammateRuntimeEvidenceId,
  TeammateRuntimeTurnId,
  type TeammateRuntimeCreateRequest,
  type TeammateRuntimeDisposeRequest,
  type TeammateRuntimeProvider,
  type TeammateRuntimeProfileSnapshot,
  type TeammateRuntimePresenceEvent,
  type TeammateRuntimeRegistration,
  type TeammateRuntimeRequirements,
  type TeamMemberSnapshot,
} from '../src/index.ts'
import type { TeammateRuntimeRegistry } from '../src/service-types.ts'
import { TestSessionQuery } from './test-session-query.ts'
import { defineTeammateRuntimeProviderConformance } from '../src/testkit.ts'

const roots: string[] = []
const SIGNAL = new AbortController().signal

function runtimeProfile(
  overrides: Partial<TeammateRuntimeProfileSnapshot> = {},
): TeammateRuntimeProfileSnapshot {
  return {
    persona: 'Be precise and skeptical.',
    mission: 'Review the assigned change.',
    context: [],
    memory: [],
    toolPolicy: { mode: 'inherit', names: [] },
    hooks: [],
    ...overrides,
  }
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error('provider request aborted')
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

interface NativeSession {
  readonly launchRequestId: ReturnType<typeof TeammateLaunchRequestId>
  readonly memberId: SessionId
  readonly handle: ReturnType<typeof TeammateRuntimeHandle>
  readonly initialTurnId: ReturnType<typeof TeammateRuntimeTurnId>
  readonly turns: Map<string, ReturnType<typeof TeammateRuntimeTurnId>>
  status: 'running' | 'idle'
}

interface FakeDurableStore {
  readonly sessions: Map<string, NativeSession>
  readonly evaluations: Map<string, ReturnType<typeof TeammateEvaluationHandle>>
  nextHandle: number
  nextTurn: number
  nextEvaluation: number
}

function fakeStore(): FakeDurableStore {
  return {
    sessions: new Map(),
    evaluations: new Map(),
    nextHandle: 1,
    nextTurn: 1,
    nextEvaluation: 1,
  }
}

class FakeDurableRuntime implements TeammateRuntimeProvider {
  readonly id: string
  readonly displayName: string
  readonly contextModes = ['fresh'] as const
  readonly profileCapabilities = ['persona', 'mission'] as const
  readonly runtimeCapabilities = ['evidence', 'evaluation'] as const
  readonly attachedRuntimes = new Set<ReturnType<typeof TeammateRuntimeHandle>>()
  readonly attachedEvaluations = new Set<ReturnType<typeof TeammateEvaluationHandle>>()
  private readonly presenceListeners = new Set<(event: TeammateRuntimePresenceEvent) => void>()
  readonly onPresenceChanged = vi.fn<NonNullable<TeammateRuntimeProvider['onPresenceChanged']>>((listener) => {
    this.presenceListeners.add(listener)
    return () => { this.presenceListeners.delete(listener) }
  })
  readonly create = vi.fn<TeammateRuntimeProvider['create']>(async (request) => {
    request.signal.throwIfAborted()
    const key = `${request.launchRequestId}:${request.memberId}`
    let session = this.store.sessions.get(key)
    if (session === undefined) {
      session = {
        launchRequestId: request.launchRequestId,
        memberId: request.memberId,
        handle: TeammateRuntimeHandle(`native-${this.store.nextHandle++}`),
        initialTurnId: TeammateRuntimeTurnId(`native-initial-${this.store.nextHandle - 1}`),
        turns: new Map(),
        status: 'idle',
      }
      this.store.sessions.set(key, session)
    }
    this.attachedRuntimes.add(session.handle)
    return { nativeHandle: session.handle, turnId: session.initialTurnId, presence: session.status }
  })
  readonly resume = vi.fn<TeammateRuntimeProvider['resume']>(async (request) => {
    request.signal.throwIfAborted()
    const session = [...this.store.sessions.values()].find(candidate =>
      candidate.launchRequestId === request.launchRequestId
      && candidate.memberId === request.memberId
      && (request.nativeHandle === undefined || candidate.handle === request.nativeHandle))
    if (session === undefined) return undefined
    this.attachedRuntimes.add(session.handle)
    return { nativeHandle: session.handle, turnId: session.initialTurnId, presence: session.status }
  })
  readonly deliver = vi.fn<TeammateRuntimeProvider['deliver']>(async (request) => {
    request.signal.throwIfAborted()
    const session = this.session(request.nativeHandle)
    let turnId = session.turns.get(request.deliveryId)
    if (turnId === undefined) {
      turnId = TeammateRuntimeTurnId(`native-turn-${this.store.nextTurn++}`)
      session.turns.set(request.deliveryId, turnId)
    }
    session.status = 'idle'
    return { turnId, presence: session.status }
  })
  readonly interrupt = vi.fn<TeammateRuntimeProvider['interrupt']>((request) => {
    const session = this.session(request.nativeHandle)
    const previousStatus = session.status
    session.status = 'idle'
    return { previousStatus }
  })
  readonly evidence = vi.fn<NonNullable<TeammateRuntimeProvider['evidence']>>(async (request) => {
    request.signal.throwIfAborted()
    const session = this.session(request.nativeHandle)
    return {
      nativeHandle: session.handle,
      items: [session.initialTurnId, ...session.turns.values()].map((turnId, index) => ({
        id: TeammateRuntimeEvidenceId(`evidence-${index + 1}`),
        kind: 'turn' as const,
        timestamp: index + 1,
        turnId,
        outcome: 'completed' as const,
      })),
      complete: true,
    }
  })
  readonly createEvaluationHandle = vi.fn<NonNullable<TeammateRuntimeProvider['createEvaluationHandle']>>(async (
    request,
  ) => {
    request.signal.throwIfAborted()
    let handle = this.store.evaluations.get(request.evaluationId)
    if (handle === undefined) {
      handle = TeammateEvaluationHandle(`native-eval-${this.store.nextEvaluation++}`)
      this.store.evaluations.set(request.evaluationId, handle)
    }
    this.attachedEvaluations.add(handle)
    return { evaluationHandle: handle }
  })
  readonly dispose = vi.fn<TeammateRuntimeProvider['dispose']>(async (request: TeammateRuntimeDisposeRequest) => {
    request.signal.throwIfAborted()
    if (request.kind === 'runtime') this.attachedRuntimes.delete(request.nativeHandle)
    else this.attachedEvaluations.delete(request.evaluationHandle)
  })

  constructor(store: FakeDurableStore, id = 'fake-native', displayName?: string) {
    this.store = store
    this.id = id
    this.displayName = displayName ?? (id === 'fake-native' ? 'Fake Native' : 'Other Native')
  }

  private readonly store: FakeDurableStore

  publishPresence(
    nativeHandle: ReturnType<typeof TeammateRuntimeHandle>,
    presence: TeammateRuntimePresenceEvent['presence'],
  ): void {
    const session = this.session(nativeHandle)
    if (presence !== 'inactive') session.status = presence
    for (const listener of [...this.presenceListeners]) listener({ nativeHandle, presence })
  }

  private session(handle: ReturnType<typeof TeammateRuntimeHandle>): NativeSession {
    const session = [...this.store.sessions.values()].find(candidate => candidate.handle === handle)
    if (session === undefined) throw new Error(`unknown native handle ${handle}`)
    return session
  }
}

async function runtimeContext(
  storageRoot: string,
  config: ConstructorParameters<typeof TeamService>[1] = {},
) {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(JsonlSessionPersistence, { root: storageRoot })
  await ctx.plugin(TestSessionQuery)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(SubagentService)
  const teamFiber = await ctx.plugin(TeamService, config)
  return { ctx, teamFiber }
}

async function setup(config: ConstructorParameters<typeof TeamService>[1] = {}) {
  const storageRoot = mkdtempSync(join(tmpdir(), 'dsh-team-runtime-'))
  roots.push(storageRoot)
  const { ctx, teamFiber } = await runtimeContext(storageRoot, config)
  const lead = ctx.agentLoop.create(SessionId('external-lead'), {})
  return { ctx, teamFiber, lead }
}

async function register(ctx: Context, provider: TeammateRuntimeProvider) {
  const fiber = ctx.plugin({
    inject: ['agentTeams'],
    apply(pluginCtx: Context) {
      pluginCtx.agentTeams.registerTeammateRuntimeProvider(provider)
    },
  })
  await fiber
  return fiber
}

function createRequest(overrides: Partial<TeammateRuntimeCreateRequest> = {}): TeammateRuntimeCreateRequest {
  return {
    launchRequestId: TeammateLaunchRequestId('11111111-1111-4111-8111-111111111111'),
    memberId: SessionId('member-1'),
    memberName: 'native-worker',
    description: 'Native worker responsibility',
    initialWork: [{ type: 'text', text: 'Start native work.' }],
    profile: runtimeProfile(),
    requirements: {
      contextMode: 'fresh',
      profileCapabilities: ['persona', 'mission'],
      runtimeCapabilities: ['evidence'],
    },
    signal: SIGNAL,
    ...overrides,
  }
}

type ProviderOverrides = Omit<
  Partial<TeammateRuntimeProvider>,
  'evidence' | 'createEvaluationHandle' | 'onPresenceChanged'
> & {
  readonly evidence?: TeammateRuntimeProvider['evidence'] | undefined
  readonly createEvaluationHandle?: TeammateRuntimeProvider['createEvaluationHandle'] | undefined
  readonly onPresenceChanged?: TeammateRuntimeProvider['onPresenceChanged'] | undefined
}

function providerWith(
  provider: FakeDurableRuntime,
  overrides: ProviderOverrides,
): TeammateRuntimeProvider {
  const { evidence, createEvaluationHandle, onPresenceChanged, ...requiredOverrides } = overrides
  const resolvedEvidence = Object.hasOwn(overrides, 'evidence') ? evidence : provider.evidence
  const resolvedEvaluation = Object.hasOwn(overrides, 'createEvaluationHandle')
    ? createEvaluationHandle
    : provider.createEvaluationHandle
  const resolvedPresence = Object.hasOwn(overrides, 'onPresenceChanged')
    ? onPresenceChanged
    : provider.onPresenceChanged
  return {
    id: provider.id,
    displayName: provider.displayName,
    contextModes: provider.contextModes,
    profileCapabilities: provider.profileCapabilities,
    runtimeCapabilities: provider.runtimeCapabilities,
    create: provider.create,
    resume: provider.resume,
    deliver: provider.deliver,
    interrupt: provider.interrupt,
    dispose: provider.dispose,
    ...requiredOverrides,
    ...(resolvedEvidence === undefined ? {} : { evidence: resolvedEvidence }),
    ...(resolvedEvaluation === undefined ? {} : { createEvaluationHandle: resolvedEvaluation }),
    ...(resolvedPresence === undefined ? {} : { onPresenceChanged: resolvedPresence }),
  }
}

interface TeamRuntimeTestInternals {
  readonly teammateRuntimeRegistry: TeammateRuntimeRegistry & {
    closeAdmission(): void
    disposeAttached(): Promise<void>
  }
  readonly roster: {
    reconcileProvisioning(root: Agent, signal: AbortSignal): Promise<void>
    reconcileExternalProvisioning(root: Agent, member: TeamMemberSnapshot, signal: AbortSignal): Promise<void>
    resumeExternalMembers(root: Agent, signal: AbortSignal): Promise<void>
  }
}

function runtimeInternals(ctx: Context): TeamRuntimeTestInternals {
  return ctx.agentTeams as unknown as TeamRuntimeTestInternals
}

function runtimeRegistry(ctx: Context): TeamRuntimeTestInternals['teammateRuntimeRegistry'] {
  return runtimeInternals(ctx).teammateRuntimeRegistry
}

function externalMember(
  id: string,
  name: string,
  launchRequestId: ReturnType<typeof TeammateLaunchRequestId>,
): TeamMemberSnapshot {
  return {
    id: SessionId(id),
    name,
    description: `${name} responsibility`,
    provider: 'fake-native',
    context: 'fresh',
    externalRuntime: {
      kind: 'external-agent',
      launchRequestId,
      requestFingerprint: 'a'.repeat(64),
      requirements: createRequest().requirements,
    },
    phase: 'provisioning',
  }
}

async function attachedRuntimeCase(id: string) {
  const runtime = await setup()
  const provider = new FakeDurableRuntime(fakeStore(), id)
  const providerFiber = await register(runtime.ctx, provider)
  const registry = runtimeRegistry(runtime.ctx)
  const created = await registry.create(id, createRequest({
    launchRequestId: TeammateLaunchRequestId(`launch-${id}`),
  }))
  return { provider, providerFiber, registry, created }
}

type AttachedRuntimeCase = Awaited<ReturnType<typeof attachedRuntimeCase>>

function runtimeDelivery(fixture: Pick<AttachedRuntimeCase, 'created'>, deliveryId = 'invalid-result-delivery') {
  return {
    nativeHandle: fixture.created.nativeHandle,
    deliveryId: TeamMessageId(deliveryId),
    senderId: SessionId('external-lead'),
    senderName: 'lead',
    content: [] as const,
    delivery: 'quiet' as const,
    signal: SIGNAL,
  }
}

defineTeammateRuntimeProviderConformance({
  name: 'fake native provider',
  testApi: { describe, expect, it },
  createFixture() {
    const store = fakeStore()
    let provider = new FakeDurableRuntime(store)
    return {
      provider,
      createRequest: createRequest(),
      armCreateCancellation() {
        const started = Promise.withResolvers<undefined>()
        provider.create.mockImplementationOnce(async (request) => {
          started.resolve(undefined)
          return await new Promise<never>((_resolve, reject) => {
            const abort = (): void => { reject(abortReason(request.signal)) }
            if (request.signal.aborted) abort()
            else request.signal.addEventListener('abort', abort, { once: true })
          })
        })
        return started.promise
      },
      armDeliveryCancellation() {
        const started = Promise.withResolvers<undefined>()
        provider.deliver.mockImplementationOnce(async (request) => {
          started.resolve(undefined)
          return await new Promise<never>((_resolve, reject) => {
            const abort = (): void => { reject(abortReason(request.signal)) }
            if (request.signal.aborted) abort()
            else request.signal.addEventListener('abort', abort, { once: true })
          })
        })
        return started.promise
      },
      reopen: () => {
        provider = new FakeDurableRuntime(store)
        return provider
      },
      assertSingleRuntime(nativeHandle) {
        expect(store.sessions).toHaveLength(1)
        expect(provider.attachedRuntimes).toEqual(new Set([nativeHandle]))
      },
      assertTurn(nativeHandle, deliveryId, turnId) {
        const session = [...store.sessions.values()].find(candidate => candidate.handle === nativeHandle)
        expect(session?.turns.get(deliveryId)).toBe(turnId)
      },
      assertInterrupted(nativeHandle) {
        expect(provider.interrupt).toHaveBeenLastCalledWith({ nativeHandle })
        const session = [...store.sessions.values()].find(candidate => candidate.handle === nativeHandle)
        expect(session?.status).toBe('idle')
      },
      assertDetached() {
        expect(provider.attachedRuntimes).toHaveLength(0)
        expect(provider.attachedEvaluations).toHaveLength(0)
      },
    }
  },
})

describe('durable teammate runtime registry', () => {
  it('admits bounded opaque durable identities and releases an oversized native result', async () => {
    expect(TeammateLaunchRequestId('launch/request/请求')).toBe('launch/request/请求')
    expect(TeammateRuntimeHandle('native/session/运行')).toBe('native/session/运行')
    expect(() => TeammateLaunchRequestId('')).toThrow(/non-empty.*200 UTF-8 bytes/u)
    expect(() => TeammateRuntimeHandle('运'.repeat(67))).toThrow(/non-empty.*200 UTF-8 bytes/u)

    const { ctx } = await setup()
    const provider = new FakeDurableRuntime(fakeStore())
    const providerFiber = await register(ctx, provider)
    const oversized = 'x'.repeat(201) as ReturnType<typeof TeammateRuntimeHandle>
    provider.create.mockResolvedValueOnce({ nativeHandle: oversized, presence: 'idle' })

    await expect(runtimeRegistry(ctx).create('fake-native', createRequest({
      launchRequestId: TeammateLaunchRequestId('launch/request/请求'),
    }))).rejects.toThrow(/non-empty.*200 UTF-8 bytes/u)
    expect(provider.dispose).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'runtime',
      nativeHandle: oversized,
    }))
    expect(runtimeRegistry(ctx).available('fake-native')).toBe(false)
    await providerFiber.dispose()
  })

  it('passes a detached canonical Profile policy snapshot before native work', async () => {
    const { ctx } = await setup()
    const provider = new FakeDurableRuntime(fakeStore())
    const providerFiber = await register(ctx, providerWith(provider, {
      profileCapabilities: ['persona', 'mission', 'context', 'memory', 'tool-policy', 'hooks'],
    }))
    const profile = runtimeProfile({
      context: [{ id: 'brief', title: 'Brief', content: 'Inspect lifecycle ownership.' }],
      memory: [{ id: 'rule', title: 'Rule', content: 'Never reuse a native handle.' }],
      toolPolicy: { mode: 'allow', names: ['read_file'] },
      hooks: [{ point: 'before-tool', effect: 'deny', matcher: 'shell', text: 'No shell access.' }],
    })
    const request = createRequest({
      profile: { ...profile, secret: 'must-not-cross-the-seam' } as TeammateRuntimeProfileSnapshot,
      requirements: {
        contextMode: 'fresh',
        profileCapabilities: ['persona', 'mission', 'context', 'memory', 'tool-policy', 'hooks'],
        runtimeCapabilities: ['evidence'],
      },
    })

    await runtimeRegistry(ctx).create('fake-native', request)

    expect(provider.create).toHaveBeenCalledWith(expect.objectContaining({ profile }))
    const received = provider.create.mock.calls[0]?.[0].profile
    expect(received).not.toBe(request.profile)
    expect(received).not.toHaveProperty('secret')
    await providerFiber.dispose()
  })

  it('rejects Profile-policy drift before provider work or durable reservation', async () => {
    const { ctx, lead } = await setup()
    const provider = new FakeDurableRuntime(fakeStore())
    const providerFiber = await register(ctx, provider)

    await expect(ctx.agentTeams.spawnTeammate(lead, {
      name: 'profile-drift',
      description: 'Profile drift probe',
      prompt: [],
      context: 'fresh',
      runtime: {
        kind: 'external-agent',
        provider: 'fake-native',
        launchRequestId: TeammateLaunchRequestId('profile-drift-launch'),
        profile: runtimeProfile({ context: [{ id: 'brief', title: 'Brief', content: 'Required.' }] }),
        requirements: {
          contextMode: 'fresh',
          profileCapabilities: ['persona', 'mission'],
          runtimeCapabilities: [],
        },
      },
      signal: SIGNAL,
    })).rejects.toMatchObject({ code: 'TEAM_RUNTIME_CAPABILITY_MISMATCH' })
    expect(provider.create).not.toHaveBeenCalled()
    expect(ctx.agentTeams.listMembers(lead)).toHaveLength(1)
    await providerFiber.dispose()
  })

  it('bounds the complete canonical Profile by UTF-8 bytes at the exact configured edge', async () => {
    const profile = runtimeProfile({ persona: '审'.repeat(8) })
    const exactBytes = Buffer.byteLength(JSON.stringify(profile), 'utf8')
    const exact = await setup({ maxProfileBytes: exactBytes })
    const exactProvider = new FakeDurableRuntime(fakeStore())
    const exactFiber = await register(exact.ctx, exactProvider)
    await expect(runtimeRegistry(exact.ctx).create('fake-native', createRequest({ profile }))).resolves.toBeDefined()
    await exactFiber.dispose()

    const oversized = await setup({ maxProfileBytes: exactBytes - 1 })
    const oversizedProvider = new FakeDurableRuntime(fakeStore())
    const oversizedFiber = await register(oversized.ctx, oversizedProvider)
    await expect(runtimeRegistry(oversized.ctx).create('fake-native', createRequest({ profile })))
      .rejects.toMatchObject({ code: 'TEAM_RUNTIME_CAPABILITY_MISMATCH' })
    expect(oversizedProvider.create).not.toHaveBeenCalled()
    await oversizedFiber.dispose()
  })

  it('bounds the complete normalized evidence page by UTF-8 bytes at the exact configured edge', async () => {
    const page = {
      nativeHandle: TeammateRuntimeHandle('native-1'),
      items: [{
        id: TeammateRuntimeEvidenceId('multibyte-evidence'),
        kind: 'diagnostic' as const,
        timestamp: 1,
        name: '审'.repeat(8),
      }],
      complete: true,
    }
    const exactBytes = Buffer.byteLength(JSON.stringify(page), 'utf8')
    const exact = await setup({ maxEvidenceBytes: exactBytes })
    const exactProvider = new FakeDurableRuntime(fakeStore())
    const exactFiber = await register(exact.ctx, exactProvider)
    const exactRuntime = await runtimeRegistry(exact.ctx).create('fake-native', createRequest())
    exactProvider.evidence.mockResolvedValueOnce(page)
    await expect(runtimeRegistry(exact.ctx).evidence('fake-native', {
      nativeHandle: exactRuntime.nativeHandle,
      limit: 1,
      signal: SIGNAL,
    })).resolves.toEqual(page)
    await exactFiber.dispose()

    const oversized = await setup({ maxEvidenceBytes: exactBytes - 1 })
    const oversizedProvider = new FakeDurableRuntime(fakeStore())
    const oversizedFiber = await register(oversized.ctx, oversizedProvider)
    const oversizedRuntime = await runtimeRegistry(oversized.ctx).create('fake-native', createRequest())
    oversizedProvider.evidence.mockResolvedValueOnce(page)
    await expect(runtimeRegistry(oversized.ctx).evidence('fake-native', {
      nativeHandle: oversizedRuntime.nativeHandle,
      limit: 1,
      signal: SIGNAL,
    })).rejects.toMatchObject({ code: 'TEAM_RUNTIME_IDENTITY_CONFLICT' })
    expect(runtimeRegistry(oversized.ctx).available('fake-native')).toBe(false)
    await oversizedFiber.dispose()
  })

  it('enforces the deployment evidence-item limit before provider work', async () => {
    const { ctx } = await setup({ maxEvidenceItems: 1 })
    const provider = new FakeDurableRuntime(fakeStore())
    const providerFiber = await register(ctx, provider)
    const created = await runtimeRegistry(ctx).create('fake-native', createRequest())

    await expect(runtimeRegistry(ctx).evidence('fake-native', {
      nativeHandle: created.nativeHandle,
      limit: 2,
      signal: SIGNAL,
    })).rejects.toThrow('integer from 1 through 1')
    expect(provider.evidence).not.toHaveBeenCalled()
    await providerFiber.dispose()
  })

  it('captures one detached external launch snapshot across reservation and provider acceptance', async () => {
    const { ctx, lead } = await setup()
    const provider = new FakeDurableRuntime(fakeStore())
    const providerFiber = await register(ctx, provider)
    const first = runtimeProfile({ persona: 'Captured persona.' })
    const changed = runtimeProfile({ persona: 'Mutated persona.' })
    let profileReads = 0
    let promptReads = 0
    let contextReads = 0
    const runtime = {
      kind: 'external-agent' as const,
      provider: 'fake-native',
      launchRequestId: TeammateLaunchRequestId('captured-profile-launch'),
      get profile() {
        profileReads += 1
        return profileReads === 1 ? first : changed
      },
      requirements: createRequest().requirements,
    }

    await ctx.agentTeams.spawnTeammate(lead, {
      name: 'captured-profile',
      description: 'Profile capture probe',
      get prompt() {
        promptReads += 1
        return promptReads === 1
          ? [{ type: 'text' as const, text: 'Captured initial work.' }]
          : [{ type: 'text' as const, text: 'Mutated initial work.' }]
      },
      get context() {
        contextReads += 1
        return contextReads === 1 ? 'fresh' as const : 'fork' as const
      },
      runtime,
      signal: SIGNAL,
    })

    expect(profileReads).toBe(1)
    expect(promptReads).toBe(1)
    expect(contextReads).toBe(1)
    expect(provider.create).toHaveBeenCalledWith(expect.objectContaining({
      initialWork: [{ type: 'text', text: 'Captured initial work.' }],
      profile: first,
    }))
    await providerFiber.dispose()
  })

  it('validates complete provider registrations, stable ordering, and Fiber ownership', async () => {
    const { ctx, teamFiber } = await setup()
    expect(ctx.agentTeams).not.toHaveProperty('teammateRuntimes')
    const invalidBase = new FakeDurableRuntime(fakeStore())
    const invalidProviders = [
      providerWith(invalidBase, { id: 'x'.repeat(201) }),
      providerWith(invalidBase, { id: 'invalid/provider' }),
      providerWith(invalidBase, { displayName: '   ' }),
      providerWith(invalidBase, { displayName: 'x'.repeat(121) }),
      providerWith(invalidBase, { contextModes: [] }),
      providerWith(invalidBase, { contextModes: ['fresh', 'fresh'] }),
      providerWith(invalidBase, { profileCapabilities: ['persona', 'persona'] }),
      providerWith(invalidBase, { runtimeCapabilities: ['evidence', 'evidence'] }),
    ]
    for (const invalid of invalidProviders) {
      expect(() => ctx.agentTeams.registerTeammateRuntimeProvider(invalid))
        .toThrow(expect.objectContaining({ code: 'TEAM_RUNTIME_INVALID_PROVIDER' }))
    }
    expect(() => ctx.agentTeams.registerTeammateRuntimeProvider(providerWith(invalidBase, {
      evidence: undefined,
    }))).toThrow(expect.objectContaining({ code: 'TEAM_RUNTIME_INVALID_PROVIDER' }))
    expect(() => ctx.agentTeams.registerTeammateRuntimeProvider(providerWith(invalidBase, {
      createEvaluationHandle: undefined,
    }))).toThrow(expect.objectContaining({ code: 'TEAM_RUNTIME_INVALID_PROVIDER' }))

    const minimalBase = new FakeDurableRuntime(fakeStore(), 'minimal-contract')
    const minimalRegistration = ctx.agentTeams.registerTeammateRuntimeProvider(providerWith(minimalBase, {
      runtimeCapabilities: [],
      evidence: undefined,
      createEvaluationHandle: undefined,
    }))
    expect(runtimeRegistry(ctx).snapshot()).toContainEqual(expect.objectContaining({ id: 'minimal-contract' }))
    await minimalRegistration()

    const first = new FakeDurableRuntime(fakeStore())
    const firstRegistration = ctx.agentTeams.registerTeammateRuntimeProvider(first)
    expect(() => ctx.agentTeams.registerTeammateRuntimeProvider(new FakeDurableRuntime(fakeStore())))
      .toThrow(expect.objectContaining({ code: 'TEAM_RUNTIME_INVALID_PROVIDER' }))

    const zetaRegistration = ctx.agentTeams.registerTeammateRuntimeProvider(
      new FakeDurableRuntime(fakeStore(), 'zeta-native', 'Shared Name'),
    )
    const alphaRegistration = ctx.agentTeams.registerTeammateRuntimeProvider(
      new FakeDurableRuntime(fakeStore(), 'alpha-native', 'Shared Name'),
    )
    expect(runtimeRegistry(ctx).snapshot().map(provider => provider.id)).toEqual([
      'fake-native',
      'alpha-native',
      'zeta-native',
    ])

    await firstRegistration()
    await expect(firstRegistration.replace(new FakeDurableRuntime(fakeStore())))
      .rejects.toMatchObject({ code: 'TEAM_RUNTIME_UNAVAILABLE' })
    await alphaRegistration()
    await zetaRegistration()

    const registry = runtimeRegistry(ctx)
    const service = ctx.agentTeams
    const closingRegistration = service.registerTeammateRuntimeProvider(
      new FakeDurableRuntime(fakeStore(), 'closing-native'),
    )
    ;(registry as unknown as { closeAdmission(): void }).closeAdmission()
    await expect(closingRegistration.replace(new FakeDurableRuntime(fakeStore(), 'closing-native')))
      .rejects.toMatchObject({ code: 'TEAM_RUNTIME_UNAVAILABLE' })
    await teamFiber.dispose()
    expect(() => service.registerTeammateRuntimeProvider(new FakeDurableRuntime(fakeStore())))
      .toThrow(expect.objectContaining({ code: 'TEAM_RUNTIME_UNAVAILABLE' }))
  })

  it('rolls back every provider reference when registration effect installation fails', async () => {
    const { ctx } = await setup()
    const registry = runtimeRegistry(ctx) as TeamRuntimeTestInternals['teammateRuntimeRegistry'] & {
      register(owner: Context, provider: TeammateRuntimeProvider): TeammateRuntimeRegistration
    }
    const installFailure = new Error('owner effect installation failed')
    const rejectedOwner = {
      effect: () => { throw installFailure },
    } as unknown as Context
    const provider = new FakeDurableRuntime(fakeStore())

    expect(() => registry.register(rejectedOwner, provider)).toThrow(installFailure)
    const internals = registry as unknown as { records: Set<{ provider?: TeammateRuntimeProvider }> }
    expect(internals.records).toHaveLength(0)

    const registration = ctx.agentTeams.registerTeammateRuntimeProvider(provider)
    expect(registration.available()).toBe(true)
    await registration()
  })

  it('quarantines a provider that denies an already persisted native handle during resume', async () => {
    const { ctx } = await setup()
    const provider = new FakeDurableRuntime(fakeStore())
    const registration = ctx.agentTeams.registerTeammateRuntimeProvider(provider)
    const registry = runtimeRegistry(ctx)
    const created = await registry.create('fake-native', createRequest())
    provider.resume.mockResolvedValueOnce(undefined)

    await expect(registry.resume('fake-native', {
      launchRequestId: createRequest().launchRequestId,
      memberId: createRequest().memberId,
      nativeHandle: created.nativeHandle,
      requirements: createRequest().requirements,
      signal: SIGNAL,
    })).rejects.toMatchObject({ code: 'TEAM_RUNTIME_IDENTITY_CONFLICT' })
    expect(registration.available()).toBe(false)
    await registration()
  })

  it('canonicalizes requirements, rejects duplicate capabilities, and normalizes evidence', async () => {
    const { ctx } = await setup()
    const provider = new FakeDurableRuntime(fakeStore())
    const providerFiber = await register(ctx, provider)
    const registry = runtimeRegistry(ctx)

    const canonical = registry.validate('fake-native', {
      contextMode: 'fresh',
      profileCapabilities: ['mission', 'persona'],
      runtimeCapabilities: ['evidence', 'evaluation'],
    })
    expect(canonical).toEqual({
      contextMode: 'fresh',
      profileCapabilities: ['persona', 'mission'],
      runtimeCapabilities: ['evaluation', 'evidence'],
    })
    expect(Object.isFrozen(canonical.profileCapabilities)).toBe(true)

    const duplicateRequirements: TeammateRuntimeRequirements[] = [
      { contextMode: 'fresh', profileCapabilities: ['persona', 'persona'], runtimeCapabilities: [] },
      { contextMode: 'fresh', profileCapabilities: [], runtimeCapabilities: ['evidence', 'evidence'] },
    ]
    for (const requirements of duplicateRequirements) {
      expect(() => registry.validate('fake-native', requirements))
        .toThrow(expect.objectContaining({ code: 'TEAM_RUNTIME_CAPABILITY_MISMATCH' }))
    }

    const created = await registry.create('fake-native', createRequest())
    await expect(registry.resume('fake-native', {
      launchRequestId: TeammateLaunchRequestId('unknown-launch'),
      memberId: SessionId('unknown-member'),
      requirements: createRequest().requirements,
      signal: SIGNAL,
    })).resolves.toBeUndefined()
    const delivery = {
      nativeHandle: created.nativeHandle,
      deliveryId: TeamMessageId('validation-delivery'),
      senderId: SessionId('external-lead'),
      senderName: 'lead',
      content: [{ type: 'text' as const, text: 'Validate provider output.' }],
      delivery: 'wakeup' as const,
      signal: SIGNAL,
    }
    await registry.deliver('fake-native', delivery)

    for (const limit of [0, 1.5, 1_001]) {
      await expect(registry.evidence('fake-native', {
        nativeHandle: created.nativeHandle,
        limit,
        signal: SIGNAL,
      })).rejects.toThrow(TypeError)
    }
    const pagedEvidence = {
      nativeHandle: created.nativeHandle,
      items: [],
      nextCursor: TeammateRuntimeEvidenceCursor('next-page'),
      complete: false,
    }
    provider.evidence.mockImplementationOnce(async () => pagedEvidence)
    await expect(registry.evidence('fake-native', {
      nativeHandle: created.nativeHandle,
      limit: 1,
      signal: SIGNAL,
    })).resolves.toEqual({
      nativeHandle: created.nativeHandle,
      items: [],
      nextCursor: TeammateRuntimeEvidenceCursor('next-page'),
      complete: false,
    })

    const providerEvidence = {
      nativeHandle: created.nativeHandle,
      items: [
        {
          id: TeammateRuntimeEvidenceId('full-evidence'),
          kind: 'tool' as const,
          timestamp: 3,
          turnId: TeammateRuntimeTurnId('evidence-turn'),
          name: 'read',
          outcome: 'completed' as const,
          secret: 'must-not-cross',
        },
        {
          id: TeammateRuntimeEvidenceId('minimal-evidence'),
          kind: 'diagnostic' as const,
          timestamp: 4,
        },
      ],
      complete: true,
    }
    provider.evidence.mockImplementationOnce(async () => providerEvidence)
    const evidence = await registry.evidence('fake-native', {
      nativeHandle: created.nativeHandle,
      cursor: TeammateRuntimeEvidenceCursor('current-page'),
      limit: 2,
      signal: SIGNAL,
    })
    expect(evidence.items).toEqual([
      {
        id: 'full-evidence',
        kind: 'tool',
        timestamp: 3,
        turnId: 'evidence-turn',
        name: 'read',
        outcome: 'completed',
      },
      { id: 'minimal-evidence', kind: 'diagnostic', timestamp: 4 },
    ])
    expect(JSON.stringify(evidence)).not.toContain('must-not-cross')

    await expect(registry.createEvaluationHandle('fake-native', {
      evaluationId: TeammateEvaluationId('missing-capability'),
      profile: runtimeProfile(),
      requirements: { ...createRequest().requirements, runtimeCapabilities: ['evidence'] },
      input: [],
      signal: SIGNAL,
    })).rejects.toMatchObject({ code: 'TEAM_RUNTIME_CAPABILITY_MISMATCH' })
    const evaluationRequest = {
      evaluationId: TeammateEvaluationId('stable-evaluation'),
      profile: runtimeProfile(),
      requirements: { ...createRequest().requirements, runtimeCapabilities: ['evaluation'] as const },
      input: [{ type: 'text' as const, text: 'Evaluate.' }],
      signal: SIGNAL,
    }
    const evaluation = await registry.createEvaluationHandle('fake-native', evaluationRequest)
    await expect(registry.dispose('fake-native', {
      kind: 'evaluation',
      evaluationHandle: TeammateEvaluationHandle('unknown-evaluation'),
      signal: SIGNAL,
    })).rejects.toMatchObject({ code: 'TEAM_RUNTIME_IDENTITY_CONFLICT' })
    await registry.dispose('fake-native', {
      kind: 'evaluation',
      evaluationHandle: evaluation.evaluationHandle,
      signal: SIGNAL,
    })
    await registry.dispose('fake-native', {
      kind: 'runtime',
      nativeHandle: created.nativeHandle,
      signal: SIGNAL,
    })
    expect(registry.runtimePresence('fake-native', created.nativeHandle)).toBe('inactive')
    expect(() => registry.interrupt('fake-native', { nativeHandle: created.nativeHandle }))
      .toThrow(expect.objectContaining({ code: 'TEAM_RUNTIME_IDENTITY_CONFLICT' }))
    await providerFiber.dispose()
  })

  it('quarantines and releases durable resources after semantic identity conflicts', async () => {
    const createCase = await setup()
    const createProvider = new FakeDurableRuntime(fakeStore(), 'invalid-create')
    const createFiber = await register(createCase.ctx, createProvider)
    const createRegistry = runtimeRegistry(createCase.ctx)
    const firstRuntime = await createRegistry.create('invalid-create', createRequest())
    createProvider.create.mockResolvedValueOnce({ nativeHandle: firstRuntime.nativeHandle, presence: 'idle' })
    await expect(createRegistry.create('invalid-create', createRequest({
      launchRequestId: TeammateLaunchRequestId('22222222-2222-4222-8222-222222222222'),
      memberId: SessionId('member-2'),
    })))
      .rejects.toMatchObject({ code: 'TEAM_RUNTIME_IDENTITY_CONFLICT' })
    expect(createRegistry.available('invalid-create')).toBe(false)
    expect(createProvider.dispose).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'runtime',
      nativeHandle: firstRuntime.nativeHandle,
    }))
    await createFiber.dispose()

    const resumeCase = await setup()
    const resumeProvider = new FakeDurableRuntime(fakeStore(), 'invalid-resume')
    const resumeFiber = await register(resumeCase.ctx, resumeProvider)
    const created = await runtimeRegistry(resumeCase.ctx).create('invalid-resume', createRequest())
    const wrongRuntime = TeammateRuntimeHandle('native-wrong-resume')
    resumeProvider.resume.mockResolvedValueOnce({ nativeHandle: wrongRuntime, presence: 'idle' })
    await expect(runtimeRegistry(resumeCase.ctx).resume('invalid-resume', {
      launchRequestId: createRequest().launchRequestId,
      memberId: createRequest().memberId,
      nativeHandle: created.nativeHandle,
      requirements: createRequest().requirements,
      signal: SIGNAL,
    })).rejects.toMatchObject({ code: 'TEAM_RUNTIME_IDENTITY_CONFLICT' })
    expect(runtimeRegistry(resumeCase.ctx).available('invalid-resume')).toBe(false)
    expect(resumeProvider.dispose).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'runtime',
      nativeHandle: wrongRuntime,
    }))
    await resumeFiber.dispose()

    const evaluationCase = await setup()
    const evaluationProvider = new FakeDurableRuntime(fakeStore(), 'invalid-evaluation')
    const evaluationFiber = await register(evaluationCase.ctx, evaluationProvider)
    const evaluationRegistry = runtimeRegistry(evaluationCase.ctx)
    const firstEvaluation = await evaluationRegistry.createEvaluationHandle('invalid-evaluation', {
      evaluationId: TeammateEvaluationId('first-evaluation'),
      profile: runtimeProfile(),
      requirements: { ...createRequest().requirements, runtimeCapabilities: ['evaluation'] },
      input: [],
      signal: SIGNAL,
    })
    evaluationProvider.createEvaluationHandle.mockResolvedValueOnce(firstEvaluation)
    await expect(evaluationRegistry.createEvaluationHandle('invalid-evaluation', {
      evaluationId: TeammateEvaluationId('second-evaluation'),
      profile: runtimeProfile(),
      requirements: { ...createRequest().requirements, runtimeCapabilities: ['evaluation'] },
      input: [],
      signal: SIGNAL,
    })).rejects.toMatchObject({ code: 'TEAM_RUNTIME_IDENTITY_CONFLICT' })
    expect(evaluationRegistry.available('invalid-evaluation')).toBe(false)
    expect(evaluationProvider.dispose).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'evaluation',
      evaluationHandle: firstEvaluation.evaluationHandle,
    }))
    await evaluationFiber.dispose()

    const resultViolations: Array<(fixture: AttachedRuntimeCase) => Promise<unknown>> = [
      async (fixture) => {
        fixture.provider.create.mockResolvedValueOnce({
          ...fixture.created,
          turnId: TeammateRuntimeTurnId('changed-initial-turn'),
        })
        return await fixture.registry.create(fixture.provider.id, createRequest({
          launchRequestId: TeammateLaunchRequestId(`launch-${fixture.provider.id}`),
        }))
      },
      async (fixture) => {
        const request = runtimeDelivery(fixture)
        await fixture.registry.deliver(fixture.provider.id, request)
        fixture.provider.deliver.mockResolvedValueOnce({
          turnId: TeammateRuntimeTurnId('changed-turn'), presence: 'idle',
        })
        return await fixture.registry.deliver(fixture.provider.id, request)
      },
      async (fixture) => {
        const first = await fixture.registry.deliver(
          fixture.provider.id,
          runtimeDelivery(fixture, 'first-delivery'),
        )
        fixture.provider.deliver.mockResolvedValueOnce({ turnId: first.turnId, presence: 'idle' })
        return await fixture.registry.deliver(
          fixture.provider.id,
          runtimeDelivery(fixture, 'second-delivery'),
        )
      },
      async (fixture) => {
        fixture.provider.evidence.mockResolvedValueOnce({
          nativeHandle: TeammateRuntimeHandle('wrong-runtime'), items: [], complete: true,
        })
        return await fixture.registry.evidence(fixture.provider.id, {
          nativeHandle: fixture.created.nativeHandle, limit: 1, signal: SIGNAL,
        })
      },
      async (fixture) => {
        fixture.provider.evidence.mockResolvedValueOnce({
          nativeHandle: fixture.created.nativeHandle,
          items: [
            { id: TeammateRuntimeEvidenceId('one'), kind: 'turn', timestamp: 1 },
            { id: TeammateRuntimeEvidenceId('two'), kind: 'turn', timestamp: 2 },
          ],
          complete: false,
        })
        return await fixture.registry.evidence(fixture.provider.id, {
          nativeHandle: fixture.created.nativeHandle, limit: 1, signal: SIGNAL,
        })
      },
    ]
    for (const [index, violate] of resultViolations.entries()) {
      const fixture = await attachedRuntimeCase(`invalid-result-${index}`)
      await expect(Promise.resolve().then(() => violate(fixture)))
        .rejects.toMatchObject({ code: 'TEAM_RUNTIME_IDENTITY_CONFLICT' })
      expect(fixture.registry.available(fixture.provider.id)).toBe(false)
      await fixture.providerFiber.dispose()
      expect(fixture.provider.attachedRuntimes).toHaveLength(0)
    }
  })

  it('publishes authoritative registration availability when a generation is quarantined', async () => {
    const { ctx } = await setup()
    const provider = new FakeDurableRuntime(fakeStore())
    const registration = ctx.agentTeams.registerTeammateRuntimeProvider(provider)
    const changed = vi.fn()
    const unsubscribe = registration.onAvailabilityChanged(changed)
    expect(registration.available()).toBe(true)
    expect(registration.metadata()).toEqual(expect.objectContaining({ id: 'fake-native' }))
    const registry = runtimeRegistry(ctx)
    const created = await registry.create('fake-native', createRequest())
    const delivery = runtimeDelivery({ created })
    await registry.deliver('fake-native', delivery)
    provider.deliver.mockResolvedValueOnce({ turnId: TeammateRuntimeTurnId('changed-turn'), presence: 'idle' })

    await expect(registry.deliver('fake-native', delivery))
      .rejects.toMatchObject({ code: 'TEAM_RUNTIME_IDENTITY_CONFLICT' })
    expect(registration.available()).toBe(false)
    expect(changed).toHaveBeenCalledTimes(1)
    unsubscribe()
    await registration()
  })

  it('contains throwing availability listeners and diagnostics while withdrawing a provider', async () => {
    const { ctx } = await setup()
    const provider = new FakeDurableRuntime(fakeStore())
    const registration = ctx.agentTeams.registerTeammateRuntimeProvider(provider)
    const registry = runtimeRegistry(ctx)
    await registry.create('fake-native', createRequest())
    const later = vi.fn()
    registration.onAvailabilityChanged(() => { throw new Error('availability listener failed') })
    registration.onAvailabilityChanged(later)
    const error = vi.spyOn(ctx.logger, 'error').mockImplementation(() => {
      throw new Error('diagnostic sink failed')
    })

    await expect(registration()).resolves.toBeUndefined()
    expect(later).toHaveBeenCalledTimes(1)
    expect(registration.available()).toBe(false)
    expect(registry.snapshot()).toEqual([])
    expect(provider.attachedRuntimes).toHaveLength(0)
    error.mockRestore()
  })

  it('fails a synchronous interrupt when registry admission closes reentrantly', async () => {
    const { ctx } = await setup()
    const provider = new FakeDurableRuntime(fakeStore())
    const providerFiber = await register(ctx, provider)
    const registry = runtimeRegistry(ctx)
    const created = await registry.create('fake-native', createRequest())
    provider.interrupt.mockImplementationOnce(() => {
      registry.closeAdmission()
      return { previousStatus: 'running' }
    })

    expect(() => registry.interrupt('fake-native', { nativeHandle: created.nativeHandle }))
      .toThrow(expect.objectContaining({ code: 'TEAM_RUNTIME_UNAVAILABLE' }))
    expect(registry.available('fake-native')).toBe(false)
    expect(registry.runtimePresence('fake-native', created.nativeHandle)).toBe('inactive')

    await providerFiber.dispose()
  })

  it('does not dispose an exact handle twice when explicit disposal wins a retirement race', async () => {
    const { ctx } = await setup({ disposalTimeoutMs: 25 })
    const provider = new FakeDurableRuntime(fakeStore())
    const providerFiber = await register(ctx, provider)
    const registry = runtimeRegistry(ctx)
    const created = await registry.create('fake-native', createRequest())
    const started = Promise.withResolvers<undefined>()
    const released = Promise.withResolvers<undefined>()
    provider.dispose.mockImplementationOnce(async (request) => {
      started.resolve(undefined)
      await released.promise
      if (request.kind === 'runtime') provider.attachedRuntimes.delete(request.nativeHandle)
    })

    const explicit = registry.dispose('fake-native', {
      kind: 'runtime',
      nativeHandle: created.nativeHandle,
      signal: SIGNAL,
    })
    void explicit.catch(() => undefined)
    await started.promise
    const retiring = providerFiber.dispose()
    released.resolve(undefined)

    await expect(explicit).rejects.toMatchObject({ code: 'TEAM_RUNTIME_UNAVAILABLE' })
    await retiring
    expect(provider.dispose.mock.calls.filter(([request]) =>
      request.kind === 'runtime' && request.nativeHandle === created.nativeHandle)).toHaveLength(1)
  })

  it('guards capabilities and exposes every idempotent exact-handle operation', async () => {
    const { ctx } = await setup()
    const store = fakeStore()
    const provider = new FakeDurableRuntime(store)
    const providerFiber = await register(ctx, provider)

    const snapshot = runtimeRegistry(ctx).snapshot()
    expect(snapshot).toEqual([{
      id: 'fake-native',
      displayName: 'Fake Native',
      contextModes: ['fresh'],
      profileCapabilities: ['persona', 'mission'],
      runtimeCapabilities: ['evaluation', 'evidence'],
    }])
    expect(Object.isFrozen(snapshot)).toBe(true)
    expect(Object.isFrozen(snapshot[0])).toBe(true)

    const guarded = new FakeDurableRuntime(fakeStore(), 'minimal-native')
    const minimal: TeammateRuntimeProvider = {
      id: guarded.id,
      displayName: guarded.displayName,
      contextModes: ['fresh'],
      profileCapabilities: ['persona', 'mission'],
      runtimeCapabilities: [],
      create: guarded.create,
      resume: guarded.resume,
      deliver: guarded.deliver,
      interrupt: guarded.interrupt,
      evidence: guarded.evidence,
      createEvaluationHandle: guarded.createEvaluationHandle,
      dispose: guarded.dispose,
    }
    const minimalFiber = await register(ctx, minimal)
    const incompatible = [
      { contextMode: 'fork', profileCapabilities: ['persona', 'mission'], runtimeCapabilities: [] },
      { contextMode: 'fresh', profileCapabilities: ['persona', 'mission', 'context'], runtimeCapabilities: [] },
      { contextMode: 'fresh', profileCapabilities: ['persona', 'mission', 'memory'], runtimeCapabilities: [] },
      { contextMode: 'fresh', profileCapabilities: ['persona', 'mission', 'tool-policy'], runtimeCapabilities: [] },
      { contextMode: 'fresh', profileCapabilities: ['persona', 'mission', 'hooks'], runtimeCapabilities: [] },
      { contextMode: 'fresh', profileCapabilities: ['persona', 'mission'], runtimeCapabilities: ['exact-call-approval'] },
      { contextMode: 'fresh', profileCapabilities: ['persona', 'mission'], runtimeCapabilities: ['sandbox'] },
      { contextMode: 'fresh', profileCapabilities: ['persona', 'mission'], runtimeCapabilities: ['evaluation'] },
      { contextMode: 'fresh', profileCapabilities: ['persona', 'mission'], runtimeCapabilities: ['evidence'] },
      { contextMode: 'fresh', profileCapabilities: ['persona', 'mission'], runtimeCapabilities: ['usage'] },
    ] satisfies TeammateRuntimeRequirements[]
    for (const requirements of incompatible) {
      await expect(runtimeRegistry(ctx).create('minimal-native', createRequest({ requirements })))
        .rejects.toMatchObject({ code: 'TEAM_RUNTIME_CAPABILITY_MISMATCH' })
    }
    expect(guarded.create).not.toHaveBeenCalled()
    const minimalCreated = await runtimeRegistry(ctx).create('minimal-native', createRequest({
      requirements: {
        contextMode: 'fresh',
        profileCapabilities: ['persona', 'mission'],
        runtimeCapabilities: [],
      },
    }))
    await expect(runtimeRegistry(ctx).evidence('minimal-native', {
      nativeHandle: minimalCreated.nativeHandle,
      limit: 1,
      signal: SIGNAL,
    })).rejects.toMatchObject({ code: 'TEAM_RUNTIME_CAPABILITY_MISMATCH' })
    expect(guarded.evidence).not.toHaveBeenCalled()
    await minimalFiber.dispose()

    const created = await runtimeRegistry(ctx).create('fake-native', createRequest())
    const retried = await runtimeRegistry(ctx).create('fake-native', createRequest())
    expect(retried.nativeHandle).toBe(created.nativeHandle)
    expect(store.sessions).toHaveLength(1)

    const delivery = {
      nativeHandle: created.nativeHandle,
      deliveryId: TeamMessageId('team-message-1'),
      senderId: SessionId('external-lead'),
      senderName: 'lead',
      content: [{ type: 'text' as const, text: 'Review this.' }],
      delivery: 'wakeup' as const,
      signal: SIGNAL,
    }
    const firstTurn = await runtimeRegistry(ctx).deliver('fake-native', delivery)
    const retriedTurn = await runtimeRegistry(ctx).deliver('fake-native', delivery)
    expect(retriedTurn.turnId).toBe(firstTurn.turnId)

    expect(runtimeRegistry(ctx).interrupt('fake-native', {
      nativeHandle: created.nativeHandle,
    })).toEqual({ previousStatus: 'idle' })
    await expect(runtimeRegistry(ctx).evidence('fake-native', {
      nativeHandle: created.nativeHandle,
      limit: 20,
      signal: SIGNAL,
    })).resolves.toMatchObject({ nativeHandle: created.nativeHandle, complete: true })
    const evaluation = await runtimeRegistry(ctx).createEvaluationHandle('fake-native', {
      evaluationId: TeammateEvaluationId('eval-1'),
      profile: runtimeProfile(),
      requirements: {
        contextMode: 'fresh',
        profileCapabilities: ['persona', 'mission'],
        runtimeCapabilities: ['evaluation', 'evidence'],
      },
      input: [{ type: 'text', text: 'Evaluate this.' }],
      signal: SIGNAL,
    })
    expect(provider.attachedEvaluations).toContain(evaluation.evaluationHandle)

    const otherStore = fakeStore()
    otherStore.nextHandle = 50
    const other = new FakeDurableRuntime(otherStore, 'other-native')
    const otherFiber = await register(ctx, other)
    const otherCreated = await runtimeRegistry(ctx).create(
      'other-native',
      createRequest({ launchRequestId: TeammateLaunchRequestId('22222222-2222-4222-8222-222222222222') }),
    )
    expect(() => runtimeRegistry(ctx).interrupt('fake-native', {
      nativeHandle: otherCreated.nativeHandle,
    })).toThrow(expect.objectContaining({ code: 'TEAM_RUNTIME_IDENTITY_CONFLICT' }))

    const deliveryStarted = Promise.withResolvers<undefined>()
    provider.deliver.mockImplementationOnce(async (request) => {
      deliveryStarted.resolve(undefined)
      return await new Promise<never>((_resolve, reject) => {
        const abort = (): void => { reject(abortReason(request.signal)) }
        if (request.signal.aborted) abort()
        else request.signal.addEventListener('abort', abort, { once: true })
      })
    })
    const inFlight = runtimeRegistry(ctx).deliver('fake-native', {
      ...delivery,
      deliveryId: TeamMessageId('team-message-in-flight'),
    })
    void inFlight.catch(() => undefined)
    await deliveryStarted.promise
    const removing = providerFiber.dispose()
    await vi.waitFor(() => { expect(runtimeRegistry(ctx).available('fake-native')).toBe(false) })
    await expect(runtimeRegistry(ctx).create('fake-native', createRequest()))
      .rejects.toMatchObject({ code: 'TEAM_RUNTIME_UNAVAILABLE' })
    await expect(inFlight).rejects.toMatchObject({ code: 'TEAM_RUNTIME_UNAVAILABLE' })
    await removing
    expect(runtimeRegistry(ctx).snapshot()).toEqual([
      expect.objectContaining({ id: 'other-native' }),
    ])
    expect(provider.attachedRuntimes).toHaveLength(0)
    expect(provider.attachedEvaluations).toHaveLength(0)
    expect(other.attachedRuntimes).toContain(otherCreated.nativeHandle)
    await otherFiber.dispose()
  })

  it('routes two turns through one native identity across a cold Host restart without one-shot fallback', async () => {
    const storageRoot = mkdtempSync(join(tmpdir(), 'dsh-team-runtime-restart-'))
    roots.push(storageRoot)
    const first = await runtimeContext(storageRoot)
    const leadId = SessionId('external-restart-lead')
    const lead = first.ctx.agentLoop.create(leadId, {})
    const store = fakeStore()
    const provider = new FakeDurableRuntime(store)
    const providerFiber = await register(first.ctx, provider)
    const firstOneShot = vi.spyOn(first.ctx.subagents, 'startContinuable')
    const launchRequestId = TeammateLaunchRequestId('33333333-3333-4333-8333-333333333333')
    const launch = {
      name: 'native-worker',
      description: 'Native worker responsibility',
      prompt: [{ type: 'text' as const, text: 'Initial native assignment.' }],
      context: 'fresh' as const,
      runtime: {
        kind: 'external-agent' as const,
        provider: 'fake-native',
        launchRequestId,
        profile: runtimeProfile(),
        requirements: {
          contextMode: 'fresh' as const,
          profileCapabilities: ['persona', 'mission'] as const,
          runtimeCapabilities: ['evidence'] as const,
        },
      },
      signal: SIGNAL,
    }
    const started = await first.ctx.agentTeams.spawnTeammate(lead, launch)
    expect(started.member).toMatchObject({
      name: 'native-worker',
      status: 'idle',
      provider: 'fake-native',
      externalRuntime: {
        launchRequestId,
        nativeHandle: 'native-1',
        initialTurnId: 'native-initial-1',
      },
    })
    expect(firstOneShot).not.toHaveBeenCalled()
    await expect(first.ctx.agentTeams.spawnTeammate(lead, launch)).resolves.toEqual(started)
    await expect(first.ctx.agentTeams.spawnTeammate(lead, {
      ...launch,
      prompt: [{ text: 'Initial native assignment.', type: 'text' }],
    })).resolves.toEqual(started)
    await expect(first.ctx.agentTeams.spawnTeammate(lead, {
      ...launch,
      prompt: [{ type: 'text', text: 'Conflicting retry.' }],
    })).rejects.toMatchObject({ code: 'TEAM_RUNTIME_IDENTITY_CONFLICT' })
    await expect(first.ctx.agentTeams.spawnTeammate(lead, {
      ...launch,
      runtime: { ...launch.runtime, profile: runtimeProfile({ persona: 'Changed retry persona.' }) },
    })).rejects.toMatchObject({ code: 'TEAM_RUNTIME_IDENTITY_CONFLICT' })
    await expect(first.ctx.agentTeams.sendMessage(lead, {
      target: 'native-worker',
      content: [{ type: 'text', text: 'First native turn.' }],
      delivery: 'wakeup',
      signal: SIGNAL,
    })).resolves.toMatchObject({ status: 'accepted' })
    const delivered = lead.session.ownEvents().findLast(event => event.type === 'team/message/delivered')
    expect(delivered).toMatchObject({
      type: 'team/message/delivered',
      data: {
        targetId: started.member.id,
        nativeTurnId: 'native-turn-1',
      },
    })
    await expect(first.ctx.agentTeams.readTeammateRuntimeEvidence(lead, 'native-worker', {
      limit: 10,
      signal: SIGNAL,
    })).resolves.toMatchObject({
      nativeHandle: 'native-1',
      complete: true,
      items: expect.arrayContaining([
        expect.objectContaining({ turnId: 'native-turn-1', outcome: 'completed' }),
      ]),
    })
    expect(first.ctx.agentTeams.interrupt(lead, 'native-worker')).toEqual({ previousStatus: 'idle' })
    expect(provider.interrupt).toHaveBeenLastCalledWith({ nativeHandle: 'native-1' })

    await providerFiber.dispose()
    expect(first.ctx.agentTeams.listMembers(lead)).toContainEqual(expect.objectContaining({
      name: 'native-worker',
      status: 'inactive',
    }))
    await first.ctx.fiber.dispose()

    const second = await runtimeContext(storageRoot)
    const secondOneShot = vi.spyOn(second.ctx.subagents, 'startContinuable')
    const leadHandle = await second.ctx.agents.resume({ resumeSessionId: leadId, agentOptions: {} })
    await vi.waitFor(() => {
      expect(second.ctx.agentTeams.listMembers(leadHandle.agent)).toContainEqual(expect.objectContaining({
        name: 'native-worker',
        status: 'inactive',
      }))
    })
    const resumedProvider = new FakeDurableRuntime(store)
    const resumedFiber = await register(second.ctx, resumedProvider)
    await vi.waitFor(() => {
      const row = second.ctx.agentTeams.listMembers(leadHandle.agent)
        .find(member => member.name === 'native-worker')
      expect(row).toMatchObject({ name: 'native-worker', status: 'idle' })
      expect(row?.externalRuntime).toMatchObject({ launchRequestId, nativeHandle: 'native-1' })
    })
    expect(store.sessions).toHaveLength(1)
    expect(resumedProvider.resume).toHaveBeenCalledWith(expect.objectContaining({
      launchRequestId,
      memberId: started.member.id,
      nativeHandle: 'native-1',
    }))
    expect(resumedProvider.create).not.toHaveBeenCalled()
    await expect(second.ctx.agentTeams.sendMessage(leadHandle.agent, {
      target: 'native-worker',
      content: [{ type: 'text', text: 'Second native turn.' }],
      delivery: 'wakeup',
      signal: SIGNAL,
    })).resolves.toMatchObject({ status: 'accepted' })
    expect([...store.sessions.values()][0]?.turns).toHaveLength(2)
    expect(firstOneShot).not.toHaveBeenCalled()
    expect(secondOneShot).not.toHaveBeenCalled()

    await resumedFiber.dispose()
    await leadHandle.dispose()
    await second.ctx.fiber.dispose()
  })

  it('wakes Team change waiters when an external provider disappears and reattaches', async () => {
    const { ctx, lead } = await setup()
    const store = fakeStore()
    const provider = new FakeDurableRuntime(store)
    const providerFiber = await register(ctx, provider)
    await ctx.agentTeams.spawnTeammate(lead, {
      name: 'observable-native',
      description: 'Observable native responsibility',
      prompt: [{ type: 'text', text: 'Remain observable.' }],
      context: 'fresh',
      runtime: {
        kind: 'external-agent',
        provider: 'fake-native',
        launchRequestId: TeammateLaunchRequestId('observable-native-launch'),
        profile: runtimeProfile(),
        requirements: createRequest().requirements,
      },
      signal: SIGNAL,
    })
    const observeWake = async (wait: Promise<unknown>): Promise<unknown> => await Promise.race([
      wait,
      new Promise((resolve) => { setTimeout(() => { resolve('missed-change') }, 500) }),
    ])

    const removalWait = ctx.agentTeams.waitForChange(lead, 10_000, SIGNAL)
    await providerFiber.dispose()
    await expect(observeWake(removalWait)).resolves.toEqual({ timedOut: false })
    expect(ctx.agentTeams.listMembers(lead)).toContainEqual(expect.objectContaining({
      name: 'observable-native',
      status: 'inactive',
    }))

    const resumedProvider = new FakeDurableRuntime(store)
    const resumeStarted = Promise.withResolvers<undefined>()
    const releaseResume = Promise.withResolvers<undefined>()
    const baseResume = resumedProvider.resume.getMockImplementation()
    if (baseResume === undefined) throw new Error('fake provider resume implementation is missing')
    resumedProvider.resume.mockImplementation(async (request) => {
      resumeStarted.resolve(undefined)
      await releaseResume.promise
      return await baseResume(request)
    })
    const providerReturnWait = ctx.agentTeams.waitForChange(lead, 10_000, SIGNAL)
    const resumedFiber = await register(ctx, resumedProvider)
    await expect(observeWake(providerReturnWait)).resolves.toEqual({ timedOut: false })
    await resumeStarted.promise
    expect(ctx.agentTeams.listMembers(lead)).toContainEqual(expect.objectContaining({
      name: 'observable-native',
      status: 'inactive',
    }))

    const attachedWait = ctx.agentTeams.waitForChange(lead, 10_000, SIGNAL)
    releaseResume.resolve(undefined)
    await expect(observeWake(attachedWait)).resolves.toEqual({ timedOut: false })
    expect(ctx.agentTeams.listMembers(lead)).toContainEqual(expect.objectContaining({
      name: 'observable-native',
      status: 'idle',
    }))
    await resumedFiber.dispose()
  })

  it('wakes Team change waiters when provider-native work settles asynchronously', async () => {
    const { ctx, lead } = await setup()
    const provider = new FakeDurableRuntime(fakeStore())
    const providerFiber = await register(ctx, provider)
    const started = await ctx.agentTeams.spawnTeammate(lead, {
      name: 'async-native',
      description: 'Asynchronous native responsibility',
      prompt: [{ type: 'text', text: 'Remain observable.' }],
      context: 'fresh',
      runtime: {
        kind: 'external-agent',
        provider: 'fake-native',
        launchRequestId: TeammateLaunchRequestId('async-native-launch'),
        profile: runtimeProfile(),
        requirements: createRequest().requirements,
      },
      signal: SIGNAL,
    })
    const nativeHandle = started.member.externalRuntime?.nativeHandle
    if (nativeHandle === undefined) throw new Error('external teammate lost its native handle')
    const baseDeliver = provider.deliver.getMockImplementation()
    if (baseDeliver === undefined) throw new Error('fake provider deliver implementation is missing')
    provider.deliver.mockImplementationOnce(async (request) => {
      const result = await baseDeliver(request)
      provider.publishPresence(request.nativeHandle, 'running')
      return { ...result, presence: 'running' }
    })
    await ctx.agentTeams.sendMessage(lead, {
      target: 'async-native',
      content: [{ type: 'text', text: 'Run asynchronously.' }],
      delivery: 'wakeup',
      signal: SIGNAL,
    })
    expect(ctx.agentTeams.listMembers(lead)).toContainEqual(expect.objectContaining({
      name: 'async-native',
      status: 'running',
    }))

    const changed = ctx.agentTeams.waitForChange(lead, 10_000, SIGNAL)
    provider.publishPresence(nativeHandle, 'idle')
    await expect(Promise.race([
      changed,
      new Promise((resolve) => { setTimeout(() => { resolve('missed-change') }, 500) }),
    ])).resolves.toEqual({ timedOut: false })
    expect(ctx.agentTeams.listMembers(lead)).toContainEqual(expect.objectContaining({
      name: 'async-native',
      status: 'idle',
    }))
    await providerFiber.dispose()
  })

  it('keeps an inactive native interrupt inactive and wakes its Team waiter', async () => {
    const { ctx, lead } = await setup()
    const provider = new FakeDurableRuntime(fakeStore())
    const providerFiber = await register(ctx, provider)
    const started = await ctx.agentTeams.spawnTeammate(lead, {
      name: 'inactive-native',
      description: 'Inactive interrupt responsibility',
      prompt: [{ type: 'text', text: 'Become inactive.' }],
      context: 'fresh',
      runtime: {
        kind: 'external-agent',
        provider: 'fake-native',
        launchRequestId: TeammateLaunchRequestId('inactive-native-launch'),
        profile: runtimeProfile(),
        requirements: createRequest().requirements,
      },
      signal: SIGNAL,
    })
    const nativeHandle = started.member.externalRuntime?.nativeHandle
    if (nativeHandle === undefined) throw new Error('external teammate lost its native handle')
    provider.interrupt.mockReturnValueOnce({ previousStatus: 'inactive' })
    const changed = ctx.agentTeams.waitForChange(lead, 10_000, SIGNAL)

    expect(ctx.agentTeams.interrupt(lead, 'inactive-native')).toEqual({ previousStatus: 'inactive' })
    await expect(Promise.race([
      changed,
      new Promise((resolve) => { setTimeout(() => { resolve('missed-change') }, 500) }),
    ])).resolves.toEqual({ timedOut: false })
    expect(ctx.agentTeams.listMembers(lead)).toContainEqual(expect.objectContaining({
      id: started.member.id,
      status: 'inactive',
    }))
    await providerFiber.dispose()
    expect(provider.dispose).toHaveBeenCalledWith(expect.objectContaining({ kind: 'runtime', nativeHandle }))
    expect(provider.attachedRuntimes).toHaveLength(0)
  })

  it('rejects external context drift and preserves failed retry identity', async () => {
    const { ctx, lead } = await setup()
    const provider = new FakeDurableRuntime(fakeStore())
    const providerFiber = await register(ctx, provider)
    await expect(ctx.agentTeams.spawnTeammate(lead, {
      name: 'context-drift',
      description: 'Context drift probe',
      prompt: [],
      context: 'fork',
      runtime: {
        kind: 'external-agent',
        provider: 'fake-native',
        launchRequestId: TeammateLaunchRequestId('context-drift-launch'),
        profile: runtimeProfile(),
        requirements: {
          contextMode: 'fresh',
          profileCapabilities: ['persona', 'mission'],
          runtimeCapabilities: [],
        },
      },
      signal: SIGNAL,
    })).rejects.toMatchObject({ code: 'TEAM_RUNTIME_CAPABILITY_MISMATCH' })
    expect(ctx.agentTeams.listMembers(lead)).toHaveLength(1)

    provider.create.mockRejectedValueOnce(new Error('native launch rejected'))
    const failedLaunch = {
      name: 'failed-native',
      description: 'Failed native responsibility',
      prompt: [{ type: 'text' as const, text: 'Fail once.' }],
      context: 'fresh' as const,
      runtime: {
        kind: 'external-agent' as const,
        provider: 'fake-native',
        launchRequestId: TeammateLaunchRequestId('failed-native-launch'),
        profile: runtimeProfile(),
        requirements: createRequest().requirements,
      },
      signal: SIGNAL,
    }
    await expect(ctx.agentTeams.spawnTeammate(lead, failedLaunch)).rejects.toThrow('native launch rejected')
    const row = ctx.agentTeams.listMembers(lead).find(member => member.name === failedLaunch.name)
    if (row?.externalRuntime === undefined || row.description === undefined || row.context === undefined) {
      throw new Error('missing failed external provisioning row')
    }
    lead.session.append('team/member', {
      version: 1,
      teamId: TeamId(lead.id),
      member: {
        id: row.id,
        name: row.name,
        description: row.description,
        provider: 'fake-native',
        context: row.context,
        externalRuntime: row.externalRuntime,
        phase: 'failed',
        error: 'native launch rejected',
      },
    })
    await expect(ctx.agentTeams.spawnTeammate(lead, failedLaunch))
      .rejects.toMatchObject({ code: 'TEAM_PROVISIONING_CONFLICT' })
    await providerFiber.dispose()
  })

  it('cleans an accepted native handle when recovery wins the terminal roster race', async () => {
    const { ctx, lead } = await setup()
    const provider = new FakeDurableRuntime(fakeStore())
    const providerFiber = await register(ctx, provider)
    const baseCreate = provider.create.getMockImplementation()
    if (baseCreate === undefined) throw new Error('fake provider create implementation is missing')
    const raceCreate = (cleanupFails: boolean): void => {
      provider.create.mockImplementationOnce(async (request) => {
        const accepted = await baseCreate(request)
        const row = ctx.agentTeams.listMembers(lead).find(member => member.id === request.memberId)
        if (row?.externalRuntime === undefined || row.description === undefined || row.context === undefined) {
          throw new Error('missing external provisioning row during settlement race')
        }
        lead.session.append('team/member', {
          version: 1,
          teamId: TeamId(lead.id),
          member: {
            id: row.id,
            name: row.name,
            description: row.description,
            provider: 'fake-native',
            context: row.context,
            externalRuntime: row.externalRuntime,
            phase: 'failed',
            error: 'recovery won the race',
          },
        })
        if (cleanupFails) provider.dispose.mockRejectedValueOnce(new Error('race cleanup failed'))
        return accepted
      })
    }
    const launch = (name: string, launchRequestId: string) => ctx.agentTeams.spawnTeammate(lead, {
      name,
      description: `${name} responsibility`,
      prompt: [],
      context: 'fresh',
      runtime: {
        kind: 'external-agent',
        provider: 'fake-native',
        launchRequestId: TeammateLaunchRequestId(launchRequestId),
        profile: runtimeProfile(),
        requirements: createRequest().requirements,
      },
      signal: SIGNAL,
    })

    raceCreate(false)
    await expect(launch('race-clean', 'race-clean-launch'))
      .rejects.toMatchObject({ code: 'TEAM_PROVISIONING_CONFLICT' })
    raceCreate(true)
    await expect(launch('race-cleanup-fails', 'race-cleanup-fails-launch'))
      .rejects.toThrow(/external provisioning conflict cleanup failed/)
    await providerFiber.dispose()
  })

  it('reconciles an external provisioning record only to the provider-native identity', async () => {
    const { ctx, lead } = await setup()
    const internals = runtimeInternals(ctx)
    const launchRequestId = TeammateLaunchRequestId('recovery-native-launch')
    const member = externalMember('recovery-native-member', 'recovery-native', launchRequestId)
    lead.session.append('team/member', { version: 1, teamId: TeamId(lead.id), member })

    await internals.roster.reconcileProvisioning(lead, SIGNAL)
    expect(ctx.agentTeams.listMembers(lead)).toContainEqual(expect.objectContaining({
      name: member.name,
      status: 'provisioning',
    }))

    const store = fakeStore()
    const provider = new FakeDurableRuntime(store)
    const providerFiber = await register(ctx, provider)
    await vi.waitFor(() => { expect(provider.resume).toHaveBeenCalled() })
    expect(ctx.agentTeams.listMembers(lead)).toContainEqual(expect.objectContaining({
      name: member.name,
      status: 'provisioning',
    }))
    const memberRuntime = member.externalRuntime
    if (memberRuntime === undefined) throw new Error('external fixture lost its runtime snapshot')
    await provider.create({
      launchRequestId,
      memberId: member.id,
      memberName: member.name,
      description: member.description,
      initialWork: [],
      profile: runtimeProfile(),
      requirements: memberRuntime.requirements,
      signal: SIGNAL,
    })
    await internals.roster.reconcileProvisioning(lead, SIGNAL)
    const recovered = ctx.agentTeams.listMembers(lead).find(candidate => candidate.name === member.name)
    expect(recovered).toMatchObject({ name: member.name, status: 'idle' })
    expect(recovered?.externalRuntime).toMatchObject({ nativeHandle: 'native-1' })

    const synthetic = externalMember(
      'synthetic-recovery-member',
      'synthetic-recovery',
      TeammateLaunchRequestId('synthetic-recovery-launch'),
    )
    provider.resume.mockRejectedValueOnce(new Error('unexpected resume failure'))
    await expect(internals.roster.reconcileExternalProvisioning(lead, synthetic, SIGNAL))
      .rejects.toThrow('unexpected resume failure')
    provider.resume.mockRejectedValueOnce(new TeammateRuntimeError(
      'native identity conflict',
      'TEAM_RUNTIME_IDENTITY_CONFLICT',
    ))
    await expect(internals.roster.reconcileExternalProvisioning(lead, synthetic, SIGNAL))
      .rejects.toMatchObject({ code: 'TEAM_RUNTIME_IDENTITY_CONFLICT' })

    const raced = externalMember(
      'raced-recovery-member',
      'raced-recovery',
      TeammateLaunchRequestId('raced-recovery-launch'),
    )
    lead.session.append('team/member', { version: 1, teamId: TeamId(lead.id), member: raced })
    provider.resume.mockImplementationOnce(async () => {
      lead.session.append('team/member', {
        version: 1,
        teamId: TeamId(lead.id),
        member: { ...raced, phase: 'failed', error: 'concurrent recovery failed' },
      })
      return { nativeHandle: TeammateRuntimeHandle('native-raced'), presence: 'idle' }
    })
    await internals.roster.reconcileExternalProvisioning(lead, raced, SIGNAL)
    expect(ctx.agentTeams.listMembers(lead)).toContainEqual(expect.objectContaining({
      name: raced.name,
      status: 'failed',
    }))

    provider.resume.mockRejectedValueOnce(new Error('active resume failed'))
    await expect(internals.roster.resumeExternalMembers(lead, SIGNAL)).rejects.toThrow('active resume failed')
    provider.resume.mockRejectedValueOnce(new TeammateRuntimeError(
      'active identity conflict',
      'TEAM_RUNTIME_IDENTITY_CONFLICT',
    ))
    await expect(internals.roster.resumeExternalMembers(lead, SIGNAL))
      .rejects.toMatchObject({ code: 'TEAM_RUNTIME_IDENTITY_CONFLICT' })
    await providerFiber.dispose()
  })

  it('atomically replaces one provider generation and reattaches the same durable handle', async () => {
    const { ctx } = await setup()
    const store = fakeStore()
    const original = new FakeDurableRuntime(store)
    let registration: TeammateRuntimeRegistration | undefined
    const providerFiber = ctx.plugin({
      inject: ['agentTeams'],
      apply(pluginCtx: Context) {
        registration = pluginCtx.agentTeams.registerTeammateRuntimeProvider(original)
      },
    })
    await providerFiber
    if (registration === undefined) throw new Error('runtime registration was not installed')
    const created = await runtimeRegistry(ctx).create('fake-native', createRequest())

    const replacement = new FakeDurableRuntime(store, 'fake-native', 'Fake Native v2')
    const deliveryStarted = Promise.withResolvers<undefined>()
    const releaseDelivery = Promise.withResolvers<undefined>()
    original.deliver.mockImplementationOnce(async (request) => {
      deliveryStarted.resolve(undefined)
      await releaseDelivery.promise
      throw abortReason(request.signal)
    })
    const retiringDelivery = runtimeRegistry(ctx).deliver('fake-native', {
      nativeHandle: created.nativeHandle,
      deliveryId: TeamMessageId('generation-retirement'),
      senderId: SessionId('external-lead'),
      senderName: 'lead',
      content: [],
      delivery: 'quiet',
      signal: SIGNAL,
    })
    void retiringDelivery.catch(() => undefined)
    await deliveryStarted.promise
    const replacing = registration.replace(replacement)
    await vi.waitFor(() => {
      expect(runtimeRegistry(ctx).snapshot()).toEqual([])
    })
    await expect(runtimeRegistry(ctx).resume('fake-native', {
      launchRequestId: createRequest().launchRequestId,
      memberId: createRequest().memberId,
      nativeHandle: created.nativeHandle,
      requirements: createRequest().requirements,
      signal: SIGNAL,
    })).rejects.toMatchObject({ code: 'TEAM_RUNTIME_UNAVAILABLE' })
    releaseDelivery.resolve(undefined)
    await expect(retiringDelivery).rejects.toMatchObject({ code: 'TEAM_RUNTIME_UNAVAILABLE' })
    await replacing
    expect(runtimeRegistry(ctx).snapshot()).toEqual([
      expect.objectContaining({ id: 'fake-native', displayName: 'Fake Native v2' }),
    ])
    await expect(runtimeRegistry(ctx).resume('fake-native', {
      launchRequestId: createRequest().launchRequestId,
      memberId: createRequest().memberId,
      nativeHandle: created.nativeHandle,
      requirements: createRequest().requirements,
      signal: SIGNAL,
    })).resolves.toMatchObject({ nativeHandle: created.nativeHandle })
    expect(original.attachedRuntimes).toHaveLength(0)
    expect(runtimeRegistry(ctx).runtimePresence('fake-native', created.nativeHandle)).toBe('idle')
    expect(replacement.attachedRuntimes).toContain(created.nativeHandle)
    await expect(registration.replace(new FakeDurableRuntime(store, 'different-native')))
      .rejects.toMatchObject({ code: 'TEAM_RUNTIME_INVALID_PROVIDER' })
    expect(runtimeRegistry(ctx).snapshot()).toEqual([
      expect.objectContaining({ id: 'fake-native', displayName: 'Fake Native v2' }),
    ])

    const closingDeliveryStarted = Promise.withResolvers<undefined>()
    const releaseClosingDelivery = Promise.withResolvers<undefined>()
    replacement.deliver.mockImplementationOnce(async (request) => {
      closingDeliveryStarted.resolve(undefined)
      await releaseClosingDelivery.promise
      throw abortReason(request.signal)
    })
    const closingDelivery = runtimeRegistry(ctx).deliver('fake-native', {
      nativeHandle: created.nativeHandle,
      deliveryId: TeamMessageId('closing-replacement'),
      senderId: SessionId('external-lead'),
      senderName: 'lead',
      content: [],
      delivery: 'quiet',
      signal: SIGNAL,
    })
    void closingDelivery.catch(() => undefined)
    await closingDeliveryStarted.promise
    const interruptedReplacement = registration.replace(
      new FakeDurableRuntime(store, 'fake-native', 'Fake Native v3'),
    )
    await vi.waitFor(() => { expect(runtimeRegistry(ctx).snapshot()).toEqual([]) })
    runtimeRegistry(ctx).closeAdmission()
    releaseClosingDelivery.resolve(undefined)
    await expect(closingDelivery).rejects.toMatchObject({ code: 'TEAM_RUNTIME_UNAVAILABLE' })
    await expect(interruptedReplacement).rejects.toMatchObject({ code: 'TEAM_RUNTIME_UNAVAILABLE' })
    expect(runtimeRegistry(ctx).snapshot()).toEqual([])

    await providerFiber.dispose()
    expect(replacement.attachedRuntimes).toHaveLength(0)
  })

  it('fails a replacement closed when the retiring provider cannot release its resources', async () => {
    const { ctx } = await setup()
    const original = new FakeDurableRuntime(fakeStore())
    const other = new FakeDurableRuntime(fakeStore(), 'other-native')
    const originalRegistration = ctx.agentTeams.registerTeammateRuntimeProvider(original)
    const otherRegistration = ctx.agentTeams.registerTeammateRuntimeProvider(other)
    const registry = runtimeRegistry(ctx)
    await registry.create('fake-native', createRequest())
    original.dispose.mockRejectedValueOnce(new Error('retiring cleanup failed'))
    const replacement = new FakeDurableRuntime(fakeStore(), 'fake-native', 'Fake Native v2')

    await expect(originalRegistration.replace(replacement)).rejects.toThrow(/retirement failed/u)
    expect(registry.available('fake-native')).toBe(false)
    expect(registry.snapshot()).toEqual([expect.objectContaining({ id: 'other-native' })])
    await expect(registry.create('fake-native', createRequest({
      launchRequestId: TeammateLaunchRequestId('replacement-must-not-run'),
    }))).rejects.toMatchObject({ code: 'TEAM_RUNTIME_UNAVAILABLE' })
    expect(replacement.create).not.toHaveBeenCalled()
    expect(() => ctx.agentTeams.registerTeammateRuntimeProvider(
      new FakeDurableRuntime(fakeStore()),
    )).toThrow(expect.objectContaining({ code: 'TEAM_RUNTIME_INVALID_PROVIDER' }))

    original.dispose.mockImplementation(async (request) => {
      if (request.kind === 'runtime') original.attachedRuntimes.delete(request.nativeHandle)
      else original.attachedEvaluations.delete(request.evaluationHandle)
    })
    await originalRegistration()
    const recoveredRegistration = ctx.agentTeams.registerTeammateRuntimeProvider(
      new FakeDurableRuntime(fakeStore()),
    )
    expect(recoveredRegistration.available()).toBe(true)
    await recoveredRegistration()
    await otherRegistration()
  })

  it('keeps a quarantined provider id occupied until failed exact-handle cleanup is retried', async () => {
    const { ctx } = await setup()
    const provider = new FakeDurableRuntime(fakeStore())
    const registration = ctx.agentTeams.registerTeammateRuntimeProvider(provider)
    const registry = runtimeRegistry(ctx)
    const created = await registry.create('fake-native', createRequest())
    const delivery = {
      nativeHandle: created.nativeHandle,
      deliveryId: TeamMessageId('quarantine-occupancy'),
      senderId: SessionId('external-lead'),
      senderName: 'lead',
      content: [] as const,
      delivery: 'quiet' as const,
      signal: SIGNAL,
    }
    await registry.deliver('fake-native', delivery)
    provider.deliver.mockResolvedValueOnce({
      turnId: TeammateRuntimeTurnId('changed-turn'),
      presence: 'idle',
    })
    provider.dispose.mockRejectedValueOnce(new Error('quarantine cleanup failed'))

    await expect(registry.deliver('fake-native', delivery)).rejects.toThrow(/cleanup failed/u)
    expect(() => ctx.agentTeams.registerTeammateRuntimeProvider(
      new FakeDurableRuntime(fakeStore()),
    )).toThrow(expect.objectContaining({ code: 'TEAM_RUNTIME_INVALID_PROVIDER' }))

    provider.dispose.mockImplementation(async (request) => {
      if (request.kind === 'runtime') provider.attachedRuntimes.delete(request.nativeHandle)
      else provider.attachedEvaluations.delete(request.evaluationHandle)
    })
    await registration()
    const recoveredRegistration = ctx.agentTeams.registerTeammateRuntimeProvider(
      new FakeDurableRuntime(fakeStore()),
    )
    await recoveredRegistration()
  })

  it('keeps caller cancellation ownership only until native initial-work acceptance', async () => {
    const { ctx, lead } = await setup()
    const store = fakeStore()
    const provider = new FakeDurableRuntime(store)
    const providerFiber = await register(ctx, provider)
    const launchRequestId = TeammateLaunchRequestId('44444444-4444-4444-8444-444444444444')
    const beforeAcceptance = new AbortController()
    provider.create.mockImplementationOnce(async (request) => {
      return await new Promise<never>((_resolve, reject) => {
        const abort = (): void => { reject(abortReason(request.signal)) }
        if (request.signal.aborted) abort()
        else request.signal.addEventListener('abort', abort, { once: true })
      })
    })
    const interrupted = ctx.agentTeams.spawnTeammate(lead, {
      name: 'cancel-owner',
      description: 'Cancellation ownership probe',
      prompt: [{ type: 'text', text: 'Accept this durably.' }],
      context: 'fresh',
      runtime: {
        kind: 'external-agent',
        provider: 'fake-native',
        launchRequestId,
        profile: runtimeProfile(),
        requirements: {
          contextMode: 'fresh',
          profileCapabilities: ['persona', 'mission'],
          runtimeCapabilities: ['evidence'],
        },
      },
      signal: beforeAcceptance.signal,
    })
    await vi.waitFor(() => { expect(provider.create).toHaveBeenCalledTimes(1) })
    beforeAcceptance.abort(new Error('caller disconnected before acceptance'))
    await expect(interrupted).rejects.toThrow('caller disconnected before acceptance')
    expect(ctx.agentTeams.listMembers(lead)).toContainEqual(expect.objectContaining({
      name: 'cancel-owner',
      status: 'provisioning',
    }))

    await expect(ctx.agentTeams.spawnTeammate(lead, {
      name: 'cancel-owner',
      description: 'Cancellation ownership probe',
      prompt: [{ type: 'text', text: 'Accept this durably.' }],
      context: 'fresh',
      runtime: {
        kind: 'external-agent',
        provider: 'fake-native',
        launchRequestId,
        profile: runtimeProfile(),
        requirements: {
          contextMode: 'fresh',
          profileCapabilities: ['mission', 'persona'],
          runtimeCapabilities: ['evidence'],
        },
      },
      signal: SIGNAL,
    })).resolves.toMatchObject({ member: { name: 'cancel-owner', status: 'idle' } })
    expect(store.sessions).toHaveLength(1)

    const afterAcceptance = new AbortController()
    const baseCreate = provider.create.getMockImplementation()
    if (baseCreate === undefined) throw new Error('fake provider create implementation is missing')
    provider.create.mockImplementationOnce(async (request) => {
      const accepted = await baseCreate(request)
      afterAcceptance.abort(new Error('caller disconnected after acceptance'))
      return accepted
    })
    await expect(ctx.agentTeams.spawnTeammate(lead, {
      name: 'accepted-owner',
      description: 'Post-acceptance cancellation probe',
      prompt: [{ type: 'text', text: 'Accept before disconnect.' }],
      context: 'fresh',
      runtime: {
        kind: 'external-agent',
        provider: 'fake-native',
        launchRequestId: TeammateLaunchRequestId('55555555-5555-4555-8555-555555555555'),
        profile: runtimeProfile(),
        requirements: {
          contextMode: 'fresh',
          profileCapabilities: ['persona', 'mission'],
          runtimeCapabilities: ['evidence'],
        },
      },
      signal: afterAcceptance.signal,
    })).resolves.toMatchObject({ member: { name: 'accepted-owner', status: 'idle' } })
    expect(afterAcceptance.signal.aborted).toBe(true)
    expect(store.sessions).toHaveLength(2)

    await providerFiber.dispose()
  })

  it('contains provider cleanup failures in Team disposal', async () => {
    const { ctx, teamFiber } = await setup({ disposalTimeoutMs: 25 })
    const provider = new FakeDurableRuntime(fakeStore())
    await register(ctx, provider)
    await runtimeRegistry(ctx).create('fake-native', createRequest())
    await runtimeRegistry(ctx).createEvaluationHandle('fake-native', {
      evaluationId: TeammateEvaluationId('cleanup-evaluation'),
      profile: runtimeProfile(),
      requirements: { ...createRequest().requirements, runtimeCapabilities: ['evaluation'] },
      input: [],
      signal: SIGNAL,
    })
    provider.dispose.mockRejectedValue(new Error('native cleanup failed'))

    await expect((ctx.agentTeams as unknown as { disposeRuntime(): Promise<void> }).disposeRuntime())
      .rejects.toThrow(/runtime disposal failed/)
    await teamFiber.dispose()
  })

  it('keeps provider retirement pending until an admitted operation reaches quiescence', async () => {
    const { ctx } = await setup({ disposalTimeoutMs: 25 })
    const provider = new FakeDurableRuntime(fakeStore())
    const providerFiber = await register(ctx, provider)
    const created = await runtimeRegistry(ctx).create('fake-native', createRequest())
    const started = Promise.withResolvers<undefined>()
    const released = Promise.withResolvers<undefined>()
    provider.deliver.mockImplementationOnce(async () => {
      started.resolve(undefined)
      await released.promise
      return { turnId: TeammateRuntimeTurnId('released-turn'), presence: 'idle' }
    })
    const pending = runtimeRegistry(ctx).deliver('fake-native', {
      nativeHandle: created.nativeHandle,
      deliveryId: TeamMessageId('ignored-retirement'),
      senderId: SessionId('external-lead'),
      senderName: 'lead',
      content: [],
      delivery: 'quiet',
      signal: SIGNAL,
    })
    void pending.catch(() => undefined)
    await started.promise

    let retired = false
    const retiring = providerFiber.dispose().then(() => { retired = true })
    await new Promise(resolve => setTimeout(resolve, 35))
    expect(retired).toBe(false)
    expect(runtimeRegistry(ctx).available('fake-native')).toBe(false)
    released.resolve(undefined)
    await retiring
    await expect(pending).rejects.toMatchObject({ code: 'TEAM_RUNTIME_UNAVAILABLE' })
  })

  it('aborts but still awaits a native disposer until it reaches quiescence', async () => {
    const { ctx } = await setup({ disposalTimeoutMs: 25 })
    const provider = new FakeDurableRuntime(fakeStore())
    const providerFiber = await register(ctx, provider)
    await runtimeRegistry(ctx).create('fake-native', createRequest())
    const released = Promise.withResolvers<undefined>()
    let cleanupSignal: AbortSignal | undefined
    provider.dispose.mockImplementationOnce(async (request) => {
      cleanupSignal = request.signal
      await released.promise
    })

    let retired = false
    const retiring = providerFiber.dispose().then(() => { retired = true })
    await new Promise(resolve => setTimeout(resolve, 35))
    expect(cleanupSignal?.aborted).toBe(true)
    expect(retired).toBe(false)
    expect(runtimeRegistry(ctx).available('fake-native')).toBe(false)
    released.resolve(undefined)
    await retiring
  })

  it('starts cleanup for every provider before awaiting a hung generation', async () => {
    const { ctx } = await setup({ disposalTimeoutMs: 25 })
    const first = new FakeDurableRuntime(fakeStore(), 'first-native')
    const second = new FakeDurableRuntime(fakeStore(), 'second-native')
    await register(ctx, first)
    await register(ctx, second)
    const registry = runtimeRegistry(ctx)
    await registry.create('first-native', createRequest({
      launchRequestId: TeammateLaunchRequestId('first-cleanup-launch'),
    }))
    await registry.create('second-native', createRequest({
      launchRequestId: TeammateLaunchRequestId('second-cleanup-launch'),
      memberId: SessionId('member-2'),
    }))
    const releaseFirst = Promise.withResolvers<undefined>()
    first.dispose.mockImplementationOnce(async () => { await releaseFirst.promise })

    registry.closeAdmission()
    let settled = false
    const disposal = registry.disposeAttached().then(() => { settled = true })
    await vi.waitFor(() => { expect(second.dispose).toHaveBeenCalledTimes(1) })
    expect(settled).toBe(false)
    releaseFirst.resolve(undefined)
    await disposal
  })

  it('releases every provider and correlation index after final registry disposal', async () => {
    const { ctx } = await setup()
    const provider = new FakeDurableRuntime(fakeStore())
    const registration = ctx.agentTeams.registerTeammateRuntimeProvider(provider)
    const registry = runtimeRegistry(ctx)
    const created = await registry.create('fake-native', createRequest())
    await registry.deliver('fake-native', runtimeDelivery({ created }))
    await registry.createEvaluationHandle('fake-native', {
      evaluationId: TeammateEvaluationId('final-cleanup-evaluation'),
      profile: runtimeProfile(),
      requirements: { ...createRequest().requirements, runtimeCapabilities: ['evaluation'] },
      input: [],
      signal: SIGNAL,
    })

    registry.closeAdmission()
    await registry.disposeAttached()
    const ownership = registry as unknown as Record<string, Map<unknown, unknown> | Set<unknown>>
    for (const field of [
      'providers',
      'records',
      'creationHandles',
      'runtimeIdentities',
      'deliveryTurns',
      'turnIdentities',
      'evaluationHandles',
      'evaluationIdentities',
      'presence',
    ]) {
      expect(ownership[field]?.size, field).toBe(0)
    }
    expect(registration.available()).toBe(false)
    await registration()
  })

  it('aborts timed-out cleanup and retries every still-attached exact handle', async () => {
    const { ctx } = await setup({ disposalTimeoutMs: 25 })
    const provider = new FakeDurableRuntime(fakeStore())
    await register(ctx, provider)
    const registry = runtimeRegistry(ctx)
    const created = await registry.create('fake-native', createRequest())
    let timedOutSignal: AbortSignal | undefined
    provider.dispose.mockImplementationOnce(async (request) => {
      timedOutSignal = request.signal
      return await new Promise<never>((_resolve, reject) => {
        const abort = (): void => { reject(abortReason(request.signal)) }
        if (request.signal.aborted) abort()
        else request.signal.addEventListener('abort', abort, { once: true })
      })
    })

    registry.closeAdmission()
    await expect(registry.disposeAttached()).rejects.toThrow(/cleanup failed/u)
    expect(timedOutSignal?.aborted).toBe(true)
    provider.dispose.mockImplementation(async (request) => {
      if (request.kind === 'runtime') provider.attachedRuntimes.delete(request.nativeHandle)
      else provider.attachedEvaluations.delete(request.evaluationHandle)
    })
    await expect(registry.disposeAttached()).resolves.toBeUndefined()
    expect(provider.dispose).toHaveBeenLastCalledWith(expect.objectContaining({
      kind: 'runtime',
      nativeHandle: created.nativeHandle,
    }))
    expect(provider.attachedRuntimes).toHaveLength(0)
  })

  it('rejects and releases a native handle returned after provider retirement', async () => {
    const { ctx } = await setup({ disposalTimeoutMs: 25 })
    const provider = new FakeDurableRuntime(fakeStore())
    await register(ctx, provider)
    const registry = runtimeRegistry(ctx)
    const started = Promise.withResolvers<undefined>()
    const accepted = Promise.withResolvers<ReturnType<TeammateRuntimeProvider['create']> extends Promise<infer T> ? T : never>()
    provider.create.mockImplementationOnce(async () => {
      started.resolve(undefined)
      return await accepted.promise
    })
    const pending = registry.create('fake-native', createRequest({
      launchRequestId: TeammateLaunchRequestId('late-native-launch'),
    }))
    void pending.catch(() => undefined)
    await started.promise

    registry.closeAdmission()
    let disposed = false
    const disposing = registry.disposeAttached().then(() => { disposed = true })
    await new Promise(resolve => setTimeout(resolve, 35))
    expect(disposed).toBe(false)
    const lateHandle = TeammateRuntimeHandle('native-late')
    accepted.resolve({ nativeHandle: lateHandle, presence: 'idle' })
    await expect(pending).rejects.toMatchObject({ code: 'TEAM_RUNTIME_UNAVAILABLE' })
    await disposing
    await vi.waitFor(() => {
      expect(provider.dispose).toHaveBeenCalledWith(expect.objectContaining({
        kind: 'runtime',
        nativeHandle: lateHandle,
      }))
    })
  })

  it('contains late resume and evaluation results after retirement', async () => {
    const { ctx } = await setup({ disposalTimeoutMs: 25 })
    const provider = new FakeDurableRuntime(fakeStore())
    await register(ctx, provider)
    const registry = runtimeRegistry(ctx)
    const created = await registry.create('fake-native', createRequest())
    const resumed = Promise.withResolvers<Awaited<ReturnType<TeammateRuntimeProvider['resume']>>>()
    const missing = Promise.withResolvers<Awaited<ReturnType<TeammateRuntimeProvider['resume']>>>()
    const evaluated = Promise.withResolvers<Awaited<ReturnType<NonNullable<TeammateRuntimeProvider['createEvaluationHandle']>>>>()
    provider.resume
      .mockImplementationOnce(async () => await resumed.promise)
      .mockImplementationOnce(async () => await missing.promise)
    provider.createEvaluationHandle.mockImplementationOnce(async () => await evaluated.promise)
    const resumeRequest = {
      launchRequestId: createRequest().launchRequestId,
      memberId: createRequest().memberId,
      nativeHandle: created.nativeHandle,
      requirements: createRequest().requirements,
      signal: SIGNAL,
    }
    const lateResume = registry.resume('fake-native', resumeRequest)
    const lateMissing = registry.resume('fake-native', {
      launchRequestId: TeammateLaunchRequestId('late-missing-launch'),
      memberId: SessionId('late-missing-member'),
      requirements: resumeRequest.requirements,
      signal: resumeRequest.signal,
    })
    const lateEvaluationHandle = TeammateEvaluationHandle('native-eval-late')
    const lateEvaluation = registry.createEvaluationHandle('fake-native', {
      evaluationId: TeammateEvaluationId('late-evaluation'),
      profile: runtimeProfile(),
      requirements: { ...createRequest().requirements, runtimeCapabilities: ['evaluation'] },
      input: [],
      signal: SIGNAL,
    })
    void lateResume.catch(() => undefined)
    void lateMissing.catch(() => undefined)
    void lateEvaluation.catch(() => undefined)

    registry.closeAdmission()
    let disposed = false
    const disposing = registry.disposeAttached().then(() => { disposed = true })
    await new Promise(resolve => setTimeout(resolve, 35))
    expect(disposed).toBe(false)
    provider.dispose.mockImplementation(async (request) => {
      if (request.kind === 'evaluation') throw new Error('late evaluation cleanup failed')
      provider.attachedRuntimes.delete(request.nativeHandle)
    })
    resumed.resolve({ nativeHandle: created.nativeHandle, presence: 'idle' })
    missing.resolve(undefined)
    evaluated.resolve({ evaluationHandle: lateEvaluationHandle })
    await expect(lateResume).rejects.toMatchObject({ code: 'TEAM_RUNTIME_UNAVAILABLE' })
    await expect(lateMissing).rejects.toMatchObject({ code: 'TEAM_RUNTIME_UNAVAILABLE' })
    await expect(lateEvaluation).rejects.toMatchObject({ code: 'TEAM_RUNTIME_UNAVAILABLE' })
    await expect(disposing).rejects.toThrow(/cleanup failed/u)
    provider.dispose.mockImplementation(async (request) => {
      if (request.kind === 'runtime') provider.attachedRuntimes.delete(request.nativeHandle)
      else provider.attachedEvaluations.delete(request.evaluationHandle)
    })
    await expect(registry.disposeAttached()).resolves.toBeUndefined()
    expect(provider.dispose).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'evaluation',
      evaluationHandle: lateEvaluationHandle,
    }))
  })
})
