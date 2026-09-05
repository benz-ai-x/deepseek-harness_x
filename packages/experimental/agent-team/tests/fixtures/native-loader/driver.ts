/** Execute native queries through a real shipped profile and its Loader composition. */
import { SessionId } from '@deepseek-ai/dsh-session'
import { TeammateLaunchRequestId } from '@deepseek-ai/dsh-experimental-agent-team'
import type {} from './native-product.ts'
import { bootProductionProfile } from '../../../../../test-support/loader-smoke/tests/fixtures/production-profile.ts'

const configPath = process.argv[2]
if (configPath === undefined) throw new Error('native query Loader driver requires a patch path')
const ctx = await bootProductionProfile({ binName: 'native-team-query', profile: 'headless', overlayPaths: [configPath] })
try {
  const lead = await ctx.agents.create({ sessionId: SessionId('native-loader-lead') })
  await ctx.agentTeams.createTask(lead.agent, { subject: 'Inspect', description: 'Inspect the shared source.' })
  await ctx.agentTeams.spawnTeammate(lead.agent, {
    name: 'reviewer', description: 'Review shared tasks.', context: 'fresh',
    prompt: [{ type: 'text', text: 'Read the shared task board.' }], signal: new AbortController().signal,
    runtime: {
      kind: 'external-agent', provider: 'native-query', launchRequestId: TeammateLaunchRequestId('native-loader-launch'),
      profile: { persona: 'Be precise.', mission: 'Review the source.', context: [], memory: [], toolPolicy: { mode: 'inherit', names: [] }, hooks: [] },
      requirements: { contextMode: 'fresh', profileCapabilities: ['persona', 'mission'], runtimeCapabilities: [] },
    },
  })
  const grant = ctx.nativeQueryFixture.grant
  if (grant === undefined) throw new Error('the composed Team did not grant its native member access')
  const signal = new AbortController().signal
  const query = await grant.execute({ operation: 'tasks.list', limit: 1 }, signal)
  const forged = await grant.execute({ operation: 'members.list', role: 'lead' }, signal)
  await ctx.fiber.dispose()
  const revoked = await grant.execute({ operation: 'members.list' }, signal)
  process.stdout.write(`${JSON.stringify({ query, forged, revoked }, null, 2)}\n`)
} finally {
  await ctx.fiber.dispose()
}
