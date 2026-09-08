import {
  useCallback, useEffect, useMemo, useRef, useState,
  type ChangeEvent, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type {
  TeamMemberView as TeamRosterMember,
  TeamTaskAction,
  TeamTaskId,
  TeamTaskMutationResult,
  TeamTaskView as TeamTask,
  TeamView,
} from '@deepseek-ai/dsh-experimental-agent-team/client'
import type { RemoteResult } from '@deepseek-ai/dsh-api-remotes/client'
import {
  IconCheckOutline14, IconCloseOutline16, IconEditOutline16, IconPlusOutline16,
  IconRefreshOutline14, IconTrashOutline16, IconUserOutline16, StateDot,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type {
  HostObservable, InjectFace, PropsLocale, PropsRenderSlots, PropsRuntime,
} from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { NS, type TeamKey } from './locales.ts'
import css from './TeamAction.module.css'

/** Generated Remote result consumed directly by the Team UI. */
export type TeamActionResult<T> = RemoteResult<T>

/** Generated Remote result whose business value preserves Team task rejections. */
export type TeamTaskActionResult = RemoteResult<TeamTaskMutationResult>

/** Generation-fenced Team watch destinations owned by one mounted panel. */
export interface TeamActionWatchSink {
  replace(value: TeamView): void
  invalidated(): void
  stale(): void
  failed(error: unknown): void
}

/** Minimal lifecycle exposed by the reconnecting Team stream. */
export interface TeamActionWatchControl {
  start(): void
  dispose(): Promise<void>
}

/** Business actions injected by the browser plugin. */
export interface TeamActionInjected {
  readonly hooks: {
    readonly panelViews: HostObservable<readonly TeamPanelView[]>
  }
  resolveTeamSessionId: (sessionId: SessionId) => SessionId
  load: (sessionId: SessionId) => Promise<TeamActionResult<TeamView>>
  getTask: (sessionId: SessionId, taskId: TeamTaskId) => Promise<TeamActionResult<TeamTask>>
  watch: (sessionId: SessionId, sink: TeamActionWatchSink) => TeamActionWatchControl
  createTask: (sessionId: SessionId, input: {
    subject: string
    description: string
    blockedBy: TeamTaskId[]
    writeScopes: string[]
  }) => Promise<TeamTaskActionResult>
  updateTask: (sessionId: SessionId, input: {
    taskId: TeamTaskId
    expectedRevision: number
    action: TeamTaskAction
    subject?: string
    description?: string
    blockedBy?: TeamTaskId[]
    writeScopes?: string[]
    owner?: string
  }) => Promise<TeamTaskActionResult>
  openTeammate: (sessionId: SessionId, member: TeamRosterMember) => Promise<void>
}

/** Navigation metadata for one public Team panel child view. */
export interface TeamPanelView {
  readonly id: string
  readonly label: string
}

/** Full props of the Team conversation-header action. */
export type TeamActionProps =
  PropsRuntime<'conversation.session.header.actions'> & PropsRenderSlots<'agent-team.panel.view'>
  & InjectFace<TeamActionInjected> & PropsLocale<typeof NS>

interface Draft {
  subject: string
  description: string
  blockers: string
  scopes: string
}

const EMPTY_DRAFT: Draft = { subject: '', description: '', blockers: '', scopes: '' }

const GRAPH_NODE_WIDTH = 144
const GRAPH_NODE_HEIGHT = 104
const GRAPH_COLUMN_GAP = 64
const GRAPH_ROW_GAP = 32
const GRAPH_PADDING = 20

interface TaskGraphNode {
  readonly task: TeamTask
  readonly column: number
  readonly row: number
  readonly x: number
  readonly y: number
}

interface TaskGraphLayout {
  readonly nodes: readonly TaskGraphNode[]
  readonly byId: ReadonlyMap<TeamTaskId, TaskGraphNode>
  readonly width: number
  readonly height: number
}

interface GraphTransform {
  readonly x: number
  readonly y: number
  readonly scale: number
}

type TeamWatchPhase = 'connecting' | 'connected' | 'stale' | 'disconnected' | 'unavailable'

const DEFAULT_GRAPH_TRANSFORM: GraphTransform = { x: 0, y: 0, scale: 1 }

/** Deterministically place prerequisites before dependents without a graph dependency. */
function taskGraphLayout(tasks: readonly TeamTask[]): TaskGraphLayout {
  const byTaskId = new Map(tasks.map(task => [task.id, task]))
  const depth = new Map<TeamTaskId, number>()
  const visiting = new Set<TeamTaskId>()
  const taskDepth = (id: TeamTaskId): number => {
    const prior = depth.get(id)
    if (prior !== undefined) return prior
    /* The Host rejects cycles; keep malformed carrier data bounded instead of recursing forever. */
    if (visiting.has(id)) return 0
    visiting.add(id)
    const task = byTaskId.get(id)
    const value = task === undefined || task.blockedBy.length === 0
      ? 0
      : Math.max(0, ...task.blockedBy.map(blocker => taskDepth(blocker) + 1))
    visiting.delete(id)
    depth.set(id, value)
    return value
  }
  const rows = new Map<number, number>()
  const nodes = tasks.map((task) => {
    const column = taskDepth(task.id)
    const row = rows.get(column) ?? 0
    rows.set(column, row + 1)
    return {
      task,
      column,
      row,
      x: GRAPH_PADDING + column * (GRAPH_NODE_WIDTH + GRAPH_COLUMN_GAP),
      y: GRAPH_PADDING + row * (GRAPH_NODE_HEIGHT + GRAPH_ROW_GAP),
    }
  })
  const maxColumn = Math.max(0, ...nodes.map(node => node.column))
  const maxRows = Math.max(1, ...rows.values())
  return {
    nodes,
    byId: new Map(nodes.map(node => [node.task.id, node])),
    width: GRAPH_PADDING * 2 + (maxColumn + 1) * GRAPH_NODE_WIDTH + maxColumn * GRAPH_COLUMN_GAP,
    height: GRAPH_PADDING * 2 + maxRows * GRAPH_NODE_HEIGHT + (maxRows - 1) * GRAPH_ROW_GAP,
  }
}

function items(value: string): string[] {
  return [...new Set(value.split(',').map(item => item.trim()).filter(Boolean))]
}

function taskIds(value: string): TeamTaskId[] {
  return items(value) as TeamTaskId[]
}

/**
 * One failure line for either carrier: a Remote failure, or a Team business
 * rejection whose codes stay local to this seam and never ride the wire.
 */
function failureText(error: { readonly code: string; readonly message: string }): string {
  return `${error.message} (${error.code})`
}

function statusKey(status: TeamTask['status']): TeamKey {
  switch (status) {
    case 'pending': return 'status.pending'
    case 'in_progress': return 'status.in_progress'
    case 'completed': return 'status.completed'
    case 'deleted': return 'status.deleted'
  }
}

function memberStatusKey(status: TeamRosterMember['status']): TeamKey {
  switch (status) {
    case 'running': return 'memberStatus.running'
    case 'idle': return 'memberStatus.idle'
    case 'inactive': return 'memberStatus.inactive'
    case 'provisioning': return 'memberStatus.provisioning'
    case 'failed': return 'memberStatus.failed'
  }
}

/** Render the live Team roster and compare-and-set task board. */
export function TeamAction({
  sessionId, load, getTask, watch, createTask, updateTask, openTeammate, usePanelViews,
  resolveTeamSessionId, renderSlot, t,
}: TeamActionProps) {
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [view, setView] = useState<TeamView | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [createDraft, setCreateDraft] = useState<Draft>(EMPTY_DRAFT)
  const [editing, setEditing] = useState<string | null>(null)
  const [editBase, setEditBase] = useState<Readonly<{ taskId: TeamTaskId; revision: number }> | null>(null)
  const [editDraft, setEditDraft] = useState<Draft>(EMPTY_DRAFT)
  const [pendingTasks, setPendingTasks] = useState<ReadonlySet<string>>(() => new Set())
  const [activeView, setActiveView] = useState('overview')
  const [taskViewMode, setTaskViewMode] = useState<'list' | 'graph'>('list')
  const [selectedTaskId, setSelectedTaskId] = useState<TeamTaskId | null>(null)
  const [selectedTaskDetail, setSelectedTaskDetail] = useState<TeamTask | null>(null)
  const [taskFilter, setTaskFilter] = useState('')
  const [graphTransform, setGraphTransform] = useState<GraphTransform>(DEFAULT_GRAPH_TRANSFORM)
  const [watchPhase, setWatchPhase] = useState<TeamWatchPhase>('connecting')
  const childViews = usePanelViews(views => views)
  const sessionRef = useRef(sessionId)
  const viewRef = useRef<TeamView | null>(null)
  const conflictDraftRef = useRef<string | null>(null)
  const refreshGeneration = useRef(0)
  const refreshInFlightRef = useRef<Promise<boolean> | null>(null)
  const refreshQueueRef = useRef<Array<{
    resolve(value: boolean): void
    reject(error: unknown): void
  }>>([])
  const watchGeneration = useRef(0)
  const detailGeneration = useRef(0)
  const graphViewportRef = useRef<HTMLDivElement>(null)
  const graphNodeRefs = useRef(new Map<TeamTaskId, HTMLButtonElement>())
  const graphDragRef = useRef<{
    pointerId: number
    clientX: number
    clientY: number
    originX: number
    originY: number
  } | null>(null)
  sessionRef.current = sessionId

  useEffect(() => {
    refreshGeneration.current += 1
    refreshInFlightRef.current = null
    refreshQueueRef.current.splice(0).forEach((waiter) => { waiter.resolve(false) })
    watchGeneration.current += 1
    detailGeneration.current += 1
    viewRef.current = null
    conflictDraftRef.current = null
    setOpen(false)
    setLoading(false)
    setView(null)
    setError(null)
    setCreating(false)
    setCreateDraft(EMPTY_DRAFT)
    setEditing(null)
    setEditBase(null)
    setEditDraft(EMPTY_DRAFT)
    setPendingTasks(new Set())
    setActiveView('overview')
    setTaskViewMode('list')
    setSelectedTaskId(null)
    setSelectedTaskDetail(null)
    setTaskFilter('')
    setGraphTransform(DEFAULT_GRAPH_TRANSFORM)
    setWatchPhase('connecting')
    graphDragRef.current = null
  }, [sessionId])

  useEffect(() => {
    if (activeView !== 'overview' && !childViews.some(view => view.id === activeView)) {
      setActiveView('overview')
    }
  }, [activeView, childViews])

  const replaceView = useCallback((next: TeamView): void => {
    viewRef.current = next
    setView(next)
    setSelectedTaskId(current => current ?? next.tasks[0]?.id ?? null)
  }, [])

  useEffect(() => {
    const selected = view?.tasks.find(task => task.id === selectedTaskId)
    const generation = ++detailGeneration.current
    if (selectedTaskId === null || view === null || selected !== undefined) {
      setSelectedTaskDetail(null)
      return
    }
    const requestedSession = sessionId
    const requestedTaskId = selectedTaskId
    void getTask(requestedSession, requestedTaskId).then((result) => {
      if (sessionRef.current !== requestedSession || detailGeneration.current !== generation) return
      if (result.ok) {
        setSelectedTaskDetail(result.value.id === requestedTaskId ? result.value : null)
      } else {
        setSelectedTaskDetail(null)
        setError(failureText(result.error))
      }
    })
  }, [getTask, selectedTaskId, sessionId, view])

  const refreshOnce = useCallback(async (): Promise<boolean> => {
    const requestedSession = sessionId
    const generation = ++refreshGeneration.current
    setLoading(true)
    const result = await load(requestedSession)
    if (sessionRef.current !== requestedSession || refreshGeneration.current !== generation) return false
    setLoading(false)
    if (result.ok) {
      replaceView(result.value)
      setError(conflictDraftRef.current)
      return true
    } else {
      setError(failureText(result.error))
      return false
    }
  }, [load, replaceView, sessionId])

  const refreshOnceRef = useRef(refreshOnce)
  refreshOnceRef.current = refreshOnce
  const refresh = useCallback((): Promise<boolean> => {
    if (refreshInFlightRef.current !== null) {
      return new Promise<boolean>((resolve, reject) => {
        refreshQueueRef.current.push({ resolve, reject })
      })
    }
    const start = (): Promise<boolean> => {
      const request = refreshOnceRef.current()
      refreshInFlightRef.current = request
      void request.then(() => {
        if (refreshInFlightRef.current !== request) return
        refreshInFlightRef.current = null
        const queued = refreshQueueRef.current.splice(0)
        if (queued.length === 0) return
        const trailing = start()
        void trailing.then(
          (value) => { queued.forEach((waiter) => { waiter.resolve(value) }) },
          (error: unknown) => { queued.forEach((waiter) => { waiter.reject(error) }) },
        )
      }, (error: unknown) => {
        if (refreshInFlightRef.current !== request) return
        refreshInFlightRef.current = null
        const queued = refreshQueueRef.current.splice(0)
        queued.forEach((waiter) => { waiter.reject(error) })
      })
      return request
    }
    return start()
  }, [])

  useEffect(() => {
    if (!open) return
    const requestedSession = sessionId
    const generation = ++watchGeneration.current
    const current = (): boolean => sessionRef.current === requestedSession
      && watchGeneration.current === generation
    setWatchPhase('connecting')
    const control = watch(requestedSession, {
      replace(next) {
        if (!current()) return
        refreshGeneration.current += 1
        setLoading(false)
        replaceView(next)
        setError(conflictDraftRef.current)
        setWatchPhase('connected')
      },
      invalidated() {
        if (current()) void refresh()
      },
      stale() {
        if (current()) setWatchPhase(viewRef.current === null ? 'disconnected' : 'stale')
      },
      failed() {
        if (current()) setWatchPhase('unavailable')
      },
    })
    control.start()
    return () => {
      if (watchGeneration.current === generation) watchGeneration.current += 1
      refreshGeneration.current += 1
      refreshInFlightRef.current = null
      refreshQueueRef.current.splice(0).forEach((waiter) => { waiter.resolve(false) })
      void control.dispose()
    }
  }, [open, refresh, replaceView, sessionId, watch])

  const invalidateRefresh = useCallback((): void => {
    refreshGeneration.current += 1
    setLoading(false)
  }, [])

  const settleTask = useCallback(async (
    taskId: string,
    operation: () => Promise<TeamTaskActionResult>,
    conflictKey: TeamKey = 'conflict',
  ): Promise<TeamTask | undefined> => {
    const requestedSession = sessionId
    invalidateRefresh()
    setPendingTasks(current => new Set(current).add(taskId))
    try {
      const result = await operation()
      if (sessionRef.current !== requestedSession) return undefined
      if (!result.ok) {
        setError(failureText(result.error))
        return undefined
      }
      if (!result.value.ok) {
        if (result.value.error.code === 'team-task-conflict') {
          const conflictMessage = t(conflictKey)
          if (conflictKey === 'conflictDraft') conflictDraftRef.current = conflictMessage
          const reloaded = await refresh()
          if (sessionRef.current !== requestedSession) return undefined
          if (reloaded && conflictKey === 'conflictDraft') {
            const currentTask = viewRef.current?.tasks.find(task => task.id === taskId)
            if (currentTask !== undefined) {
              setEditBase(current => current?.taskId === currentTask.id
                ? { taskId: currentTask.id, revision: currentTask.revision }
                : current)
            }
          }
          if (reloaded) setError(conflictMessage)
        } else {
          setError(failureText(result.value.error))
        }
        return undefined
      }
      const task = result.value.value
      if (conflictKey === 'conflictDraft') conflictDraftRef.current = null
      setError(null)
      await refresh()
      if (sessionRef.current !== requestedSession) return undefined
      return task
    } finally {
      if (sessionRef.current === requestedSession) {
        setPendingTasks((current) => {
          const next = new Set(current)
          next.delete(taskId)
          return next
        })
      }
    }
  }, [invalidateRefresh, refresh, sessionId, t])

  const submitCreate = async (): Promise<void> => {
    const subject = createDraft.subject.trim()
    const description = createDraft.description.trim()
    /* v8 ignore next -- TaskForm disables Save while either normalized field is empty. */
    if (subject === '' || description === '') return
    const created = await settleTask('create', () => createTask(sessionId, {
      subject,
      description,
      blockedBy: taskIds(createDraft.blockers),
      writeScopes: items(createDraft.scopes),
    }))
    if (created === undefined) return
    setCreateDraft(EMPTY_DRAFT)
    setCreating(false)
  }

  const startEdit = (task: TeamTask): void => {
    conflictDraftRef.current = null
    setError(null)
    setEditing(task.id)
    setEditBase({ taskId: task.id, revision: task.revision })
    setEditDraft({
      subject: task.subject,
      description: task.description,
      blockers: task.blockedBy.join(', '),
      scopes: task.writeScopes.join(', '),
    })
  }

  const submitEdit = async (task: TeamTask): Promise<void> => {
    const requestedSession = sessionId
    const edited = await settleTask(task.id, () => updateTask(requestedSession, {
      taskId: task.id,
      expectedRevision: editBase?.taskId === task.id ? editBase.revision : task.revision,
      action: 'edit',
      subject: editDraft.subject.trim(),
      description: editDraft.description.trim(),
      blockedBy: taskIds(editDraft.blockers),
      writeScopes: items(editDraft.scopes),
    }), 'conflictDraft')
    if (edited === undefined) return
    setEditing(null)
    setEditBase(null)
  }

  const teammates = view?.members.filter(member => member.role === 'teammate') ?? []
  const assignable = view?.members.filter(member => member.status !== 'failed' && member.status !== 'provisioning') ?? []
  const selectedTask = view?.tasks.find(task => task.id === selectedTaskId)
    ?? (selectedTaskDetail?.id === selectedTaskId ? selectedTaskDetail : undefined)
  const visibleTasks = useMemo(() => {
    const tasks = view?.tasks ?? []
    const query = taskFilter.trim().toLocaleLowerCase()
    if (query === '') return tasks
    return tasks.filter(task => [
      task.id,
      task.subject,
      task.description,
      task.status,
      task.ownerName ?? '',
    ].some(value => value.toLocaleLowerCase().includes(query)))
  }, [taskFilter, view?.tasks])
  const taskById = useMemo(
    () => new Map((view?.tasks ?? []).map(task => [task.id, task])),
    [view?.tasks],
  )
  const visibleTaskIds = useMemo(() => new Set(visibleTasks.map(task => task.id)), [visibleTasks])
  const graphLayout = useMemo(() => taskGraphLayout(visibleTasks), [visibleTasks])
  const hiddenBlockers = (task: TeamTask): TeamTaskId[] => task.blockedBy.filter(id => !visibleTaskIds.has(id))
  const unfinishedBlockers = (task: TeamTask): TeamTaskId[] => task.blockedBy.filter(
    id => taskById.get(id)?.status !== 'completed',
  )

  const zoomGraph = (change: number): void => {
    setGraphTransform((current) => {
      const minimum = current.scale < 0.5 ? Math.min(0.05, current.scale) : 0.5
      return {
        ...current,
        scale: Math.round(Math.min(2, Math.max(minimum, current.scale + change)) * 100) / 100,
      }
    })
  }

  const fitGraph = (): void => {
    const viewport = graphViewportRef.current
    const width = viewport?.clientWidth === undefined || viewport.clientWidth === 0 ? 480 : viewport.clientWidth
    const height = viewport?.clientHeight === undefined || viewport.clientHeight === 0 ? 260 : viewport.clientHeight
    const scale = Math.min(
      1,
      Math.max(1, width - 16) / graphLayout.width,
      Math.max(1, height - 16) / graphLayout.height,
    )
    setGraphTransform({
      x: Math.round((width - graphLayout.width * scale) / 2),
      y: Math.round((height - graphLayout.height * scale) / 2),
      scale: Math.round(scale * 100) / 100,
    })
  }

  const beginGraphPan = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (event.target instanceof Element && event.target.closest('button') !== null) return
    graphDragRef.current = {
      pointerId: event.pointerId,
      clientX: event.clientX,
      clientY: event.clientY,
      originX: graphTransform.x,
      originY: graphTransform.y,
    }
    const capture = Reflect.get(event.currentTarget, 'setPointerCapture')
    if (typeof capture === 'function') Reflect.apply(capture, event.currentTarget, [event.pointerId])
  }

  const moveGraphPan = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const drag = graphDragRef.current
    if (drag === null || drag.pointerId !== event.pointerId) return
    setGraphTransform(current => ({
      ...current,
      x: Math.round(drag.originX + event.clientX - drag.clientX),
      y: Math.round(drag.originY + event.clientY - drag.clientY),
    }))
  }

  const endGraphPan = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const drag = graphDragRef.current
    if (drag === null || drag.pointerId !== event.pointerId) return
    graphDragRef.current = null
    const release = Reflect.get(event.currentTarget, 'releasePointerCapture')
    if (typeof release === 'function') Reflect.apply(release, event.currentTarget, [event.pointerId])
  }

  const moveGraphSelection = (task: TeamTask, event: ReactKeyboardEvent<HTMLButtonElement>): void => {
    let nextId: TeamTaskId | undefined
    if (event.key === 'ArrowRight') {
      nextId = graphLayout.nodes.find(node => node.task.blockedBy.includes(task.id))?.task.id
    } else if (event.key === 'ArrowLeft') {
      nextId = task.blockedBy[0]
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      const index = graphLayout.nodes.findIndex(node => node.task.id === task.id)
      const change = event.key === 'ArrowDown' ? 1 : -1
      nextId = graphLayout.nodes[index + change]?.task.id
    } else if (event.key === 'Home') {
      nextId = graphLayout.nodes[0]?.task.id
    } else if (event.key === 'End') {
      nextId = graphLayout.nodes.at(-1)?.task.id
    }
    if (nextId === undefined || !graphLayout.byId.has(nextId)) return
    event.preventDefault()
    setSelectedTaskId(nextId)
    graphNodeRefs.current.get(nextId)?.focus()
  }

  return (
    <div className={css.root} data-team-action>
      <button
        type="button"
        className={css.trigger}
        aria-expanded={open}
        onClick={() => {
          const next = !open
          setOpen(next)
          if (next) void refresh()
        }}
      >
        <IconUserOutline16 size={14} />
        <span>{t('trigger')}</span>
        {teammates.length > 0 && <span className={css.count}>{teammates.length}</span>}
      </button>
      {open && (
        <div className={css.panel} role="dialog" aria-label={t('trigger')}>
          <div className={css.toolbar}>
            <strong>{t('trigger')}</strong>
            <span className={css.spacer} />
            <button type="button" className={css.iconButton} aria-label={t('refresh')} onClick={() => { void refresh() }}>
              <IconRefreshOutline14 />
            </button>
            <button type="button" className={css.iconButton} aria-label={t('close')} onClick={() => { setOpen(false) }}>
              <IconCloseOutline16 size={14} />
            </button>
          </div>
          <div className={css.tabs} role="tablist" aria-label={t('navigation')}>
            <button
              type="button"
              role="tab"
              aria-selected={activeView === 'overview'}
              className={activeView === 'overview' ? css.activeTab : css.tab}
              onClick={() => { setActiveView('overview') }}
            >
              {t('overview')}
            </button>
            {childViews.map(child => (
              <button
                key={child.id}
                type="button"
                role="tab"
                aria-selected={activeView === child.id}
                className={activeView === child.id ? css.activeTab : css.tab}
                onClick={() => { setActiveView(child.id) }}
              >
                {child.label}
              </button>
            ))}
          </div>
          {activeView === 'overview' && error !== null && <div className={css.error} role="alert">{error}</div>}
          {activeView === 'overview' && watchPhase === 'stale' && (
            <div className={css.notice} role="status">{t('watchStale')}</div>
          )}
          {activeView === 'overview' && watchPhase === 'disconnected' && (
            <div className={css.notice} role="status">{t('watchDisconnected')}</div>
          )}
          {activeView === 'overview' && watchPhase === 'unavailable' && (
            <div className={css.notice} role="status">{t('watchUnavailable')}</div>
          )}
          {activeView === 'overview' && loading && view === null && <div className={css.notice}>{t('loading')}</div>}
          {activeView === 'overview' && view !== null && (
            <>
              <section>
                <h3>{t('roster')}</h3>
                <div className={css.roster}>
                  {view.members.map(member => (
                    <button
                      key={member.id}
                      type="button"
                      className={css.member}
                      disabled={member.role === 'lead' || member.status === 'failed' || member.status === 'provisioning'}
                      title={member.role === 'teammate' ? t('open') : undefined}
                      onClick={() => {
                        void openTeammate(sessionId, member).catch((reason: unknown) => { setError(String(reason)) })
                      }}
                    >
                      <StateDot state={member.status === 'running' ? 'ongoing' : member.status === 'failed' ? 'error' : 'done'} />
                      <span className={css.memberText}>
                        <span>{member.name}</span>
                        <small>{t(memberStatusKey(member.status))}{member.model === undefined ? '' : ` · ${t('model')}: ${member.model}`}</small>
                        {member.diagnostics.map(diagnostic => <small key={diagnostic} className={css.diagnostic}>{diagnostic}</small>)}
                      </span>
                    </button>
                  ))}
                </div>
              </section>
              <section>
                <div className={css.sectionTitle}>
                  <h3>{t('tasks')}</h3>
                  <button type="button" className={css.smallButton} onClick={() => { setCreating(true) }}>
                    <IconPlusOutline16 size={13} /> {t('create')}
                  </button>
                </div>
                {creating && (
                  <TaskForm
                    draft={createDraft}
                    setDraft={setCreateDraft}
                    dependencyOptions={view.tasks}
                    pending={pendingTasks.has('create')}
                    onSave={() => { void submitCreate() }}
                    onCancel={() => { setCreating(false) }}
                    t={t}
                  />
                )}
                {view.tasks.length === 0 && !creating && <div className={css.notice}>{t('empty')}</div>}
                {view.tasks.length > 0 && (
                  <>
                    <div className={css.taskViewSwitch} role="group" aria-label={t('taskView')}>
                      <button
                        type="button"
                        aria-pressed={taskViewMode === 'list'}
                        onClick={() => { setTaskViewMode('list') }}
                      >{t('taskList')}</button>
                      <button
                        type="button"
                        aria-pressed={taskViewMode === 'graph'}
                        onClick={() => { setTaskViewMode('graph') }}
                      >{t('taskGraph')}</button>
                    </div>
                    <input
                      className={css.taskFilter}
                      type="search"
                      aria-label={t('taskFilter')}
                      placeholder={t('taskFilter')}
                      value={taskFilter}
                      onChange={(event: ChangeEvent<HTMLInputElement>) => { setTaskFilter(event.target.value) }}
                    />
                    {visibleTasks.length === 0 && <div className={css.notice}>{t('noMatchingTasks')}</div>}
                    {taskViewMode === 'list'
                      ? (
                        <div className={css.tasks} role="list" aria-label={t('taskList')}>
                          {visibleTasks.map(task => (
                            <div key={task.id} role="listitem">
                              <button
                                type="button"
                                className={css.taskChoice}
                                aria-label={`${task.id} · ${task.subject}`}
                                aria-pressed={task.id === selectedTaskId}
                                onClick={() => { setSelectedTaskId(task.id) }}
                              >
                                <span className={css.taskTitle}>
                                  <strong>{task.subject}</strong>
                                  <span>{t(statusKey(task.status))}</span>
                                </span>
                                <span className={css.meta}>
                                  <span>{task.id}</span>
                                  {task.id !== selectedTaskId && task.status === 'pending' && (
                                    <span>{task.ready ? t('ready') : t('blocked')}</span>
                                  )}
                                  {unfinishedBlockers(task).length > 0 && (
                                    <span>{t('blockedBy')}: {unfinishedBlockers(task).join(', ')}</span>
                                  )}
                                  {hiddenBlockers(task).length > 0 && (
                                    <span className={css.hiddenDependency}>
                                      {t('hiddenDependencies')}{hiddenBlockers(task).join(', ')}
                                    </span>
                                  )}
                                  {task.id !== selectedTaskId && task.writeScopeWarnings.map(warning => (
                                    <span key={warning} className={css.warning}>{warning}</span>
                                  ))}
                                </span>
                              </button>
                            </div>
                          ))}
                        </div>
                      )
                      : (
                        <div className={css.taskGraphFrame}>
                          <div className={css.taskGraphControls}>
                            <button type="button" aria-label={t('zoomIn')} onClick={() => { zoomGraph(0.2) }}>+</button>
                            <button type="button" aria-label={t('zoomOut')} onClick={() => { zoomGraph(-0.2) }}>−</button>
                            <button type="button" onClick={fitGraph}>{t('fitGraph')}</button>
                          </div>
                          <div
                            ref={graphViewportRef}
                            className={css.taskGraph}
                            role="application"
                            aria-label={t('taskGraph')}
                            tabIndex={0}
                            data-zoom={graphTransform.scale}
                            data-pan-x={graphTransform.x}
                            data-pan-y={graphTransform.y}
                            onPointerDown={beginGraphPan}
                            onPointerMove={moveGraphPan}
                            onPointerUp={endGraphPan}
                            onPointerCancel={endGraphPan}
                          >
                            <div
                              className={css.taskGraphCanvas}
                              style={{
                                width: graphLayout.width,
                                height: graphLayout.height,
                                transform: `translate(${graphTransform.x}px, ${graphTransform.y}px) scale(${graphTransform.scale})`,
                              } satisfies CSSProperties}
                            >
                              <svg
                                className={css.taskEdges}
                                width={graphLayout.width}
                                height={graphLayout.height}
                                viewBox={`0 0 ${graphLayout.width} ${graphLayout.height}`}
                              >
                                <defs>
                                  <marker
                                    id="agent-team-task-arrow"
                                    markerWidth="7"
                                    markerHeight="7"
                                    refX="6"
                                    refY="3.5"
                                    orient="auto"
                                    markerUnits="strokeWidth"
                                  >
                                    <path className={css.taskArrow} d="M 0 0 L 7 3.5 L 0 7 z" />
                                  </marker>
                                </defs>
                                {graphLayout.nodes.flatMap(node => node.task.blockedBy.flatMap((blockerId) => {
                                  const blocker = graphLayout.byId.get(blockerId)
                                  if (blocker === undefined) return []
                                  return [(
                                    <line
                                      key={`${blockerId}:${node.task.id}`}
                                      className={css.taskEdge}
                                      aria-label={`${blockerId} → ${node.task.id}`}
                                      data-from-task-id={blockerId}
                                      data-to-task-id={node.task.id}
                                      markerEnd="url(#agent-team-task-arrow)"
                                      x1={blocker.x + GRAPH_NODE_WIDTH}
                                      y1={blocker.y + GRAPH_NODE_HEIGHT / 2}
                                      x2={node.x}
                                      y2={node.y + GRAPH_NODE_HEIGHT / 2}
                                    />
                                  )]
                                }))}
                              </svg>
                              <div className={css.taskNodes}>
                                {graphLayout.nodes.map(node => (
                                  <button
                                    key={node.task.id}
                                    ref={(element) => {
                                      if (element === null) graphNodeRefs.current.delete(node.task.id)
                                      else graphNodeRefs.current.set(node.task.id, element)
                                    }}
                                    type="button"
                                    className={css.taskNode}
                                    style={{ left: node.x, top: node.y } satisfies CSSProperties}
                                    data-graph-column={node.column}
                                    data-graph-row={node.row}
                                    aria-label={`${node.task.id} · ${node.task.subject}`}
                                    aria-pressed={node.task.id === selectedTaskId}
                                    aria-keyshortcuts="ArrowLeft ArrowRight ArrowUp ArrowDown Home End"
                                    onKeyDown={(event) => { moveGraphSelection(node.task, event) }}
                                    onClick={() => { setSelectedTaskId(node.task.id) }}
                                  >
                                    <span>{node.task.id}</span>
                                    <strong>{node.task.subject}</strong>
                                    <small>{t(statusKey(node.task.status))}</small>
                                    <small>{t('owner')}: {node.task.ownerName ?? t('unowned')}</small>
                                    {node.task.status === 'pending' && (
                                      <small>{node.task.ready ? t('ready') : t('blocked')}</small>
                                    )}
                                    {unfinishedBlockers(node.task).length > 0 && (
                                      <small>{t('blockedBy')}: {unfinishedBlockers(node.task).join(', ')}</small>
                                    )}
                                    {hiddenBlockers(node.task).length > 0 && (
                                      <small className={css.hiddenDependency}>
                                        {t('hiddenDependencies')}{hiddenBlockers(node.task).join(', ')}
                                      </small>
                                    )}
                                  </button>
                                ))}
                              </div>
                            </div>
                          </div>
                        </div>
                      )}
                    {selectedTask !== undefined && (
                      <section className={css.taskDetail} role="region" aria-label={t('taskDetails')}>
                        {editing === selectedTask.id && selectedTask.status !== 'deleted'
                          ? (
                            <TaskForm
                              draft={editDraft}
                              setDraft={setEditDraft}
                              dependencyOptions={view.tasks}
                              taskId={selectedTask.id}
                              pending={pendingTasks.has(selectedTask.id)}
                              onSave={() => { void submitEdit(selectedTask) }}
                              onCancel={() => {
                                conflictDraftRef.current = null
                                setError(null)
                                setEditing(null)
                                setEditBase(null)
                              }}
                              t={t}
                            />
                          )
                          : (
                            <article className={css.task}>
                              <div className={css.taskTitle}>
                                <strong>{selectedTask.id} · {selectedTask.subject}</strong>
                                <span>{t(statusKey(selectedTask.status))}</span>
                              </div>
                              <p>{selectedTask.description}</p>
                              <div className={css.meta}>
                                {selectedTask.status === 'pending' && (
                                  <span>{selectedTask.ready ? t('ready') : t('blocked')}</span>
                                )}
                                {unfinishedBlockers(selectedTask).length > 0 && (
                                  <span>{t('blockedBy')}: {unfinishedBlockers(selectedTask).join(', ')}</span>
                                )}
                                {selectedTask.writeScopes.length > 0 && (
                                  <span>{t('writeScopes')}: {selectedTask.writeScopes.join(', ')}</span>
                                )}
                                {selectedTask.writeScopeWarnings.map(warning => (
                                  <span key={warning} className={css.warning}>{warning}</span>
                                ))}
                              </div>
                              {selectedTask.status !== 'deleted' && <div className={css.taskActions}>
                                <label>
                                  {t('owner')}
                                  <select
                                    value={selectedTask.ownerName ?? ''}
                                    disabled={pendingTasks.has(selectedTask.id) || selectedTask.status === 'completed'}
                                    onChange={(event: ChangeEvent<HTMLSelectElement>) => {
                                      const owner = event.target.value
                                      void settleTask(selectedTask.id, () => updateTask(sessionId, {
                                        taskId: selectedTask.id,
                                        expectedRevision: selectedTask.revision,
                                        action: 'reassign',
                                        ...owner === '' ? {} : { owner },
                                      }))
                                    }}
                                  >
                                    <option value="">{t('unowned')}</option>
                                    {assignable.map(member => (
                                      <option key={member.id} value={member.name}>{member.name}</option>
                                    ))}
                                  </select>
                                </label>
                                <button
                                  type="button"
                                  onClick={() => { startEdit(selectedTask) }}
                                  disabled={pendingTasks.has(selectedTask.id)}
                                >
                                  <IconEditOutline16 size={13} /> {t('edit')}
                                </button>
                                {selectedTask.status === 'in_progress' && (
                                  <button type="button" disabled={pendingTasks.has(selectedTask.id)} onClick={() => {
                                    void settleTask(selectedTask.id, () => updateTask(sessionId, {
                                      taskId: selectedTask.id,
                                      expectedRevision: selectedTask.revision,
                                      action: 'complete',
                                    }))
                                  }}><IconCheckOutline14 /> {t('complete')}</button>
                                )}
                                {selectedTask.status === 'completed' && (
                                  <button type="button" disabled={pendingTasks.has(selectedTask.id)} onClick={() => {
                                    void settleTask(selectedTask.id, () => updateTask(sessionId, {
                                      taskId: selectedTask.id,
                                      expectedRevision: selectedTask.revision,
                                      action: 'reopen',
                                    }))
                                  }}>{t('reopen')}</button>
                                )}
                                <button type="button" disabled={pendingTasks.has(selectedTask.id)} onClick={() => {
                                  void settleTask(selectedTask.id, () => updateTask(sessionId, {
                                    taskId: selectedTask.id,
                                    expectedRevision: selectedTask.revision,
                                    action: 'delete',
                                  }))
                                }}><IconTrashOutline16 size={13} /> {t('delete')}</button>
                              </div>}
                            </article>
                          )}
                      </section>
                    )}
                  </>
                )}
              </section>
            </>
          )}
          {activeView !== 'overview' && renderSlot('agent-team.panel.view', {
            teamSessionId: resolveTeamSessionId(sessionId),
          }, { only: activeView })}
        </div>
      )}
    </div>
  )
}

