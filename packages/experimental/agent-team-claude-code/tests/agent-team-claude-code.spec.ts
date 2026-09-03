import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import type {
  Options,
  Query,
  SDKMessage,
  SDKResultMessage,
  SDKSessionInfo,
  SessionMessage,
  SpawnOptions,
} from '@anthropic-ai/claude-agent-sdk'
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
  TeammateLaunchRequestId,
  TeammateEvaluationHandle,
  TeammateRuntimeError,
  TeammateRuntimeEvidenceCursor,
  TeammateRuntimeHandle,
  type TeammateRuntimeCreateRequest,
} from '@deepseek-ai/dsh-experimental-agent-team'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as claudeRuntime from '../src/index.ts'
import { TestSessionQuery } from '../../agent-team/tests/test-session-query.ts'

type QueryFactory = (params: { prompt: string; options: Options }) => Query

const sdkMocks = vi.hoisted(() => ({
  query: vi.fn<QueryFactory>(),
  getSessionInfo: vi.fn<(sessionId: string, options?: { dir?: string }) => Promise<SDKSessionInfo | undefined>>(),
  getSessionMessages: vi.fn<(sessionId: string, options?: { dir?: string }) => Promise<SessionMessage[]>>(),
}))

vi.mock('@anthropic-ai/claude-agent-sdk', async importOriginal => ({
  ...await importOriginal<typeof import('@anthropic-ai/claude-agent-sdk')>(),
  query: sdkMocks.query,
  getSessionInfo: sdkMocks.getSessionInfo,
  getSessionMessages: sdkMocks.getSessionMessages,
}))

interface FakeChild {
  readonly handle: SubprocessHandle
  readonly terminate: ReturnType<typeof vi.fn>
}

interface QueryPlan {
  readonly child: FakeChild
  readonly messages: readonly SDKMessage[] | ((options: Options) => readonly SDKMessage[])
  readonly failure?: Error
  readonly release?: Promise<void>
  readonly closeError?: Error
}

const temporaryRoots: string[] = []
const fibers: Array<{ dispose(): void | Promise<void> }> = []
const contexts: Context[] = []
const plans: QueryPlan[] = []

function nextPlan(): QueryPlan {
  const plan = plans.shift()
  if (plan === undefined) throw new Error('missing Claude SDK query plan')
  return plan
}

beforeEach(() => {
  sdkMocks.query.mockReset()
  sdkMocks.getSessionInfo.mockReset().mockResolvedValue(undefined)
  sdkMocks.getSessionMessages.mockReset().mockResolvedValue([])
  plans.splice(0)
  sdkMocks.query.mockImplementation(({ options }) => {
    const plan = nextPlan()
    options.spawnClaudeCodeProcess?.({
      command: options.pathToClaudeCodeExecutable ?? '/missing/claude',
      args: ['--print'],
      cwd: options.cwd,
      env: options.env ?? {},
      signal: options.abortController?.signal,
    } as SpawnOptions)
    const close = vi.fn(() => {
      if (plan.closeError !== undefined) throw plan.closeError
    })
    async function* stream(): AsyncGenerator<SDKMessage, void> {
      const messages = typeof plan.messages === 'function' ? plan.messages(options) : plan.messages
      for (const message of messages) yield message
      const release = plan.release
      if (release !== undefined) {
        await new Promise<void>((resolve, reject) => {
          const finish = (): void => {
            options.abortController?.signal.removeEventListener('abort', abort)
            resolve()
          }
          const abort = (): void => {
            options.abortController?.signal.removeEventListener('abort', abort)
            const reason: unknown = options.abortController?.signal.reason
            reject(reason instanceof Error ? reason : new Error('aborted'))
          }
          void release.then(finish, (cause: unknown) => {
            reject(cause instanceof Error ? cause : new Error(String(cause)))
          })
          if (options.abortController?.signal.aborted === true) abort()
          else options.abortController?.signal.addEventListener('abort', abort, { once: true })
        })
      }
      if (plan.failure !== undefined) throw plan.failure
    }
    return Object.assign(stream(), { close }) as unknown as Query
  })
})

