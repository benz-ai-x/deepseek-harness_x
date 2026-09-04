/** Record one external Team member through the real SDK session event path. */

import { defineTool } from '@deepseek-ai/dsh-tools'

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
      return { name: 'external-worker', nativeHandle }
    },
  }))
}
