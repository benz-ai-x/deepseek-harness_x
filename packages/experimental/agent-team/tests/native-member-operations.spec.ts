import { mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { SessionId } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import Subagents from '@deepseek-ai/dsh-subagent'
import * as SubagentSpawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import { MockAdapter } from '../../../core/agent-loop/tests/mock-adapter.ts'
import TeamService, {
  TeamId,
  TeammateEvaluationHandle,
  TeammateEvaluationId,
  TeammateLaunchRequestId,
  TeammateRuntimeHandle,
  TeammateRuntimeEvidenceId,
  TeammateRuntimeToolCallId,
  TeammateRuntimeTurnId,
  type NativeMemberGrant,
  type TeammateProfileCapability,
  type TeammateRuntimeCapability,
  type TeammateRuntimeCreateRequest,
  type TeammateRuntimeCreateResult,
  type TeammateRuntimeDeliverRequest,
  type TeammateRuntimeDeliverResult,
  type TeammateRuntimeEvidenceItem,
  type TeammateRuntimeEvidenceRequest,
  type TeammateRuntimeProvider,
  type TeammateRuntimePresenceEvent,
  type TeammateRuntimeProfileSnapshot,
  type TeammateRuntimeResumeRequest,
} from '../src/index.ts'
import { TestSessionQuery } from './test-session-query.ts'

// Only the external native product is deterministic; Team authority and storage are real.
class NativeProduct implements TeammateRuntimeProvider {
  readonly id = 'native-query'
  readonly displayName = 'Native query fixture'
  readonly contextModes = ['fresh'] as const
  readonly profileCapabilities: readonly TeammateProfileCapability[] = ['persona', 'mission']
  readonly runtimeCapabilities: readonly TeammateRuntimeCapability[] = []
  readonly memberOperations = ['members.list', 'tasks.list', 'tasks.get'] as const
  readonly grants = new Map<TeammateRuntimeHandle, NativeMemberGrant>()
  constructor(readonly handles = new Map<string, TeammateRuntimeHandle>()) {}

  async create(request: TeammateRuntimeCreateRequest): Promise<TeammateRuntimeCreateResult> {
    const handle = TeammateRuntimeHandle(`native-${request.memberId}`)
    this.handles.set(request.memberId, handle)
    return { nativeHandle: handle, presence: 'idle' as const }
  }

  async resume(request: TeammateRuntimeResumeRequest) {
    const handle = this.handles.get(request.memberId)
    return handle === undefined ? undefined : { nativeHandle: handle, presence: 'idle' as const }
  }

  bindMemberOperations(request: { nativeHandle: TeammateRuntimeHandle; grant: NativeMemberGrant }) {
    this.grants.set(request.nativeHandle, request.grant)
  }

  async deliver(_request: TeammateRuntimeDeliverRequest): Promise<TeammateRuntimeDeliverResult> {
    throw new Error('the query fixture does not deliver messages')
  }
  interrupt() { return { previousStatus: 'idle' as const } }
  async dispose() { /* Native identities remain available for a later qualified resume. */ }
}

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function setup(provider = new NativeProduct()) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-native-query-'))
  const ctx = new Context()
  cleanups.push(async () => {
    try { await ctx.fiber.dispose() }
    finally { rmSync(root, { recursive: true, force: true }) }
  })
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(JsonlSessionPersistence, { root })
  await ctx.plugin(TestSessionQuery)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(Subagents)
  const teamFiber = await ctx.plugin(TeamService)
  const lead = await ctx.agents.create({ sessionId: SessionId('native-team-lead') })
  const unrelated = await ctx.agents.create({ sessionId: SessionId('unrelated-lead') })
  const registration = ctx.agentTeams.registerTeammateRuntimeProvider(provider)
  const launched = await ctx.agentTeams.spawnTeammate(lead.agent, {
    name: 'reviewer', description: 'Review the assigned report.', context: 'fresh',
    prompt: [{ type: 'text', text: 'Read the Team members.' }], signal: new AbortController().signal,
    runtime: {
      kind: 'external-agent', provider: provider.id, launchRequestId: TeammateLaunchRequestId('native-query-launch'),
      profile: {
        persona: 'Be precise.', mission: 'Review the report.', context: [], memory: [],
        toolPolicy: { mode: 'inherit', names: [] }, hooks: [],
      },
      requirements: { contextMode: 'fresh', profileCapabilities: ['persona', 'mission'], runtimeCapabilities: [] },
    },
  })
  const handle = launched.member.externalRuntime!.nativeHandle!
  return { ctx, lead, unrelated, provider, registration, launched, handle, teamFiber, root }
}

