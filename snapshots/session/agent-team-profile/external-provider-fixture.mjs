/** Deterministic native provider and operation consumer for the shipped Agent Teams profile snapshot. */

// Scenario imports follow the same source or built mode as the CLI launcher.
const { TeammateLaunchRequestId, TeammateRuntimeHandle, TeammateRuntimeTurnId, TeammateRuntimeToolCallId } = process.env.DSH_EXAMPLE_MODE === 'lib'
  ? await import('../../../packages/experimental/agent-team/lib/index.js')
  : await import('@deepseek-ai/dsh-experimental-agent-team')
const { defineTool } = process.env.DSH_EXAMPLE_MODE === 'lib'
  ? await import('../../../packages/core/tools/lib/index.js')
  : await import('@deepseek-ai/dsh-tools')

export const name = 'agent-team-external-snapshot-fixture'
export const inject = ['agentTeams', 'tools']

const NATIVE_HANDLE = TeammateRuntimeHandle('snapshot-native-runtime-1')
const INITIAL_TURN = TeammateRuntimeTurnId('snapshot-initial-turn')

/**
 * Register the native fixture and model triggers for real Team launch, queries, messages and final results.
 * @param {import('@deepseek-ai/cordis').Context} ctx - owning Loader context.
 */
export function apply(ctx) {
  /** @type {import('@deepseek-ai/dsh-experimental-agent-team').NativeMemberGrant | undefined} */
  let memberGrant
  /** @type {import('@deepseek-ai/dsh-experimental-agent-team').TeammateRuntimeProvider} */
  const provider = {
    id: 'snapshot-native',
    displayName: 'Snapshot Native',
    contextModes: ['fresh'],
    profileCapabilities: ['persona', 'mission'],
    runtimeCapabilities: [],
    memberOperations: ['members.list', 'tasks.list', 'tasks.get', 'messages.send'],
    bindMemberOperations(request) {
      if (request.nativeHandle !== NATIVE_HANDLE) throw new Error('native fixture received another handle')
      memberGrant = request.grant
    },
    async create() {
      return { nativeHandle: NATIVE_HANDLE, presence: 'idle', turnId: INITIAL_TURN }
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
    async dispose() { memberGrant = undefined },
  }

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
      return { name: result.member.name, status: /** @type {'idle'} */ ('idle') }
    },
  }))
  ctx.tools.register({
    name: 'query_external_teammate',
    description: 'Ask the native fixture to query its Team using its Host-issued member grant.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        operation: { type: 'string', enum: ['members.list', 'tasks.list', 'tasks.get'] },
        limit: { type: 'integer' },
        cursor: { type: 'string' },
        taskId: { type: 'string' },
      },
      required: ['operation'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: { ok: { type: 'boolean' } },
        required: ['ok'],
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args, exec) {
      if (memberGrant === undefined) throw new Error('native fixture has no member grant')
      return await memberGrant.execute(args, exec.signal)
    },
  })

  for (const operation of ['messages.send', 'turns.settle']) {
    ctx.tools.register(defineTool({
      name: operation === 'messages.send' ? 'report_external_teammate' : 'finish_external_teammate',
      description: operation === 'messages.send'
        ? 'Ask the native fixture to report its progress to the Team Lead.'
        : 'Ask the native fixture to return its completed review to the Team Lead.',
      parameters: {},
      output: {
        schema: { type: 'object', additionalProperties: false,
          properties: { accepted: { type: 'boolean', required: true } } },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
      },
      async execute(_args, exec) {
        if (memberGrant === undefined) throw new Error('native fixture has no member grant')
        const input = operation === 'messages.send'
          ? { operation, target: 'lead', text: 'I am reviewing the shared source.' }
          : { operation, outcome: 'completed', text: 'The review found no issues in the shared source.' }
        /** @type {import('@deepseek-ai/dsh-experimental-agent-team').NativeMemberOperationSource} */
        const source = operation === 'messages.send'
          ? { kind: 'tool', turnId: INITIAL_TURN, callId: TeammateRuntimeToolCallId('snapshot-progress-call') }
          : { kind: 'settlement', turnId: INITIAL_TURN }
        const receipt = await memberGrant.execute(input, exec.signal, source)
        if (!receipt.ok) throw new Error(receipt.error.code)
        const replay = await memberGrant.execute(input, exec.signal, source)
        if (JSON.stringify(replay) !== JSON.stringify(receipt)) throw new Error('native replay changed its accepted result')
        return { accepted: true }
      },
    }))
  }
}
