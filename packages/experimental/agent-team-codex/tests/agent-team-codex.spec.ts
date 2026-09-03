import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { SessionId } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SubagentService from '@deepseek-ai/dsh-subagent'
import type {
  SubprocessHandle,
  SubprocessOutcome,
} from '@deepseek-ai/dsh-subprocess'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import TeamService, {
  TeamMessageId,
  TeammateEvaluationHandle,
  TeammateLaunchRequestId,
  TeammateRuntimeError,
  TeammateRuntimeEvidenceCursor,
  TeammateRuntimeHandle,
  type TeammateRuntimeCreateRequest,
  type TeammateRuntimeEvidenceRequest,
  type TeammateRuntimeEvidenceResult,
  type TeammateRuntimeProvider,
} from '@deepseek-ai/dsh-experimental-agent-team'
import * as codexRuntime from '../src/index.ts'
import { TestSessionQuery } from '../../agent-team/tests/test-session-query.ts'

type JsonObject = Record<string, unknown>

const temporaryRoots: string[] = []

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

class ProtocolPeer {
  private buffer = ''
  private readonly frames: JsonObject[] = []
  private readonly wakeups = new Set<() => void>()

  constructor(input: PassThrough, private readonly output: PassThrough) {
    input.on('data', (chunk: Buffer | string) => {
      this.buffer += chunk.toString()
      for (;;) {
        const newline = this.buffer.indexOf('\n')
        if (newline < 0) break
        const line = this.buffer.slice(0, newline)
        this.buffer = this.buffer.slice(newline + 1)
        if (line.trim().length > 0) this.frames.push(JSON.parse(line) as JsonObject)
      }
      for (const wake of this.wakeups) wake()
      this.wakeups.clear()
    })
  }

  async nextMethod(method: string): Promise<JsonObject> {
    for (;;) {
      const index = this.frames.findIndex(frame => frame.method === method)
      if (index >= 0) return this.frames.splice(index, 1)[0]!
      await new Promise<void>((resolve) => { this.wakeups.add(resolve) })
    }
  }

  async nextResponse(id: number): Promise<JsonObject> {
    for (;;) {
      const index = this.frames.findIndex(frame => frame.id === id && frame.method === undefined)
      if (index >= 0) return this.frames.splice(index, 1)[0]!
      await new Promise<void>((resolve) => { this.wakeups.add(resolve) })
    }
  }

  send(...frames: readonly JsonObject[]): void {
    this.output.write(`${frames.map(frame => JSON.stringify(frame)).join('\n')}\n`)
  }

  respond(request: JsonObject, result: unknown): void {
    this.send({ id: request.id, result })
  }
}

function fakeChild(options: {
  readonly settleOnTerminate?: boolean
  readonly swallowDoneFailureOnWait?: boolean
} = {}): {
  readonly handle: SubprocessHandle
  readonly peer: ProtocolPeer
  readonly terminate: ReturnType<typeof vi.fn>
  readonly settle: (outcome?: SubprocessOutcome) => void
  readonly fail: (error?: Error) => void
} {
  const fromChild = new PassThrough()
  const toChild = new PassThrough()
  const stderr = new PassThrough()
  const peer = new ProtocolPeer(toChild, fromChild)
  let exited = false
  let settleDone!: (outcome: SubprocessOutcome) => void
  let rejectDone!: (error: Error) => void
  const done = new Promise<SubprocessOutcome>((resolve, reject) => {
    settleDone = resolve
    rejectDone = reject
  })
  const settle = (outcome: SubprocessOutcome = { exitCode: 0, signal: null }): void => {
    if (exited) return
    exited = true
    settleDone(outcome)
  }
  const fail = (error = new Error('fake subprocess failed')): void => {
    if (exited) return
    exited = true
    rejectDone(error)
  }
  const terminate = vi.fn(() => {
    if (options.settleOnTerminate !== false) settle()
  })
  const handle: SubprocessHandle = {
    pid: 1234,
    stdin: toChild,
    stdout: fromChild,
    stderr,
    collected: {},
    done,
    terminate,
    waitForExit: async () => {
      if (!exited) {
        if (options.swallowDoneFailureOnWait === true) await done.catch(() => undefined)
        else await done
      }
      return true
    },
  }
  return { handle, peer, terminate, settle, fail }
}

async function respondProject(
  peer: ProtocolPeer,
  projectId = 'project-codex-runtime',
): Promise<JsonObject> {
  const request = await peer.nextMethod('project/create')
  peer.respond(request, { project: { id: projectId } })
  return request
}

async function setup(
  child: ReturnType<typeof fakeChild>,
  config: codexRuntime.Config = {},
  existingStorageRoot?: string,
  resumeLead = false,
) {
  const storageRoot = existingStorageRoot ?? mkdtempSync(join(tmpdir(), 'dsh-team-codex-'))
  if (existingStorageRoot === undefined) temporaryRoots.push(storageRoot)
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(JsonlSessionPersistence, { root: storageRoot })
  await ctx.plugin(TestSessionQuery)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(SubagentService)
  await ctx.plugin(LocalSubprocessRuntime)
  await ctx.plugin(TeamService)
  const registerProvider = vi.spyOn(ctx.agentTeams, 'registerTeammateRuntimeProvider')
  const spawn = vi.spyOn(ctx.subprocess, 'spawn').mockReturnValue(child.handle)
  const providerFiber = await ctx.plugin(codexRuntime, Object.assign({
    cwd: process.cwd(),
    sandbox: 'read-only' as const,
  }, config))
  const leadHandle = resumeLead
    ? await ctx.agents.resume({ resumeSessionId: SessionId('codex-team-lead'), agentOptions: {} })
    : undefined
  const lead = leadHandle?.agent ?? ctx.agentLoop.create(SessionId('codex-team-lead'), {})
  const provider: TeammateRuntimeProvider | undefined = registerProvider.mock.calls[0]?.[0]
  if (provider === undefined) throw new Error('Codex provider did not register')
  return { ctx, lead, leadHandle, provider, providerFiber, spawn, storageRoot }
}

function profile() {
  return {
    persona: 'Be exact.',
    mission: 'Review the assigned change.',
    context: [],
    memory: [],
    toolPolicy: { mode: 'inherit' as const, names: [] },
    hooks: [],
  }
}

function createRequest(overrides: Partial<TeammateRuntimeCreateRequest> = {}): TeammateRuntimeCreateRequest {
  return {
    launchRequestId: TeammateLaunchRequestId('aaaaaaaa-1111-4111-8111-111111111111'),
    memberId: SessionId('direct-codex-member'),
    memberName: 'direct-codex',
    description: 'Exercise the provider directly',
    initialWork: [{ type: 'text', text: 'Run direct provider work.' }],
    profile: profile(),
    requirements: {
      contextMode: 'fresh',
      profileCapabilities: ['persona', 'mission'],
      runtimeCapabilities: ['sandbox', 'evidence', 'usage'],
    },
    signal: new AbortController().signal,
    ...overrides,
  }
}

function queryEvidence(
  provider: TeammateRuntimeProvider,
  request: TeammateRuntimeEvidenceRequest,
): Promise<TeammateRuntimeEvidenceResult> {
  if (provider.evidence === undefined) {
    throw new Error('Codex provider did not expose its advertised evidence capability')
  }
  return provider.evidence(request)
}

async function beginFreshCreation(
  provider: TeammateRuntimeProvider,
  child: ReturnType<typeof fakeChild>,
): Promise<{
  creating: Promise<Awaited<ReturnType<TeammateRuntimeProvider['create']>>>
  threadStart: JsonObject
}> {
  const creating = provider.create(createRequest())
  const initialize = await child.peer.nextMethod('initialize')
  child.peer.send(
    { method: 'item/completed', params: { item: { type: 'commandExecution', id: 'too-early-item' } } },
    { method: 'thread/tokenUsage/updated', params: { turnId: 'too-early-turn' } },
  )
  child.peer.respond(initialize, {})
  await child.peer.nextMethod('initialized')
  await respondProject(child.peer, 'project-failure-matrix')
  const listed = await child.peer.nextMethod('thread/list')
  child.peer.respond(listed, { data: [], nextCursor: null })
  const threadStart = await child.peer.nextMethod('thread/start')
  return { creating, threadStart }
}

