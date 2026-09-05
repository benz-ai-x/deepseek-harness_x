/** Deterministic external product; the composed Team owner grants its actual member access. */
import { Service, type Context } from '@deepseek-ai/cordis'
import { TeammateRuntimeHandle, type NativeMemberGrant } from '@deepseek-ai/dsh-experimental-agent-team'

declare module '@deepseek-ai/cordis' {
  interface Context {
    nativeQueryFixture: NativeProduct
  }
}

export default class NativeProduct extends Service {
  static inject = ['agentTeams']
  grant: NativeMemberGrant | undefined

  constructor(ctx: Context) {
    super(ctx, 'nativeQueryFixture')
    ctx.agentTeams.registerTeammateRuntimeProvider({
      id: 'native-query', displayName: 'Native query fixture', contextModes: ['fresh'],
      profileCapabilities: ['persona', 'mission'], runtimeCapabilities: [],
      memberOperations: ['members.list', 'tasks.list', 'tasks.get'],
      async create() { return { nativeHandle: TeammateRuntimeHandle('native-loader-handle'), presence: 'idle' } },
      async resume() { return { nativeHandle: TeammateRuntimeHandle('native-loader-handle'), presence: 'idle' } },
      bindMemberOperations: ({ grant }) => { this.grant = grant },
      async deliver() { throw new Error('the native query fixture does not accept deliveries') },
      interrupt() { return { previousStatus: 'idle' } },
      async dispose() {},
    })
  }
}