interface TaskFormProps {
  draft: Draft
  setDraft: (draft: Draft) => void
  dependencyOptions: readonly TeamTask[]
  taskId?: TeamTaskId
  pending: boolean
  onSave: () => void
  onCancel: () => void
  t: TeamActionProps['t']
}

function TaskForm({ draft, setDraft, dependencyOptions, taskId, pending, onSave, onCancel, t }: TaskFormProps) {
  const field = (key: keyof Draft, value: string): void => { setDraft({ ...draft, [key]: value }) }
  const blockers = taskIds(draft.blockers)
  const availableIds = new Set(dependencyOptions
    .filter(task => task.id !== taskId && task.status !== 'deleted')
    .map(task => task.id))
  const unavailableBlockers = blockers.filter(id => id !== taskId && !availableIds.has(id))
  const toggleBlocker = (id: TeamTaskId, checked: boolean): void => {
    field('blockers', (checked ? [...blockers, id] : blockers.filter(blocker => blocker !== id)).join(', '))
  }
  return (
    <div className={css.form}>
      <input value={draft.subject} placeholder={t('subject')} onChange={(event: ChangeEvent<HTMLInputElement>) => { field('subject', event.target.value) }} />
      <textarea value={draft.description} placeholder={t('description')} onChange={(event: ChangeEvent<HTMLTextAreaElement>) => { field('description', event.target.value) }} />
      <fieldset className={css.dependencyPicker}>
        <legend>{t('blockers')}</legend>
        {dependencyOptions.filter(task => task.id !== taskId && task.status !== 'deleted').map(task => (
          <label key={task.id} className={css.dependencyOption}>
            <input
              type="checkbox"
              checked={blockers.includes(task.id)}
              disabled={pending}
              onChange={(event: ChangeEvent<HTMLInputElement>) => { toggleBlocker(task.id, event.target.checked) }}
            />
            <span>{task.id} · {task.subject}</span>
          </label>
        ))}
        {unavailableBlockers.map(id => (
          <label key={id} className={css.dependencyOption}>
            <input
              type="checkbox"
              checked
              disabled={pending}
              onChange={(event: ChangeEvent<HTMLInputElement>) => { toggleBlocker(id, event.target.checked) }}
            />
            <span>{id} · {t('dependencyUnavailable')}</span>
          </label>
        ))}
      </fieldset>
      <input value={draft.scopes} placeholder={t('scopes')} onChange={(event: ChangeEvent<HTMLInputElement>) => { field('scopes', event.target.value) }} />
      <div className={css.formActions}>
        <button type="button" disabled={pending || draft.subject.trim() === '' || draft.description.trim() === ''} onClick={onSave}>{t('save')}</button>
        <button type="button" disabled={pending} onClick={onCancel}>{t('cancel')}</button>
      </div>
    </div>
  )
}
