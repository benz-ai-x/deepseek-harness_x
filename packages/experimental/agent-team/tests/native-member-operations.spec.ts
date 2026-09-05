import { mkdtempSync, rmSync } from 'node:fs'
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
import TeamService, {
  TeammateEvaluationHandle,
  TeammateEvaluationId,
  TeammateLaunchRequestId,
  TeammateRuntimeHandle,
  TeammateRuntimeEvidenceId,
  TeammateRuntimeTurnId,
  type NativeMemberGrant,
  type TeammateRuntimeCapability,
  type TeammateRuntimeCreateRequest,
  type TeammateRuntimeProvider,
  type TeammateRuntimeResumeRequest,
} from '../src/index.ts'
import { TestSessionQuery } from './test-session-query.ts'

// Only the external native product is deterministic; Team authority and storage are real.
class NativeProduct implements TeammateRuntimeProvider {
  readonly id = 'native-query'
  readonly displayName = 'Native query fixture'
  readonly contextModes = ['fresh'] as const
  readonly profileCapabilities = ['persona', 'mission'] as const
  readonly runtimeCapabilities: readonly TeammateRuntimeCapability[] = []
  readonly memberOperations = ['members.list', 'tasks.list', 'tasks.get'] as const
  readonly grants = new Map<TeammateRuntimeHandle, NativeMemberGrant>()
  constructor(readonly handles = new Map<string, TeammateRuntimeHandle>()) {}

  async create(request: TeammateRuntimeCreateRequest) {
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

  async deliver(): Promise<never> { throw new Error('the query fixture does not deliver messages') }
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
  await ctx.plugin(TeamService)
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
  return { ctx, lead, unrelated, provider, registration, launched, handle }
}

describe('native Team member queries', () => {
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
        toolPolicy: { mode: 'inherit', names: [] }, hooks: [],
      },
      requirements: { contextMode: 'fresh', profileCapabilities: ['persona', 'mission'], runtimeCapabilities: ['evaluation'] },
      input: [{ type: 'text', text: 'Evaluate this fixture.' }],
      environment: { sandbox: 'read-only', approval: 'never', toolAllowlist: [], fixtures: [], maxSteps: 1, maxOutputTokens: 100, maxElapsedMs: 1_000 },
      signal: new AbortController().signal,
    })
    expect(result).toMatchObject({ terminal: 'completed' })
    expect([...provider.grants.keys()]).toEqual([handle])
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
