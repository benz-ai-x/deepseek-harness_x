/** Record one external Team member through the real SDK session event path. */

const { defineTool } = process.env.DSH_EXAMPLE_MODE === 'lib'
  ? await import('../../../packages/core/tools/lib/index.js')
  : await import('@deepseek-ai/dsh-tools')

export const name = 'agent-team-sdk-event-fixture'
export const inject = ['tools']

/** Register one deterministic event producer used only by the SDK snapshot. */
export function apply(ctx) {
  ctx.tools.register(defineTool({
    name: 'record_external_team_member',
    description: 'Record one deterministic external Team member event for SDK projection testing.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          name: { type: 'string', required: true },
          nativeHandle: { type: 'string', required: true },
        },
      },
      render(_args, value) {
        return [{ type: 'text', text: JSON.stringify(value) }]
      },
    },
    async execute(_args, exec) {
      if (exec.agent === undefined) throw new Error('SDK Team event fixture requires an Agent')
      const nativeHandle = 'snapshot-native-runtime-1'
      const member = {
        id: 'snapshot-external-member-1',
        name: 'external-worker',
        description: 'SDK external event worker',
        provider: 'snapshot-native',
        context: 'fresh',
        externalRuntime: {
          kind: 'external-agent',
          launchRequestId: 'snapshot-native-launch-1',
          requestFingerprint: '23141189f1aad9c1b1dd243a9a2d5ddf08904f600d68a50914dca0adb325b68e',
          requirements: {
            contextMode: 'fresh',
            profileCapabilities: ['persona', 'mission'],
            runtimeCapabilities: [],
          },
        },
        phase: 'provisioning',
      }
      exec.agent.session.append('team/member', {
        version: 2,
        teamId: exec.agent.id,
        member,
      })
      exec.agent.session.append('team/member', {
        version: 2,
        teamId: exec.agent.id,
        member: {
          ...member,
          externalRuntime: {
            ...member.externalRuntime,
            nativeHandle,
          },
          phase: 'active',
        },
      })
      const { createHash } = await import('node:crypto')
      const messageId = 'snapshot-native-message-1'
      const source = { kind: 'tool', turnId: 'snapshot-native-turn-1', callId: 'snapshot-native-call-1' }
      const text = 'The native review is ready.'
      exec.agent.session.append('team/native-operation/committed', {
        version: 4, kind: 'message',
        teamId: exec.agent.id,
        message: {
          id: messageId, senderId: 'snapshot-external-member-1', senderName: 'external-worker',
          targetId: exec.agent.id, content: [{ type: 'text', text }]
        },
        receipt: {
          id: createHash('sha256').update(JSON.stringify([
            exec.agent.id, 'snapshot-external-member-1', 'snapshot-native', nativeHandle,
            source.kind, source.turnId, source.callId
          ])).digest('hex'),
          memberId: 'snapshot-external-member-1', provider: 'snapshot-native', nativeHandle, source,
          inputFingerprint: createHash('sha256').update(JSON.stringify({
            operation: 'messages.send', target: 'lead', text
          })).digest('hex'),
          result: { ok: true, operation: 'messages.send', value: { messageId, status: 'queued' } }
        }
      })
      const requestId = 'snapshot-human-request-1'
      const humanMessageId = 'snapshot-human-message-1'
      const humanText = 'Please apply the review.'
      exec.agent.session.append('team/message/request-committed', {
        version: 1,
        teamId: exec.agent.id,
        message: {
          id: humanMessageId,
          senderId: exec.agent.id,
          senderName: 'lead',
          targetId: member.id,
          content: [{ type: 'text', text: humanText }]
        },
        receipt: {
          requestId,
          senderId: exec.agent.id,
          inputFingerprint: createHash('sha256').update(JSON.stringify({
            recipientId: member.id,
            text: humanText,
            replyTo: messageId
          })).digest('hex'),
          replyTo: messageId,
          result: { requestId, messageId: humanMessageId, status: 'accepted' }
        }
      })
      const task = { id: 'snapshot-native-task-1', revision: 1, subject: 'Review', description: 'Review shared tasks.',
        status: 'pending', blockedBy: [], writeScopes: [] }
      exec.agent.session.append('team/task', { version: 2, teamId: exec.agent.id, task })
      const taskSource = { kind: 'tool', turnId: source.turnId, callId: 'snapshot-native-task-call' }
      exec.agent.session.append('team/native-operation/committed', {
        version: 4, kind: 'task', teamId: exec.agent.id,
        task: { ...task, revision: 2, status: 'in_progress', ownerId: 'snapshot-external-member-1' },
        receipt: {
          id: createHash('sha256').update(JSON.stringify([exec.agent.id, 'snapshot-external-member-1',
            'snapshot-native', nativeHandle, taskSource.kind, taskSource.turnId, taskSource.callId])).digest('hex'),
          memberId: 'snapshot-external-member-1', provider: 'snapshot-native', nativeHandle, source: taskSource,
          inputFingerprint: '37f10bbd831910445a3d66a5905feaf37775f74e0497fc8496bf3f0c47778e61',
          request: { operation: 'tasks.update', taskId: task.id, expectedRevision: 1, action: 'claim' },
          result: { ok: true, operation: 'tasks.update', value: { task: {
            id: task.id, revision: 2, status: 'in_progress', ownerName: 'external-worker', ready: false
          } } }
        }
      })
      return { name: 'external-worker', nativeHandle }
    },
  }))
}
