/** Source-safe Agent Teams browser registration and Remote mount lifecycle. */

import type {
  TeamMemberView as TeamRosterMember,
  TeamView,
  TeamWatchFrame,
} from '@deepseek-ai/dsh-experimental-agent-team/client'
import type {} from '@deepseek-ai/dsh-experimental-agent-team/remote'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import { RemoteSnapshotStream, RemoteStreamCarrierError } from '@deepseek-ai/dsh-api-gateway/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { TypertRemoteContribution } from '@deepseek-ai/dsh-typert-protocol'
import { resolveSlotLabel } from '@deepseek-ai/dsh-client-ui-slots'
import {
  TeamAction, type TeamActionInjected, type TeamActionResult, type TeamPanelView,
  type TeamActionWatchSink, type TeamTaskActionResult,
} from './TeamAction.tsx'
import { en, NS, zh, type TeamKey } from './locales.ts'
import { AgentTeamPanelNavigationService } from './navigation.ts'
import { createTeamWatchOwner, type TeamWatchControl } from './watch-owner.ts'

/** Values the Team panel owner passes to every public child view. */
export interface AgentTeamPanelViewOwnerProps {
  /** Exact Team Lead Session whose independently authorized state the child reads. */
  readonly teamSessionId: SessionId
  /** Exact Team member requested by cross-plugin navigation, when one was addressed. */
  readonly selectedMemberId?: SessionId
  /** Monotonic navigation request revision; a matching child consumes each revision once. */
  readonly navigationRevision?: number
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Agent Teams roster and task-board copy. */
    'agent-team': TeamKey
  }

  interface SlotMap {
    /** Public views composed inside the single Agent Teams owner panel. */
    'agent-team.panel.view': {
      kind: 'list'
      scope: 'session'
      owner: AgentTeamPanelViewOwnerProps
    }
  }
}

/** Required browser services for RPC, navigation, slots, and localized copy. */
export const inject = ['sessions', 'remote', 'slots', 'locale']

function registerUi(ctx: ClientContext): void {
  const watchOwner = createTeamWatchOwner()
  ctx.effect(
    () => async () => { await watchOwner.dispose() },
    'client-ui-agent-team: watch controls',
  )
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'client-ui-agent-team: dictionaries')
  const panelNavigation = new AgentTeamPanelNavigationService(ctx)
  const sessions = ctx.sessions
  const leadSessionId = (sessionId: SessionId): SessionId => {
    const address = sessions.binding(sessionId)?.session.getSnapshot().subagent?.address
    return address?.parentSessionId ?? sessionId
  }

  let panelViewSnapshot: readonly TeamPanelView[] = []
  const panelViewListeners = new Set<() => void>()
  const panelViews: TeamActionInjected['hooks']['panelViews'] = {
    getSnapshot: () => panelViewSnapshot,
    subscribe: (listener) => {
      panelViewListeners.add(listener)
      return () => { panelViewListeners.delete(listener) }
    },
  }
  const refreshPanelViews = (): void => {
    const next = ctx.slots.entries('agent-team.panel.view').flatMap((entry) => {
      const id = entry.options.id
      if (id === undefined) return []
      return [{ id, label: resolveSlotLabel(entry.options.label) ?? id }]
    })
    const unchanged = panelViewSnapshot.length === next.length
      && panelViewSnapshot.every((entry, index) => {
        const candidate = next[index]
        return candidate !== undefined && candidate.id === entry.id && candidate.label === entry.label
      })
    if (unchanged) return
    panelViewSnapshot = next
    for (const listener of panelViewListeners) listener()
  }

  const actions: TeamActionInjected = {
    hooks: { panelViews, panelNavigation: panelNavigation.observable },
    consumePanelNavigation: (revision) => { panelNavigation.consume(revision) },
    resolveTeamSessionId: leadSessionId,
    async load(sessionId): Promise<TeamActionResult<TeamView>> {
      return await ctx.remote.agentTeams.view(leadSessionId(sessionId))
    },
    async getTask(sessionId, taskId) {
      return await ctx.remote.agentTeams.getTask(leadSessionId(sessionId), taskId)
    },
    watch(sessionId, sink) {
      return watchOwner.own(createTeamActionWatch(ctx, leadSessionId(sessionId), sink))
    },
    async createTask(sessionId, input): Promise<TeamTaskActionResult> {
      return await ctx.remote.agentTeams.createTask(leadSessionId(sessionId), input)
    },
    async updateTask(sessionId, input) {
      const { owner, ...rest } = input
      return await ctx.remote.agentTeams.updateTask(leadSessionId(sessionId), {
        ...rest,
        ...owner === undefined ? {} : { owner },
      })
    },
    async openTeammate(sessionId: SessionId, member: TeamRosterMember): Promise<void> {
      if (member.role !== 'teammate') return
      const parentSessionId = leadSessionId(sessionId)
      await sessions.refreshSubagents(parentSessionId)
      if (sessions.list.getSnapshot().current !== sessionId) return
      sessions.openSubagent({
        parentSessionId,
        childSessionId: member.id,
        mode: 'continuable',
      })
    },
  }

  ctx.slots.inject(
    'conversation.session.header.actions',
    () => ctx.slots.register({
      name: 'conversation.session.header.actions',
      id: 'agent-team',
      order: 20,
      locale: NS,
      children: {
        'agent-team.panel.view': { kind: 'list', scope: 'session' },
      },
      inject: () => actions,
    }, TeamAction),
  )
  ctx.effect(() => {
    const disposeSlots = ctx.slots.subscribe('agent-team.panel.view', refreshPanelViews)
    const disposeLocale = ctx.locale.subscribe(refreshPanelViews)
    refreshPanelViews()
    return () => {
      disposeLocale()
      disposeSlots()
      panelViewSnapshot = []
      for (const listener of panelViewListeners) listener()
      panelViewListeners.clear()
    }
  }, 'client-ui-agent-team: panel views')
}

