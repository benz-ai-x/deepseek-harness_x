import { Service, type Context } from '@deepseek-ai/cordis'
import type { TeammateRuntimeProvider } from '@deepseek-ai/dsh-experimental-agent-team'

interface CatalogOwnerStats {
  registrations: number
  disposals: number
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    claudeCodeCatalogOwner: CatalogOwnerFixture
  }
}

export default class CatalogOwnerFixture extends Service {
  static inject = ['agentTeams']

  readonly stats: CatalogOwnerStats = { registrations: 0, disposals: 0 }

  constructor(ctx: Context) {
    super(ctx, 'claudeCodeCatalogOwner')
  }

  registerExternalRuntimeProvider(provider: TeammateRuntimeProvider): () => Promise<void> {
    this.stats.registrations += 1
    const registration = this.ctx.agentTeams.registerTeammateRuntimeProvider(provider)
    return async (): Promise<void> => {
      this.stats.disposals += 1
      await registration()
    }
  }
}