describe('native Team member queries', () => {
  it('requires trusted tool or settlement correlation outside model arguments', async () => {
    const { provider, handle } = await setup()
    const grant = provider.grants.get(handle)!
    const signal = new AbortController().signal
    const send = { operation: 'messages.send', target: 'lead', text: 'A review update.' }
    const settle = { operation: 'turns.settle', outcome: 'completed', text: 'Review complete.' }
    const tool = { kind: 'tool' as const, turnId: TeammateRuntimeTurnId('turn-1'), callId: TeammateRuntimeToolCallId('call-1') }
    const settlement = { kind: 'settlement' as const, turnId: TeammateRuntimeTurnId('turn-1') }
    for (const [input, source] of [[send, undefined], [send, settlement], [settle, tool]] as const) {
      expect(await grant.execute(input, signal, source))
        .toMatchObject({ ok: false, error: { code: 'TEAM_NATIVE_CORRELATION_REQUIRED' } })
    }
    expect(await grant.execute({ ...send, source: tool }, signal))
      .toMatchObject({ ok: false, error: { code: 'TEAM_NATIVE_INVALID_REQUEST' } })
  })

  it.each(['caller', 'provider'] as const)('refuses a native message when its %s cancels at the write queue', async (owner) => {
    const { provider, handle, registration, lead } = await setup()
    const grant = provider.grants.get(handle)!
    const cancellation = new AbortController()
    const operation = grant.execute({ operation: 'messages.send', target: 'lead', text: 'Do not queue this.' },
      cancellation.signal, { kind: 'tool', turnId: TeammateRuntimeTurnId('turn-1'), callId: TeammateRuntimeToolCallId('call-1') })
    await Promise.resolve()
    let retiring: Promise<void> | undefined
    if (owner === 'caller') cancellation.abort()
    else retiring = registration()
    expect(await operation).toMatchObject({ ok: false, error: {
      code: owner === 'caller' ? 'TEAM_NATIVE_CANCELLED' : 'TEAM_NATIVE_GRANT_REVOKED',
    } })
    expect(lead.agent.session.ownEvents().filter(event => event.type === 'team/native-operation/committed')).toHaveLength(0)
    await retiring
  })

  it('keeps a committed message when provider retirement wins before its native response', async () => {
    const { ctx, provider, handle, registration, lead } = await setup()
    const grant = provider.grants.get(handle)!
    const signal = new AbortController().signal
    let retiring: Promise<void> | undefined
    const unobserve = ctx.on('session/event', (session, event) => {
      if (session.id !== lead.agent.id || event.type !== 'team/native-operation/committed') return
      retiring = ctx.agentTeams.waitForChange(lead.agent, 10_000, signal).then(async () => { await registration() })
    })
    try {
      expect(await grant.execute({ operation: 'messages.send', target: 'lead', text: 'Keep the committed review.' }, signal,
        { kind: 'tool', turnId: TeammateRuntimeTurnId('turn-1'), callId: TeammateRuntimeToolCallId('call-1') }))
        .toMatchObject({ ok: false, error: { code: 'TEAM_NATIVE_GRANT_REVOKED' } })
      await retiring
      const stored = await ctx.sessionPersistence.open(lead.agent.id, 'read')
      try {
        expect((await stored.read(0)).filter(event => event.type === 'team/native-operation/committed')).toHaveLength(1)
      } finally {
        await stored.close()
      }
    } finally {
      unobserve()
    }
  })

  it.each(['completed', 'failed', 'interrupted'] as const)(
    'commits one %s work notification to the Lead as the native member',
    async (outcome) => {
      const { ctx, lead, provider, handle, launched } = await setup()
      const grant = provider.grants.get(handle)!
      const signal = new AbortController().signal
      const source = { kind: 'settlement' as const, turnId: TeammateRuntimeTurnId('work-turn-1') }
      const input = { operation: 'turns.settle', outcome, text: 'The review found two missing assertions.' }
      const accepted = await grant.execute(input, signal, source)
      expect(accepted).toMatchObject({ ok: true, operation: 'turns.settle', value: { status: 'queued', outcome } })
      expect(await grant.execute(input, signal, source)).toEqual(accepted)
      await ctx.sessions.flush(lead.agent.session)
      const stored = await ctx.sessionPersistence.open(lead.agent.id, 'read')
      try {
        const committed = (await stored.read(0)).filter(event => event.type === 'team/native-operation/committed')
        expect(committed).toHaveLength(1)
        expect(committed[0]?.data).toMatchObject({ message: {
          senderId: launched.member.id, senderName: 'reviewer', targetId: lead.agent.id,
          content: [{ type: 'text', text: 'The review found two missing assertions.' }],
        }, receipt: { source, result: accepted } })
      } finally {
        await stored.close()
      }
    },
  )

  it('recovers the original native receipt after a full Host restart and refuses conflicts and retired grants', async () => {
    const { ctx, lead, provider, handle, root } = await setup()
    const old = provider.grants.get(handle)!
    const signal = new AbortController().signal
    const source = { kind: 'tool' as const, turnId: TeammateRuntimeTurnId('work-turn-1'),
      callId: TeammateRuntimeToolCallId('send-call-1') }
    const input = { operation: 'messages.send', target: 'lead', text: 'The review is ready.' }
    const original = await old.execute(input, signal, source)
    expect(original).toMatchObject({ ok: true, operation: 'messages.send' })
    const leadId = lead.agent.id
    await ctx.fiber.dispose()

    const restored = new Context()
    cleanups.push(async () => { await restored.fiber.dispose() })
    await mountAgentLoopTestDependencies(restored)
    await restored.plugin(SessionProjectionRegistry)
    await restored.plugin(JsonlSessionPersistence, { root })
    await restored.plugin(TestSessionQuery)
    await restored.plugin(AgentLoop, { agents: [] })
    await restored.plugin(Subagents)
    await restored.plugin(TeamService)
    const replacement = new NativeProduct(provider.handles)
    restored.agentTeams.registerTeammateRuntimeProvider(replacement)
    const resumed = await restored.agents.resume({ resumeSessionId: leadId, agentOptions: {} })
    await vi.waitFor(() => { expect(replacement.grants.has(handle)).toBe(true) })
    const current = replacement.grants.get(handle)!
    expect(current.identity).toEqual(old.identity)
    expect(await current.execute(input, signal, source)).toEqual(original)
    expect(await current.execute({ ...input, text: 'Different review.' }, signal, source))
      .toMatchObject({ ok: false, error: { code: 'TEAM_NATIVE_OPERATION_CONFLICT' } })
    expect(await old.execute(input, signal, source))
      .toMatchObject({ ok: false, error: { code: 'TEAM_NATIVE_GRANT_REVOKED' } })
    await restored.sessions.flush(resumed.agent.session)
    const stored = await restored.sessionPersistence.open(leadId, 'read')
    try {
      const committed = (await stored.read(0)).filter(event => event.type === 'team/native-operation/committed')
      expect(committed).toHaveLength(1)
      expect(committed[0]?.data).toMatchObject({ receipt: { result: original } })
    } finally {
      await stored.close()
    }
  })

  it('retries a failed real mailbox flush before returning a receipt and delivering to the native peer', async () => {
    class ReceivingProduct extends NativeProduct {
      readonly deliveries: TeammateRuntimeDeliverRequest[] = []
      override async deliver(request: TeammateRuntimeDeliverRequest) {
        this.deliveries.push(request)
        return { turnId: TeammateRuntimeTurnId(`delivery-${request.deliveryId}`), presence: 'idle' as const }
      }
    }
    const native = new ReceivingProduct()
    const { ctx, lead, provider, handle, root } = await setup(native)
    await ctx.agentTeams.spawnTeammate(lead.agent, {
      name: 'peer', description: 'Receive the review.', context: 'fresh',
      prompt: [{ type: 'text', text: 'Wait for the review.' }], signal: new AbortController().signal,
      runtime: {
        kind: 'external-agent', provider: provider.id, launchRequestId: TeammateLaunchRequestId('peer-launch'),
        profile: { persona: 'Read carefully.', mission: 'Verify the review.', context: [], memory: [],
          toolPolicy: { mode: 'inherit', names: [] }, hooks: [] },
        requirements: { contextMode: 'fresh', profileCapabilities: ['persona', 'mission'], runtimeCapabilities: [] },
      },
    })
    await ctx.sessions.flush(lead.agent.session)
    const relative = readdirSync(root, { recursive: true }).find(path =>
      typeof path === 'string' && path.includes(lead.agent.id) && path.endsWith('session.jsonl.zstd'))
    if (typeof relative !== 'string') throw new Error('Lead has no durable Session log')
    const path = join(root, relative)
    const backup = `${path}.before-flush-failure`
    const signal = new AbortController().signal
    const grant = provider.grants.get(handle)!
    const source = { kind: 'tool' as const, turnId: TeammateRuntimeTurnId('work-turn-1'),
      callId: TeammateRuntimeToolCallId('send-call-1') }
    const input = { operation: 'messages.send', target: 'peer', text: 'The review is ready.' }
    renameSync(path, backup)
    try {
      mkdirSync(path)
      expect(await grant.execute(input, signal, source))
        .toMatchObject({ ok: false, error: { code: 'TEAM_NATIVE_OPERATION_FAILED' } })
      expect(native.deliveries).toHaveLength(0)
    } finally {
      rmSync(path, { recursive: true, force: true })
      renameSync(backup, path)
    }
    const accepted = await grant.execute(input, signal, source)
    expect(accepted).toMatchObject({ ok: true, operation: 'messages.send', value: { status: 'queued' } })
    await vi.waitFor(() => { expect(native.deliveries).toHaveLength(1) })
    const stored = await ctx.sessionPersistence.open(lead.agent.id, 'read')
    try {
      expect((await stored.read(0)).filter(event => event.type === 'team/native-operation/committed'))
        .toHaveLength(1)
    } finally {
      await stored.close()
    }
  })

  it('persists one member message and returns its original receipt when the native call is retried', async () => {
    class MessagingProduct extends NativeProduct {
      override async create(request: TeammateRuntimeCreateRequest) {
        return { ...await super.create(request), turnId: TeammateRuntimeTurnId('work-turn-1') }
      }
    }
    const { ctx, lead, provider, handle, launched } = await setup(new MessagingProduct())
    const grant = provider.grants.get(handle)!
    const source = {
      kind: 'tool' as const,
      turnId: TeammateRuntimeTurnId('work-turn-1'),
      callId: TeammateRuntimeToolCallId('send-call-1'),
    }
    const signal = new AbortController().signal
    const input = { operation: 'messages.send', target: 'lead', text: 'The review is ready.' }
    const result = await grant.execute(input, signal, source)
    expect(result).toMatchObject({ ok: true, operation: 'messages.send', value: {
      messageId: expect.any(String) as unknown, status: 'queued',
    } })
    expect(await grant.execute({ text: input.text, target: input.target, operation: input.operation }, signal, source))
      .toEqual(result)
    expect(await grant.execute({ ...input, target: ' lead ' }, signal, source)).toEqual(result)
    await ctx.sessions.flush(lead.agent.session)
    const stored = await ctx.sessionPersistence.open(lead.agent.session.id, 'read')
    try {
      const events = await stored.read(0)
      const committed = events.filter(event => event.type === 'team/native-operation/committed')
      expect(committed).toHaveLength(1)
      expect(committed[0]?.data).toMatchObject({ version: 3, message: {
        senderId: launched.member.id, senderName: 'reviewer', targetId: lead.agent.id,
        content: [{ type: 'text', text: 'The review is ready.' }],
      }, receipt: { result } })
    } finally {
      await stored.close()
    }
  })

  it('revokes native grants even when a DSH child cannot persist its final state', async () => {
    const { ctx, provider, handle, root, teamFiber } = await setup()
    const failures: unknown[] = []
    ctx.logger.exporter({ export(message) { if (message.type === 'error') failures.push(...message.args as readonly unknown[]) } })
    await ctx.plugin(SubagentSpawn, { providerName: 'spawn' })
    ctx.llm.registerAdapter(['mock'], new MockAdapter(['hang']))
    const lead = await ctx.agentLoop.create(SessionId('failed-storage-lead'), { provider: 'mock', model: 'mock' })
    const launched = await ctx.agentTeams.spawnTeammate(lead, {
      name: 'dsh-worker', description: 'Hold a live model request.', context: 'fresh', provider: 'spawn',
      prompt: [{ type: 'text', text: 'Wait for instructions.' }], signal: new AbortController().signal,
    })
    await vi.waitFor(() => { expect(ctx.agents.get(launched.member.id)?.status).toBe('running') })
    await ctx.sessions.flush(ctx.agents.get(launched.member.id)!.session)
    const relative = readdirSync(root, { recursive: true }).find(path =>
      typeof path === 'string' && path.includes(launched.member.id) && path.endsWith('session.jsonl.zstd'))
    if (typeof relative !== 'string') throw new Error('DSH child has no persisted session file')
    const path = join(root, relative)
    const backup = `${path}.before-failure`
    renameSync(path, backup)
    try {
      mkdirSync(path)
      await teamFiber.dispose()
    } finally {
      rmSync(path, { recursive: true, force: true })
      renameSync(backup, path)
    }
    const failure = failures.find((error): error is Error => error instanceof Error
      && 'code' in error && error.code === 'ACTIVATION_TEARDOWN_FAILED')
    expect(failure?.message).toContain('selected activation(s)')
    expect(ctx.agents.get(launched.member.id)).toBeUndefined()
    expect(ctx.get('agentTeams')).toBeUndefined()
    expect(await provider.grants.get(handle)!.execute({ operation: 'members.list' }, new AbortController().signal))
      .toMatchObject({ ok: false, error: { code: 'TEAM_NATIVE_GRANT_REVOKED' } })
  })

  it('keeps authority revoked when registration disposal overtakes a replacement', async () => {
    const started = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    class DrainingProduct extends NativeProduct {
      override async dispose() {
        started.resolve(undefined)
        await release.promise
      }
    }
    const original = new DrainingProduct()
    const { registration, handle } = await setup(original)
    cleanups.push(async () => { release.resolve(undefined) })
    const next = new NativeProduct(original.handles)
    const replacement = registration.replace(next)
    void replacement.catch(() => undefined)
    try {
      await started.promise
      const disposing = registration()
      release.resolve(undefined)
      await expect(replacement).rejects.toMatchObject({ code: 'TEAM_RUNTIME_UNAVAILABLE' })
      await disposing
      expect(registration.available()).toBe(false)
      expect(next.grants.size).toBe(0)
      expect(original.grants.get(handle)!.signal.aborted).toBe(true)
    } finally { release.resolve(undefined) }
  })

  it('quarantines concurrent invalid evidence without restoring native authority', async () => {
    class EvidenceProduct extends NativeProduct {
      override readonly runtimeCapabilities = ['evidence'] as const
      async evidence(request: TeammateRuntimeEvidenceRequest) {
        return { nativeHandle: request.nativeHandle, items: [{
          id: TeammateRuntimeEvidenceId('bad-native-result'), kind: 'turn' as const, timestamp: -1,
        }], complete: true }
      }
    }
    const provider = new EvidenceProduct()
    const { ctx, lead, registration, handle } = await setup(provider)
    const request = { limit: 1, signal: new AbortController().signal }
    const outcomes = await Promise.allSettled([
      ctx.agentTeams.readTeammateRuntimeEvidence(lead.agent, 'reviewer', request),
      ctx.agentTeams.readTeammateRuntimeEvidence(lead.agent, 'reviewer', request),
    ])
    expect(outcomes).toMatchObject([
      { status: 'rejected', reason: { code: 'TEAM_RUNTIME_IDENTITY_CONFLICT' } },
      { status: 'rejected', reason: { code: 'TEAM_RUNTIME_IDENTITY_CONFLICT' } },
    ])
    expect(registration.available()).toBe(false)
    expect(provider.grants.get(handle)!.signal.aborted).toBe(true)
  })

  it('refuses running native work without lifecycle observation before issuing a grant', async () => {
    class UnobservableProduct extends NativeProduct {
      override async create(request: TeammateRuntimeCreateRequest): Promise<TeammateRuntimeCreateResult> {
        return { ...await super.create(request), presence: 'running' }
      }
    }
    const { ctx, lead, provider, handle } = await setup()
    const unobservable = Object.assign(new UnobservableProduct(), { id: 'unobservable-native' })
    const registration = ctx.agentTeams.registerTeammateRuntimeProvider(unobservable)
    await expect(ctx.agentTeams.spawnTeammate(lead.agent, {
      name: 'unobservable', description: 'Cannot observe completion.', context: 'fresh',
      prompt: [{ type: 'text', text: 'Read tasks.' }], signal: new AbortController().signal,
      runtime: { kind: 'external-agent', provider: unobservable.id,
        launchRequestId: TeammateLaunchRequestId('unobservable-launch'),
        profile: { persona: 'Be precise.', mission: 'Review.', context: [], memory: [],
          toolPolicy: { mode: 'inherit', names: [] }, hooks: [] },
        requirements: { contextMode: 'fresh', profileCapabilities: ['persona', 'mission'], runtimeCapabilities: [] },
      },
    })).rejects.toMatchObject({ code: 'TEAM_RUNTIME_IDENTITY_CONFLICT' })
    expect(registration.available()).toBe(false)
    expect(unobservable.grants.size).toBe(0)
    expect(provider.grants.get(handle)!.signal.aborted).toBe(false)
    await registration()
  })

  it.each([false, true])('recovers pending native identity and rejects a conflicting concurrent handle: %s', async (conflict) => {
    const firstEntered = Promise.withResolvers<undefined>()
    const secondEntered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    class RecoveringProduct extends NativeProduct {
      pendingResumes = 0
      override async resume(request: TeammateRuntimeResumeRequest) {
        if (request.memberId !== 'pending-query-member') return await super.resume(request)
        const call = ++this.pendingResumes
        if (call === 1) firstEntered.resolve(undefined)
        if (call === 2) secondEntered.resolve(undefined)
        await release.promise
        return { nativeHandle: TeammateRuntimeHandle(conflict && call === 2 ? 'conflicting-native' : 'pending-native'), presence: 'idle' as const }
      }
    }
    const provider = new RecoveringProduct()
    const { ctx, lead, registration, handle } = await setup(provider)
    cleanups.push(async () => { release.resolve(undefined) })
    const original = lead.agent.session.ownEvents().find(event => event.type === 'team/member' && event.data.member.phase === 'provisioning')
    if (original?.type !== 'team/member' || original.data.member.externalRuntime === undefined) throw new Error('fixture has no durable provisioning record')
    const pending = await ctx.agents.create({ sessionId: SessionId('pending-query-lead') })
    pending.agent.session.append('team/member', {
      version: 2, teamId: TeamId(pending.agent.id), member: {
        ...original.data.member, id: SessionId('pending-query-member'),
        externalRuntime: { ...original.data.member.externalRuntime, launchRequestId: TeammateLaunchRequestId('pending-query-launch') },
      },
    })
    await ctx.sessions.flush(pending.agent.session)
    const firstTrigger = ctx.agentTeams.registerTeammateRuntimeProvider(Object.assign(new NativeProduct(), { id: 'first-recovery-trigger' }))
    try {
      await firstEntered.promise
      const secondTrigger = ctx.agentTeams.registerTeammateRuntimeProvider(Object.assign(new NativeProduct(), { id: 'second-recovery-trigger' }))
      try {
        await secondEntered.promise
        release.resolve(undefined)
        await vi.waitFor(() => {
          expect(ctx.agentTeams.listMembers(pending.agent)[1]?.externalRuntime?.nativeHandle).toBe('pending-native')
          expect(registration.available()).toBe(!conflict)
          if (!conflict) expect(provider.grants.get(TeammateRuntimeHandle('pending-native'))).toBeDefined()
        })
        if (conflict) {
          expect(provider.grants.get(handle)!.signal.aborted).toBe(true)
          expect(provider.grants.has(TeammateRuntimeHandle('conflicting-native'))).toBe(false)
        } else {
          expect(await provider.grants.get(TeammateRuntimeHandle('pending-native'))!.execute({ operation: 'members.list' }, new AbortController().signal))
            .toMatchObject({ ok: true, value: { members: [{ id: pending.agent.id }, { id: 'pending-query-member' }] } })
        }
      } finally { release.resolve(undefined); await secondTrigger() }
    } finally { release.resolve(undefined); await firstTrigger() }
  })

  it('preserves exact DSH roles while native topology changes around ordinary subagents', async () => {
    const { ctx, lead, provider, handle } = await setup()
    await ctx.plugin(SubagentSpawn, { providerName: 'spawn' })
    ctx.llm.registerAdapter(['mock'], new MockAdapter(['hang', 'hang']))
    const dshLead = await ctx.agentLoop.create(SessionId('dsh-role-lead'), { provider: 'mock', model: 'mock' })
    const ordinary = await ctx.subagents.startContinuable({
      provider: 'spawn', label: 'ordinary worker',
      request: { prompt: [{ type: 'text', text: 'Wait for instructions.' }], parent: dshLead },
      signal: new AbortController().signal,
    })
    await vi.waitFor(() => { expect(ctx.agents.get(ordinary.childId)?.status).toBe('running') })
    expect(ctx.agentTeams.tryMembership(ctx.agents.get(ordinary.childId)!)).toBeUndefined()
    const teammate = await ctx.agentTeams.spawnTeammate(dshLead, {
      name: 'dsh-worker', description: 'Wait for instructions.', context: 'fresh', provider: 'spawn',
      prompt: [{ type: 'text', text: 'Wait for instructions.' }], signal: new AbortController().signal,
    })
    await vi.waitFor(() => { expect(ctx.agents.get(teammate.member.id)?.status).toBe('running') })
    await expect(ctx.agentTeams.readTeammateRuntimeEvidence(ctx.agents.get(teammate.member.id)!, 'lead', {
      limit: 1, signal: new AbortController().signal,
    })).rejects.toMatchObject({ code: 'TEAM_LEAD_REQUIRED' })
    await expect(ctx.agentTeams.readTeammateRuntimeEvidence(lead.agent, 'lead', {
      limit: 1, signal: new AbortController().signal,
    })).rejects.toMatchObject({ code: 'TEAM_MEMBER_NOT_FOUND' })
    const additional = ctx.agentTeams.registerTeammateRuntimeProvider(Object.assign(new NativeProduct(), { id: 'topology-observer' }))
    expect(ctx.agentTeams.tryMembership(ctx.agents.get(ordinary.childId)!)).toBeUndefined()
    expect(await provider.grants.get(handle)!.execute({ operation: 'members.list' }, new AbortController().signal))
      .toMatchObject({ ok: true, value: { members: [{ name: 'lead' }, { name: 'reviewer' }] } })
    await additional()
  })

  it.each(['observe', 'cleanup'] as const)('revokes old grants when replacement presence %s fails', async (failure) => {
    class ObservedProduct extends NativeProduct {
      failObservation = false
      failCleanup = false
      onPresenceChanged() {
        if (this.failObservation) throw new Error('native presence observation failed')
        return () => {
          if (!this.failCleanup) return
          this.failCleanup = false
          throw new Error('native presence cleanup failed')
        }
      }
    }
    const original = new ObservedProduct()
    const { registration, handle } = await setup(original)
    const grant = original.grants.get(handle)!
    const replacement = new ObservedProduct(original.handles)
    original.failCleanup = failure === 'cleanup'
    replacement.failObservation = failure === 'observe'
    await expect(registration.replace(replacement)).rejects.toThrow(/observation failed|retirement failed/u)
    expect(registration.available()).toBe(false)
    expect(replacement.grants.size).toBe(0)
    expect(grant.signal.aborted).toBe(true)
    expect(await grant.execute({ operation: 'members.list' }, new AbortController().signal))
      .toMatchObject({ ok: false, error: { code: 'TEAM_NATIVE_GRANT_REVOKED' } })
    await registration()
  })

  it('preserves bounded usage and tool evidence but revokes an unqualified approval producer', async () => {
    let items: readonly TeammateRuntimeEvidenceItem[] = [
      { id: TeammateRuntimeEvidenceId('usage-1'), kind: 'usage', timestamp: 1,
        usage: { inputTokens: 14, outputTokens: 7, cacheWriteTokens: 2 } },
      { id: TeammateRuntimeEvidenceId('tool-1'), kind: 'tool', timestamp: 2,
        callId: TeammateRuntimeToolCallId('call-1'), name: 'read',
        usage: { inputTokens: 14, outputTokens: 7, totalTokens: 21, cacheReadTokens: 3, reasoningTokens: 1 } },
    ]
    class EvidenceProduct extends NativeProduct {
      override readonly runtimeCapabilities = ['evidence'] as const
      async evidence(request: TeammateRuntimeEvidenceRequest) {
        return { nativeHandle: request.nativeHandle, items, complete: true }
      }
    }
    const provider = new EvidenceProduct()
    const { ctx, lead, handle, registration } = await setup(provider)
    const result = await ctx.agentTeams.readTeammateRuntimeEvidence(lead.agent, 'reviewer', {
      limit: 2, signal: new AbortController().signal,
    })
    expect(result.items).toEqual([
      { id: 'usage-1', kind: 'usage', timestamp: 1, usage: { inputTokens: 14, outputTokens: 7, cacheWriteTokens: 2 } },
      { id: 'tool-1', kind: 'tool', timestamp: 2, callId: 'call-1', name: 'read',
        usage: { inputTokens: 14, outputTokens: 7, totalTokens: 21, cacheReadTokens: 3, reasoningTokens: 1 } },
    ])
    items = [{ id: TeammateRuntimeEvidenceId('approval-1'), kind: 'approval', timestamp: 3 }]
    await expect(ctx.agentTeams.readTeammateRuntimeEvidence(lead.agent, 'reviewer', {
      limit: 1, signal: new AbortController().signal,
    })).rejects.toMatchObject({ code: 'TEAM_RUNTIME_IDENTITY_CONFLICT' })
    expect(registration.available()).toBe(false)
    expect(provider.grants.get(handle)!.signal.aborted).toBe(true)
  })

  it.each([
    { kind: 'turn', timestamp: -1 },
    { kind: 'turn', timestamp: Number.NaN },
    { kind: 'approval', outcome: 'asked' },
    { kind: 'approval', turnId: 'turn-1', name: 'read', approvalId: 'approval-1', callId: 'call-1', policyId: 'policy-1', outcome: 'unrecognized' },
    { kind: 'other' },
    { kind: 'turn', approvalId: 'approval-1' },
    { kind: 'turn', policyId: 'policy-1' },
    { kind: 'turn', callId: 'call-1' },
    { kind: 'turn', step: 1 },
    { kind: 'tool', step: 0 },
    { kind: 'tool', outcome: 'unrecognized' },
    { kind: 'usage', usage: { inputTokens: -1, outputTokens: 0 } },
  ])('revokes native authority when external evidence violates its contract: %j', async (malformed) => {
    class EvidenceProduct extends NativeProduct {
      override readonly runtimeCapabilities = ['evidence', 'exact-call-approval'] as const
      override readonly profileCapabilities = ['persona', 'mission', 'hooks'] as const
      async evidence(request: TeammateRuntimeEvidenceRequest) {
        const item = { id: TeammateRuntimeEvidenceId('native-evidence-1'), timestamp: 1, ...malformed } as TeammateRuntimeEvidenceItem
        return { nativeHandle: request.nativeHandle, items: [item], complete: true }
      }
    }
    const provider = new EvidenceProduct()
    const { ctx, lead, handle, registration } = await setup(provider)
    const grant = provider.grants.get(handle)!
    await expect(ctx.agentTeams.readTeammateRuntimeEvidence(lead.agent, 'reviewer', {
      limit: 1, signal: new AbortController().signal,
    })).rejects.toThrow()
    expect(registration.available()).toBe(false)
    expect(grant.signal.aborted).toBe(true)
    expect(await grant.execute({ operation: 'tasks.list' }, new AbortController().signal))
      .toMatchObject({ ok: false, error: { code: 'TEAM_NATIVE_GRANT_REVOKED' } })
  })

  const invalidProfiles: readonly Partial<TeammateRuntimeProfileSnapshot>[] = [
    { persona: ' ' },
    { context: [{ id: 'bad id', title: 'Context', content: 'Read only.' }] },
    { toolPolicy: { mode: 'inherit', names: ['read'] } },
    { toolPolicy: { mode: 'allow', names: ['read', 'read'] } },
    { hooks: [{ point: 'session-start', effect: 'deny', text: 'Refuse.' }] },
    { hooks: [{ point: 'before-step', effect: 'context', matcher: 'read', text: 'Review.' }] },
    { hooks: [{ point: 'before-tool', effect: 'context', matcher: 'read', text: 'Review.' }] },
    { hooks: [{ point: 'before-tool', effect: 'deny', text: 'Refuse.' }] },
    { hooks: [{ point: 'after-tool', effect: 'deny', matcher: 'read', text: 'Refuse.' }] },
    { hooks: [{ point: 'after-tool', effect: 'context', text: 'Review.' }] },
    { hooks: [{ id: 'bad id', point: 'before-step', effect: 'context', text: 'Review.' }] },
    { hooks: [{ point: 'before-tool', effect: 'ask', matcher: 'read', text: 'Confirm.' }] },
  ]
  it.each(invalidProfiles)('rejects malformed native launch policy without issuing another grant: %j', async (invalid) => {
    class ProfileProduct extends NativeProduct {
      override readonly profileCapabilities = ['persona', 'mission', 'context', 'memory', 'tool-policy', 'hooks'] as const
    }
    const provider = new ProfileProduct()
    const { ctx, lead } = await setup(provider)
    await expect(ctx.agentTeams.spawnTeammate(lead.agent, {
      name: 'invalid-policy', description: 'Must not reach native creation.', context: 'fresh',
      prompt: [{ type: 'text', text: 'Read the task board.' }], signal: new AbortController().signal,
      runtime: {
        kind: 'external-agent', provider: provider.id, launchRequestId: TeammateLaunchRequestId('invalid-native-profile'),
        profile: { persona: 'Review carefully.', mission: 'Inspect.', context: [], memory: [],
          toolPolicy: { mode: 'inherit', names: [] }, hooks: [], ...invalid },
        requirements: { contextMode: 'fresh', profileCapabilities: provider.profileCapabilities, runtimeCapabilities: [] },
      },
    })).rejects.toMatchObject({ code: 'TEAM_RUNTIME_CAPABILITY_MISMATCH' })
    expect(provider.handles.size).toBe(1)
    expect(provider.grants.size).toBe(1)
    expect(ctx.agentTeams.listMembers(lead.agent).map(member => member.name)).toEqual(['lead', 'reviewer'])
  })

  it('rejects unknown or duplicate operation declarations before publishing a provider', async () => {
    const { ctx } = await setup()
    for (const memberOperations of [['tasks.delete'], ['tasks.list', 'tasks.list']]) {
      const provider = Object.assign(new NativeProduct(), { id: 'invalid-native-queries', memberOperations })
      expect(() => ctx.agentTeams.registerTeammateRuntimeProvider(provider))
        .toThrow(expect.objectContaining({ code: 'TEAM_RUNTIME_INVALID_PROVIDER' }))
    }
    for (const declaration of [
      { memberOperations: undefined }, { bindMemberOperations: undefined },
    ]) {
      const provider = Object.assign(new NativeProduct(), { id: 'missing-native-queries', ...declaration })
      expect(() => ctx.agentTeams.registerTeammateRuntimeProvider(provider))
        .toThrow(expect.objectContaining({ code: 'TEAM_RUNTIME_INVALID_PROVIDER' }))
    }
    const unavailableEvaluation = Object.assign(new NativeProduct(), {
      id: 'incomplete-evaluation-provider', runtimeCapabilities: ['evaluation'], evaluationTools: [],
    })
    expect(() => ctx.agentTeams.registerTeammateRuntimeProvider(unavailableEvaluation))
      .toThrow(/advertises evaluation without implementing it/u)
    expect(() => ctx.agentTeams.registerTeammateRuntimeProvider(Object.assign(new NativeProduct(), {
      id: 'unqualified-evaluation-tools', evaluationTools: [],
    }))).toThrow(/must publish evaluation tools exactly when evaluation is supported/u)
  })

  it('reattaches and reauthorizes an inactive native member before mailbox delivery', async () => {
    class RestartingProduct extends NativeProduct {
      report: (event: TeammateRuntimePresenceEvent) => void = () => {}
      onPresenceChanged(listener: (event: TeammateRuntimePresenceEvent) => void) {
        this.report = listener
        return () => { this.report = () => {} }
      }
      override async deliver(request: TeammateRuntimeDeliverRequest): Promise<TeammateRuntimeDeliverResult> {
        const grant = this.grants.get(request.nativeHandle)!
        const result = await grant.execute({ operation: 'members.list' }, request.signal)
        if (!result.ok) throw new Error(result.error.code)
        return { turnId: TeammateRuntimeTurnId('reattached-work'), presence: 'idle' }
      }
    }
    const provider = new RestartingProduct()
    const { ctx, lead, handle } = await setup(provider)
    const oldGrant = provider.grants.get(handle)!
    provider.report({ nativeHandle: handle, presence: 'inactive' })
    expect(oldGrant.signal.aborted).toBe(true)
    const receipt = await ctx.agentTeams.sendMessage(lead.agent, {
      target: 'reviewer', content: [{ type: 'text', text: 'Continue the review.' }], signal: new AbortController().signal,
    })
    expect(receipt.status).toBe('accepted')
    expect(provider.grants.get(handle)).not.toBe(oldGrant)
    const stored = await ctx.sessionPersistence.open(lead.agent.id, 'read')
    try {
      expect((await stored.read(0)).filter(event => event.type === 'team/message/delivered'))
        .toContainEqual(expect.objectContaining({ data: expect.objectContaining({ messageId: receipt.messageId }) }))
    } finally { await stored.close() }
    expect(await oldGrant.execute({ operation: 'members.list' }, new AbortController().signal))
      .toMatchObject({ ok: false, error: { code: 'TEAM_NATIVE_GRANT_REVOKED' } })
  })

  it('never revives an old grant when a detached native process reports presence again', async () => {
    class ReportingProduct extends NativeProduct {
      private readonly listeners = new Set<(event: TeammateRuntimePresenceEvent) => void>()
      onPresenceChanged(listener: (event: TeammateRuntimePresenceEvent) => void) {
        this.listeners.add(listener)
        return () => { this.listeners.delete(listener) }
      }
      report(event: TeammateRuntimePresenceEvent) {
        for (const listener of this.listeners) listener(event)
      }
      queueReport(event: TeammateRuntimePresenceEvent) {
        const pending = [...this.listeners]
        return () => { for (const listener of pending) listener(event) }
      }
    }
    const provider = new ReportingProduct()
    const { handle, registration } = await setup(provider)
    const grant = provider.grants.get(handle)!
    const signal = new AbortController().signal
    provider.report({ nativeHandle: TeammateRuntimeHandle('unattached-native-handle'), presence: 'inactive' })
    expect(grant.signal.aborted).toBe(false)
    provider.report({ nativeHandle: handle, presence: 'inactive' })
    expect(await grant.execute({ operation: 'members.list' }, signal))
      .toMatchObject({ ok: false, error: { code: 'TEAM_NATIVE_GRANT_REVOKED' } })
    provider.report({ nativeHandle: handle, presence: 'idle' })
    expect(await grant.execute({ operation: 'members.list' }, signal))
      .toMatchObject({ ok: false, error: { code: 'TEAM_NATIVE_GRANT_REVOKED' } })
    expect(grant.signal.aborted).toBe(true)
    const late = provider.queueReport({ nativeHandle: handle, presence: 'idle' })
    await registration()
    late()
    expect(registration.available()).toBe(false)
    expect(await grant.execute({ operation: 'members.list' }, signal))
      .toMatchObject({ ok: false, error: { code: 'TEAM_NATIVE_GRANT_REVOKED' } })
  })

  it('keeps current authority across unrelated Agent disposal and idempotent provider recovery', async () => {
    const { ctx, provider, handle, unrelated } = await setup()
    const grant = provider.grants.get(handle)!
    await unrelated.dispose()
    expect(grant.signal.aborted).toBe(false)
    const rebound = Promise.withResolvers<undefined>()
    const bind = provider.bindMemberOperations.bind(provider)
    provider.bindMemberOperations = (request) => {
      bind(request)
      rebound.resolve(undefined)
    }
    const registration = ctx.agentTeams.registerTeammateRuntimeProvider(Object.assign(new NativeProduct(), { id: 'another-native-provider' }))
    await rebound.promise
    expect(provider.grants.get(handle)).toBe(grant)
    expect(await grant.execute({ operation: 'tasks.list' }, new AbortController().signal))
      .toEqual({ ok: true, operation: 'tasks.list', value: { tasks: [] } })
    await registration()
  })

  it('gives an accepted native member a query grant for its actual Team', async () => {
    const { provider, handle, lead, unrelated, launched } = await setup()
    const grant = provider.grants.get(handle)
    expect(grant, 'the Host must bind access after accepting the durable member identity').toBeDefined()
    const result = await grant!.execute({ operation: 'members.list' }, new AbortController().signal)
    expect(result).toMatchObject({ ok: true, operation: 'members.list', value: { members: [
      { id: lead.agent.id, name: 'lead', role: 'lead' },
      { id: launched.member.id, name: 'reviewer', role: 'teammate' },
    ] } })
    expect(JSON.stringify(result)).not.toContain(unrelated.agent.id)
  })

  it('reads live shared tasks with bounded pages and Team-local lookup', async () => {
    const { ctx, provider, handle, lead, unrelated } = await setup()
    const first = await ctx.agentTeams.createTask(lead.agent, { subject: 'Inspect', description: 'Inspect the source.' })
    const second = await ctx.agentTeams.createTask(lead.agent, {
      subject: 'Report', description: 'Report after inspection.', blockedBy: [first.id],
    })
    await ctx.agentTeams.createTask(unrelated.agent, { subject: 'Private elsewhere', description: 'Another Team.' })
    const grant = provider.grants.get(handle)!
    const signal = new AbortController().signal
    expect(await grant.execute({ operation: 'tasks.list', limit: 1 }, signal)).toEqual({
      ok: true, operation: 'tasks.list', value: { tasks: [first], nextCursor: first.id },
    })
    expect(await grant.execute({ operation: 'tasks.list', limit: 1, cursor: first.id }, signal)).toEqual({
      ok: true, operation: 'tasks.list', value: { tasks: [second] },
    })
    expect(await grant.execute({ operation: 'tasks.list', cursor: second.id }, signal)).toEqual({
      ok: true, operation: 'tasks.list', value: { tasks: [] },
    })
    expect(await grant.execute({ operation: 'tasks.get', taskId: second.id }, signal)).toEqual({
      ok: true, operation: 'tasks.get', value: { task: second },
    })
    await ctx.agentTeams.updateTask(lead.agent, { taskId: first.id, expectedRevision: first.revision, action: 'claim' })
    const live = ctx.agentTeams.getTask(lead.agent, first.id)
    const result = await grant.execute({ operation: 'tasks.get', taskId: first.id }, signal)
    expect(result).toEqual({ ok: true, operation: 'tasks.get', value: { task: live } })
    expect(JSON.stringify(result)).not.toContain('Private elsewhere')
    expect(await grant.execute({ operation: 'tasks.get', taskId: 'task-99' }, signal))
      .toMatchObject({ ok: false, error: { code: 'TEAM_TASK_NOT_FOUND' } })
    expect(await grant.execute({ operation: 'tasks.list', cursor: 'task-99' }, signal))
      .toMatchObject({ ok: false, error: { code: 'TEAM_NATIVE_INVALID_CURSOR' } })
  })

  it('bounds complete JSON requests and results while allowing smaller task pages', async () => {
    const { ctx, provider, handle, lead } = await setup()
    const grant = provider.grants.get(handle)!
    const signal = new AbortController().signal
    expect(await grant.execute({ operation: 'tasks.get', taskId: 'secret'.repeat(1_000) }, signal))
      .toEqual({ ok: false, error: { code: 'TEAM_NATIVE_REQUEST_LIMIT', message: 'The Team query request exceeds 4096 UTF-8 bytes.' } })
    for (let index = 0; index < 5; index += 1) {
      await ctx.agentTeams.createTask(lead.agent, { subject: `Task ${index}`, description: 'x'.repeat(16_384) })
    }
    const tooLarge = await grant.execute({ operation: 'tasks.list' }, signal)
    expect(tooLarge).toEqual({ ok: false, error: {
      code: 'TEAM_NATIVE_RESULT_LIMIT', message: 'The Team query result exceeds 65536 UTF-8 bytes; request a smaller task page.',
    } })
    const page = await grant.execute({ operation: 'tasks.list', limit: 1 }, signal)
    expect(page).toMatchObject({ ok: true, operation: 'tasks.list', value: { nextCursor: 'task-1' } })
    expect(Buffer.byteLength(JSON.stringify(page), 'utf8')).toBeLessThanOrEqual(65_536)
    expect(await grant.execute({ operation: 'tasks.list', limit: 101 }, signal))
      .toMatchObject({ ok: false, error: { code: 'TEAM_NATIVE_INVALID_REQUEST' } })
  })

  it.each([['ASCII', 'x', 1], ['multibyte', '界', 3]] as const)(
    'checks the complete %s request at and one byte beyond 4096 UTF-8 bytes',
    async (_label, character, width) => {
      const { provider, handle } = await setup()
      const grant = provider.grants.get(handle)!
      const signal = new AbortController().signal
      const request = { operation: 'tasks.get', taskId: '' }
      const remaining = 4_096 - Buffer.byteLength(JSON.stringify(request), 'utf8')
      request.taskId = character.repeat(Math.floor(remaining / width)) + 'x'.repeat(remaining % width)
      expect(Buffer.byteLength(JSON.stringify(request), 'utf8')).toBe(4_096)
      // At the byte limit, the oversized identifier reaches the separate task-id schema.
      expect(await grant.execute(request, signal))
        .toMatchObject({ ok: false, error: { code: 'TEAM_NATIVE_INVALID_REQUEST' } })
      request.taskId += 'x'
      expect(Buffer.byteLength(JSON.stringify(request), 'utf8')).toBe(4_097)
      expect(await grant.execute(request, signal))
        .toMatchObject({ ok: false, error: { code: 'TEAM_NATIVE_REQUEST_LIMIT' } })
    },
  )

  it.each([['ASCII', 'x'.repeat(16_300)], ['multibyte', '界'.repeat(5_400)]] as const)(
    'returns a complete %s task page at 65536 bytes and rejects the next byte',
    async (_label, description) => {
      const { ctx, provider, handle, lead } = await setup()
      const grant = provider.grants.get(handle)!
      const signal = new AbortController().signal
      for (let index = 0; index < 3; index += 1) {
        await ctx.agentTeams.createTask(lead.agent, { subject: `Task ${index}`, description })
      }
      const last = await ctx.agentTeams.createTask(lead.agent, { subject: 'Last task', description: 'x' })
      const expected = { ok: true, operation: 'tasks.list', value: { tasks: ctx.agentTeams.listTasks(lead.agent) } }
      const padding = 65_536 - Buffer.byteLength(JSON.stringify(expected), 'utf8')
      const edited = await ctx.agentTeams.updateTask(lead.agent, {
        taskId: last.id, expectedRevision: last.revision, action: 'edit', description: 'x'.repeat(padding + 1),
      })
      expected.value.tasks = ctx.agentTeams.listTasks(lead.agent)
      expect(Buffer.byteLength(JSON.stringify(expected), 'utf8')).toBe(65_536)
      const accepted = await grant.execute({ operation: 'tasks.list' }, signal)
      expect(accepted).toEqual(expected)
      expect(Buffer.byteLength(JSON.stringify(accepted), 'utf8')).toBe(65_536)
      await ctx.agentTeams.updateTask(lead.agent, {
        taskId: last.id, expectedRevision: edited.revision, action: 'edit', description: 'x'.repeat(padding + 2),
      })
      expected.value.tasks = ctx.agentTeams.listTasks(lead.agent)
      expect(Buffer.byteLength(JSON.stringify(expected), 'utf8')).toBe(65_537)
      expect(await grant.execute({ operation: 'tasks.list' }, signal)).toEqual({ ok: false, error: {
        code: 'TEAM_NATIVE_RESULT_LIMIT', message: 'The Team query result exceeds 65536 UTF-8 bytes; request a smaller task page.',
      } })
    },
  )

  it('revokes old authority before cleanup and regrants only the verified recovered identity', async () => {
    const { ctx, provider, registration, handle, lead } = await setup()
    const old = provider.grants.get(handle)!
    const signal = new AbortController().signal
    let duringCutoff: ReturnType<NativeMemberGrant['execute']> | undefined
    registration.onAvailabilityChanged(() => {
      if (!registration.available()) duringCutoff = old.execute({ operation: 'members.list' }, signal)
    })
    const disposing = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    cleanups.push(async () => { release.resolve(undefined) })
    provider.dispose = async () => {
      disposing.resolve(undefined)
      await release.promise
    }
    const replacement = new NativeProduct(provider.handles)
    const replacing = registration.replace(replacement)
    await disposing.promise
    expect(old.signal.aborted).toBe(true)
    expect(await duringCutoff).toMatchObject({ ok: false, error: { code: 'TEAM_NATIVE_GRANT_REVOKED' } })
    expect(await old.execute({ operation: 'members.list' }, signal))
      .toMatchObject({ ok: false, error: { code: 'TEAM_NATIVE_GRANT_REVOKED' } })
    release.resolve(undefined)
    await replacing
    await vi.waitFor(() => { expect(replacement.grants.has(handle)).toBe(true) })
    const current = replacement.grants.get(handle)!
    expect(current).not.toBe(old)
    expect(current.identity).toEqual(old.identity)
    expect(await current.execute({ operation: 'members.list' }, signal)).toMatchObject({ ok: true })
    expect(await old.execute({ operation: 'members.list' }, signal)).toMatchObject({ ok: false })

    const leadId = lead.agent.id
    await lead.dispose()
    expect(current.signal.aborted, 'Lead disposal cancels outstanding native queries immediately').toBe(true)
    expect(await current.execute({ operation: 'members.list' }, signal))
      .toMatchObject({ ok: false, error: { code: 'TEAM_NATIVE_GRANT_REVOKED' } })
    const resumed = await ctx.agents.resume({ resumeSessionId: leadId, agentOptions: {} })
    await vi.waitFor(() => { expect(replacement.grants.get(handle)).not.toBe(current) })
    const recovered = replacement.grants.get(handle)!
    expect(recovered.identity).toEqual(old.identity)
    expect(current.signal.aborted).toBe(true)
    expect(await recovered.execute({ operation: 'members.list' }, signal)).toMatchObject({ ok: true })
    await resumed.dispose()
    await registration()
    expect(recovered.signal.aborted).toBe(true)
    expect(await recovered.execute({ operation: 'members.list' }, signal)).toMatchObject({ ok: false })
  })

  it('refuses model-supplied authority and cancellation without mutating Team facts', async () => {
    const { ctx, provider, handle, lead, unrelated } = await setup()
    const grant = provider.grants.get(handle)!
    const before = [...lead.agent.session.ownEvents()]
    const signal = new AbortController().signal
    for (const input of [
      undefined,
      { operation: 'members.list', teamId: unrelated.agent.id },
      { operation: 'members.list', role: 'lead' },
      { operation: 'tasks.list', memberId: lead.agent.id },
      { operation: 'tasks.list', nativeHandle: 'guessed-native-handle' },
      { operation: 'rpc', method: 'createTask', args: {} },
      { operation: 'tasks.update', taskId: 'task-1', action: 'claim' },
    ]) {
      expect(await grant.execute(input, signal))
        .toMatchObject({ ok: false, error: { code: 'TEAM_NATIVE_INVALID_REQUEST' } })
    }
    expect(await grant.execute({ operation: 'members.list' }, AbortSignal.abort('private abort reason')))
      .toEqual({ ok: false, error: { code: 'TEAM_NATIVE_CANCELLED', message: 'The Team query was cancelled.' } })
    const cancellation = new AbortController()
    const queued = grant.execute({ operation: 'tasks.list' }, cancellation.signal)
    cancellation.abort()
    expect(await queued).toMatchObject({ ok: false, error: { code: 'TEAM_NATIVE_CANCELLED' } })
    // Serialized model identity must not become an ordinary DSH Agent credential.
    const forged = JSON.parse(JSON.stringify({ id: lead.agent.id })) as unknown as Parameters<typeof ctx.agentTeams.listMembers>[0]
    expect(() => ctx.agentTeams.listMembers(forged)).toThrow()
    expect(lead.agent.session.ownEvents()).toEqual(before)
  })

  it('never grants production Team authority to isolated evaluation handles', async () => {
    class EvaluatingProduct extends NativeProduct {
      override readonly runtimeCapabilities = ['evaluation'] as const
      override readonly profileCapabilities = ['persona', 'mission', 'hooks'] as const
      readonly evaluationTools = []
      async createEvaluationHandle() {
        return {
          evaluationHandle: TeammateEvaluationHandle('isolated-worker'), turnId: TeammateRuntimeTurnId('evaluation-turn'),
          terminal: 'completed' as const, output: [], complete: true, startedAt: 1, endedAt: 2,
          evidence: [{ id: TeammateRuntimeEvidenceId('evaluation-terminal'), kind: 'turn' as const,
            turnId: TeammateRuntimeTurnId('evaluation-turn'), outcome: 'completed' as const, timestamp: 2 }],
        }
      }
    }
    const provider = new EvaluatingProduct()
    const { ctx, lead, handle } = await setup(provider)
    const before = ctx.agentTeams.listMembers(lead.agent)
    const result = await ctx.agentTeams.runTeammateEvaluation(lead.agent, provider.id, {
      evaluationId: TeammateEvaluationId('isolated-case'),
      profile: {
        persona: 'Be precise.', mission: 'Review only the fixture.', context: [], memory: [],
        toolPolicy: { mode: 'inherit', names: [] },
        hooks: [{ id: 'evaluation-context', point: 'before-step', effect: 'context', text: 'Read only.' }],
      },
      requirements: { contextMode: 'fresh', profileCapabilities: ['persona', 'mission', 'hooks'], runtimeCapabilities: ['evaluation'] },
      input: [{ type: 'text', text: 'Evaluate this fixture.' }],
      environment: { sandbox: 'read-only', approval: 'never', toolAllowlist: [], fixtures: [], maxSteps: 1, maxOutputTokens: 100, maxElapsedMs: 1_000 },
      signal: new AbortController().signal,
    })
    expect(result).toMatchObject({ terminal: 'completed' })
    expect([...provider.grants.keys()]).toEqual([handle])
    expect(ctx.agentTeams.listMembers(lead.agent)).toEqual(before)
    await expect(ctx.agentTeams.runTeammateEvaluation(lead.agent, provider.id, {
      evaluationId: TeammateEvaluationId('oversized-isolated-case'),
      profile: { persona: 'Be precise.', mission: 'Review.', context: [], memory: [],
        toolPolicy: { mode: 'inherit', names: [] }, hooks: [] },
      requirements: { contextMode: 'fresh', profileCapabilities: ['persona', 'mission'], runtimeCapabilities: ['evaluation'] },
      input: [{ type: 'text', text: 'Evaluate.' }],
      environment: { sandbox: 'read-only', approval: 'never', toolAllowlist: [],
        fixtures: [{ id: 'oversized-fixture', content: 'x'.repeat(200_000) }],
        maxSteps: 1, maxOutputTokens: 100, maxElapsedMs: 1_000 },
      signal: new AbortController().signal,
    })).rejects.toMatchObject({ code: 'TEAM_RUNTIME_CAPABILITY_MISMATCH' })
    expect(provider.grants.get(handle)!.signal.aborted).toBe(false)
    expect(ctx.agentTeams.listMembers(lead.agent)).toEqual(before)
  })

  it('quarantines a failed native binding while preserving the accepted member', async () => {
    const provider = new NativeProduct()
    provider.bindMemberOperations = ({ nativeHandle, grant }) => {
      provider.grants.set(nativeHandle, grant)
      throw new Error('external connection refused its binding')
    }
    const { ctx, lead, registration, handle, launched } = await setup(provider)
    expect(registration.available()).toBe(false)
    const grant = provider.grants.get(handle)!
    expect(grant.signal.aborted).toBe(true)
    expect(await grant.execute({ operation: 'members.list' }, new AbortController().signal))
      .toMatchObject({ ok: false, error: { code: 'TEAM_NATIVE_GRANT_REVOKED' } })
    await vi.waitFor(() => {
      const row = ctx.agentTeams.listMembers(lead.agent).find(member => member.id === launched.member.id)
      expect(row).toMatchObject({ id: launched.member.id, name: 'reviewer', status: 'inactive' })
      expect(row?.externalRuntime?.nativeHandle).toBe(handle)
    })
    const memberEvents = lead.agent.session.ownEvents().filter(event => event.type === 'team/member')
    expect(memberEvents.at(-1)).toMatchObject({ data: { member: { phase: 'active' } } })
  })
})
