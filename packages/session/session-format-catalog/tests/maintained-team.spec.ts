import { describe, expect, it } from 'vitest'
import type { SessionFormatJsonValue } from '@deepseek-ai/dsh-session-format'
import { sessionFormatCatalog } from '../src/index.ts'

const runtime = {
  kind: 'external-agent', launchRequestId: 'launch-1', requestFingerprint: 'a'.repeat(64),
  requirements: { contextMode: 'fresh', profileCapabilities: ['persona', 'mission'], runtimeCapabilities: ['evidence', 'usage'] },
}
const member = {
  id: 'worker', name: 'worker', description: 'work', provider: 'native', context: 'fresh', phase: 'active',
  externalRuntime: { ...runtime, nativeHandle: 'handle-1', initialTurnId: 'turn-1' },
}
const message = { id: 'message-1', senderId: 'worker', senderName: 'worker', targetId: 'lead',
  content: [{ type: 'text', text: 'done' }] }
const receipt = {
  id: 'b'.repeat(64), memberId: 'worker', provider: 'native', nativeHandle: 'handle-1',
  source: { kind: 'settlement', turnId: 'turn-1' }, inputFingerprint: 'c'.repeat(64),
  result: { ok: true, operation: 'turns.settle', value: { messageId: 'message-1', status: 'queued', outcome: 'completed' } },
}

/** Exercise the public physical decoder and the complete adjacent chain. */
function restore(type: string, data: SessionFormatJsonValue, version = 0): unknown {
  const header = { type: 'session', version, id: 'lead', createdAt: 1, delegationDepth: 0 }
  const rows = [
    { type: 'turn/start', seq: 0, time: 2, data: { turn: 1 } },
    { type: 'step/start', seq: 1, time: 3, data: { turn: 1, step: 1 } },
    { type, seq: 2, time: 4, data, ...type === 'user/message' ? { surfaceOp: 'append' } : {} },
    { type: 'step/end', seq: 3, time: 5, data: { turn: 1, step: 1 } },
    { type: 'turn/end', seq: 4, time: 6, data: { turn: 1, reason: { kind: 'completed' } } },
  ]
  const before = JSON.stringify({ header, rows })
  const current = sessionFormatCatalog.migrate(sessionFormatCatalog.decodeArtifact(header, rows))
  expect(current.header).toMatchObject({ version: 2, id: 'lead', createdAt: 1, isSeeded: false })
  expect(JSON.stringify({ header, rows })).toBe(before)
  const encoded = sessionFormatCatalog.encodeCurrent(current)
  expect(sessionFormatCatalog.migrate(sessionFormatCatalog.decodeArtifact(encoded.header, encoded.rows))).toEqual(current)
  return current.events.find(event => event.type === type)?.data
}

describe('maintained Team historical formats', () => {
  it.each([0, 1])('preserves fixed routes, external identity, native delivery and payload 3 at Session %i', (version) => {
    const routed = { id: 'dsh-worker', name: 'reviewer', description: 'review', provider: 'in-process', context: 'fresh',
      phase: 'active', requestedRoute: { provider: 'mock' },
      resolvedRoute: { provider: 'mock', model: 'review-model', reasoningEffort: 'high' } }
    for (const memberValue of [member, routed]) {
      const data = { version: 2, teamId: 'lead', member: memberValue }
      expect(restore('team/member', data, version)).toEqual(data)
    }
    const delivered = { version: 2, teamId: 'lead', messageId: 'message-1', targetId: 'worker', nativeTurnId: 'turn-2' }
    expect(restore('team/message/delivered', delivered, version)).toEqual(delivered)
    const native = { version: 3, teamId: 'lead', message, receipt }
    expect(restore('team/native-operation/committed', native, version)).toEqual(native)
    const inbound = { role: 'user', id: 'inbound', content: [{ type: 'text', text: 'work' }],
      source: { kind: 'team-message', teamId: 'lead', messageId: 'message-1', senderId: 'worker' } }
    expect(restore('user/message', inbound, version)).toEqual(inbound)
  })

  it.each([
    { name: 'external route', value: { ...member, requestedRoute: { provider: 'other' } } },
    { name: 'missing active handle', value: { ...member, externalRuntime: runtime } },
    { name: 'provisioning handle', value: { ...member, phase: 'provisioning' } },
    { name: 'context mismatch', value: { ...member, context: 'fork' } },
    { name: 'duplicate capabilities', value: { ...member, externalRuntime: { ...member.externalRuntime,
      requirements: { ...runtime.requirements, runtimeCapabilities: ['evidence', 'evidence'] } } } },
    { name: 'unordered capabilities', value: { ...member, externalRuntime: { ...member.externalRuntime,
      requirements: { ...runtime.requirements, runtimeCapabilities: ['usage', 'evidence'] } } } },
    { name: 'missing mission', value: { ...member, externalRuntime: { ...member.externalRuntime,
      requirements: { ...runtime.requirements, profileCapabilities: ['persona'] } } } },
    { name: 'oversized native identity', value: { ...member, externalRuntime: { ...member.externalRuntime,
      nativeHandle: '汉'.repeat(67) } } },
    { name: 'unknown required field', value: { ...member, futureAuthority: true } },
  ])('refuses $name rather than losing retained Team facts', ({ value }) => {
    expect(() => restore('team/member', { version: 2, teamId: 'lead', member: value })).toThrow()
  })

  it('refuses an oversized native task request and mixed payload generations', () => {
    const task = { id: 'task-1', revision: 2, subject: 'work', description: 'work', status: 'pending', blockedBy: [], writeScopes: [] }
    expect(() => restore('team/native-operation/committed', { version: 4, kind: 'task', teamId: 'lead', task,
      receipt: { ...receipt, source: { kind: 'tool', turnId: 'turn-1', callId: 'call-1' },
        request: { operation: 'tasks.update', taskId: 'x'.repeat(129), expectedRevision: 1, action: 'claim' },
        result: { ok: true, operation: 'tasks.update', value: { task: { id: 'task-1', revision: 2, status: 'pending', ready: true } } } } }))
      .toThrow(/taskId exceeds 128/)
    expect(() => restore('team/native-operation/committed', { version: 3, kind: 'message', teamId: 'lead', message, receipt }))
      .toThrow(/unexpected member/)
    expect(() => restore('team/message/delivered', { version: 1, teamId: 'lead', messageId: 'message-1', targetId: 'worker', nativeTurnId: 'turn-2' }))
      .toThrow(/version must be one of 2/)
  })
})
