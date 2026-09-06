/** Execute native operations through a real shipped profile and its Loader composition. */
import assert from 'node:assert/strict'
import { SessionId } from '@deepseek-ai/dsh-session'
import { TeammateLaunchRequestId, TeammateRuntimeTurnId, TeammateRuntimeToolCallId } from '@deepseek-ai/dsh-experimental-agent-team'
import type {} from './native-product.ts'
import { bootProductionProfile } from '../../../../../test-support/loader-smoke/tests/fixtures/production-profile.ts'

const configPath = process.argv[2]
if (configPath === undefined) throw new Error('native query Loader driver requires a patch path')
const ctx = await bootProductionProfile({ binName: 'native-team-query', profile: 'headless', overlayPaths: [configPath] })
try {
  const lead = await ctx.agents.create({ sessionId: SessionId('native-loader-lead') })
  await ctx.agentTeams.createTask(lead.agent, { subject: 'Inspect', description: 'Inspect the shared source.' })
  const spawned = await ctx.agentTeams.spawnTeammate(lead.agent, {
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
  const source = {
    kind: 'tool' as const,
    turnId: TeammateRuntimeTurnId('native-loader-turn'),
    callId: TeammateRuntimeToolCallId('native-loader-message'),
  }
  assert.equal(spawned.member.externalRuntime?.initialTurnId, source.turnId)
  const input = { operation: 'messages.send', target: 'lead', text: 'Review is in progress.' }
  const sent = await grant.execute(input, signal, source)
  assert.equal(sent.ok, true)
  assert.deepEqual(await grant.execute(input, signal, source), sent)
  const conflict = await grant.execute({ ...input, text: 'A different request.' }, signal, source)
  const settled = await grant.execute({ operation: 'turns.settle', outcome: 'completed', text: 'The review found no issues.' }, signal, {
    kind: 'settlement', turnId: source.turnId,
  })
  assert.equal(settled.ok, true)
  const handle = await ctx.sessionPersistence.open(lead.agent.id, 'read')
  let operations
  try {
    const events = await handle.read(0)
    const committed = events.filter(event => event.type === 'team/native-operation/committed')
    assert.equal(committed.length, 2)
    operations = committed.map(({ data }) => {
      assert.equal(data.message.senderId, spawned.member.id)
      assert.equal(data.message.targetId, lead.agent.id)
      assert.equal(data.receipt.result.value.messageId, data.message.id)
      assert.equal(data.receipt.source.turnId, source.turnId)
      return {
        version: data.version, operation: data.receipt.result.operation,
        status: data.receipt.result.value.status, sender: data.message.senderName,
        source: data.receipt.source, content: data.message.content,
      }
    })
  } finally {
    await handle.close()
  }
  await ctx.fiber.dispose()
  const revoked = await grant.execute({ operation: 'members.list' }, signal)
  process.stdout.write(`${JSON.stringify({ query, forged, conflict, operations, revoked }, null, 2)}\n`)
} finally {
  await ctx.fiber.dispose()
}
