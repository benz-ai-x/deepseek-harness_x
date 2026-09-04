import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deleteSession } from '@anthropic-ai/claude-agent-sdk'
import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { SessionId } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SubagentService from '@deepseek-ai/dsh-subagent'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import TeamService, { TeammateLaunchRequestId } from '@deepseek-ai/dsh-experimental-agent-team'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as claudeRuntime from '../src/index.ts'
import { TestSessionQuery } from '../../agent-team/tests/test-session-query.ts'

const roots: string[] = []
const contexts: Context[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(async (ctx) => { await ctx.fiber.dispose() }))
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

async function mount(
  storageRoot: string,
  workspace: string,
  resume: boolean,
): Promise<{ ctx: Context; lead: Awaited<ReturnType<Context['agentLoop']['create']>> }> {
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
  await ctx.plugin(claudeRuntime, {
    cwd: workspace,
    sandbox: 'read-only',
    disposeGraceMs: 2_000,
  })
  const resumed = resume
    ? await ctx.agents.resume({
      resumeSessionId: SessionId('claude-real-canary-lead'),
      agentOptions: {},
    })
    : undefined
  return {
    ctx,
    lead: resumed?.agent ?? await ctx.agentLoop.create(SessionId('claude-real-canary-lead'), {}),
  }
}

describe('real Claude Code durable-runtime canary', () => {
  it.runIf(process.env.DSH_CLAUDE_AGENT_SDK_CANARY === '1')(
    'starts and resumes one package-pinned native Session across a Host restart',
    async () => {
      const root = mkdtempSync(join(tmpdir(), 'dsh-team-claude-real-'))
      roots.push(root)
      const workspace = join(root, 'workspace')
      const storageRoot = join(root, 'sessions')
      mkdirSync(workspace)
      mkdirSync(storageRoot)
      let nativeHandle: string | undefined
      try {
        const first = await mount(storageRoot, workspace, false)
        const created = await first.ctx.agentTeams.spawnTeammate(first.lead, {
          name: 'real-claude',
          description: 'Exercise the package-pinned Claude Agent SDK',
          prompt: [{ type: 'text', text: 'Reply with exactly first-real-turn. Do not use tools.' }],
          context: 'fresh',
          runtime: {
            kind: 'external-agent',
            provider: 'claude-code',
            launchRequestId: TeammateLaunchRequestId('55555555-5555-4555-8555-555555555555'),
            profile: {
              persona: 'Be exact.',
              mission: 'Exercise persistent Claude Code state.',
              context: [],
              memory: [],
              toolPolicy: { mode: 'inherit', names: [] },
              hooks: [],
            },
            requirements: {
              contextMode: 'fresh',
              profileCapabilities: ['persona', 'mission'],
              runtimeCapabilities: ['sandbox', 'evidence', 'usage'],
            },
          },
          signal: new AbortController().signal,
        })
        nativeHandle = created.member.externalRuntime?.nativeHandle
        expect(nativeHandle).toMatch(/^[0-9a-f-]+$/u)
        await vi.waitFor(() => {
          expect(first.ctx.agentTeams.listMembers(first.lead)[1]?.status).toBe('idle')
        }, { timeout: 60_000 })
        await first.ctx.fiber.dispose()

        const second = await mount(storageRoot, workspace, true)
        await vi.waitFor(() => {
          expect(second.ctx.agentTeams.listMembers(second.lead)[1]).toMatchObject({
            name: 'real-claude',
            status: 'idle',
            externalRuntime: { nativeHandle },
          })
        }, { timeout: 20_000 })
        await expect(second.ctx.agentTeams.sendMessage(second.lead, {
          target: 'real-claude',
          content: [{ type: 'text', text: 'Reply with exactly second-real-turn. Do not use tools.' }],
          signal: new AbortController().signal,
        })).resolves.toMatchObject({ status: 'accepted' })
        await vi.waitFor(() => {
          expect(second.ctx.agentTeams.listMembers(second.lead)[1]?.status).toBe('idle')
        }, { timeout: 60_000 })
      } finally {
        if (nativeHandle !== undefined) {
          await deleteSession(nativeHandle, { dir: workspace }).catch(() => {})
        }
      }
    },
    120_000,
  )
})