afterEach(async () => {
  for (const fiber of fibers.splice(0)) await Promise.resolve(fiber.dispose()).catch(() => {})
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose().catch(() => {})
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function fakeChild(options: {
  readonly pid?: number
  readonly terminateError?: Error
  readonly waitError?: Error
  readonly doneError?: Error
  readonly exitRelease?: Promise<void>
} = {}): FakeChild {
  const stdin = new PassThrough()
  const stdout = new PassThrough()
  let settle!: (outcome: SubprocessOutcome) => void
  let rejectDone!: (error: Error) => void
  const done = new Promise<SubprocessOutcome>((resolve, reject) => {
    settle = resolve
    rejectDone = reject
  })
  void done.catch(() => {})
  let exited = false
  const finishExit = (): void => {
    if (options.doneError !== undefined) rejectDone(options.doneError)
    else settle({ exitCode: 0, signal: null })
  }
  const terminate = vi.fn(() => {
    if (exited) return
    exited = true
    if (options.terminateError !== undefined) {
      finishExit()
      throw options.terminateError
    }
    if (options.exitRelease === undefined) finishExit()
    else void options.exitRelease.then(finishExit, rejectDone)
  })
  return {
    handle: {
      pid: options.pid ?? 3210,
      stdin,
      stdout,
      stderr: new PassThrough(),
      collected: {},
      done,
      terminate,
      waitForExit: async () => {
        if (options.waitError !== undefined) throw options.waitError
        await done
        return true
      },
    },
    terminate,
  }
}

function system(sessionId: string): SDKMessage {
  return {
    type: 'system',
    subtype: 'init',
    session_id: sessionId,
  } as SDKMessage
}

function result(sessionId: string, outcome: 'success' | 'error_during_execution' = 'success'): SDKResultMessage {
  return outcome === 'success'
    ? {
      type: 'result',
      subtype: 'success',
      session_id: sessionId,
      is_error: false,
      result: 'private model output',
      usage: { input_tokens: 10, output_tokens: 5 },
      modelUsage: {},
    } as SDKResultMessage
    : {
      type: 'result',
      subtype: outcome,
      session_id: sessionId,
      is_error: true,
      errors: ['/private/secret.txt SECRET_TOKEN'],
      usage: { input_tokens: 10, output_tokens: 5 },
      modelUsage: {},
    } as SDKResultMessage
}

function assistantWithTool(sessionId: string): SDKMessage {
  return {
    type: 'assistant',
    session_id: sessionId,
    message: {
      role: 'assistant',
      content: [
        {
          type: 'tool_use',
          id: 'tool-private-id',
          name: 'Read',
          input: { file_path: '/private/secret.txt', token: 'SECRET_TOKEN' },
        },
        { type: 'text', text: 'private model output' },
      ],
    },
  } as SDKMessage
}

function permissionDenied(sessionId: string): SDKMessage {
  return {
    type: 'system',
    subtype: 'permission_denied',
    session_id: sessionId,
    tool_name: 'Read',
    tool_use_id: 'private-tool-id',
    decision_reason: '/private/secret.txt SECRET_TOKEN',
  } as SDKMessage
}

function queryWithoutMessages(close = vi.fn()): Query {
  async function* stream(): AsyncGenerator<SDKMessage, void> {}
  return Object.assign(stream(), { close }) as unknown as Query
}

function sessionInfo(sessionId: string): SDKSessionInfo {
  return {
    sessionId,
    summary: 'private native summary',
    lastModified: Date.now(),
    cwd: '/private/native/path',
  }
}

function transcript(sessionId: string, prompt: string): SessionMessage {
  return {
    type: 'user',
    uuid: 'bbbbbbbb-1111-4111-8111-111111111111',
    session_id: sessionId,
    message: { role: 'user', content: prompt },
    parent_tool_use_id: null,
    parent_agent_id: null,
  }
}

async function nextTask(): Promise<void> {
  await new Promise<void>((resolve) => { setImmediate(resolve) })
}

function profile() {
  return {
    persona: 'Be exact.',
    mission: 'Review the assigned change.',
    context: [{ id: 'context', title: 'Boundary', content: 'Read only.' }],
    memory: [{ id: 'memory', title: 'Rule', content: 'Preserve facts.' }],
    toolPolicy: { mode: 'inherit' as const, names: [] },
    hooks: [],
  }
}

function createRequest(overrides: Partial<TeammateRuntimeCreateRequest> = {}): TeammateRuntimeCreateRequest {
  return {
    launchRequestId: TeammateLaunchRequestId('aaaaaaaa-1111-4111-8111-111111111111'),
    memberId: SessionId('direct-claude-member'),
    memberName: 'direct-claude',
    description: 'Exercise the Claude provider directly',
    initialWork: [{ type: 'text', text: 'Run direct provider work.' }],
    profile: profile(),
    requirements: {
      contextMode: 'fresh',
      profileCapabilities: ['persona', 'mission', 'context', 'memory'],
      runtimeCapabilities: ['sandbox', 'evidence', 'usage'],
    },
    signal: new AbortController().signal,
    ...overrides,
  }
}

async function setup(children: readonly FakeChild[], config: claudeRuntime.Config = {}) {
  const storageRoot = mkdtempSync(join(tmpdir(), 'dsh-team-claude-'))
  temporaryRoots.push(storageRoot)
  const ctx = new Context()
  contexts.push(ctx)
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(JsonlSessionPersistence, { root: storageRoot })
  await ctx.plugin(TestSessionQuery)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(SubagentService)
  await ctx.plugin(LocalSubprocessRuntime)
  await ctx.plugin(TeamService)
  const register = vi.spyOn(ctx.agentTeams, 'registerTeammateRuntimeProvider')
  const spawn = vi.spyOn(ctx.subprocess, 'spawn')
  for (const child of children) spawn.mockReturnValueOnce(child.handle)
  const fiber = await ctx.plugin(claudeRuntime, config)
  fibers.push(fiber)
  const provider = register.mock.calls[0]?.[0]
  if (provider === undefined) throw new Error('Claude provider did not register')
  return { ctx, provider, fiber, spawn }
}

describe('durable Claude Code teammate runtime', () => {
  it('uses one stable native Session and fixed fail-closed SDK policy for duplicate launches', async () => {
    const child = fakeChild()
    plans.push({ child, messages: options => [system(options.sessionId ?? '')] })
    const { provider } = await setup([child])
    const first = provider.create(createRequest())
    const second = provider.create(createRequest())

    const firstResult = await first
    expect(firstResult.nativeHandle).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
    )
    await expect(second).resolves.toEqual(firstResult)
    await expect(provider.create(createRequest())).resolves.toMatchObject({
      nativeHandle: firstResult.nativeHandle,
    })
    expect(sdkMocks.query).toHaveBeenCalledTimes(1)

    const call = sdkMocks.query.mock.calls[0]?.[0]
    expect(call?.prompt).toContain('Run direct provider work.')
    expect(call?.prompt).toContain('## Persona\nBe exact.')
    expect(call?.prompt).toContain('## Memory: Rule\nPreserve facts.')
    expect(call?.options).toMatchObject({
      sessionId: firstResult.nativeHandle,
      persistSession: true,
      pathToClaudeCodeExecutable: claudeRuntime.claudeCodePackageBin,
      permissionMode: 'dontAsk',
      tools: ['Read', 'Glob', 'Grep'],
      allowedTools: ['Read', 'Glob', 'Grep'],
      settingSources: [],
      skills: [],
      plugins: [],
      mcpServers: {},
      strictMcpConfig: true,
      sandbox: {
        enabled: true,
        failIfUnavailable: true,
        autoAllowBashIfSandboxed: false,
        allowUnsandboxedCommands: false,
      },
    })
    expect(call?.options.resume).toBeUndefined()
    expect(call?.options.canUseTool).toBeTypeOf('function')
    expect(await call?.options.canUseTool?.('Bash', { command: 'cat /secret' }, {
      signal: new AbortController().signal,
      suggestions: [],
      toolUseID: 'tool-secret',
      requestId: 'request-secret',
    })).toMatchObject({ behavior: 'deny' })
    expect(await call?.options.onElicitation?.({
      mode: 'form',
      elicitationId: 'private-id',
      serverName: 'private-server',
      message: 'private request',
      requestedSchema: {},
    }, {
      signal: new AbortController().signal,
      requestId: 'request-secret',
    })).toEqual({ action: 'decline' })
    expect(await call?.options.onUserDialog?.({
      dialogKind: 'private-kind',
      payload: {},
    }, {
      signal: new AbortController().signal,
      requestId: 'request-secret',
    })).toEqual({ behavior: 'cancelled' })
  })

  it('declares only truthful fresh-profile, sandbox, evidence, and usage capabilities', async () => {
    const { provider } = await setup([])
    expect(provider).toMatchObject({
      id: 'claude-code',
      displayName: 'Claude Code',
      contextModes: ['fresh'],
      profileCapabilities: ['persona', 'mission', 'context', 'memory'],
      runtimeCapabilities: ['sandbox', 'evidence', 'usage'],
    })
    await expect(provider.create(createRequest({
      requirements: {
        contextMode: 'fork',
        profileCapabilities: ['tool-policy', 'hooks'],
        runtimeCapabilities: ['exact-call-approval', 'evaluation'],
      },
    }))).rejects.toBeInstanceOf(TeammateRuntimeError)
  })

  it('recovers the same launch from its native transcript after Host restart without another query', async () => {
    const child = fakeChild()
    plans.push({
      child,
      messages: options => [system(options.sessionId ?? ''), result(options.sessionId ?? '')],
    })
    const firstHost = await setup([child])
    const created = await firstHost.provider.create(createRequest())
    await vi.waitFor(() => { expect(child.terminate).toHaveBeenCalled() })
    const nativePrompt = sdkMocks.query.mock.calls[0]?.[0].prompt
    if (nativePrompt === undefined) throw new Error('missing first native prompt')

    await firstHost.fiber.dispose()
    sdkMocks.getSessionInfo.mockResolvedValue(sessionInfo(created.nativeHandle))
    sdkMocks.getSessionMessages.mockResolvedValue([transcript(created.nativeHandle, nativePrompt)])
    const secondHost = await setup([])

    await expect(secondHost.provider.create(createRequest())).resolves.toEqual({
      nativeHandle: created.nativeHandle,
      turnId: created.turnId,
      presence: 'idle',
    })
    expect(sdkMocks.query).toHaveBeenCalledTimes(1)
    expect(sdkMocks.getSessionInfo).toHaveBeenLastCalledWith(created.nativeHandle, {
      dir: process.cwd(),
    })
  })

  it('resumes one Session for multiple turns and de-duplicates a persisted delivery marker', async () => {
    const createChild = fakeChild()
    plans.push({
      child: createChild,
      messages: options => [system(options.sessionId ?? ''), result(options.sessionId ?? '')],
    })
    const firstHost = await setup([createChild])
    const created = await firstHost.provider.create(createRequest())
    await vi.waitFor(() => { expect(createChild.terminate).toHaveBeenCalled() })
    const launchPrompt = sdkMocks.query.mock.calls[0]?.[0].prompt
    if (launchPrompt === undefined) throw new Error('missing launch prompt')
    sdkMocks.getSessionInfo.mockResolvedValue(sessionInfo(created.nativeHandle))
    let nativeMessages = [transcript(created.nativeHandle, launchPrompt)]
    sdkMocks.getSessionMessages.mockImplementation(async () => nativeMessages)

    const firstTurnChild = fakeChild()
    plans.push({
      child: firstTurnChild,
      messages: options => [system(options.resume ?? ''), result(options.resume ?? '')],
    })
    firstHost.spawn.mockReturnValueOnce(firstTurnChild.handle)
    const firstDelivery = await firstHost.provider.deliver({
      nativeHandle: created.nativeHandle,
      deliveryId: TeamMessageId('delivery-one'),
      senderId: SessionId('lead'),
      senderName: 'lead',
      content: [{ type: 'text', text: 'Continue with the second turn.' }],
      delivery: 'wakeup',
      signal: new AbortController().signal,
    })
    await vi.waitFor(() => { expect(firstTurnChild.terminate).toHaveBeenCalled() })
    const deliveryPrompt = sdkMocks.query.mock.calls[1]?.[0].prompt
    if (deliveryPrompt === undefined) throw new Error('missing delivery prompt')
    nativeMessages = [...nativeMessages, transcript(created.nativeHandle, deliveryPrompt)]
    expect(sdkMocks.query.mock.calls[1]?.[0].options).toMatchObject({
      resume: created.nativeHandle,
      persistSession: true,
    })
    await nextTask()
    await expect(firstHost.provider.deliver({
      nativeHandle: created.nativeHandle,
      deliveryId: TeamMessageId('delivery-one'),
      senderId: SessionId('lead'),
      senderName: 'lead',
      content: [{ type: 'text', text: 'duplicate must not run' }],
      delivery: 'quiet',
      signal: new AbortController().signal,
    })).resolves.toEqual({ turnId: firstDelivery.turnId, presence: 'idle' })

    await firstHost.fiber.dispose()
    const secondHost = await setup([])
    await expect(secondHost.provider.resume({
      launchRequestId: createRequest().launchRequestId,
      memberId: createRequest().memberId,
      nativeHandle: created.nativeHandle,
      requirements: createRequest().requirements,
      signal: new AbortController().signal,
    })).resolves.toEqual({ nativeHandle: created.nativeHandle, turnId: created.turnId, presence: 'idle' })
    await expect(secondHost.provider.deliver({
      nativeHandle: created.nativeHandle,
      deliveryId: TeamMessageId('delivery-one'),
      senderId: SessionId('lead'),
      senderName: 'lead',
      content: [{ type: 'text', text: 'Continue with the second turn.' }],
      delivery: 'wakeup',
      signal: new AbortController().signal,
    })).resolves.toEqual({ turnId: firstDelivery.turnId, presence: 'idle' })
    expect(sdkMocks.query).toHaveBeenCalledTimes(2)
  })

  it('serializes concurrent deliveries before native lookup and query admission', async () => {
    const createChild = fakeChild()
    const firstDeliveryChild = fakeChild()
    const secondDeliveryChild = fakeChild()
    const firstExit = Promise.withResolvers<undefined>()
    plans.push(
      {
        child: createChild,
        messages: options => [system(options.sessionId ?? ''), result(options.sessionId ?? '')],
      },
      {
        child: firstDeliveryChild,
        messages: options => [system(options.resume ?? ''), result(options.resume ?? '')],
        release: firstExit.promise,
      },
      {
        child: secondDeliveryChild,
        messages: options => [system(options.resume ?? ''), result(options.resume ?? '')],
      },
    )
    const host = await setup([createChild, firstDeliveryChild, secondDeliveryChild])
    const created = await host.provider.create(createRequest())
    await vi.waitFor(() => { expect(createChild.terminate).toHaveBeenCalled() })
    const launchPrompt = sdkMocks.query.mock.calls[0]?.[0].prompt
    if (launchPrompt === undefined) throw new Error('missing launch prompt')
    sdkMocks.getSessionInfo.mockResolvedValue(sessionInfo(created.nativeHandle))
    sdkMocks.getSessionMessages.mockResolvedValue([transcript(created.nativeHandle, launchPrompt)])

    const first = host.provider.deliver({
      nativeHandle: created.nativeHandle,
      deliveryId: TeamMessageId('concurrent-delivery-one'),
      senderId: SessionId('lead'),
      senderName: 'lead',
      content: [{ type: 'text', text: 'First concurrent delivery.' }],
      delivery: 'wakeup',
      signal: new AbortController().signal,
    })
    const duplicateController = new AbortController()
    const duplicate = host.provider.deliver({
      nativeHandle: created.nativeHandle,
      deliveryId: TeamMessageId('concurrent-delivery-one'),
      senderId: SessionId('lead'),
      senderName: 'lead',
      content: [{ type: 'text', text: 'Duplicate concurrent delivery.' }],
      delivery: 'quiet',
      signal: duplicateController.signal,
    })
    const second = host.provider.deliver({
      nativeHandle: created.nativeHandle,
      deliveryId: TeamMessageId('concurrent-delivery-two'),
      senderId: SessionId('lead'),
      senderName: 'lead',
      content: [{ type: 'text', text: 'Second concurrent delivery.' }],
      delivery: 'wakeup',
      signal: new AbortController().signal,
    })
    duplicateController.abort('duplicate waiter cancelled')

    await expect(duplicate).rejects.toThrow('operation aborted')
    await expect(first).resolves.toMatchObject({ presence: 'running' })
    await nextTask()
    expect(sdkMocks.query).toHaveBeenCalledTimes(2)
    firstExit.resolve(undefined)
    await expect(second).resolves.toMatchObject({ presence: 'running' })
    expect(sdkMocks.query).toHaveBeenCalledTimes(3)
  })

  it('retries one delivery after native admission fails before acceptance', async () => {
    const createChild = fakeChild()
    const failedChild = fakeChild()
    const retryChild = fakeChild()
    plans.push(
      {
        child: createChild,
        messages: options => [system(options.sessionId ?? ''), result(options.sessionId ?? '')],
      },
      {
        child: failedChild,
        messages: [],
        failure: new Error('/private/pre-acceptance-failure'),
      },
      {
        child: retryChild,
        messages: options => [system(options.resume ?? ''), result(options.resume ?? '')],
      },
    )
    const host = await setup([createChild, failedChild, retryChild])
    const created = await host.provider.create(createRequest())
    await vi.waitFor(() => { expect(createChild.terminate).toHaveBeenCalled() })
    const launchPrompt = sdkMocks.query.mock.calls[0]?.[0].prompt
    if (launchPrompt === undefined) throw new Error('missing launch prompt')
    sdkMocks.getSessionInfo.mockResolvedValue(sessionInfo(created.nativeHandle))
    sdkMocks.getSessionMessages.mockResolvedValue([transcript(created.nativeHandle, launchPrompt)])
    const request = {
      nativeHandle: created.nativeHandle,
      deliveryId: TeamMessageId('retry-delivery'),
      senderId: SessionId('lead'),
      senderName: 'lead',
      content: [{ type: 'text' as const, text: 'Retry exact delivery.' }],
      delivery: 'wakeup' as const,
      signal: new AbortController().signal,
    }

    await expect(host.provider.deliver(request)).rejects.toMatchObject({
      code: 'TEAM_RUNTIME_UNAVAILABLE',
    })
    await expect(host.provider.deliver(request)).resolves.toMatchObject({ presence: 'running' })
    expect(sdkMocks.query).toHaveBeenCalledTimes(3)
  })

  it('interrupts only the exact active Session and keeps other turns running', async () => {
    const firstChild = fakeChild()
    const secondChild = fakeChild()
    const firstGate = Promise.withResolvers<undefined>()
    const secondGate = Promise.withResolvers<undefined>()
    plans.push(
      { child: firstChild, messages: options => [system(options.sessionId ?? '')], release: firstGate.promise },
      { child: secondChild, messages: options => [system(options.sessionId ?? '')], release: secondGate.promise },
    )
    const host = await setup([firstChild, secondChild])
    const first = await host.provider.create(createRequest())
    const second = await host.provider.create(createRequest({
      launchRequestId: TeammateLaunchRequestId('aaaaaaaa-2222-4222-8222-222222222222'),
      memberId: SessionId('other-claude-member'),
    }))

    expect(host.provider.interrupt({ nativeHandle: first.nativeHandle })).toEqual({ previousStatus: 'running' })
    await vi.waitFor(() => { expect(firstChild.terminate).toHaveBeenCalled() })
    expect(secondChild.terminate).not.toHaveBeenCalled()
    expect(host.provider.interrupt({
      nativeHandle: TeammateRuntimeHandle('missing'),
    })).toEqual({ previousStatus: 'inactive' })

    secondGate.resolve(undefined)
    await nextTask()
    expect(second.nativeHandle).not.toBe(first.nativeHandle)
  })

  it('retains only bounded normalized evidence and never provider payloads or secrets', async () => {
    const child = fakeChild()
    plans.push({
      child,
      messages: options => [
        system(options.sessionId ?? ''),
        assistantWithTool(options.sessionId ?? ''),
        result(options.sessionId ?? '', 'error_during_execution'),
      ],
    })
    const { provider } = await setup([child], { maxEvidenceItems: 2 })
    const created = await provider.create(createRequest())
    await vi.waitFor(() => { expect(child.terminate).toHaveBeenCalled() })
    if (provider.evidence === undefined) throw new Error('missing advertised evidence operation')
    const evidence = await provider.evidence({
      nativeHandle: created.nativeHandle,
      limit: 10,
      signal: new AbortController().signal,
    })

    expect(evidence.items).toHaveLength(2)
    expect(evidence.items.map(item => item.kind)).toEqual(['usage', 'turn'])
    expect(evidence.items[0]).toMatchObject({
      kind: 'usage',
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
    })
    const serialized = JSON.stringify(evidence)
    expect(serialized).not.toContain('/private/')
    expect(serialized).not.toContain('SECRET_TOKEN')
    expect(serialized).not.toContain('private model output')
    expect(serialized).not.toContain('native summary')
  })

  it('cancels a pre-acceptance launch, returns bounded diagnostics, and removes the exact child', async () => {
    const child = fakeChild()
    const never = Promise.withResolvers<undefined>()
    plans.push({
      child,
      messages: [],
      release: never.promise,
      failure: new Error('/private/secret.txt SECRET_TOKEN'),
    })
    const { provider } = await setup([child])
    const controller = new AbortController()
    const creating = provider.create(createRequest({ signal: controller.signal }))
    await nextTask()
    controller.abort(new Error('caller cancelled'))

    const error = await creating.catch((cause: unknown) => cause)
    expect(error).toBeInstanceOf(TeammateRuntimeError)
    expect((error as Error).message).toBe('Claude Code durable runtime failed during query-run')
    expect((error as Error).message).not.toContain('/private/')
    expect((error as Error).message).not.toContain('SECRET_TOKEN')
    await vi.waitFor(() => { expect(child.terminate).toHaveBeenCalled() })
  })

  it('rejects policy weakening before registration and unregisters plus quiesces on Fiber disposal', async () => {
    const child = fakeChild()
    const gate = Promise.withResolvers<undefined>()
    plans.push({
      child,
      messages: options => [system(options.sessionId ?? '')],
      release: gate.promise,
    })
    const host = await setup([child])
    expect(() => {
      claudeRuntime.apply(host.ctx, {
        providerName: 'claude-unsafe',
        sandbox: 'workspace-write' as never,
      })
    }).toThrow(/sandbox.*read-only/u)
    const registry = (host.ctx.agentTeams as unknown as {
      teammateRuntimeRegistry: {
        available(providerId: string): boolean
        snapshot(): readonly unknown[]
      }
    }).teammateRuntimeRegistry
    expect(registry.available('claude-unsafe')).toBe(false)

    await host.provider.create(createRequest())
    await host.fiber.dispose()
    expect(child.terminate).toHaveBeenCalled()
    expect(registry.available('claude-code')).toBe(false)
    expect(registry.snapshot()).not.toContainEqual(expect.objectContaining({ id: 'claude-code' }))
  })

  it.each([
    {
      label: 'unsupported Profile capability',
      requirements: {
        contextMode: 'fresh' as const,
        profileCapabilities: ['tool-policy' as const],
        runtimeCapabilities: ['sandbox' as const],
      },
    },
    {
      label: 'unsupported runtime capability',
      requirements: {
        contextMode: 'fresh' as const,
        profileCapabilities: ['persona' as const],
        runtimeCapabilities: ['evaluation' as const],
      },
    },
  ])('rejects $label before native lookup', async ({ requirements }) => {
    const { provider } = await setup([])
    await expect(provider.create(createRequest({ requirements }))).rejects.toMatchObject({
      code: 'TEAM_RUNTIME_CAPABILITY_MISMATCH',
    })
    expect(sdkMocks.getSessionInfo).not.toHaveBeenCalled()
    expect(sdkMocks.query).not.toHaveBeenCalled()
  })

  it.each([
    {
      label: 'tool-policy mode',
      profile: {
        ...profile(),
        toolPolicy: { mode: 'allow' as const, names: ['Read'] },
      },
    },
    {
      label: 'tool-policy names',
      profile: {
        ...profile(),
        toolPolicy: { mode: 'inherit' as const, names: ['Read'] },
      },
    },
    {
      label: 'hooks',
      profile: {
        ...profile(),
        hooks: [{ point: 'before-tool' as const, effect: 'deny' as const, text: 'deny' }],
      },
    },
  ])('rejects Profile $label before native lookup', async ({ profile: requestedProfile }) => {
    const { provider } = await setup([])
    await expect(provider.create(createRequest({ profile: requestedProfile }))).rejects.toMatchObject({
      code: 'TEAM_RUNTIME_CAPABILITY_MISMATCH',
    })
    expect(sdkMocks.getSessionInfo).not.toHaveBeenCalled()
  })

  it.each([
    { label: 'empty', initialWork: [] },
    { label: 'non-text', initialWork: [{ type: 'image', image: 'private' }] },
    { label: 'blank', initialWork: [{ type: 'text', text: '   ' }] },
  ])('rejects $label work before starting a native query', async ({ initialWork }) => {
    const { provider } = await setup([])
    await expect(provider.create(createRequest({
      initialWork: initialWork as TeammateRuntimeCreateRequest['initialWork'],
    }))).rejects.toMatchObject({ code: 'TEAM_RUNTIME_CAPABILITY_MISMATCH' })
    expect(sdkMocks.query).not.toHaveBeenCalled()
  })

  it('validates resume identity, absence, marker ownership, and native lookup failures', async () => {
    const child = fakeChild()
    const gate = Promise.withResolvers<undefined>()
    plans.push({
      child,
      messages: options => [system(options.sessionId ?? '')],
      release: gate.promise,
    })
    const host = await setup([child])
    const created = await host.provider.create(createRequest())
    await expect(host.provider.resume({
      launchRequestId: createRequest().launchRequestId,
      memberId: createRequest().memberId,
      nativeHandle: created.nativeHandle,
      requirements: createRequest().requirements,
      signal: new AbortController().signal,
    })).resolves.toEqual({ nativeHandle: created.nativeHandle, turnId: created.turnId, presence: 'running' })
    await expect(host.provider.resume({
      launchRequestId: createRequest().launchRequestId,
      memberId: createRequest().memberId,
      nativeHandle: TeammateRuntimeHandle('wrong-native-session'),
      requirements: createRequest().requirements,
      signal: new AbortController().signal,
    })).rejects.toMatchObject({ code: 'TEAM_RUNTIME_IDENTITY_CONFLICT' })

    const absent = createRequest({
      launchRequestId: TeammateLaunchRequestId('aaaaaaaa-3333-4333-8333-333333333333'),
      memberId: SessionId('absent-claude-member'),
    })
    await expect(host.provider.resume({
      launchRequestId: absent.launchRequestId,
      memberId: absent.memberId,
      requirements: absent.requirements,
      signal: absent.signal,
    })).resolves.toBeUndefined()

    const detached = createRequest({
      launchRequestId: TeammateLaunchRequestId('aaaaaaaa-4444-4444-8444-444444444444'),
      memberId: SessionId('detached-claude-member'),
    })
    sdkMocks.getSessionInfo.mockResolvedValueOnce(sessionInfo('different-session'))
    await expect(host.provider.resume({
      launchRequestId: detached.launchRequestId,
      memberId: detached.memberId,
      requirements: detached.requirements,
      signal: detached.signal,
    })).rejects.toMatchObject({ code: 'TEAM_RUNTIME_IDENTITY_CONFLICT' })

    sdkMocks.getSessionInfo.mockImplementationOnce(async sessionId => sessionInfo(sessionId))
    sdkMocks.getSessionMessages.mockImplementationOnce(async sessionId => [
      transcript(sessionId, { nested: [null, 7, 'another marker'] } as unknown as string),
    ])
    await expect(host.provider.resume({
      launchRequestId: detached.launchRequestId,
      memberId: detached.memberId,
      requirements: detached.requirements,
      signal: detached.signal,
    })).rejects.toMatchObject({ code: 'TEAM_RUNTIME_IDENTITY_CONFLICT' })

    const launchDigest = createHash('sha256')
      .update(JSON.stringify([
        'launch',
        'claude-code',
        detached.launchRequestId,
        detached.memberId,
      ]))
      .digest('hex')
    sdkMocks.getSessionInfo.mockImplementationOnce(async sessionId => sessionInfo(sessionId))
    sdkMocks.getSessionMessages.mockResolvedValueOnce([
      transcript('untrusted-session', `[dsh-agent-team:launch:${launchDigest}]`),
    ])
    await expect(host.provider.resume({
      launchRequestId: detached.launchRequestId,
      memberId: detached.memberId,
      requirements: detached.requirements,
      signal: detached.signal,
    })).rejects.toMatchObject({ code: 'TEAM_RUNTIME_IDENTITY_CONFLICT' })

    sdkMocks.getSessionInfo.mockRejectedValueOnce(new Error('/private/native/session/path'))
    await expect(host.provider.resume({
      launchRequestId: detached.launchRequestId,
      memberId: detached.memberId,
      requirements: detached.requirements,
      signal: detached.signal,
    })).rejects.toMatchObject({
      code: 'TEAM_RUNTIME_UNAVAILABLE',
      message: 'Claude Code durable runtime failed during resume',
    })
  })

  it('fails a deterministic launch collision instead of appending to a foreign Session', async () => {
    const { provider } = await setup([])
    sdkMocks.getSessionInfo.mockImplementation(async sessionId => sessionInfo(sessionId))
    sdkMocks.getSessionMessages.mockImplementation(async sessionId => [
      transcript(sessionId, 'foreign prompt without the DSH marker'),
    ])
    await expect(provider.create(createRequest())).rejects.toMatchObject({
      code: 'TEAM_RUNTIME_IDENTITY_CONFLICT',
    })
    expect(sdkMocks.query).not.toHaveBeenCalled()
  })

  it('rejects unavailable, malformed, and failed native delivery admission safely', async () => {
    const createChild = fakeChild()
    plans.push({
      child: createChild,
      messages: options => [system(options.sessionId ?? ''), result(options.sessionId ?? '')],
    })
    const host = await setup([createChild])
    const created = await host.provider.create(createRequest())
    await vi.waitFor(() => { expect(createChild.terminate).toHaveBeenCalled() })

    await expect(host.provider.deliver({
      nativeHandle: TeammateRuntimeHandle('not-attached'),
      deliveryId: TeamMessageId('unknown-delivery'),
      senderId: SessionId('lead'),
      senderName: 'lead',
      content: [{ type: 'text', text: 'work' }],
      delivery: 'quiet',
      signal: new AbortController().signal,
    })).rejects.toMatchObject({ code: 'TEAM_RUNTIME_IDENTITY_CONFLICT' })

    sdkMocks.getSessionInfo.mockResolvedValueOnce(undefined)
    sdkMocks.getSessionMessages.mockResolvedValueOnce([])
    await expect(host.provider.deliver({
      nativeHandle: created.nativeHandle,
      deliveryId: TeamMessageId('missing-native'),
      senderId: SessionId('lead'),
      senderName: 'lead',
      content: [{ type: 'text', text: 'work' }],
      delivery: 'quiet',
      signal: new AbortController().signal,
    })).rejects.toMatchObject({ code: 'TEAM_RUNTIME_IDENTITY_CONFLICT' })

    sdkMocks.getSessionInfo.mockRejectedValueOnce(new Error('SECRET_TOKEN /private/path'))
    await expect(host.provider.deliver({
      nativeHandle: created.nativeHandle,
      deliveryId: TeamMessageId('lookup-failure'),
      senderId: SessionId('lead'),
      senderName: 'lead',
      content: [{ type: 'text', text: 'work' }],
      delivery: 'quiet',
      signal: new AbortController().signal,
    })).rejects.toMatchObject({
      code: 'TEAM_RUNTIME_UNAVAILABLE',
      message: 'Claude Code durable runtime failed during delivery',
    })

    sdkMocks.getSessionInfo.mockResolvedValueOnce(sessionInfo('different-session'))
    await expect(host.provider.deliver({
      nativeHandle: created.nativeHandle,
      deliveryId: TeamMessageId('identity-failure'),
      senderId: SessionId('lead'),
      senderName: 'lead',
      content: [{ type: 'text', text: 'work' }],
      delivery: 'quiet',
      signal: new AbortController().signal,
    })).rejects.toMatchObject({ code: 'TEAM_RUNTIME_IDENTITY_CONFLICT' })

    sdkMocks.getSessionInfo.mockImplementationOnce(async sessionId => sessionInfo(sessionId))
    sdkMocks.getSessionMessages.mockResolvedValueOnce([])
    await expect(host.provider.deliver({
      nativeHandle: created.nativeHandle,
      deliveryId: TeamMessageId('invalid-content'),
      senderId: SessionId('lead'),
      senderName: 'lead',
      content: [],
      delivery: 'quiet',
      signal: new AbortController().signal,
    })).rejects.toMatchObject({ code: 'TEAM_RUNTIME_CAPABILITY_MISMATCH' })
  })

  it('aborts a delivery waiting behind the exact active turn', async () => {
    const child = fakeChild()
    const gate = Promise.withResolvers<undefined>()
    plans.push({
      child,
      messages: options => [system(options.sessionId ?? '')],
      release: gate.promise,
    })
    const { provider } = await setup([child])
    const created = await provider.create(createRequest())
    const controller = new AbortController()
    const delivery = provider.deliver({
      nativeHandle: created.nativeHandle,
      deliveryId: TeamMessageId('blocked-delivery'),
      senderId: SessionId('lead'),
      senderName: 'lead',
      content: [{ type: 'text', text: 'must not start' }],
      delivery: 'quiet',
      signal: controller.signal,
    })
    controller.abort('bounded cancellation')

    await expect(delivery).rejects.toThrow('operation aborted')
    expect(sdkMocks.query).toHaveBeenCalledOnce()
  })

  it('rejects a queued delivery when disposal wins before its operation starts', async () => {
    const child = fakeChild()
    plans.push({
      child,
      messages: options => [system(options.sessionId ?? ''), result(options.sessionId ?? '')],
    })
    const { provider } = await setup([child])
    const created = await provider.create(createRequest())
    await vi.waitFor(() => { expect(child.terminate).toHaveBeenCalled() })
    await nextTask()

    const delivery = provider.deliver({
      nativeHandle: created.nativeHandle,
      deliveryId: TeamMessageId('dispose-before-delivery-start'),
      senderId: SessionId('lead'),
      senderName: 'lead',
      content: [{ type: 'text', text: 'Must remain unstarted.' }],
      delivery: 'quiet',
      signal: new AbortController().signal,
    })
    const disposal = provider.dispose({
      kind: 'runtime',
      nativeHandle: created.nativeHandle,
      signal: new AbortController().signal,
    })

    await expect(delivery).rejects.toMatchObject({ code: 'TEAM_RUNTIME_IDENTITY_CONFLICT' })
    await expect(disposal).resolves.toBeUndefined()
    expect(sdkMocks.query).toHaveBeenCalledOnce()
  })

  it('rejects a delivery after disposal interrupts the active turn it awaited', async () => {
    const child = fakeChild()
    const gate = Promise.withResolvers<undefined>()
    plans.push({
      child,
      messages: options => [system(options.sessionId ?? '')],
      release: gate.promise,
    })
    const { provider } = await setup([child])
    const created = await provider.create(createRequest())
    const delivery = provider.deliver({
      nativeHandle: created.nativeHandle,
      deliveryId: TeamMessageId('dispose-during-active-turn'),
      senderId: SessionId('lead'),
      senderName: 'lead',
      content: [{ type: 'text', text: 'Must not reach a second query.' }],
      delivery: 'quiet',
      signal: new AbortController().signal,
    })
    await nextTask()
    const disposal = provider.dispose({
      kind: 'runtime',
      nativeHandle: created.nativeHandle,
      signal: new AbortController().signal,
    })

    await expect(delivery).rejects.toMatchObject({ code: 'TEAM_RUNTIME_IDENTITY_CONFLICT' })
    await expect(disposal).resolves.toBeUndefined()
    expect(sdkMocks.query).toHaveBeenCalledOnce()
  })

  it('pages normalized evidence and rejects bad cursors, cancellation, and detached handles', async () => {
    const child = fakeChild()
    plans.push({
      child,
      messages: options => [
        { type: 'system', subtype: 'status' } as SDKMessage,
        system(options.sessionId ?? ''),
        permissionDenied(options.sessionId ?? ''),
        { type: 'assistant', session_id: options.sessionId, message: null } as unknown as SDKMessage,
        { type: 'assistant', session_id: options.sessionId, message: [] } as unknown as SDKMessage,
        {
          type: 'assistant',
          session_id: options.sessionId,
          message: { content: 'private non-array' },
        } as unknown as SDKMessage,
        {
          ...assistantWithTool(options.sessionId ?? ''),
          message: {
            content: [
              null,
              'text',
              { type: 'text', text: 'private' },
              { type: 'tool_use', name: 'Glob' },
              { type: 'tool_use', id: 'grep-id', name: 'Grep' },
              { type: 'tool_use', id: 'bash-id', name: 'Bash' },
            ],
          },
        } as SDKMessage,
        result(options.sessionId ?? ''),
      ],
    })
    const { provider } = await setup([child], { maxEvidenceItems: 20 })
    const created = await provider.create(createRequest())
    await vi.waitFor(() => { expect(child.terminate).toHaveBeenCalled() })
    if (provider.evidence === undefined) throw new Error('missing evidence operation')

    const first = await provider.evidence({
      nativeHandle: created.nativeHandle,
      limit: 1,
      signal: new AbortController().signal,
    })
    expect(first).toMatchObject({ complete: false, nextCursor: '1' })
    expect(first.items).toHaveLength(1)
    if (first.nextCursor === undefined) throw new Error('missing evidence cursor')
    const rest = await provider.evidence({
      nativeHandle: created.nativeHandle,
      cursor: first.nextCursor,
      limit: 20,
      signal: new AbortController().signal,
    })
    expect(rest.complete).toBe(true)
    expect(rest.nextCursor).toBeUndefined()
    expect([...first.items, ...rest.items].map(item => item.name).filter(Boolean)).toEqual([
      'permission-denied',
      'glob',
      'grep',
    ])

    for (const cursor of ['not-a-number', '-1', '999']) {
      await expect(provider.evidence({
        nativeHandle: created.nativeHandle,
        cursor: TeammateRuntimeEvidenceCursor(cursor),
        limit: 1,
        signal: new AbortController().signal,
      })).rejects.toMatchObject({ code: 'TEAM_RUNTIME_IDENTITY_CONFLICT' })
    }
    const cancelled = new AbortController()
    cancelled.abort()
    await expect(provider.evidence({
      nativeHandle: created.nativeHandle,
      limit: 1,
      signal: cancelled.signal,
    })).rejects.toThrow()
    await expect(provider.evidence({
      nativeHandle: TeammateRuntimeHandle('detached'),
      limit: 1,
      signal: new AbortController().signal,
    })).rejects.toMatchObject({ code: 'TEAM_RUNTIME_IDENTITY_CONFLICT' })
  })

  it('disposes only runtime handles, coalesces disposal, and publishes contained presence edges', async () => {
    const child = fakeChild()
    const gate = Promise.withResolvers<undefined>()
    plans.push({
      child,
      messages: options => [system(options.sessionId ?? '')],
      release: gate.promise,
    })
    const { provider } = await setup([child])
    const events: unknown[] = []
    const unsubscribe = provider.onPresenceChanged?.((event) => { events.push(event) })
    provider.onPresenceChanged?.(() => { throw new Error('observer failure') })
    const created = await provider.create(createRequest())
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
    await Promise.all([
      provider.dispose({
        kind: 'runtime',
        nativeHandle: created.nativeHandle,
        signal: new AbortController().signal,
      }),
      provider.dispose({
        kind: 'runtime',
        nativeHandle: created.nativeHandle,
        signal: new AbortController().signal,
      }),
    ])
    expect(child.terminate).toHaveBeenCalled()
    expect(events).toContainEqual({ nativeHandle: created.nativeHandle, presence: 'inactive' })
    unsubscribe?.()
    expect(provider.interrupt({ nativeHandle: created.nativeHandle })).toEqual({ previousStatus: 'inactive' })
  })

  it.each([
    { label: 'no process', mode: 'none' },
    { label: 'wrong executable', mode: 'wrong-command' },
    { label: 'a second process', mode: 'double-spawn' },
    { label: 'invalid process id', mode: 'bad-pid' },
    { label: 'synchronous SDK failure', mode: 'throw' },
  ])('fails safely when the SDK publishes $label', async ({ mode }) => {
    const child = fakeChild({ pid: mode === 'bad-pid' ? -1 : 3210 })
    const host = await setup(mode === 'none' || mode === 'throw' ? [] : [child])
    sdkMocks.query.mockImplementationOnce(({ options }) => {
      const spawn = (command: string): void => {
        options.spawnClaudeCodeProcess?.({
          command,
          args: [],
          cwd: options.cwd,
          env: options.env ?? {},
          signal: options.abortController?.signal,
        } as SpawnOptions)
      }
      if (mode === 'throw') throw new Error('/private/sdk/startup')
      if (mode === 'wrong-command') spawn('/unqualified/claude')
      if (mode === 'double-spawn') {
        spawn(options.pathToClaudeCodeExecutable ?? '')
        spawn(options.pathToClaudeCodeExecutable ?? '')
      }
      if (mode === 'bad-pid') spawn(options.pathToClaudeCodeExecutable ?? '')
      return queryWithoutMessages()
    })

    const error = await host.provider.create(createRequest()).catch((cause: unknown) => cause)
    expect(error).toMatchObject({
      code: 'TEAM_RUNTIME_UNAVAILABLE',
      message: 'Claude Code durable runtime failed during query-start',
    })
    expect((error as Error).message).not.toContain('/private/')
    if (mode === 'double-spawn' || mode === 'bad-pid') {
      expect(child.terminate).toHaveBeenCalled()
    }
  })

  it('waits for exact process exit before rejecting a synchronous SDK startup failure', async () => {
    const exit = Promise.withResolvers<undefined>()
    const child = fakeChild({ exitRelease: exit.promise })
    const host = await setup([child])
    sdkMocks.query.mockImplementationOnce(({ options }) => {
      options.spawnClaudeCodeProcess?.({
        command: options.pathToClaudeCodeExecutable ?? '',
        args: [],
        cwd: options.cwd,
        env: options.env ?? {},
        signal: options.abortController?.signal,
      } as SpawnOptions)
      throw new Error('/private/synchronous-startup-failure')
    })

    let settled = false
    const creating = host.provider.create(createRequest())
    void creating.then(() => { settled = true }, () => { settled = true })
    await vi.waitFor(() => { expect(child.terminate).toHaveBeenCalled() })
    await nextTask()
    expect(settled).toBe(false)
    exit.resolve(undefined)
    await expect(creating).rejects.toMatchObject({ code: 'TEAM_RUNTIME_UNAVAILABLE' })
  })

  it('contains wrong-Session, post-acceptance SDK, and teardown failures as scrubbed evidence', async () => {
    const wrongChild = fakeChild()
    plans.push({ child: wrongChild, messages: [system('wrong-session')] })
    const wrong = await setup([wrongChild])
    await expect(wrong.provider.create(createRequest())).rejects.toMatchObject({
      code: 'TEAM_RUNTIME_UNAVAILABLE',
      message: 'Claude Code durable runtime failed during query-run',
    })
    await vi.waitFor(() => { expect(wrongChild.terminate).toHaveBeenCalled() })

    const failedChild = fakeChild({
      terminateError: new Error('/private/terminate'),
      waitError: new Error('/private/wait'),
      doneError: new Error('SECRET_TOKEN'),
    })
    plans.push({
      child: failedChild,
      messages: options => [system(options.sessionId ?? '')],
      failure: new Error('/private/query SECRET_TOKEN'),
      closeError: new Error('/private/close'),
    })
    wrong.spawn.mockReturnValueOnce(failedChild.handle)
    const request = createRequest({
      launchRequestId: TeammateLaunchRequestId('aaaaaaaa-5555-4555-8555-555555555555'),
      memberId: SessionId('failure-claude-member'),
    })
    const created = await wrong.provider.create(request)
    await vi.waitFor(() => { expect(failedChild.terminate).toHaveBeenCalled() })
    if (wrong.provider.evidence === undefined) throw new Error('missing evidence operation')
    await vi.waitFor(async () => {
      const page = await wrong.provider.evidence?.({
        nativeHandle: created.nativeHandle,
        limit: 20,
        signal: new AbortController().signal,
      })
      expect(page?.items).toHaveLength(2)
    })
    const evidence = await wrong.provider.evidence({
      nativeHandle: created.nativeHandle,
      limit: 20,
      signal: new AbortController().signal,
    })
    expect(evidence.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'diagnostic', name: 'query-failed', outcome: 'failed' }),
      expect.objectContaining({ kind: 'turn', outcome: 'failed' }),
    ]))
    expect(JSON.stringify(evidence)).not.toMatch(/private|SECRET_TOKEN/u)
  })

  it('uses custom deployment settings and validates timer and evidence limits', async () => {
    const child = fakeChild()
    plans.push({
      child,
      messages: options => [system(options.sessionId ?? ''), result(options.sessionId ?? '')],
    })
    const custom = await setup([child], {
      providerName: 'claude-custom',
      cwd: '.',
      model: 'claude-pinned-model',
      sandbox: 'read-only',
      disposeGraceMs: 19,
      maxEvidenceItems: 3,
    })
    await custom.provider.create(createRequest())
    expect(sdkMocks.query.mock.calls[0]?.[0].options).toMatchObject({
      cwd: process.cwd(),
      model: 'claude-pinned-model',
    })
    expect(custom.spawn).toHaveBeenCalledWith(expect.objectContaining({ graceMs: 19 }))

    for (const disposeGraceMs of [0, Number.POSITIVE_INFINITY, 2_147_483_648]) {
      expect(() => {
        claudeRuntime.apply(custom.ctx, {
          providerName: `invalid-grace-${String(disposeGraceMs)}`,
          disposeGraceMs,
        })
      }).toThrow(/disposeGraceMs/u)
    }
    for (const maxEvidenceItems of [0, 1.5]) {
      expect(() => {
        claudeRuntime.apply(custom.ctx, {
          providerName: `invalid-evidence-${String(maxEvidenceItems)}`,
          maxEvidenceItems,
        })
      }).toThrow(/maxEvidenceItems/u)
    }
  })

  it('rejects new work after provider disposal and makes repeated close idempotent', async () => {
    const host = await setup([])
    await host.fiber.dispose()
    await host.fiber.dispose()
    await expect(host.provider.create(createRequest())).rejects.toMatchObject({
      code: 'TEAM_RUNTIME_UNAVAILABLE',
    })
  })

  it('aborts and awaits a native inspection that has not attached a Session during close', async () => {
    const host = await setup([])
    const inspection = Promise.withResolvers<SDKSessionInfo | undefined>()
    sdkMocks.getSessionInfo.mockImplementationOnce(async () => await inspection.promise)
    sdkMocks.getSessionMessages.mockImplementationOnce(async () => [])
    let rejected = false
    const creating = host.provider.create(createRequest())
    void creating.catch(() => { rejected = true })
    await vi.waitFor(() => { expect(sdkMocks.getSessionInfo).toHaveBeenCalledOnce() })

    await (host.provider as unknown as { close(): Promise<void> }).close()
    await nextTask()
    const rejectedBeforeNativeSettlement = rejected
    inspection.resolve(undefined)
    await creating.catch(() => {})
    expect(rejectedBeforeNativeSettlement).toBe(true)
    expect(sdkMocks.query).not.toHaveBeenCalled()
  })

  it('applies direct-call defaults without relying on Loader schema hydration', () => {
    const register = vi.fn()
    const effect = vi.fn()
    const ctx = {
      agentTeams: { registerTeammateRuntimeProvider: register },
      effect,
      logger: { warn: vi.fn() },
    } as unknown as Context

    claudeRuntime.apply(ctx, {})
    expect(register).toHaveBeenCalledWith(expect.objectContaining({
      id: 'claude-code',
      displayName: 'Claude Code',
    }))
    expect(effect).toHaveBeenCalledOnce()
  })

  it('contains launch lookup failures and empty SDK streams before publication', async () => {
    const lookup = await setup([])
    sdkMocks.getSessionInfo.mockRejectedValueOnce(new Error('/private/lookup SECRET_TOKEN'))
    const lookupFailure = await lookup.provider.create(createRequest()).catch((cause: unknown) => cause)
    expect(lookupFailure).toMatchObject({
      code: 'TEAM_RUNTIME_UNAVAILABLE',
      message: 'Claude Code durable runtime failed during creation',
    })
    expect((lookupFailure as Error).cause).toBeUndefined()

    const emptyChild = fakeChild({
      waitError: new Error('/private/wait'),
      doneError: new Error('SECRET_TOKEN'),
    })
    plans.push({
      child: emptyChild,
      messages: [],
      closeError: new Error('/private/close'),
    })
    lookup.spawn.mockReturnValueOnce(emptyChild.handle)
    const emptyRequest = createRequest({
      launchRequestId: TeammateLaunchRequestId('aaaaaaaa-6666-4666-8666-666666666666'),
      memberId: SessionId('empty-stream-member'),
    })
    await expect(lookup.provider.create(emptyRequest)).rejects.toMatchObject({
      code: 'TEAM_RUNTIME_UNAVAILABLE',
      message: 'Claude Code durable runtime failed during query-run',
    })
    expect(emptyChild.terminate).toHaveBeenCalled()
  })

  it('coalesces concurrent native resume attachment after both lookups verify one launch marker', async () => {
    const host = await setup([])
    const initial = createRequest()
    const marker = Promise.withResolvers<string>()
    sdkMocks.getSessionInfo.mockImplementation(async sessionId => sessionInfo(sessionId))
    sdkMocks.getSessionMessages.mockImplementation(async sessionId => [
      transcript(sessionId, await marker.promise),
    ])
    const first = host.provider.resume({
      launchRequestId: initial.launchRequestId,
      memberId: initial.memberId,
      requirements: initial.requirements,
      signal: initial.signal,
    })
    const second = host.provider.resume({
      launchRequestId: initial.launchRequestId,
      memberId: initial.memberId,
      requirements: initial.requirements,
      signal: initial.signal,
    })
    await nextTask()
    const expectedHandle = sdkMocks.getSessionInfo.mock.calls[0]?.[0]
    if (expectedHandle === undefined) throw new Error('missing deterministic handle')
    const digest = createHash('sha256')
      .update(JSON.stringify([
        'launch',
        'claude-code',
        initial.launchRequestId,
        initial.memberId,
      ]))
      .digest('hex')
    marker.resolve(`[dsh-agent-team:launch:${digest}]`)
    const firstResult = await first
    const secondResult = await second
    if (firstResult === undefined || secondResult === undefined) {
      throw new Error('missing deterministic resumed runtime')
    }
    expect(firstResult).toMatchObject({
      nativeHandle: expectedHandle,
      presence: 'idle',
    })
    expect(secondResult).toMatchObject({
      nativeHandle: expectedHandle,
      presence: 'idle',
    })
    expect(typeof firstResult.turnId).toBe('string')
    expect(typeof secondResult.turnId).toBe('string')
  })

  it('bounds adversarial native transcript traversal without accepting deep or oversized marker shapes', async () => {
    const host = await setup([])
    sdkMocks.getSessionInfo.mockImplementation(async sessionId => sessionInfo(sessionId))
    let deep: unknown = 'not the marker'
    for (let index = 0; index < 10; index += 1) deep = { nested: deep }
    sdkMocks.getSessionMessages.mockImplementationOnce(async sessionId => [
      transcript(sessionId, deep as string),
    ])
    await expect(host.provider.create(createRequest())).rejects.toMatchObject({
      code: 'TEAM_RUNTIME_IDENTITY_CONFLICT',
    })

    sdkMocks.getSessionMessages.mockImplementationOnce(async sessionId => [
      transcript(sessionId, Array.from({ length: 16_500 }, () => 0) as unknown as string),
    ])
    const wide = createRequest({
      launchRequestId: TeammateLaunchRequestId('aaaaaaaa-7777-4777-8777-777777777777'),
      memberId: SessionId('wide-transcript-member'),
    })
    await expect(host.provider.create(wide)).rejects.toMatchObject({
      code: 'TEAM_RUNTIME_IDENTITY_CONFLICT',
    })
  })

  it('classifies a gracefully closed interrupted SDK stream as interrupted', async () => {
    const child = fakeChild()
    const streamStarted = Promise.withResolvers<undefined>()
    const streamClosed = Promise.withResolvers<undefined>()
    const host = await setup([child])
    sdkMocks.query.mockImplementationOnce(({ options }) => {
      options.spawnClaudeCodeProcess?.({
        command: options.pathToClaudeCodeExecutable ?? '',
        args: [],
        cwd: options.cwd,
        env: options.env ?? {},
        signal: options.abortController?.signal,
      } as SpawnOptions)
      async function* stream(): AsyncGenerator<SDKMessage, void> {
        yield system(options.sessionId ?? '')
        streamStarted.resolve(undefined)
        await streamClosed.promise
      }
      return Object.assign(stream(), {
        close: () => { streamClosed.resolve(undefined) },
      }) as unknown as Query
    })
    const created = await host.provider.create(createRequest())
    await streamStarted.promise
    expect(host.provider.interrupt({ nativeHandle: created.nativeHandle })).toEqual({ previousStatus: 'running' })
    await vi.waitFor(async () => {
      if (host.provider.evidence === undefined) throw new Error('missing evidence')
      const page = await host.provider.evidence({
        nativeHandle: created.nativeHandle,
        limit: 10,
        signal: new AbortController().signal,
      })
      expect(page.items).toContainEqual(expect.objectContaining({
        kind: 'turn',
        outcome: 'interrupted',
      }))
    })
  })
})
