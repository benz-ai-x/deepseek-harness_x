import { Service, type Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'

/** One public request to open a child of the single Agent Team panel. */
export interface AgentTeamPanelNavigationRequest {
  readonly teamSessionId: SessionId
  readonly viewId: string
  readonly memberId?: SessionId
}

/** One retained, single-consumer navigation request. */
export interface AgentTeamPanelNavigationSnapshot extends AgentTeamPanelNavigationRequest {
  readonly revision: number
}

/** Cross-plugin Client navigation into the public Agent Team panel. */
export interface AgentTeamPanelNavigation {
  /**
   * Open one registered child view, optionally addressed to a Team member.
   * @param request - exact Team, public child view, and optional member.
   */
  open(request: AgentTeamPanelNavigationRequest): void
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Public navigation into the single Agent Team-owned panel. */
    agentTeamPanelNavigation: AgentTeamPanelNavigation
  }
}

/** Fiber-owned, retained-until-consumed navigation exchange. */
export class AgentTeamPanelNavigationService extends Service implements AgentTeamPanelNavigation {
  private revision = 0
  private snapshot: AgentTeamPanelNavigationSnapshot | null = null
  private readonly listeners = new Set<() => void>()

  /** Retained request observed by the owning Team panel component. */
  readonly observable: HostObservable<AgentTeamPanelNavigationSnapshot | null> = {
    getSnapshot: () => this.snapshot,
    subscribe: (listener) => {
      this.listeners.add(listener)
      return () => { this.listeners.delete(listener) }
    },
  }

  constructor(ctx: Context) {
    super(ctx, 'agentTeamPanelNavigation')
    ctx.effect(() => () => {
      this.snapshot = null
      this.listeners.clear()
    }, 'client-ui-agent-team: panel navigation')
  }

  open(request: AgentTeamPanelNavigationRequest): void {
    if (request.viewId.length === 0) throw new Error('Agent Team panel view id must not be empty')
    this.snapshot = Object.freeze({
      ...request,
      revision: ++this.revision,
    })
    this.emit()
  }

  /**
   * Clear only the exact request accepted by the current panel generation.
   * @param revision - revision accepted by the matching Team panel.
   */
  consume(revision: number): void {
    if (this.snapshot?.revision !== revision) return
    this.snapshot = null
    this.emit()
  }

  private emit(): void {
    for (const listener of this.listeners) {
      try {
        listener()
      } catch (error: unknown) {
        const diagnostic = error instanceof Error ? error.message : String(error)
        this.ctx.logger.warn(`Agent Team panel navigation subscriber failed: ${diagnostic}`)
      }
    }
  }
}