describe('durable Codex teammate runtime', () => {
  it('reports only bounded eligibility facts for the exact pinned native product', () => {
    const eligibility = codexRuntime.codexProductEligibility()
    expect(eligibility).toEqual({
      eligible: true,
      product: 'codex',
      version: '0.149.1',
      protocol: 'app-server-v2',
    })
    expect(JSON.stringify(eligibility)).not.toContain('/root/')
    expect(JSON.stringify(eligibility)).not.toContain('node_modules')
  })

  it('rejects a sandbox weakening before publishing another provider generation', async () => {
    const child = fakeChild()
    const { ctx, providerFiber } = await setup(child)
    await expect(ctx.plugin(codexRuntime, {
      providerName: 'codex-unsafe',
      cwd: process.cwd(),
      sandbox: 'danger-full-access' as never,
    })).rejects.toThrow(/sandbox.*read-only.*workspace-write/su)
    const registry = (ctx.agentTeams as unknown as {
      teammateRuntimeRegistry: { available(providerId: string): boolean }
    }).teammateRuntimeRegistry
    expect(registry.available('codex-unsafe')).toBe(false)

    await providerFiber.dispose()
    await ctx.fiber.dispose()
  })

  it('advertises only enforceable capabilities and rejects unsupported Profile policy before launch', async () => {
    const child = fakeChild()
    const { ctx, lead, providerFiber, spawn } = await setup(child)
    const registry = (ctx.agentTeams as unknown as {
      teammateRuntimeRegistry: {
        snapshot(): readonly unknown[]
      }
    }).teammateRuntimeRegistry
    expect(registry.snapshot()).toContainEqual({
      id: 'codex',
      displayName: 'Codex',
      contextModes: ['fresh'],
      profileCapabilities: ['persona', 'mission', 'context', 'memory'],
      runtimeCapabilities: ['sandbox', 'evidence', 'usage'],
    })

    await expect(ctx.agentTeams.spawnTeammate(lead, {
      name: 'codex-overclaim',
      description: 'Must fail before native launch',
      prompt: [{ type: 'text', text: 'Do not start.' }],
      context: 'fresh',
      runtime: {
        kind: 'external-agent',
        provider: 'codex',
        launchRequestId: TeammateLaunchRequestId('66666666-6666-4666-8666-666666666666'),
        profile: {
          ...profile(),
          toolPolicy: { mode: 'allow', names: ['bash'] },
        },
        requirements: {
          contextMode: 'fresh',
          profileCapabilities: ['persona', 'mission', 'tool-policy'],
          runtimeCapabilities: ['sandbox', 'exact-call-approval', 'evaluation'],
        },
      },
      signal: new AbortController().signal,
    })).rejects.toMatchObject({ code: 'TEAM_RUNTIME_CAPABILITY_MISMATCH' })
    expect(spawn).not.toHaveBeenCalled()

    await providerFiber.dispose()
    await ctx.fiber.dispose()
  })

  it('fails before the first turn when Codex reports a weaker effective sandbox', async () => {
    const child = fakeChild()
    const { ctx, lead, providerFiber } = await setup(child)
    const spawning = ctx.agentTeams.spawnTeammate(lead, {
      name: 'codex-sandbox-check',
      description: 'Reject a native sandbox downgrade',
      prompt: [{ type: 'text', text: 'This turn must never start.' }],
      context: 'fresh',
      runtime: {
        kind: 'external-agent',
        provider: 'codex',
        launchRequestId: TeammateLaunchRequestId('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),
        profile: profile(),
        requirements: {
          contextMode: 'fresh',
          profileCapabilities: ['persona', 'mission'],
          runtimeCapabilities: ['sandbox', 'evidence', 'usage'],
        },
      },
      signal: new AbortController().signal,
    })
    const initialize = await child.peer.nextMethod('initialize')
    child.peer.respond(initialize, {})
    await child.peer.nextMethod('initialized')
    await respondProject(child.peer)
    const listed = await child.peer.nextMethod('thread/list')
    child.peer.respond(listed, { data: [], nextCursor: null, backwardsCursor: null })
    const threadStart = await child.peer.nextMethod('thread/start')
    child.peer.respond(threadStart, {
      approvalPolicy: 'never',
      sandbox: { type: 'dangerFullAccess' },
      thread: {
        id: '0a999999-1111-7777-8111-111111111111',
        ephemeral: false,
        turns: [],
      },
    })

    const outcome = await Promise.race([
      spawning.then(
        () => ({ kind: 'created' as const }),
        (error: unknown) => ({ kind: 'rejected' as const, error }),
      ),
      child.peer.nextMethod('turn/start').then(() => ({ kind: 'turn-started' as const })),
    ])
    expect(outcome).toMatchObject({
      kind: 'rejected',
      error: { code: 'TEAM_RUNTIME_UNAVAILABLE' },
    })
    expect(child.terminate).toHaveBeenCalledTimes(1)

    await providerFiber.dispose()
    await ctx.fiber.dispose()
  })

  it('creates a persistent native thread and accepts initial work on that exact thread', async () => {
    const child = fakeChild()
    const { ctx, lead, providerFiber } = await setup(child)
    const spawning = ctx.agentTeams.spawnTeammate(lead, {
      name: 'codex-reviewer',
      description: 'Review code with Codex',
      prompt: [{ type: 'text', text: 'Review the current change.' }],
      context: 'fresh',
      runtime: {
        kind: 'external-agent',
        provider: 'codex',
        launchRequestId: TeammateLaunchRequestId('11111111-1111-4111-8111-111111111111'),
        profile: profile(),
        requirements: {
          contextMode: 'fresh',
          profileCapabilities: ['persona', 'mission'],
          runtimeCapabilities: ['sandbox', 'evidence', 'usage'],
        },
      },
      signal: new AbortController().signal,
    })

    const initialize = await child.peer.nextMethod('initialize')
    expect(initialize.params).toMatchObject({
      capabilities: { experimentalApi: true, requestAttestation: false },
    })
    child.peer.respond(initialize, { userAgent: 'codex-cli 0.149.1' })
    await child.peer.nextMethod('initialized')
    const projectCreate = await respondProject(child.peer, 'project-persistent-thread')
    expect(projectCreate.params).toMatchObject({
      roots: [{ path: process.cwd() }],
      metadata: { owner: 'deepseek-harness-agent-team' },
    })
    const projectCreateParams = projectCreate.params as JsonObject
    expect(projectCreateParams.name).toMatch(/^DSH Codex teammate [a-f0-9]{12}$/u)
    expect(projectCreateParams.idempotencyKey).toMatch(/^dsh-agent-team-codex:[a-f0-9]{64}$/u)
    const listed = await child.peer.nextMethod('thread/list')
    expect(listed.params).toMatchObject({ limit: 2, useStateDbOnly: true })
    const projectId = (listed.params as JsonObject).projectId
    expect(projectId).toBe('project-persistent-thread')
    child.peer.respond(listed, { data: [], nextCursor: null, backwardsCursor: null })

    const started = await child.peer.nextMethod('thread/start')
    expect(started.params).toMatchObject({
      cwd: process.cwd(),
      projectId,
      ephemeral: false,
      approvalPolicy: 'never',
      sandbox: 'read-only',
    })
    expect(JSON.stringify(started.params)).toContain('Be exact.')
    expect(JSON.stringify(started.params)).toContain('Review the assigned change.')
    child.peer.respond(started, {
      approvalPolicy: 'never',
      sandbox: { type: 'readOnly', networkAccess: false },
      thread: { id: '01999999-1111-7777-8111-111111111111', ephemeral: false, turns: [] },
    })

    const turn = await child.peer.nextMethod('turn/start')
    expect(turn.params).toMatchObject({
      threadId: '01999999-1111-7777-8111-111111111111',
      input: [{ type: 'text', text: 'Review the current change.', text_elements: [] }],
    })
    child.peer.respond(turn, { turn: { id: '01999999-2222-7777-8222-222222222222' } })

    await expect(spawning).resolves.toMatchObject({
      member: {
        name: 'codex-reviewer',
        status: 'running',
        externalRuntime: {
          nativeHandle: '01999999-1111-7777-8111-111111111111',
        },
      },
    })

    child.peer.send({
      method: 'turn/completed',
      params: {
        threadId: '01999999-1111-7777-8111-111111111111',
        turn: { id: '01999999-2222-7777-8222-222222222222', status: 'completed' },
      },
    })
    await vi.waitFor(() => {
      expect(ctx.agentTeams.listMembers(lead)[1]?.status).toBe('idle')
    })

    await providerFiber.dispose()
    expect(child.terminate).toHaveBeenCalledTimes(1)
    await ctx.fiber.dispose()
  })

  it('converges concurrent duplicate launch intents on one native thread', async () => {
    const child = fakeChild()
    const { ctx, lead, providerFiber, spawn } = await setup(child)
    const launch = {
      name: 'codex-deduplicator',
      description: 'Deduplicate Codex launches',
      prompt: [{ type: 'text' as const, text: 'Perform one native launch.' }],
      context: 'fresh' as const,
      runtime: {
        kind: 'external-agent' as const,
        provider: 'codex',
        launchRequestId: TeammateLaunchRequestId('77777777-7777-4777-8777-777777777777'),
        profile: profile(),
        requirements: {
          contextMode: 'fresh' as const,
          profileCapabilities: ['persona', 'mission'] as const,
          runtimeCapabilities: ['sandbox', 'evidence', 'usage'] as const,
        },
      },
      signal: new AbortController().signal,
    }
    const first = ctx.agentTeams.spawnTeammate(lead, launch)
    const duplicate = ctx.agentTeams.spawnTeammate(lead, launch)
    const initialize = await child.peer.nextMethod('initialize')
    child.peer.respond(initialize, {})
    await child.peer.nextMethod('initialized')
    await respondProject(child.peer)
    const listed = await child.peer.nextMethod('thread/list')
    child.peer.respond(listed, { data: [], nextCursor: null, backwardsCursor: null })
    const threadStart = await child.peer.nextMethod('thread/start')
    child.peer.respond(threadStart, {
      approvalPolicy: 'never',
      sandbox: { type: 'readOnly', networkAccess: false },
      thread: { id: '07999999-1111-7777-8111-111111111111', ephemeral: false, turns: [] },
    })
    const turnStart = await child.peer.nextMethod('turn/start')
    child.peer.respond(turnStart, { turn: { id: '07999999-2222-7777-8222-222222222222' } })

    const [created, replayed] = await Promise.all([first, duplicate])
    expect(replayed.member.id).toBe(created.member.id)
    expect(replayed.member.externalRuntime?.nativeHandle)
      .toBe(created.member.externalRuntime?.nativeHandle)
    expect(spawn).toHaveBeenCalledTimes(1)
    expect(ctx.agentTeams.listMembers(lead)).toHaveLength(2)

    child.peer.send({
      method: 'turn/completed',
      params: {
        threadId: '07999999-1111-7777-8111-111111111111',
        turn: { id: '07999999-2222-7777-8222-222222222222', status: 'completed' },
      },
    })
    await providerFiber.dispose()
    await ctx.fiber.dispose()
  })

  it('cold-resumes the same native thread after the whole Host context restarts', async () => {
    const first = fakeChild()
    const initial = await setup(first)
    const spawning = initial.ctx.agentTeams.spawnTeammate(initial.lead, {
      name: 'codex-survivor',
      description: 'Survive a Host restart',
      prompt: [{ type: 'text', text: 'Persist this native employee.' }],
      context: 'fresh',
      runtime: {
        kind: 'external-agent',
        provider: 'codex',
        launchRequestId: TeammateLaunchRequestId('88888888-8888-4888-8888-888888888888'),
        profile: profile(),
        requirements: {
          contextMode: 'fresh',
          profileCapabilities: ['persona', 'mission'],
          runtimeCapabilities: ['sandbox', 'evidence', 'usage'],
        },
      },
      signal: new AbortController().signal,
    })
    const initialize = await first.peer.nextMethod('initialize')
    first.peer.respond(initialize, {})
    await first.peer.nextMethod('initialized')
    await respondProject(first.peer, 'project-host-restart')
    const listed = await first.peer.nextMethod('thread/list')
    const projectId = (listed.params as JsonObject).projectId
    first.peer.respond(listed, { data: [], nextCursor: null, backwardsCursor: null })
    const threadStart = await first.peer.nextMethod('thread/start')
    first.peer.respond(threadStart, {
      approvalPolicy: 'never',
      sandbox: { type: 'readOnly', networkAccess: false },
      thread: {
        id: '08999999-1111-7777-8111-111111111111',
        projectId,
        ephemeral: false,
        turns: [],
      },
    })
    const turnStart = await first.peer.nextMethod('turn/start')
    first.peer.respond(turnStart, { turn: { id: '08999999-2222-7777-8222-222222222222' } })
    await spawning
    first.peer.send({
      method: 'turn/completed',
      params: {
        threadId: '08999999-1111-7777-8111-111111111111',
        turn: { id: '08999999-2222-7777-8222-222222222222', status: 'completed' },
      },
    })
    await vi.waitFor(() => { expect(initial.ctx.agentTeams.listMembers(initial.lead)[1]?.status).toBe('idle') })
    await initial.ctx.fiber.dispose()
    expect(first.terminate).toHaveBeenCalledTimes(1)

    const second = fakeChild()
    const restarted = await setup(second, {}, initial.storageRoot, true)
    await vi.waitFor(() => { expect(restarted.spawn).toHaveBeenCalledTimes(1) })
    const reinitialize = await second.peer.nextMethod('initialize')
    second.peer.respond(reinitialize, {})
    await second.peer.nextMethod('initialized')
    await respondProject(second.peer, 'project-host-restart')
    const resumed = await second.peer.nextMethod('thread/resume')
    expect(resumed.params).toMatchObject({
      threadId: '08999999-1111-7777-8111-111111111111',
      approvalPolicy: 'never',
      sandbox: 'read-only',
    })
    second.peer.respond(resumed, {
      approvalPolicy: 'never',
      sandbox: { type: 'readOnly', networkAccess: false },
      thread: {
        id: '08999999-1111-7777-8111-111111111111',
        projectId,
        ephemeral: false,
        status: { type: 'idle' },
        turns: [{
          id: '08999999-2222-7777-8222-222222222222',
          status: 'completed',
          items: [{
            type: 'userMessage',
            id: 'user-before-restart',
            clientId: 'dsh-launch:88888888-8888-4888-8888-888888888888',
            content: [],
          }],
        }],
      },
    })
    await vi.waitFor(() => {
      expect(restarted.ctx.agentTeams.listMembers(restarted.lead)[1]).toMatchObject({
        name: 'codex-survivor',
        status: 'idle',
        externalRuntime: { nativeHandle: '08999999-1111-7777-8111-111111111111' },
      })
    })

    await restarted.ctx.fiber.dispose()
    expect(second.terminate).toHaveBeenCalledTimes(1)
  })

  it('interrupts the exact active turn and removes its process tree and registration with the Fiber', async () => {
    const child = fakeChild()
    const { ctx, lead, providerFiber } = await setup(child)
    const spawning = ctx.agentTeams.spawnTeammate(lead, {
      name: 'codex-interruptee',
      description: 'Own one interruptible turn',
      prompt: [{ type: 'text', text: 'Keep working until interrupted.' }],
      context: 'fresh',
      runtime: {
        kind: 'external-agent',
        provider: 'codex',
        launchRequestId: TeammateLaunchRequestId('99999999-9999-4999-8999-999999999999'),
        profile: profile(),
        requirements: {
          contextMode: 'fresh',
          profileCapabilities: ['persona', 'mission'],
          runtimeCapabilities: ['sandbox', 'evidence', 'usage'],
        },
      },
      signal: new AbortController().signal,
    })
    const initialize = await child.peer.nextMethod('initialize')
    child.peer.respond(initialize, {})
    await child.peer.nextMethod('initialized')
    await respondProject(child.peer)
    const listed = await child.peer.nextMethod('thread/list')
    child.peer.respond(listed, { data: [], nextCursor: null, backwardsCursor: null })
    const threadStart = await child.peer.nextMethod('thread/start')
    child.peer.respond(threadStart, {
      approvalPolicy: 'never',
      sandbox: { type: 'readOnly', networkAccess: false },
      thread: { id: '09999999-1111-7777-8111-111111111111', ephemeral: false, turns: [] },
    })
    const turnStart = await child.peer.nextMethod('turn/start')
    child.peer.respond(turnStart, { turn: { id: '09999999-2222-7777-8222-222222222222' } })
    await spawning

    expect(ctx.agentTeams.interrupt(lead, 'codex-interruptee')).toEqual({ previousStatus: 'running' })
    const interrupt = await child.peer.nextMethod('turn/interrupt')
    expect(interrupt.params).toEqual({
      threadId: '09999999-1111-7777-8111-111111111111',
      turnId: '09999999-2222-7777-8222-222222222222',
    })

    await providerFiber.dispose()
    expect(child.terminate).toHaveBeenCalledTimes(1)
    expect(ctx.agentTeams.listMembers(lead)[1]).toMatchObject({
      name: 'codex-interruptee',
      status: 'inactive',
    })
    const registry = (ctx.agentTeams as unknown as {
      teammateRuntimeRegistry: {
        snapshot(): readonly unknown[]
        available(providerId: string): boolean
      }
    }).teammateRuntimeRegistry
    expect(registry.available('codex')).toBe(false)
    expect(registry.snapshot()).not.toContainEqual(expect.objectContaining({ id: 'codex' }))
    await ctx.fiber.dispose()
  })

  it('repairs a crashed App Server by resuming the exact thread before mailbox delivery', async () => {
    const first = fakeChild()
    const second = fakeChild()
    const { ctx, lead, providerFiber, spawn } = await setup(first)
    const spawning = ctx.agentTeams.spawnTeammate(lead, {
      name: 'codex-repairer',
      description: 'Repair through Codex',
      prompt: [{ type: 'text', text: 'Inspect the repository.' }],
      context: 'fresh',
      runtime: {
        kind: 'external-agent',
        provider: 'codex',
        launchRequestId: TeammateLaunchRequestId('22222222-2222-4222-8222-222222222222'),
        profile: profile(),
        requirements: {
          contextMode: 'fresh',
          profileCapabilities: ['persona', 'mission'],
          runtimeCapabilities: ['sandbox', 'evidence', 'usage'],
        },
      },
      signal: new AbortController().signal,
    })
    const initialize = await first.peer.nextMethod('initialize')
    first.peer.respond(initialize, {})
    await first.peer.nextMethod('initialized')
    await respondProject(first.peer, 'project-crash-repair')
    const listed = await first.peer.nextMethod('thread/list')
    const projectId = (listed.params as JsonObject).projectId
    first.peer.respond(listed, { data: [], nextCursor: null, backwardsCursor: null })
    const threadStart = await first.peer.nextMethod('thread/start')
    first.peer.respond(threadStart, {
      approvalPolicy: 'never',
      sandbox: { type: 'readOnly', networkAccess: false },
      thread: {
        id: '02999999-1111-7777-8111-111111111111',
        projectId,
        ephemeral: false,
        turns: [],
      },
    })
    const initialTurn = await first.peer.nextMethod('turn/start')
    first.peer.respond(initialTurn, { turn: { id: '02999999-2222-7777-8222-222222222222' } })
    await spawning
    first.peer.send({
      method: 'turn/completed',
      params: {
        threadId: '02999999-1111-7777-8111-111111111111',
        turn: { id: '02999999-2222-7777-8222-222222222222', status: 'completed' },
      },
    })
    await vi.waitFor(() => { expect(ctx.agentTeams.listMembers(lead)[1]?.status).toBe('idle') })

    spawn.mockReturnValue(second.handle)
    first.settle({ exitCode: 17, signal: null })
    await vi.waitFor(() => { expect(ctx.agentTeams.listMembers(lead)[1]?.status).toBe('inactive') })
    const delivery = ctx.agentTeams.sendMessage(lead, {
      target: 'codex-repairer',
      content: [{ type: 'text', text: 'Continue after the crash.' }],
      delivery: 'wakeup',
      signal: new AbortController().signal,
    })

    await vi.waitFor(() => { expect(spawn).toHaveBeenCalledTimes(2) })
    const reinitialize = await second.peer.nextMethod('initialize')
    second.peer.respond(reinitialize, {})
    await second.peer.nextMethod('initialized')
    await respondProject(second.peer, 'project-crash-repair')
    const resumed = await second.peer.nextMethod('thread/resume')
    expect(resumed.params).toMatchObject({
      threadId: '02999999-1111-7777-8111-111111111111',
      approvalPolicy: 'never',
      sandbox: 'read-only',
    })
    second.peer.respond(resumed, {
      approvalPolicy: 'never',
      sandbox: { type: 'readOnly', networkAccess: false },
      thread: {
        id: '02999999-1111-7777-8111-111111111111',
        projectId,
        ephemeral: false,
        status: { type: 'idle' },
        turns: [{
          id: '02999999-2222-7777-8222-222222222222',
          status: 'completed',
          items: [{ type: 'userMessage', id: 'user-1', clientId: 'dsh-launch:22222222-2222-4222-8222-222222222222', content: [] }],
        }],
      },
    })
    const deliveredTurn = await second.peer.nextMethod('turn/start')
    const deliveredParams = deliveredTurn.params as JsonObject
    expect(deliveredParams.threadId).toBe('02999999-1111-7777-8111-111111111111')
    if (!Array.isArray(deliveredParams.input)) throw new Error('turn input is not an array')
    expect(deliveredParams.input).toHaveLength(2)
    const header: unknown = deliveredParams.input[0]
    if (header === null || typeof header !== 'object' || Array.isArray(header)) {
      throw new Error('turn header is not an object')
    }
    expect((header as JsonObject).type).toBe('text')
    expect((header as JsonObject).text).toMatch(/^Team message .* from lead:$/u)
    expect((header as JsonObject).text_elements).toEqual([])
    expect(deliveredParams.input[1]).toEqual({
      type: 'text',
      text: 'Continue after the crash.',
      text_elements: [],
    })
    second.peer.respond(deliveredTurn, { turn: { id: '02999999-3333-7777-8333-333333333333' } })
    await expect(delivery).resolves.toMatchObject({ status: 'accepted' })

    await providerFiber.dispose()
    expect(second.terminate).toHaveBeenCalledTimes(1)
    await ctx.fiber.dispose()
  })

  it('bounds native evidence and never exposes raw payload ids, prompts, credentials, or paths', async () => {
    const child = fakeChild()
    const { ctx, lead, providerFiber } = await setup(child, { maxEvidenceItems: 3 })
    const spawning = ctx.agentTeams.spawnTeammate(lead, {
      name: 'codex-auditor',
      description: 'Audit with Codex',
      prompt: [{ type: 'text', text: 'Private launch prompt.' }],
      context: 'fresh',
      runtime: {
        kind: 'external-agent',
        provider: 'codex',
        launchRequestId: TeammateLaunchRequestId('33333333-3333-4333-8333-333333333333'),
        profile: profile(),
        requirements: {
          contextMode: 'fresh',
          profileCapabilities: ['persona', 'mission'],
          runtimeCapabilities: ['sandbox', 'evidence', 'usage'],
        },
      },
      signal: new AbortController().signal,
    })
    const initialize = await child.peer.nextMethod('initialize')
    child.peer.respond(initialize, {})
    await child.peer.nextMethod('initialized')
    await respondProject(child.peer)
    const listed = await child.peer.nextMethod('thread/list')
    child.peer.respond(listed, { data: [], nextCursor: null, backwardsCursor: null })
    const threadStart = await child.peer.nextMethod('thread/start')
    child.peer.respond(threadStart, {
      approvalPolicy: 'never',
      sandbox: { type: 'readOnly', networkAccess: false },
      thread: { id: '03999999-1111-7777-8111-111111111111', ephemeral: false, turns: [] },
    })
    const turnStart = await child.peer.nextMethod('turn/start')
    child.peer.respond(turnStart, { turn: { id: '03999999-2222-7777-8222-222222222222' } })
    await spawning

    child.peer.send(
      {
        method: 'item/completed',
        params: {
          threadId: '03999999-1111-7777-8111-111111111111',
          turnId: '03999999-2222-7777-8222-222222222222',
          completedAtMs: 10,
          item: {
            type: 'commandExecution',
            id: 'safe-first',
            status: 'completed',
            command: 'echo PRIVATE_PROMPT',
            cwd: '/private/first',
            aggregatedOutput: 'OPENAI_API_KEY=first-secret',
          },
        },
      },
      {
        method: 'thread/tokenUsage/updated',
        params: {
          threadId: '03999999-1111-7777-8111-111111111111',
          turnId: '03999999-2222-7777-8222-222222222222',
          tokenUsage: { rawLoginState: 'SECRET_LOGIN_STATE' },
        },
      },
      {
        method: 'item/completed',
        params: {
          threadId: '03999999-1111-7777-8111-111111111111',
          turnId: '03999999-2222-7777-8222-222222222222',
          completedAtMs: 20,
          item: {
            type: 'mcpToolCall',
            id: 'SECRET_TOKEN-/private/native/path',
            status: 'failed',
            arguments: { password: 'raw-secret' },
            result: { content: 'Private launch prompt.' },
          },
        },
      },
      {
        method: 'turn/completed',
        params: {
          threadId: '03999999-1111-7777-8111-111111111111',
          turn: {
            id: '03999999-2222-7777-8222-222222222222',
            status: 'completed',
            completedAt: 1,
          },
        },
      },
    )
    await vi.waitFor(() => { expect(ctx.agentTeams.listMembers(lead)[1]?.status).toBe('idle') })

    const registry = (ctx.agentTeams as unknown as {
      teammateRuntimeRegistry: {
        evidence(providerId: string, request: {
          nativeHandle: ReturnType<typeof TeammateRuntimeHandle>
          limit: number
          signal: AbortSignal
        }): Promise<unknown>
      }
    }).teammateRuntimeRegistry
    const evidence = await registry.evidence('codex', {
      nativeHandle: TeammateRuntimeHandle('03999999-1111-7777-8111-111111111111'),
      limit: 10,
      signal: new AbortController().signal,
    })
    expect(evidence).toMatchObject({ complete: true })
    const items = (evidence as { items: Array<Record<string, unknown>> }).items
    expect(items).toHaveLength(3)
    expect(items.some(item => item.kind === 'tool' && item.name === 'mcp-tool' && item.outcome === 'failed')).toBe(true)
    expect(items.some(item => item.kind === 'usage')).toBe(true)
    expect(items.some(item => item.kind === 'turn' && item.outcome === 'completed')).toBe(true)
    const serialized = JSON.stringify(evidence)
    for (const secret of [
      'SECRET_TOKEN',
      '/private/',
      'PRIVATE_PROMPT',
      'OPENAI_API_KEY',
      'SECRET_LOGIN_STATE',
      'raw-secret',
      'Private launch prompt.',
    ]) {
      expect(serialized).not.toContain(secret)
    }

    await providerFiber.dispose()
    await ctx.fiber.dispose()
  })

  it('returns no substitute and releases the probe process when pending recovery finds no native thread', async () => {
    const child = fakeChild()
    const { ctx, providerFiber } = await setup(child)
    const registry = (ctx.agentTeams as unknown as {
      teammateRuntimeRegistry: {
        resume(providerId: string, request: {
          launchRequestId: ReturnType<typeof TeammateLaunchRequestId>
          memberId: ReturnType<typeof SessionId>
          requirements: {
            contextMode: 'fresh'
            profileCapabilities: readonly ['persona', 'mission']
            runtimeCapabilities: readonly ['sandbox', 'evidence', 'usage']
          }
          signal: AbortSignal
        }): Promise<unknown>
      }
    }).teammateRuntimeRegistry
    const recovery = registry.resume('codex', {
      launchRequestId: TeammateLaunchRequestId('44444444-4444-4444-8444-444444444444'),
      memberId: SessionId('pending-codex-member'),
      requirements: {
        contextMode: 'fresh',
        profileCapabilities: ['persona', 'mission'],
        runtimeCapabilities: ['sandbox', 'evidence', 'usage'],
      },
      signal: new AbortController().signal,
    })
    const initialize = await child.peer.nextMethod('initialize')
    child.peer.respond(initialize, {})
    await child.peer.nextMethod('initialized')
    await respondProject(child.peer)
    const listed = await child.peer.nextMethod('thread/list')
    child.peer.respond(listed, { data: [], nextCursor: null, backwardsCursor: null })

    await expect(recovery).resolves.toBeUndefined()
    expect(child.terminate).toHaveBeenCalledTimes(1)
    await providerFiber.dispose()
    await ctx.fiber.dispose()
  })

  it('scrubs native resume failures before they cross the provider seam', async () => {
    const child = fakeChild()
    const { ctx, providerFiber } = await setup(child)
    const registry = (ctx.agentTeams as unknown as {
      teammateRuntimeRegistry: {
        resume(providerId: string, request: {
          launchRequestId: ReturnType<typeof TeammateLaunchRequestId>
          memberId: ReturnType<typeof SessionId>
          nativeHandle: ReturnType<typeof TeammateRuntimeHandle>
          requirements: {
            contextMode: 'fresh'
            profileCapabilities: readonly ['persona', 'mission']
            runtimeCapabilities: readonly ['sandbox', 'evidence', 'usage']
          }
          signal: AbortSignal
        }): Promise<unknown>
      }
    }).teammateRuntimeRegistry
    const recovery = registry.resume('codex', {
      launchRequestId: TeammateLaunchRequestId('55555555-5555-4555-8555-555555555555'),
      memberId: SessionId('persisted-codex-member'),
      nativeHandle: TeammateRuntimeHandle('05999999-1111-7777-8111-111111111111'),
      requirements: {
        contextMode: 'fresh',
        profileCapabilities: ['persona', 'mission'],
        runtimeCapabilities: ['sandbox', 'evidence', 'usage'],
      },
      signal: new AbortController().signal,
    })
    const initialize = await child.peer.nextMethod('initialize')
    child.peer.respond(initialize, {})
    await child.peer.nextMethod('initialized')
    await respondProject(child.peer)
    const resumed = await child.peer.nextMethod('thread/resume')
    child.peer.send({
      id: resumed.id,
      error: {
        code: -32_000,
        message: 'SECRET_TOKEN failed at /private/codex/session.json',
        data: { loginState: 'RAW_LOGIN_STATE' },
      },
    })

    const error = await recovery.then(
      () => undefined,
      (failure: unknown) => failure,
    )
    expect(error).toBeInstanceOf(Error)
    const message = error instanceof Error ? error.message : String(error)
    expect(message).toBe('Codex durable runtime failed during resume')
    expect(JSON.stringify({ message })).not.toMatch(/SECRET_TOKEN|\/private\/|RAW_LOGIN_STATE/u)
    expect(child.terminate).toHaveBeenCalledTimes(1)

    await providerFiber.dispose()
    await ctx.fiber.dispose()
  })

  it('rejects empty, blank, and non-text native work before spawning Codex', async () => {
    const child = fakeChild()
    const { ctx, provider, providerFiber, spawn } = await setup(child)
    for (const initialWork of [
      [],
      [{ type: 'text' as const, text: '  ' }],
      [{ type: 'reasoning' as const, text: 'Not a user text block.' }],
    ]) {
      await expect(provider.create(createRequest({ initialWork }))).rejects.toMatchObject({
        code: 'TEAM_RUNTIME_CAPABILITY_MISMATCH',
      })
    }
    expect(spawn).not.toHaveBeenCalled()
    await providerFiber.dispose()
    await ctx.fiber.dispose()
  })

  it('keeps configured authority across replay, resume, delivery, evidence, and disposal', async () => {
    const child = fakeChild()
    const { ctx, provider, providerFiber, spawn } = await setup(child, {
      model: 'fixed-codex-model',
      env: { DSH_CODEX_TEST: 'explicit' },
      sandbox: 'workspace-write',
      maxEvidenceItems: 8,
    })
    const request = createRequest({
      profile: {
        ...profile(),
        context: [{ id: 'repository', title: 'Repository', content: 'Use the checked-out source.' }],
        memory: [{ id: 'rule', title: 'Rule', content: 'Keep native identity stable.' }],
      },
    })
    const creating = provider.create(request)
    const initialize = await child.peer.nextMethod('initialize')
    child.peer.respond(initialize, {})
    await child.peer.nextMethod('initialized')
    await respondProject(child.peer, 'project-configured-runtime')
    const listed = await child.peer.nextMethod('thread/list')
    child.peer.respond(listed, { data: [], nextCursor: null })
    const threadStart = await child.peer.nextMethod('thread/start')
    expect(threadStart.params).toMatchObject({
      model: 'fixed-codex-model',
      sandbox: 'workspace-write',
      projectId: 'project-configured-runtime',
    })
    expect(JSON.stringify(threadStart.params)).toContain('## Context: Repository')
    expect(JSON.stringify(threadStart.params)).toContain('## Memory: Rule')
    child.peer.respond(threadStart, {
      approvalPolicy: 'never',
      sandbox: { type: 'workspaceWrite', networkAccess: false, writableRoots: [] },
      thread: {
        id: '06999999-1111-7777-8111-111111111111',
        projectId: 'project-configured-runtime',
        ephemeral: false,
        status: { type: 'active' },
        turns: [],
      },
    })
    const initialTurn = await child.peer.nextMethod('turn/start')
    child.peer.send({
      method: 'turn/completed',
      params: {
        threadId: '06999999-1111-7777-8111-111111111111',
        turn: {
          id: '06999999-2222-7777-8222-222222222222',
          status: 'failed',
        },
      },
    })
    child.peer.respond(initialTurn, { turn: { id: '06999999-2222-7777-8222-222222222222' } })
    const created = await creating
    expect(spawn.mock.calls[0]?.[0]).toMatchObject({
      cwd: process.cwd(),
      env: { DSH_CODEX_TEST: 'explicit' },
      graceMs: 3_000,
    })
    await vi.waitFor(() => { expect(provider.interrupt({ nativeHandle: created.nativeHandle })).toEqual({ previousStatus: 'idle' }) })

    await expect(provider.create(request)).resolves.toEqual({
      nativeHandle: created.nativeHandle,
      presence: 'idle',
    })
    await expect(provider.resume({
      launchRequestId: request.launchRequestId,
      memberId: request.memberId,
      nativeHandle: created.nativeHandle,
      requirements: request.requirements,
      signal: new AbortController().signal,
    })).resolves.toEqual({ nativeHandle: created.nativeHandle, presence: 'idle' })
    expect(spawn).toHaveBeenCalledTimes(1)

    const presence = vi.fn()
    const removePresence = provider.onPresenceChanged?.(presence)
    const deliveryRequest = {
      nativeHandle: created.nativeHandle,
      deliveryId: TeamMessageId('configured-delivery'),
      senderId: SessionId('direct-lead'),
      senderName: 'lead',
      content: [{ type: 'text' as const, text: 'Continue configured work.' }],
      delivery: 'wakeup' as const,
      signal: new AbortController().signal,
    }
    const delivery = provider.deliver(deliveryRequest)
    const deliveredTurn = await child.peer.nextMethod('turn/start')
    child.peer.respond(deliveredTurn, { turn: { id: '06999999-3333-7777-8333-333333333333' } })
    const accepted = await delivery
    await expect(provider.deliver(deliveryRequest)).resolves.toEqual(accepted)
    child.peer.send({
      method: 'turn/completed',
      params: {
        threadId: '06999999-1111-7777-8111-111111111111',
        turn: {
          id: '06999999-3333-7777-8333-333333333333',
          status: 'interrupted',
          completedAt: 2,
        },
      },
    })
    await vi.waitFor(() => { expect(presence).toHaveBeenCalledWith({ nativeHandle: created.nativeHandle, presence: 'idle' }) })
    removePresence?.()

    const firstPage = await queryEvidence(provider, {
      nativeHandle: created.nativeHandle,
      limit: 1,
      signal: new AbortController().signal,
    })
    expect(firstPage).toMatchObject({ complete: false, nextCursor: '1' })
    const nextCursor = firstPage.nextCursor
    if (nextCursor === undefined) throw new Error('expected another evidence page')
    const secondPage = await queryEvidence(provider, {
      nativeHandle: created.nativeHandle,
      cursor: nextCursor,
      limit: 10,
      signal: new AbortController().signal,
    })
    expect(secondPage).toMatchObject({ complete: true })
    expect(secondPage.items.some(item => item.outcome === 'interrupted')).toBe(true)
    for (const cursor of ['not-a-number', '99']) {
      await expect(queryEvidence(provider, {
        nativeHandle: created.nativeHandle,
        cursor: TeammateRuntimeEvidenceCursor(cursor),
        limit: 1,
        signal: new AbortController().signal,
      })).rejects.toMatchObject({ code: 'TEAM_RUNTIME_IDENTITY_CONFLICT' })
    }

    expect(provider.interrupt({ nativeHandle: TeammateRuntimeHandle('missing-runtime') }))
      .toEqual({ previousStatus: 'inactive' })
    await provider.dispose({
      kind: 'evaluation',
      evaluationHandle: TeammateEvaluationHandle('unused-evaluation'),
      signal: new AbortController().signal,
    })
    await provider.dispose({
      kind: 'runtime',
      nativeHandle: TeammateRuntimeHandle('missing-runtime'),
      signal: new AbortController().signal,
    })
    await provider.dispose({
      kind: 'runtime',
      nativeHandle: created.nativeHandle,
      signal: new AbortController().signal,
    })
    expect(child.terminate).toHaveBeenCalledTimes(1)

    await providerFiber.dispose()
    await expect(provider.create(createRequest())).rejects.toMatchObject({ code: 'TEAM_RUNTIME_UNAVAILABLE' })
    await ctx.fiber.dispose()
  })

  it('denies native interaction requests and normalizes every supported evidence shape', async () => {
    const child = fakeChild()
    const { ctx, provider, providerFiber } = await setup(child, { maxEvidenceItems: 32 })
    provider.onPresenceChanged?.(() => { throw new Error('observer failure') })
    const creating = provider.create(createRequest())
    const initialize = await child.peer.nextMethod('initialize')
    child.peer.respond(initialize, {})
    await child.peer.nextMethod('initialized')
    await respondProject(child.peer, 'project-native-requests')
    const listed = await child.peer.nextMethod('thread/list')
    child.peer.respond(listed, { data: [], nextCursor: null })
    const threadStart = await child.peer.nextMethod('thread/start')
    child.peer.respond(threadStart, {
      approvalPolicy: 'never',
      sandbox: { type: 'readOnly', networkAccess: false },
      thread: {
        id: '0b999999-1111-7777-8111-111111111111',
        ephemeral: false,
        turns: [],
      },
    })
    const turnStart = await child.peer.nextMethod('turn/start')
    const threadId = '0b999999-1111-7777-8111-111111111111'
    const turnId = '0b999999-2222-7777-8222-222222222222'
    let requestId = 100
    const nativeRequest = async (method: string, params: JsonObject): Promise<JsonObject> => {
      const id = requestId++
      child.peer.send({ id, method, params })
      return await child.peer.nextResponse(id)
    }

    await expect(nativeRequest('item/commandExecution/requestApproval', {
      threadId,
      turnId,
      availableDecisions: ['cancel', 'decline'],
    })).resolves.toMatchObject({ result: { decision: 'cancel' } })
    await expect(nativeRequest('item/fileChange/requestApproval', {
      threadId,
      turnId,
      availableDecisions: 'invalid',
    })).resolves.toMatchObject({ result: { decision: 'decline' } })
    await expect(nativeRequest('item/permissions/requestApproval', {
      threadId,
      turnId,
    })).resolves.toMatchObject({ result: { permissions: {}, scope: 'turn' } })
    await expect(nativeRequest('item/tool/requestUserInput', {
      threadId,
      turnId,
    })).resolves.toMatchObject({ result: { answers: {} } })
    await expect(nativeRequest('mcpServer/elicitation/request', {
      threadId,
      turnId: null,
    })).resolves.toMatchObject({ result: { action: 'decline', content: null, _meta: null } })
    for (const [method, params] of [
      ['unknown/request', { threadId, turnId }],
      ['item/tool/requestUserInput', { threadId: 'another-thread', turnId }],
      ['item/tool/requestUserInput', { threadId, turnId: 'another-turn' }],
      ['item/tool/requestUserInput', { threadId }],
    ] as const) {
      await expect(nativeRequest(method, params)).resolves.toHaveProperty('error')
    }

    child.peer.respond(turnStart, { turn: { id: turnId } })
    const created = await creating
    child.peer.send(
      { method: 'turn/started', params: { threadId, turn: { id: turnId } } },
      { method: 'turn/started', params: { threadId: 'another-thread', turn: null } },
      { method: 'unrelated/notification', params: { threadId } },
      { method: 'item/completed', params: { threadId, turnId, item: null } },
      { method: 'item/completed', params: { threadId, turnId, item: { type: 'unknown', id: 'ignored' } } },
      { method: 'item/completed', params: { threadId, turnId, item: { type: 'commandExecution' } } },
      {
        method: 'item/completed',
        params: { threadId, item: { type: 'commandExecution', id: 'command-completed', status: 'completed' } },
      },
      {
        method: 'item/completed',
        params: { threadId, turnId, item: { type: 'fileChange', id: 'file-success', status: 'success' } },
      },
      {
        method: 'item/completed',
        params: { threadId, turnId, item: { type: 'dynamicToolCall', id: 'dynamic-declined', status: 'declined' } },
      },
      {
        method: 'item/completed',
        params: { threadId, turnId, item: { type: 'webSearch', id: 'web-unknown', status: 'running' } },
      },
      { method: 'thread/tokenUsage/updated', params: { threadId } },
      { method: 'thread/tokenUsage/updated', params: { threadId, turnId } },
      {
        method: 'turn/completed',
        params: { threadId, turn: { id: 'another-turn', status: 'completed' } },
      },
      {
        method: 'turn/completed',
        params: { threadId, turn: { id: turnId, status: 'completed' } },
      },
    )
    await vi.waitFor(() => { expect(provider.interrupt({ nativeHandle: created.nativeHandle })).toEqual({ previousStatus: 'idle' }) })
    const evidence = await queryEvidence(provider, {
      nativeHandle: created.nativeHandle,
      limit: 32,
      signal: new AbortController().signal,
    })
    expect(evidence.items.map(item => [item.kind, item.name, item.outcome])).toEqual([
      ['tool', 'command', 'completed'],
      ['tool', 'file-change', 'completed'],
      ['tool', 'dynamic-tool', 'blocked'],
      ['tool', 'web-search', 'unknown'],
      ['usage', undefined, undefined],
      ['turn', undefined, 'completed'],
    ])

    await expect(nativeRequest('item/tool/requestUserInput', {
      threadId,
      turnId,
    })).resolves.toHaveProperty('error')
    child.peer.send(
      { method: 'turn/started', params: { threadId, turn: { id: turnId } } },
      { method: 'turn/completed', params: { threadId, turn: { id: turnId, status: 'completed' } } },
    )

    await providerFiber.dispose()
    await ctx.fiber.dispose()
  })

  it('discovers one matching native project thread and recovers launch and delivery dedupe ids', async () => {
    const child = fakeChild()
    const { ctx, provider, providerFiber } = await setup(child)
    const request = createRequest()
    const creating = provider.create(request)
    const initialize = await child.peer.nextMethod('initialize')
    child.peer.respond(initialize, {})
    await child.peer.nextMethod('initialized')
    await respondProject(child.peer, 'project-discovery')
    const listed = await child.peer.nextMethod('thread/list')
    child.peer.respond(listed, {
      data: [
        {
          id: '0c999999-0000-7777-8000-000000000000',
          projectId: 'another-project',
          ephemeral: false,
          turns: [],
        },
        {
          id: '0c999999-1111-7777-8111-111111111111',
          projectId: 'project-discovery',
          ephemeral: false,
          turns: [],
        },
      ],
      nextCursor: null,
    })
    const resumed = await child.peer.nextMethod('thread/resume')
    expect(resumed.params).toMatchObject({
      threadId: '0c999999-1111-7777-8111-111111111111',
    })
    child.peer.respond(resumed, {
      approvalPolicy: 'never',
      sandbox: { type: 'readOnly', networkAccess: false },
      thread: {
        id: '0c999999-1111-7777-8111-111111111111',
        projectId: 'project-discovery',
        ephemeral: false,
        status: { type: 'active' },
        turns: [
          { id: 42, items: [] },
          { id: 'turn-without-array', items: 'invalid' },
          {
            id: '0c999999-2222-7777-8222-222222222222',
            items: [
              null,
              [],
              {},
              { type: 'other', clientId: 'ignored-other' },
              { type: 'userMessage', clientId: 42 },
              {
                type: 'userMessage',
                clientId: `dsh-launch:${request.launchRequestId}`,
              },
              {
                type: 'userMessage',
                clientId: 'dsh-delivery:already-delivered',
              },
            ],
          },
        ],
      },
    })
    const created = await creating
    expect(created).toEqual({
      nativeHandle: '0c999999-1111-7777-8111-111111111111',
      presence: 'running',
    })
    await expect(provider.deliver({
      nativeHandle: created.nativeHandle,
      deliveryId: TeamMessageId('already-delivered'),
      senderId: SessionId('direct-lead'),
      senderName: 'lead',
      content: [{ type: 'text', text: 'Must not be submitted twice.' }],
      delivery: 'wakeup',
      signal: new AbortController().signal,
    })).resolves.toEqual({
      turnId: '0c999999-2222-7777-8222-222222222222',
      presence: 'running',
    })

    await providerFiber.dispose()
    await ctx.fiber.dispose()
  })

  it.each([
    ['non-object thread', {
      approvalPolicy: 'never',
      sandbox: { type: 'readOnly', networkAccess: false },
      thread: null,
    }],
    ['empty thread id', {
      approvalPolicy: 'never',
      sandbox: { type: 'readOnly', networkAccess: false },
      thread: { id: '', ephemeral: false, turns: [] },
    }],
    ['ephemeral thread', {
      approvalPolicy: 'never',
      sandbox: { type: 'readOnly', networkAccess: false },
      thread: { id: 'failure-thread', ephemeral: true, turns: [] },
    }],
    ['different project', {
      approvalPolicy: 'never',
      sandbox: { type: 'readOnly', networkAccess: false },
      thread: { id: 'failure-thread', projectId: 'wrong-project', ephemeral: false, turns: [] },
    }],
    ['different approval policy', {
      approvalPolicy: 'on-request',
      sandbox: { type: 'readOnly', networkAccess: false },
      thread: { id: 'failure-thread', ephemeral: false, turns: [] },
    }],
    ['non-object sandbox', {
      approvalPolicy: 'never',
      sandbox: null,
      thread: { id: 'failure-thread', ephemeral: false, turns: [] },
    }],
    ['network-enabled sandbox', {
      approvalPolicy: 'never',
      sandbox: { type: 'readOnly', networkAccess: true },
      thread: { id: 'failure-thread', ephemeral: false, turns: [] },
    }],
  ])('rejects a malformed thread/start response: %s', async (_case, response) => {
    const child = fakeChild()
    const { ctx, provider, providerFiber } = await setup(child)
    const { creating, threadStart } = await beginFreshCreation(provider, child)
    child.peer.respond(threadStart, response)
    await expect(creating).rejects.toMatchObject({ code: 'TEAM_RUNTIME_UNAVAILABLE' })
    expect(child.terminate).toHaveBeenCalledTimes(1)
    await providerFiber.dispose()
    await ctx.fiber.dispose()
  })

  it.each([
    ['invalid initialize response', null, undefined],
    ['invalid project response', {}, { project: null }],
    ['empty project identity', {}, { project: { id: '' } }],
  ])('fails closed on %s', async (_case, initializeResponse, projectResponse) => {
    const child = fakeChild()
    const { ctx, provider, providerFiber } = await setup(child)
    const creating = provider.create(createRequest())
    const initialize = await child.peer.nextMethod('initialize')
    child.peer.respond(initialize, initializeResponse)
    if (projectResponse !== undefined) {
      await child.peer.nextMethod('initialized')
      const project = await child.peer.nextMethod('project/create')
      child.peer.respond(project, projectResponse)
    }
    await expect(creating).rejects.toMatchObject({ code: 'TEAM_RUNTIME_UNAVAILABLE' })
    expect(child.terminate).toHaveBeenCalledTimes(1)
    await providerFiber.dispose()
    await ctx.fiber.dispose()
  })

  it.each([
    ['invalid list data', { data: null }, 'TEAM_RUNTIME_UNAVAILABLE'],
    ['invalid list thread', { data: [null] }, 'TEAM_RUNTIME_UNAVAILABLE'],
    ['conflicting list threads', {
      data: [
        { id: 'conflict-a', ephemeral: false, turns: [] },
        { id: 'conflict-b', ephemeral: false, turns: [] },
      ],
    }, 'TEAM_RUNTIME_IDENTITY_CONFLICT'],
  ])('fails closed on %s', async (_case, listResponse, code) => {
    const child = fakeChild()
    const { ctx, provider, providerFiber } = await setup(child)
    const creating = provider.create(createRequest())
    const initialize = await child.peer.nextMethod('initialize')
    child.peer.respond(initialize, {})
    await child.peer.nextMethod('initialized')
    await respondProject(child.peer, 'project-list-failure')
    const listed = await child.peer.nextMethod('thread/list')
    child.peer.respond(listed, listResponse)
    await expect(creating).rejects.toMatchObject({ code })
    expect(child.terminate).toHaveBeenCalledTimes(1)
    await providerFiber.dispose()
    await ctx.fiber.dispose()
  })

  it.each([
    ['different approval policy', {
      approvalPolicy: 'on-request',
      sandbox: { type: 'readOnly', networkAccess: false },
      thread: { id: 'resume-thread', projectId: 'project-resume-failure', ephemeral: false, turns: [] },
    }],
    ['network-enabled sandbox', {
      approvalPolicy: 'never',
      sandbox: { type: 'readOnly', networkAccess: true },
      thread: { id: 'resume-thread', projectId: 'project-resume-failure', ephemeral: false, turns: [] },
    }],
    ['different thread', {
      approvalPolicy: 'never',
      sandbox: { type: 'readOnly', networkAccess: false },
      thread: { id: 'different-thread', projectId: 'project-resume-failure', ephemeral: false, turns: [] },
    }],
    ['ephemeral thread', {
      approvalPolicy: 'never',
      sandbox: { type: 'readOnly', networkAccess: false },
      thread: { id: 'resume-thread', projectId: 'project-resume-failure', ephemeral: true, turns: [] },
    }],
    ['different project', {
      approvalPolicy: 'never',
      sandbox: { type: 'readOnly', networkAccess: false },
      thread: { id: 'resume-thread', projectId: 'different-project', ephemeral: false, turns: [] },
    }],
  ])('rejects a malformed thread/resume response: %s', async (_case, response) => {
    const child = fakeChild()
    const { ctx, provider, providerFiber } = await setup(child)
    const recovery = provider.resume({
      launchRequestId: TeammateLaunchRequestId('bbbbbbbb-1111-4111-8111-111111111111'),
      memberId: SessionId('resume-failure-member'),
      nativeHandle: TeammateRuntimeHandle('resume-thread'),
      requirements: createRequest().requirements,
      signal: new AbortController().signal,
    })
    const initialize = await child.peer.nextMethod('initialize')
    child.peer.respond(initialize, {})
    await child.peer.nextMethod('initialized')
    await respondProject(child.peer, 'project-resume-failure')
    const resumed = await child.peer.nextMethod('thread/resume')
    child.peer.respond(resumed, response)
    await expect(recovery).rejects.toMatchObject({ code: 'TEAM_RUNTIME_UNAVAILABLE' })
    expect(child.terminate).toHaveBeenCalledTimes(1)
    await providerFiber.dispose()
    await ctx.fiber.dispose()
  })

  it('keeps a later delivery behind the active turn and honors aborts while waiting', async () => {
    const child = fakeChild()
    const { ctx, provider, providerFiber } = await setup(child)
    const { creating, threadStart } = await beginFreshCreation(provider, child)
    child.peer.respond(threadStart, {
      approvalPolicy: 'never',
      sandbox: { type: 'readOnly', networkAccess: false },
      thread: { id: 'wait-thread', ephemeral: false, turns: [] },
    })
    const firstTurn = await child.peer.nextMethod('turn/start')
    child.peer.respond(firstTurn, { turn: { id: 'wait-turn-one' } })
    const created = await creating
    const delivery = (deliveryId: string, signal: AbortSignal) => provider.deliver({
      nativeHandle: created.nativeHandle,
      deliveryId: TeamMessageId(deliveryId),
      senderId: SessionId('direct-lead'),
      senderName: 'lead',
      content: [{ type: 'text', text: `Deliver ${deliveryId}.` }],
      delivery: 'wakeup',
      signal,
    })

    const alreadyError = new AbortController()
    alreadyError.abort(new Error('caller stopped'))
    await expect(delivery('already-error', alreadyError.signal)).rejects.toThrow('caller stopped')
    const alreadyValue = new AbortController()
    alreadyValue.abort('non-error reason')
    await expect(delivery('already-value', alreadyValue.signal)).rejects.toThrow('operation aborted')
    const during = new AbortController()
    const aborting = delivery('during', during.signal)
    await Promise.resolve()
    during.abort('later non-error reason')
    await expect(aborting).rejects.toThrow('operation aborted')

    const waiting = delivery('after-current', new AbortController().signal)
    child.peer.send({
      method: 'turn/completed',
      params: {
        threadId: 'wait-thread',
        turn: { id: 'wait-turn-one', status: 'completed' },
      },
    })
    const nextTurn = await child.peer.nextMethod('turn/start')
    expect(nextTurn.params).toMatchObject({
      threadId: 'wait-thread',
      clientUserMessageId: 'dsh-delivery:after-current',
    })
    child.peer.respond(nextTurn, { turn: { id: 'wait-turn-two' } })
    await expect(waiting).resolves.toMatchObject({ presence: 'running' })

    await providerFiber.dispose()
    await ctx.fiber.dispose()
  })

  it.each([
    'non-object-turn',
    'empty-turn-id',
    'turn-identity-mismatch',
    'turn-started-identity-mismatch',
    'invalid-terminal-status',
    'invalid-started-turn',
  ])('cleans the native process when turn admission fails: %s', async (failure) => {
    const child = fakeChild()
    const { ctx, provider, providerFiber } = await setup(child)
    const { creating, threadStart } = await beginFreshCreation(provider, child)
    child.peer.respond(threadStart, {
      approvalPolicy: 'never',
      sandbox: { type: 'readOnly', networkAccess: false },
      thread: { id: 'turn-failure-thread', ephemeral: false, turns: [] },
    })
    const turnStart = await child.peer.nextMethod('turn/start')
    if (failure === 'non-object-turn') {
      vi.spyOn(child.handle, 'waitForExit').mockRejectedValueOnce(new Error('cleanup failed'))
      child.peer.respond(turnStart, { turn: null })
    }
    else if (failure === 'empty-turn-id') child.peer.respond(turnStart, { turn: { id: '' } })
    else if (failure === 'turn-identity-mismatch') {
      child.peer.send({
        method: 'turn/started',
        params: { threadId: 'turn-failure-thread', turn: { id: 'first-turn-id' } },
      })
      child.peer.respond(turnStart, { turn: { id: 'different-turn-id' } })
    } else if (failure === 'turn-started-identity-mismatch') {
      child.peer.send(
        {
          method: 'turn/started',
          params: { threadId: 'turn-failure-thread', turn: { id: 'first-turn-id' } },
        },
        {
          method: 'turn/started',
          params: { threadId: 'turn-failure-thread', turn: { id: 'different-turn-id' } },
        },
      )
    } else if (failure === 'invalid-terminal-status') {
      child.peer.send({
        method: 'turn/completed',
        params: {
          threadId: 'turn-failure-thread',
          turn: { id: 'terminal-turn-id', status: 'not-terminal' },
        },
      })
    } else {
      child.peer.send({
        method: 'turn/started',
        params: { threadId: 'turn-failure-thread', turn: null },
      })
    }
    await expect(creating).rejects.toMatchObject({ code: 'TEAM_RUNTIME_UNAVAILABLE' })
    expect(child.terminate).toHaveBeenCalledTimes(1)
    await providerFiber.dispose()
    await ctx.fiber.dispose()
  })

  it.each(['stdout-error', 'stdin-error', 'stdout-end'])(
    'retires and terminates a native session after %s',
    async (failure) => {
      const child = fakeChild()
      const { ctx, provider, providerFiber } = await setup(child)
      const { creating, threadStart } = await beginFreshCreation(provider, child)
      child.peer.respond(threadStart, {
        approvalPolicy: 'never',
        sandbox: { type: 'readOnly', networkAccess: false },
        thread: { id: 'stream-failure-thread', ephemeral: false, turns: [] },
      })
      const turnStart = await child.peer.nextMethod('turn/start')
      child.peer.respond(turnStart, { turn: { id: 'stream-failure-turn' } })
      const created = await creating
      const waiting = failure === 'stdout-error'
        ? provider.deliver({
          nativeHandle: created.nativeHandle,
          deliveryId: TeamMessageId('waiting-on-failed-turn'),
          senderId: SessionId('direct-lead'),
          senderName: 'lead',
          content: [{ type: 'text', text: 'Wait for the failed turn.' }],
          delivery: 'wakeup',
          signal: new AbortController().signal,
        })
        : undefined
      await Promise.resolve()
      if (failure === 'stdout-error') child.handle.stdout?.emit('error', 'non-error stream failure')
      else if (failure === 'stdin-error') {
        vi.spyOn(child.handle, 'waitForExit').mockRejectedValueOnce(new Error('retirement wait failed'))
        child.handle.stdin?.emit('error', new Error('stream failure'))
      }
      else child.handle.stdout?.emit('end')
      if (waiting !== undefined) await expect(waiting).rejects.toThrow()

      await vi.waitFor(() => {
        expect(child.terminate).toHaveBeenCalledTimes(1)
        expect(provider.interrupt({ nativeHandle: created.nativeHandle })).toEqual({ previousStatus: 'inactive' })
      })
      await expect(queryEvidence(provider, {
        nativeHandle: created.nativeHandle,
        limit: 1,
        signal: new AbortController().signal,
      })).rejects.toMatchObject({ code: 'TEAM_RUNTIME_IDENTITY_CONFLICT' })
      await expect(provider.deliver({
        nativeHandle: TeammateRuntimeHandle('unknown-native-handle'),
        deliveryId: TeamMessageId('unknown-delivery'),
        senderId: SessionId('direct-lead'),
        senderName: 'lead',
        content: [{ type: 'text', text: 'Cannot route this.' }],
        delivery: 'wakeup',
        signal: new AbortController().signal,
      })).rejects.toMatchObject({ code: 'TEAM_RUNTIME_IDENTITY_CONFLICT' })

      await providerFiber.dispose()
      await ctx.fiber.dispose()
    },
  )

  it('discovers an uncorrelated native thread and preserves configured resume authority', async () => {
    const child = fakeChild()
    const { ctx, provider, providerFiber } = await setup(child, { model: 'fixed-resume-model' })
    const recovery = provider.resume({
      launchRequestId: TeammateLaunchRequestId('cccccccc-1111-4111-8111-111111111111'),
      memberId: SessionId('uncorrelated-resume-member'),
      requirements: createRequest().requirements,
      signal: new AbortController().signal,
    })
    const initialize = await child.peer.nextMethod('initialize')
    child.peer.send(
      { method: 'item/completed', params: { item: { type: 'commandExecution', id: 'pre-attach-item' } } },
      { method: 'thread/tokenUsage/updated', params: { turnId: 'pre-attach-turn' } },
    )
    child.peer.respond(initialize, {})
    await child.peer.nextMethod('initialized')
    await respondProject(child.peer, 'project-uncorrelated-resume')
    const listed = await child.peer.nextMethod('thread/list')
    child.peer.respond(listed, {
      data: [{ id: 'uncorrelated-native-thread', projectId: 'project-uncorrelated-resume' }],
    })
    const resumed = await child.peer.nextMethod('thread/resume')
    expect(resumed.params).toMatchObject({
      threadId: 'uncorrelated-native-thread',
      model: 'fixed-resume-model',
    })
    child.peer.respond(resumed, {
      approvalPolicy: 'never',
      sandbox: { type: 'readOnly', networkAccess: false },
      thread: { id: 'uncorrelated-native-thread' },
    })

    await expect(recovery).resolves.toEqual({
      nativeHandle: 'uncorrelated-native-thread',
      presence: 'idle',
    })
    child.peer.send(
      {
        method: 'item/completed',
        params: {
          threadId: 'uncorrelated-native-thread',
          turnId: 'observed-resume-turn',
          item: { type: 'commandExecution', id: 'observed-resume-item', status: 'completed' },
        },
      },
      {
        method: 'item/completed',
        params: {
          threadId: 'uncorrelated-native-thread',
          item: { type: 7, id: 'ignored-non-string-type' },
        },
      },
      {
        method: 'thread/tokenUsage/updated',
        params: { threadId: 'uncorrelated-native-thread', turnId: 'observed-resume-turn' },
      },
    )
    await vi.waitFor(async () => {
      const evidence = await provider.evidence!({
        nativeHandle: TeammateRuntimeHandle('uncorrelated-native-thread'),
        limit: 8,
        signal: new AbortController().signal,
      })
      expect(evidence.items).toHaveLength(2)
    })
    await providerFiber.dispose()
    await ctx.fiber.dispose()
  })

  it('returns no substitute when discovery reports a missing native thread', async () => {
    const child = fakeChild()
    const { ctx, provider, providerFiber } = await setup(child)
    const recovery = provider.resume({
      launchRequestId: TeammateLaunchRequestId('dddddddd-1111-4111-8111-111111111111'),
      memberId: SessionId('missing-discovery-member'),
      requirements: createRequest().requirements,
      signal: new AbortController().signal,
    })
    const initialize = await child.peer.nextMethod('initialize')
    child.peer.respond(initialize, {})
    await child.peer.nextMethod('initialized')
    await respondProject(child.peer, 'project-missing-discovery')
    const listed = await child.peer.nextMethod('thread/list')
    vi.spyOn(child.handle, 'waitForExit').mockRejectedValueOnce(new Error('probe cleanup failed'))
    child.peer.send({
      id: listed.id,
      error: { code: -32_001, message: 'thread not found' },
    })

    await expect(recovery).resolves.toBeUndefined()
    expect(child.terminate).toHaveBeenCalledTimes(1)
    await providerFiber.dispose()
    await ctx.fiber.dispose()
  })

  it.each([
    ['provider identity conflict', {
      data: [
        { id: 'resume-conflict-a', turns: [] },
        { id: 'resume-conflict-b', turns: [] },
      ],
    }, 'TEAM_RUNTIME_IDENTITY_CONFLICT'],
    ['malformed discovery response', { data: null }, 'TEAM_RUNTIME_UNAVAILABLE'],
  ])('normalizes an uncorrelated resume %s', async (_case, listResponse, code) => {
    const child = fakeChild()
    const { ctx, provider, providerFiber } = await setup(child)
    const recovery = provider.resume({
      launchRequestId: TeammateLaunchRequestId('eeeeeeee-1111-4111-8111-111111111111'),
      memberId: SessionId(`resume-${code}`),
      requirements: createRequest().requirements,
      signal: new AbortController().signal,
    })
    const initialize = await child.peer.nextMethod('initialize')
    child.peer.respond(initialize, {})
    await child.peer.nextMethod('initialized')
    await respondProject(child.peer, 'project-resume-normalization')
    const listed = await child.peer.nextMethod('thread/list')
    child.peer.respond(listed, listResponse)

    await expect(recovery).rejects.toMatchObject({ code })
    expect(child.terminate).toHaveBeenCalledTimes(1)
    await providerFiber.dispose()
    await ctx.fiber.dispose()
  })

  it('coalesces concurrent disposal and observes a rejected process completion', async () => {
    const child = fakeChild({ settleOnTerminate: false, swallowDoneFailureOnWait: true })
    const { ctx, provider, providerFiber } = await setup(child)
    const { creating, threadStart } = await beginFreshCreation(provider, child)
    child.peer.respond(threadStart, {
      approvalPolicy: 'never',
      sandbox: { type: 'readOnly', networkAccess: false },
      thread: { id: 'concurrent-dispose-thread', ephemeral: false, turns: [] },
    })
    const turnStart = await child.peer.nextMethod('turn/start')
    child.peer.respond(turnStart, { turn: { id: 'concurrent-dispose-turn' } })
    const created = await creating
    child.peer.send({
      method: 'turn/completed',
      params: {
        threadId: 'concurrent-dispose-thread',
        turn: { id: 'concurrent-dispose-turn', status: 'completed' },
      },
    })
    const request = {
      kind: 'runtime' as const,
      nativeHandle: created.nativeHandle,
      signal: new AbortController().signal,
    }
    const first = provider.dispose(request)
    const duplicate = provider.dispose(request)
    expect(child.terminate).toHaveBeenCalledTimes(1)
    child.fail(new Error('process rejected while disposal waited'))

    await expect(Promise.all([first, duplicate])).resolves.toEqual([undefined, undefined])
    await providerFiber.dispose()
    await ctx.fiber.dispose()
  })

  it('absorbs a protocol rejection after cancellation wins initialization', async () => {
    const child = fakeChild()
    const controller = new AbortController()
    const { ctx, provider, providerFiber, spawn } = await setup(child)
    spawn.mockImplementationOnce(() => {
      controller.abort('cancelled during spawn')
      return child.handle
    })
    vi.spyOn(child.handle, 'waitForExit').mockRejectedValueOnce(new Error('cancel cleanup failed'))

    await expect(provider.create(createRequest({ signal: controller.signal }))).rejects.toMatchObject({
      code: 'TEAM_RUNTIME_UNAVAILABLE',
    })
    expect(child.terminate).toHaveBeenCalledTimes(1)
    await providerFiber.dispose()
    await ctx.fiber.dispose()
  })

  it('reports cleanup failures once and keeps provider close idempotent', async () => {
    const child = fakeChild()
    const { ctx, provider, providerFiber } = await setup(child)
    const { creating, threadStart } = await beginFreshCreation(provider, child)
    child.peer.respond(threadStart, {
      approvalPolicy: 'never',
      sandbox: { type: 'readOnly', networkAccess: false },
      thread: { id: 'failed-cleanup-thread', ephemeral: false, turns: [] },
    })
    const turnStart = await child.peer.nextMethod('turn/start')
    child.peer.respond(turnStart, { turn: { id: 'failed-cleanup-turn' } })
    await creating
    vi.spyOn(child.handle.stdin!, 'end').mockImplementationOnce(() => {
      throw new Error('stdin close failed')
    })
    vi.spyOn(child.handle, 'waitForExit').mockRejectedValueOnce(new Error('wait failed'))
    const close = (provider as TeammateRuntimeProvider & { close(): Promise<void> }).close.bind(provider)

    await expect(close()).rejects.toBeInstanceOf(AggregateError)
    await expect(close()).resolves.toBeUndefined()
    await providerFiber.dispose()
    await ctx.fiber.dispose()
  })

  it('recreates a crashed correlated launch without duplicating its native initial turn', async () => {
    const first = fakeChild()
    const second = fakeChild()
    const { ctx, provider, providerFiber, spawn } = await setup(first)
    const request = createRequest()
    const { creating, threadStart } = await beginFreshCreation(provider, first)
    first.peer.respond(threadStart, {
      approvalPolicy: 'never',
      sandbox: { type: 'readOnly', networkAccess: false },
      thread: {
        id: 'recreated-correlated-thread',
        projectId: 'project-failure-matrix',
        ephemeral: false,
        turns: [],
      },
    })
    const initialTurn = await first.peer.nextMethod('turn/start')
    first.peer.respond(initialTurn, { turn: { id: 'recreated-initial-turn' } })
    const created = await creating
    first.peer.send({
      method: 'turn/completed',
      params: {
        threadId: 'recreated-correlated-thread',
        turn: { id: 'recreated-initial-turn', status: 'completed' },
      },
    })
    await vi.waitFor(() => {
      expect(provider.interrupt({ nativeHandle: created.nativeHandle })).toEqual({ previousStatus: 'idle' })
    })
    first.settle({ exitCode: 9, signal: null })
    await vi.waitFor(() => {
      expect(provider.interrupt({ nativeHandle: created.nativeHandle })).toEqual({ previousStatus: 'inactive' })
    })

    spawn.mockReturnValue(second.handle)
    const replay = provider.create(request)
    const initialize = await second.peer.nextMethod('initialize')
    second.peer.respond(initialize, {})
    await second.peer.nextMethod('initialized')
    await respondProject(second.peer, 'project-failure-matrix')
    const listed = await second.peer.nextMethod('thread/list')
    second.peer.respond(listed, {
      data: [{
        id: 'recreated-correlated-thread',
        projectId: 'project-failure-matrix',
        ephemeral: false,
        turns: [{
          id: 'recreated-initial-turn',
          items: [{
            type: 'userMessage',
            clientId: `dsh-launch:${request.launchRequestId}`,
          }],
        }],
      }],
    })
    const resumed = await second.peer.nextMethod('thread/resume')
    second.peer.respond(resumed, {
      approvalPolicy: 'never',
      sandbox: { type: 'readOnly', networkAccess: false },
      thread: {
        id: 'recreated-correlated-thread',
        projectId: 'project-failure-matrix',
        ephemeral: false,
        turns: [{
          id: 'recreated-initial-turn',
          items: [{ type: 'userMessage', clientId: `dsh-launch:${request.launchRequestId}` }],
        }],
      },
    })

    await expect(replay).resolves.toEqual({
      nativeHandle: created.nativeHandle,
      presence: 'idle',
    })
    expect(spawn).toHaveBeenCalledTimes(2)
    await providerFiber.dispose()
    await ctx.fiber.dispose()
  })

  it('fails closed when direct callers overlap native turn admission', async () => {
    const child = fakeChild()
    const { ctx, provider, providerFiber } = await setup(child)
    const { creating, threadStart } = await beginFreshCreation(provider, child)
    child.peer.respond(threadStart, {
      approvalPolicy: 'never',
      sandbox: { type: 'readOnly', networkAccess: false },
      thread: { id: 'overlapped-admission-thread', ephemeral: false, turns: [] },
    })
    const initialTurn = await child.peer.nextMethod('turn/start')
    child.peer.respond(initialTurn, { turn: { id: 'overlapped-initial-turn' } })
    const created = await creating
    child.peer.send({
      method: 'turn/completed',
      params: {
        threadId: 'overlapped-admission-thread',
        turn: { id: 'overlapped-initial-turn', status: 'completed' },
      },
    })
    await vi.waitFor(() => {
      expect(provider.interrupt({ nativeHandle: created.nativeHandle })).toEqual({ previousStatus: 'idle' })
    })
    const delivery = (id: string) => provider.deliver({
      nativeHandle: created.nativeHandle,
      deliveryId: TeamMessageId(id),
      senderId: SessionId('direct-lead'),
      senderName: 'lead',
      content: [{ type: 'text', text: `Concurrent direct delivery ${id}.` }],
      delivery: 'wakeup',
      signal: new AbortController().signal,
    })
    const first = delivery('overlap-first')
    const second = delivery('overlap-second')
    const admitted = await child.peer.nextMethod('turn/start')

    await expect(second).rejects.toThrow('native thread is not ready for a new turn')
    child.peer.respond(admitted, { turn: { id: 'overlapped-delivery-turn' } })
    await expect(first).resolves.toMatchObject({ turnId: 'overlapped-delivery-turn' })
    await providerFiber.dispose()
    await ctx.fiber.dispose()
  })

  it.each([
    [
      'provider identity error',
      new TeammateRuntimeError('bounded identity failure', 'TEAM_RUNTIME_IDENTITY_CONFLICT'),
      'TEAM_RUNTIME_IDENTITY_CONFLICT',
    ],
    ['unexpected provider error', new Error('native secret failure'), 'TEAM_RUNTIME_UNAVAILABLE'],
  ])('normalizes a %s while repairing a detached handle', async (_case, failure, code) => {
    const first = fakeChild()
    const { ctx, provider, providerFiber, spawn } = await setup(first)
    const { creating, threadStart } = await beginFreshCreation(provider, first)
    first.peer.respond(threadStart, {
      approvalPolicy: 'never',
      sandbox: { type: 'readOnly', networkAccess: false },
      thread: { id: 'identity-repair-thread', ephemeral: false, turns: [] },
    })
    const turnStart = await first.peer.nextMethod('turn/start')
    first.peer.respond(turnStart, { turn: { id: 'identity-repair-turn' } })
    const created = await creating
    first.settle({ exitCode: 3, signal: null })
    await vi.waitFor(() => {
      expect(provider.interrupt({ nativeHandle: created.nativeHandle })).toEqual({ previousStatus: 'inactive' })
    })
    spawn.mockImplementationOnce(() => {
      throw failure
    })

    await expect(provider.deliver({
      nativeHandle: created.nativeHandle,
      deliveryId: TeamMessageId('identity-repair-delivery'),
      senderId: SessionId('direct-lead'),
      senderName: 'lead',
      content: [{ type: 'text', text: 'Attempt exact repair.' }],
      delivery: 'wakeup',
      signal: new AbortController().signal,
    })).rejects.toMatchObject({ code })
    await providerFiber.dispose()
    await ctx.fiber.dispose()
  })

  it('retries process cleanup through an idempotently closed protocol connection', async () => {
    const child = fakeChild()
    const { ctx, provider, providerFiber } = await setup(child)
    const recovery = provider.resume({
      launchRequestId: TeammateLaunchRequestId('ffffffff-1111-4111-8111-111111111111'),
      memberId: SessionId('cleanup-retry-member'),
      requirements: createRequest().requirements,
      signal: new AbortController().signal,
    })
    const initialize = await child.peer.nextMethod('initialize')
    child.peer.respond(initialize, {})
    await child.peer.nextMethod('initialized')
    await respondProject(child.peer, 'project-cleanup-retry')
    const listed = await child.peer.nextMethod('thread/list')
    vi.spyOn(child.handle, 'waitForExit').mockRejectedValueOnce(new Error('first cleanup wait failed'))
    child.peer.respond(listed, { data: [] })

    await expect(recovery).rejects.toMatchObject({ code: 'TEAM_RUNTIME_UNAVAILABLE' })
    expect(child.terminate).toHaveBeenCalledTimes(2)
    await providerFiber.dispose()
    await ctx.fiber.dispose()
  })

  it('applies safe defaults, accepts bounded overrides, and rejects invalid bounds', async () => {
    const makeContext = () => {
      let cleanup: (() => Promise<void>) | undefined
      const registered = vi.fn()
      const ctx = {
        agentTeams: { registerTeammateRuntimeProvider: registered },
        effect: (activate: () => () => Promise<void>) => { cleanup = activate() },
        logger: { warn: vi.fn() },
      } as unknown as Context
      return { ctx, registered, cleanup: () => cleanup?.() }
    }
    const defaults = makeContext()
    codexRuntime.apply(defaults.ctx, {})
    expect(defaults.registered).toHaveBeenCalledWith(expect.objectContaining({ id: 'codex' }))
    await defaults.cleanup()
    await defaults.cleanup()

    const configured = makeContext()
    codexRuntime.apply(configured.ctx, {
      cwd: '.',
      providerName: 'codex-configured',
      sandbox: 'workspace-write',
      disposeGraceMs: 1,
      maxEvidenceItems: 1,
    })
    expect(configured.registered).toHaveBeenCalledWith(expect.objectContaining({ id: 'codex-configured' }))
    await configured.cleanup()

    for (const disposeGraceMs of [0, Number.POSITIVE_INFINITY, 2_147_483_648]) {
      expect(() => { codexRuntime.apply(makeContext().ctx, { disposeGraceMs }) }).toThrow(/disposeGraceMs/u)
    }
    for (const maxEvidenceItems of [0, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => { codexRuntime.apply(makeContext().ctx, { maxEvidenceItems }) }).toThrow(/maxEvidenceItems/u)
    }

    const nativePlatform = process.platform
    Object.defineProperty(process, 'platform', { configurable: true, value: 'unsupported-test-platform' })
    try {
      const unavailable = makeContext()
      codexRuntime.apply(unavailable.ctx, {})
      expect(unavailable.registered).not.toHaveBeenCalled()
    } finally {
      Object.defineProperty(process, 'platform', { configurable: true, value: nativePlatform })
    }
  })
})