type TeamWatchBaselineFrame = Extract<TeamWatchFrame, { readonly type: 'baseline' }>
type TeamWatchInvalidationFrame = Exclude<TeamWatchFrame, TeamWatchBaselineFrame>

/**
 * Bind one logical Team generation stream to its public panel sink.
 * @param ctx - Client Context providing the generated Remote stream carrier.
 * @param sessionId - exact live Lead Session selecting the watched Team.
 * @param sink - generation-fenced public panel destinations.
 * @returns reconnecting stream control owned by the panel lifecycle.
 */
export function createTeamActionWatch(
  ctx: ClientContext,
  sessionId: SessionId,
  sink: TeamActionWatchSink,
): TeamWatchControl {
  const stream = ctx.remote.$stream<TeamWatchFrame>({
    name: 'Agent Teams change stream',
    open: signal => ctx.remote.agentTeams.watch(sessionId, signal),
    ended: accepted => accepted
      ? new RemoteStreamCarrierError('Agent Teams change stream ended after its opening baseline')
      : new Error('Agent Teams change stream ended before its opening baseline'),
    carrierFailed: () => { sink.stale() },
  })
  return new RemoteSnapshotStream<TeamWatchBaselineFrame, TeamWatchInvalidationFrame>(stream, {
    name: 'Agent Teams change stream',
    isSnapshot: (frame): frame is TeamWatchBaselineFrame => frame.type === 'baseline',
    replace: (frame) => { sink.replace(frame.value) },
    update: () => { sink.invalidated() },
    failed: (error) => { sink.failed(error) },
  })
}

/**
 * Mount one generated Team Remote contribution, then register its browser UI.
 * @param ctx - Client Context carrying navigation, locale, slot, and Remote services.
 * @param contribution - generated Team descriptors selected by the browser entry.
 * @returns disposer for both the UI registrations and Remote namespace.
 */
export async function mountAgentTeamUi(
  ctx: ClientContext,
  contribution: TypertRemoteContribution,
): Promise<() => Promise<void>> {
  const disposeRemote = await ctx.remote.$mount(contribution)
  const ui = ctx.inject(['sessions', 'remote.agentTeams', 'slots', 'locale'], registerUi)
  try {
    await ui
  } catch (error) {
    await ui.dispose()
    await disposeRemote()
    throw error
  }
  return async () => {
    await ui.dispose()
    await disposeRemote()
  }
}
