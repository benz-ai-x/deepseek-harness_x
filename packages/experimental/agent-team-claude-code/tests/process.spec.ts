import { PassThrough } from 'node:stream'
import type { SpawnOptions } from '@anthropic-ai/claude-agent-sdk'
import type {
  SubprocessHandle,
  SubprocessOutcome,
} from '@deepseek-ai/dsh-subprocess'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  claudeSpawnSpec,
  ManagedClaudeCodeProcess,
  sdkEnvironmentOverlay,
} from '../src/process.ts'

afterEach(() => { vi.unstubAllEnvs() })

function spawnOptions(overrides: Partial<SpawnOptions> = {}): SpawnOptions {
  const signal = new AbortController().signal
  return {
    command: '/official/claude',
    args: ['--print'],
    cwd: '/workspace',
    env: { PATH: '/bin' },
    signal,
    ...overrides,
  }
}

function child(): {
  readonly handle: SubprocessHandle
  readonly stdin: PassThrough
  readonly stdout: PassThrough
  readonly terminate: ReturnType<typeof vi.fn>
  readonly settle: (outcome: SubprocessOutcome) => void
  readonly fail: (error: unknown) => void
} {
  const stdin = new PassThrough()
  const stdout = new PassThrough()
  let resolveDone!: (outcome: SubprocessOutcome) => void
  let rejectDone!: (error: unknown) => void
  const done = new Promise<SubprocessOutcome>((resolve, reject) => {
    resolveDone = resolve
    rejectDone = reject
  })
  void done.catch(() => {})
  const terminate = vi.fn()
  return {
    handle: {
      pid: 42,
      stdin,
      stdout,
      stderr: new PassThrough(),
      collected: {},
      done,
      terminate,
      waitForExit: async () => true,
    },
    stdin,
    stdout,
    terminate,
    settle: resolveDone,
    fail: rejectDone,
  }
}

async function nextTask(): Promise<void> {
  await new Promise<void>((resolve) => { setImmediate(resolve) })
}

describe('durable Claude Code managed-process projection', () => {
  it('forwards the exact SDK spawn request and tombstones removed ambient names', () => {
    vi.stubEnv('CLAUDE_RUNTIME_AMBIENT', 'ambient')
    const signal = new AbortController().signal
    const options = spawnOptions({
      command: String.raw`C:\Program Files\Claude\claude.exe`,
      args: ['--one', 'two'],
      cwd: '/exact/workspace',
      env: { A: 'one', B: undefined },
      signal,
    })
    expect(sdkEnvironmentOverlay(options.env)).toEqual(expect.objectContaining({
      A: 'one',
      B: undefined,
      CLAUDE_RUNTIME_AMBIENT: undefined,
    }))
    const spec = claudeSpawnSpec(options, 321)
    expect(spec).toMatchObject({
      argv: [String.raw`C:\Program Files\Claude\claude.exe`, '--one', 'two'],
      cwd: '/exact/workspace',
      stdio: { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' },
      graceMs: 321,
      signal,
    })
    expect(spec.env).toEqual(expect.objectContaining({
      A: 'one',
      B: undefined,
      CLAUDE_RUNTIME_AMBIENT: undefined,
    }))
  })

  it('fails closed when the SDK omits its workspace', () => {
    const missing = spawnOptions()
    delete missing.cwd
    expect(() => claudeSpawnSpec(missing, 1)).toThrow('omitted its workspace')
    expect(() => claudeSpawnSpec(spawnOptions({ cwd: '' }), 1)).toThrow('omitted its workspace')
  })

  it('projects streams, exit facts, listeners, and idempotent exact-tree termination', async () => {
    const fake = child()
    const process = new ManagedClaudeCodeProcess(fake.handle)
    expect(process.stdin).toBe(fake.stdin)
    expect(process.stdout).toBe(fake.stdout)
    expect(process.killed).toBe(false)
    expect(process.exitCode).toBeNull()
    expect(process.signalCode).toBeNull()
    expect(process.outcome).toBeUndefined()

    const persistent = vi.fn()
    const once = vi.fn()
    const removed = vi.fn()
    process.on('exit', persistent)
    process.once('exit', once)
    process.on('exit', removed)
    process.off('exit', removed)
    expect(process.kill('SIGTERM')).toBe(true)
    expect(process.killed).toBe(true)
    expect(process.kill('SIGKILL')).toBe(false)
    expect(fake.terminate).toHaveBeenCalledOnce()

    fake.settle({ exitCode: null, signal: 'SIGTERM' })
    await nextTask()
    expect(persistent).toHaveBeenCalledWith(null, 'SIGTERM')
    expect(once).toHaveBeenCalledOnce()
    expect(removed).not.toHaveBeenCalled()
    expect(process.exitCode).toBeNull()
    expect(process.signalCode).toBe('SIGTERM')
    expect(process.outcome).toEqual({ exitCode: null, signal: 'SIGTERM' })
    expect(process.kill('SIGTERM')).toBe(false)
  })

  it('publishes exit codes plus Error and non-Error spawn failures', async () => {
    const exited = child()
    const exitedProcess = new ManagedClaudeCodeProcess(exited.handle)
    exited.settle({ exitCode: 7, signal: null })
    await nextTask()
    expect(exitedProcess.exitCode).toBe(7)
    expect(exitedProcess.signalCode).toBeNull()
    expect(exitedProcess.outcome).toEqual({ exitCode: 7, signal: null })

    const failed = child()
    const failedProcess = new ManagedClaudeCodeProcess(failed.handle)
    const error = vi.fn()
    failedProcess.once('error', error)
    failed.fail(new Error('spawn failure'))
    await nextTask()
    expect(error).toHaveBeenCalledWith(expect.objectContaining({ message: 'spawn failure' }))

    const nonError = child()
    const nonErrorProcess = new ManagedClaudeCodeProcess(nonError.handle)
    const normalized = vi.fn()
    nonErrorProcess.on('error', normalized)
    nonError.fail('string failure')
    await nextTask()
    expect(normalized).toHaveBeenCalledWith(expect.objectContaining({ message: 'string failure' }))
  })
})
