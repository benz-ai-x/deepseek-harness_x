/** Deterministic external teammate provider and launch tool for the Agent Teams product snapshot. */

import type { Context } from '@deepseek-ai/cordis'
import {
  TeammateLaunchRequestId,
  TeammateRuntimeHandle,
  TeammateRuntimeTurnId,
  type TeammateRuntimeProvider,
} from '@deepseek-ai/dsh-experimental-agent-team'
import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'agent-team-external-snapshot-fixture'
export const inject = ['agentTeams', 'tools']

const NATIVE_HANDLE = TeammateRuntimeHandle('snapshot-native-runtime-1')

const provider: TeammateRuntimeProvider = {
  id: 'snapshot-native',
  displayName: 'Snapshot Native',
  contextModes: ['fresh'],
  profileCapabilities: ['persona', 'mission'],
  runtimeCapabilities: [],
  async create() {
    return { nativeHandle: NATIVE_HANDLE, presence: 'idle' }
  },
  async resume(request) {
    return request.nativeHandle === undefined
      ? undefined
      : { nativeHandle: request.nativeHandle, presence: 'idle' }
  },
  async deliver(request) {
    return {
      turnId: TeammateRuntimeTurnId(`snapshot-turn-${request.deliveryId}`),
      presence: 'idle',
    }
  },
  interrupt() {
    return { previousStatus: 'idle' }
  },
  async dispose() {},
}

/** Register the fake native provider and one snapshot-only launch trigger. */
export function apply(ctx: Context): void {
  ctx.agentTeams.registerTeammateRuntimeProvider(provider)
  ctx.tools.register(defineTool({
    name: 'provision_external_teammate',
    description: 'Snapshot-only trigger that provisions one deterministic external teammate.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          name: { type: 'string', required: true },
          status: { type: 'string', required: true, enum: ['idle'] },
        },
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(_args, exec) {
      if (exec.agent === undefined) throw new Error('snapshot external launch requires an Agent')
      const result = await ctx.agentTeams.spawnTeammate(exec.agent, {
        name: 'external-worker',
        description: 'Deterministic native snapshot worker',
        prompt: [{ type: 'text', text: 'Retain this initial external work.' }],
        context: 'fresh',
        signal: exec.signal,
        runtime: {
          kind: 'external-agent',
          provider: provider.id,
          launchRequestId: TeammateLaunchRequestId('snapshot-native-launch-1'),
          profile: {
            persona: 'You are the deterministic snapshot worker.',
            mission: 'Retain the accepted initial work.',
            context: [],
            memory: [],
            toolPolicy: { mode: 'inherit', names: [] },
            hooks: [],
          },
          requirements: {
            contextMode: 'fresh',
            profileCapabilities: ['persona', 'mission'],
            runtimeCapabilities: [],
          },
        },
      })
      return { name: result.member.name, status: 'idle' as const }
    },
  }))
}
