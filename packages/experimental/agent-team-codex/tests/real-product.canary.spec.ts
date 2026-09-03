import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { SessionId } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SubagentService from '@deepseek-ai/dsh-subagent'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import TeamService, {
  TeammateLaunchRequestId,
} from '@deepseek-ai/dsh-experimental-agent-team'
import * as codexRuntime from '../src/index.ts'
import { TestSessionQuery } from '../../agent-team/tests/test-session-query.ts'
import { startResponsesFixture } from '../../../subagent/subagent-codex/tests/responses-fixture.ts'

const roots: string[] = []
const contexts: Context[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(async (ctx) => { await ctx.fiber.dispose() }))
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

async function mount(
  storageRoot: string,
  workspace: string,
  env: Record<string, string>,
  resume: boolean,
): Promise<{ ctx: Context; lead: ReturnType<Context['agentLoop']['create']> }> {
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
  await ctx.plugin(codexRuntime, {
    cwd: workspace,
    env,
    sandbox: 'read-only',
    disposeGraceMs: 2_000,
  })
  const resumed = resume
    ? await ctx.agents.resume({
      resumeSessionId: SessionId('codex-real-canary-lead'),
      agentOptions: {},
    })
    : undefined
  return {
    ctx,
    lead: resumed?.agent ?? ctx.agentLoop.create(SessionId('codex-real-canary-lead'), {}),
  }
}

describe('real Codex durable-runtime canary', () => {
  it.runIf(process.env.DSH_CODEX_APP_SERVER_CANARY === '1')(
    'starts and resumes one package-pinned native thread across a Host restart',
    async () => {
      const root = mkdtempSync(join(tmpdir(), 'dsh-team-codex-real-'))
      roots.push(root)
      const workspace = join(root, 'workspace')
      const storageRoot = join(root, 'sessions')
      const codexHome = join(root, 'codex-home')
      mkdirSync(workspace)
      mkdirSync(storageRoot)
      mkdirSync(codexHome)
      const fixture = await startResponsesFixture([
        { kind: 'complete', text: 'first-real-turn' },
        { kind: 'complete', text: 'second-real-turn' },
      ])
      try {
        writeFileSync(join(codexHome, 'config.toml'), [
          'model = "fixture-model"',
          'model_provider = "fixture"',
          'approval_policy = "never"',
          'sandbox_mode = "read-only"',
          'disable_response_storage = true',
          'check_for_update_on_startup = false',
          '',
          '[model_providers.fixture]',
          'name = "Fixture Responses"',
          `base_url = "${fixture.baseUrl}"`,
          'env_key = "OPENAI_API_KEY"',
          'wire_api = "responses"',
          'requires_openai_auth = false',
          '',
          '[analytics]',
          'enabled = false',
          '',
        ].join('\n'))
        const env = {
          OPENAI_API_KEY: 'dsh-local-fixture-key',
          CODEX_HOME: codexHome,
          HOME: root,
          XDG_CONFIG_HOME: join(root, 'xdg'),
          PATH: process.env.PATH ?? delimiter,
          HTTP_PROXY: '',
          HTTPS_PROXY: '',
          ALL_PROXY: '',
          NO_PROXY: '127.0.0.1,localhost',
        }

        const first = await mount(storageRoot, workspace, env, false)
        const created = await first.ctx.agentTeams.spawnTeammate(first.lead, {
          name: 'real-codex',
          description: 'Exercise the package-pinned Codex app-server',
          prompt: [{ type: 'text', text: 'Run the first native turn.' }],
          context: 'fresh',
          runtime: {
            kind: 'external-agent',
            provider: 'codex',
            launchRequestId: TeammateLaunchRequestId('44444444-4444-4444-8444-444444444444'),
            profile: {
              persona: 'Be exact.',
              mission: 'Exercise persistent Codex state.',
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
        const nativeHandle = created.member.externalRuntime?.nativeHandle
        expect(nativeHandle).toMatch(/^[0-9a-f-]+$/u)
        await vi.waitFor(() => {
          expect(first.ctx.agentTeams.listMembers(first.lead)[1]?.status).toBe('idle')
        }, { timeout: 20_000 })
        await first.ctx.fiber.dispose()

        const second = await mount(storageRoot, workspace, env, true)
        await vi.waitFor(() => {
          expect(second.ctx.agentTeams.listMembers(second.lead)[1]).toMatchObject({
            name: 'real-codex',
            status: 'idle',
            externalRuntime: { nativeHandle },
          })
        }, { timeout: 20_000 })
        await expect(second.ctx.agentTeams.sendMessage(second.lead, {
          target: 'real-codex',
          content: [{ type: 'text', text: 'Run the second native turn.' }],
          delivery: 'wakeup',
          signal: new AbortController().signal,
        })).resolves.toMatchObject({ status: 'accepted' })
        await vi.waitFor(() => {
          expect(second.ctx.agentTeams.listMembers(second.lead)[1]?.status).toBe('idle')
          expect(fixture.requests).toHaveLength(2)
        }, { timeout: 20_000 })
      } finally {
        await fixture.close()
      }
    },
    30_000,
  )
})
