// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type {
  TeamTaskId, TeamTaskView as TeamTask, TeamView,
} from '@deepseek-ai/dsh-experimental-agent-team/client'
import { bindSnapshotSelector, makeTranslate, RemoteError } from '@deepseek-ai/dsh-client-test-runtime'
import { en as commonEn } from '@deepseek-ai/dsh-client-locale/src/locales/en.ts'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import {
  TeamAction, type TeamActionInjected, type TeamActionProps, type TeamActionResult,
  type TeamTaskActionResult,
} from '../src/client/TeamAction.tsx'
import { en, zh } from '../src/client/locales.ts'

afterEach(cleanup)

const SESSION = 'lead' as SessionId
const TASK_1 = 'task-1' as TeamTaskId
const TASK_2 = 'task-2' as TeamTaskId
const TASK_3 = 'task-3' as TeamTaskId
const EMPTY_PANEL_VIEWS: readonly [] = []
const task: TeamTask = {
  id: TASK_1,
  revision: 1,
  subject: 'Implement runtime',
  description: 'Build the Team runtime',
  status: 'in_progress',
  ownerName: 'lead',
  blockedBy: [],
  writeScopes: ['src'],
  ready: false,
  writeScopeWarnings: ['write scopes overlap with task-2'],
}
const dependencyOption: TeamTask = {
  ...task,
  id: TASK_2,
  subject: 'Dependency option',
  description: 'Selectable dependency',
  status: 'pending',
  ownerName: 'lead',
  ready: true,
  writeScopeWarnings: [],
}
const view: TeamView = {
  members: [
    { id: SESSION, name: 'lead', role: 'lead', status: 'idle', model: 'model-a', diagnostics: [] },
    {
      id: 'worker-id' as SessionId,
      name: 'worker',
      role: 'teammate',
      status: 'inactive',
      model: 'model-a',
      diagnostics: [],
    },
  ],
  tasks: [task],
}

function taskSuccess(value: TeamTask): TeamTaskActionResult {
  return { ok: true, value: { ok: true, value } }
}

function taskConflict(message: string): TeamTaskActionResult {
  return {
    ok: true,
    value: { ok: false, error: { code: 'team-task-conflict', message } },
  }
}

function taskRejected(message: string): TeamTaskActionResult {
  return {
    ok: true,
    value: { ok: false, error: { code: 'team-rejected', message } },
  }
}

function remoteFailure(message: string): TeamActionResult<never> {
  return { ok: false, error: new RemoteError('gateway/internal', message, {}) }
}

function props(actions: TeamActionInjected, sessionId: SessionId = SESSION): TeamActionProps {
  const { hooks, ...plain } = actions
  return {
    sessionId,
    renderSlot: () => null,
    ...plain,
    usePanelViews: bindSnapshotSelector(hooks.panelViews),
    t: makeTranslate(zh, commonZh),
  } as unknown as TeamActionProps
}

function actions(overrides: Partial<TeamActionInjected> = {}): TeamActionInjected {
  return {
    hooks: {
      panelViews: {
        getSnapshot: () => EMPTY_PANEL_VIEWS,
        subscribe: () => () => {},
      },
    },
    resolveTeamSessionId: sessionId => sessionId,
    load: () => Promise.resolve({ ok: true, value: view }),
    createTask: () => Promise.resolve(taskSuccess({ ...task, id: TASK_2, subject: 'New task' })),
    updateTask: () => Promise.resolve({
      ok: true,
      value: { ok: true, value: { ...task, revision: 2 } },
    }),
    openTeammate: () => Promise.resolve(),
    ...overrides,
  }
}

describe('TeamAction', () => {
  it('shares real task selection and detail between the list and dependency graph', async () => {
    const dependent: TeamTask = {
      id: TASK_2,
      revision: 4,
      subject: 'Publish result',
      description: 'Publish after the runtime is complete',
      status: 'pending',
      blockedBy: [TASK_1],
      writeScopes: ['docs'],
      ready: false,
      writeScopeWarnings: [],
    }
    render(<TeamAction {...props(actions({
      load: () => Promise.resolve({ ok: true, value: { ...view, tasks: [task, dependent] } }),
    }))} />)

    fireEvent.click(screen.getByRole('button', { name: /Agent Team/u }))
    await screen.findByText('Publish result')
    fireEvent.click(screen.getByRole('button', { name: 'task-2 · Publish result' }))

    const detail = screen.getByRole('region', { name: '任务详情' })
    expect(detail.textContent).toContain('task-2')
    expect(detail.textContent).toContain('Publish after the runtime is complete')
    expect(detail.textContent).toContain('task-1')
    expect(detail.textContent).toContain('被依赖阻塞')
    expect(detail.querySelector('select')?.value).toBe('')
    expect(screen.getByRole('button', { name: /编辑/u })).toBeTruthy()
    expect(screen.getByRole('button', { name: /删除/u })).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: '任务依赖图' }))
    const graph = screen.getByRole('application', { name: '任务依赖图' })
    const edge = within(graph).getByLabelText('task-1 → task-2')
    expect(edge.getAttribute('data-from-task-id')).toBe('task-1')
    expect(edge.getAttribute('data-to-task-id')).toBe('task-2')
    expect(edge.getAttribute('marker-end')).toBe('url(#agent-team-task-arrow)')
    const dependentNode = within(graph).getByRole('button', { name: 'task-2 · Publish result' })
    expect(dependentNode.getAttribute('aria-pressed')).toBe('true')
    expect(dependentNode.textContent).toContain(zh.unowned)
    expect(dependentNode.textContent).toContain(zh.blocked)
    expect(dependentNode.textContent).toContain('task-1')
    expect(screen.getByRole('region', { name: '任务详情' }).textContent).toContain('task-2')

    fireEvent.click(within(graph).getByRole('button', { name: 'task-1 · Implement runtime' }))
    expect(screen.getByRole('region', { name: '任务详情' }).textContent).toContain('task-1')
    fireEvent.click(screen.getByRole('button', { name: '任务列表' }))
    expect(screen.getByRole('button', { name: 'task-1 · Implement runtime' }).getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByRole('region', { name: '任务详情' }).textContent).toContain('Build the Team runtime')
  })

  it('auto-lays out the DAG and supports zoom, pan, fit, and directional keyboard navigation', async () => {
    const prerequisite: TeamTask = {
      ...task,
      status: 'completed',
      revision: 2,
      ready: false,
    }
    const middle: TeamTask = {
      id: TASK_2,
      revision: 1,
      subject: 'Integrate runtime',
      description: 'Use the completed runtime',
      status: 'completed',
      blockedBy: [TASK_1],
      writeScopes: [],
      ready: false,
      writeScopeWarnings: [],
    }
    const dependent: TeamTask = {
      id: TASK_3,
      revision: 1,
      subject: 'Publish result',
      description: 'Publish after integration',
      status: 'pending',
      blockedBy: [TASK_2],
      writeScopes: [],
      ready: true,
      writeScopeWarnings: [],
    }
    render(<TeamAction {...props(actions({
      load: () => Promise.resolve({
        ok: true,
        value: { ...view, tasks: [prerequisite, middle, dependent] },
      }),
    }))} />)

    fireEvent.click(screen.getByRole('button', { name: /Agent Team/u }))
    await screen.findByText('Publish result')
    fireEvent.click(screen.getByRole('button', { name: '任务依赖图' }))

    const graph = screen.getByRole('application', { name: '任务依赖图' })
    const first = within(graph).getByRole('button', { name: 'task-1 · Implement runtime' })
    const second = within(graph).getByRole('button', { name: 'task-2 · Integrate runtime' })
    const third = within(graph).getByRole('button', { name: 'task-3 · Publish result' })
    expect(first.getAttribute('data-graph-column')).toBe('0')
    expect(second.getAttribute('data-graph-column')).toBe('1')
    expect(third.getAttribute('data-graph-column')).toBe('2')

    fireEvent.click(screen.getByRole('button', { name: '放大依赖图' }))
    expect(graph.getAttribute('data-zoom')).toBe('1.2')
    fireEvent.pointerDown(within(graph).getByLabelText('task-1 → task-2'), {
      clientX: 20,
      clientY: 30,
      pointerId: 1,
    })
    fireEvent.pointerMove(graph, { clientX: 55, clientY: 70, pointerId: 1 })
    fireEvent.pointerUp(graph, { pointerId: 1 })
    expect(graph.getAttribute('data-pan-x')).toBe('35')
    expect(graph.getAttribute('data-pan-y')).toBe('40')
    fireEvent.click(screen.getByRole('button', { name: '适配依赖图视野' }))
    expect(graph.getAttribute('data-pan-x')).not.toBe('35')
    expect(Number(graph.getAttribute('data-zoom'))).toBeGreaterThan(0)

    first.focus()
    fireEvent.keyDown(first, { key: 'ArrowRight' })
    expect(document.activeElement).toBe(second)
    expect(second.getAttribute('aria-pressed')).toBe('true')
    fireEvent.keyDown(second, { key: 'ArrowRight' })
    expect(document.activeElement).toBe(third)
    fireEvent.keyDown(third, { key: 'ArrowLeft' })
    expect(document.activeElement).toBe(second)
    fireEvent.click(screen.getByRole('button', { name: '任务列表' }))
    expect(screen.getByRole('button', { name: 'task-2 · Integrate runtime' }).getAttribute('aria-pressed')).toBe('true')
  })

  it('shows filtered-out dependency hints without changing Host readiness', async () => {
    const prerequisite: TeamTask = {
      ...task,
      subject: 'Hidden prerequisite',
    }
    const dependent: TeamTask = {
      id: TASK_2,
      revision: 3,
      subject: 'Visible dependent',
      description: 'Still blocked by the hidden task',
      status: 'pending',
      blockedBy: [TASK_1],
      writeScopes: [],
      ready: false,
      writeScopeWarnings: [],
    }
    render(<TeamAction {...props(actions({
      load: () => Promise.resolve({ ok: true, value: { ...view, tasks: [prerequisite, dependent] } }),
    }))} />)

    fireEvent.click(screen.getByRole('button', { name: /Agent Team/u }))
    await screen.findByText('Visible dependent')
    fireEvent.click(screen.getByRole('button', { name: 'task-2 · Visible dependent' }))
    fireEvent.change(screen.getByRole('searchbox', { name: '筛选任务' }), {
      target: { value: 'Visible dependent' },
    })

    expect(screen.queryByRole('button', { name: 'task-1 · Hidden prerequisite' })).toBeNull()
    expect(screen.getByRole('button', { name: 'task-2 · Visible dependent' })).toBeTruthy()
    expect(screen.getByText('隐藏依赖：task-1')).toBeTruthy()
    expect(screen.getByRole('region', { name: '任务详情' }).textContent).toContain(zh.blocked)

    fireEvent.click(screen.getByRole('button', { name: '任务依赖图' }))
    const graph = screen.getByRole('application', { name: '任务依赖图' })
    expect(within(graph).queryByRole('button', { name: 'task-1 · Hidden prerequisite' })).toBeNull()
    expect(within(graph).getByRole('button', { name: 'task-2 · Visible dependent' })).toBeTruthy()
    expect(within(graph).getByText('隐藏依赖：task-1')).toBeTruthy()

    fireEvent.change(screen.getByRole('searchbox', { name: '筛选任务' }), { target: { value: '' } })
    expect(within(graph).getByRole('button', { name: 'task-1 · Hidden prerequisite' })).toBeTruthy()
    expect(within(graph).getByLabelText('task-1 → task-2')).toBeTruthy()
  })

  it('renders the shared task graph status and controls in English', async () => {
    const dependent: TeamTask = {
      id: TASK_2,
      revision: 2,
      subject: 'Publish result',
      description: 'Publish after the runtime is complete',
      status: 'pending',
      blockedBy: [TASK_1],
      writeScopes: [],
      ready: false,
      writeScopeWarnings: [],
    }
    const injected = actions({
      load: () => Promise.resolve({ ok: true, value: { ...view, tasks: [task, dependent] } }),
    })
    render(<TeamAction {...{
      ...props(injected),
      t: makeTranslate(en, commonEn),
    }} />)

    fireEvent.click(screen.getByRole('button', { name: /Agent Team/u }))
    await screen.findByText('Publish result')
    fireEvent.click(screen.getByRole('button', { name: en.taskGraph }))

    const graph = screen.getByRole('application', { name: en.taskGraph })
    const node = within(graph).getByRole('button', { name: 'task-2 · Publish result' })
    expect(node.textContent).toContain(`${en.owner}: ${en.unowned}`)
    expect(node.textContent).toContain(en.blocked)
    expect(screen.getByRole('button', { name: en.zoomIn })).toBeTruthy()
    expect(screen.getByRole('button', { name: en.fitGraph })).toBeTruthy()
    expect(screen.getByRole('region', { name: en.taskDetails })).toBeTruthy()

    fireEvent.change(screen.getByRole('searchbox', { name: en.taskFilter }), {
      target: { value: 'Publish result' },
    })
    expect(within(graph).getByText('Hidden dependencies: task-1')).toBeTruthy()
  })

  it('navigates a public child view inside the one Team-owned panel', async () => {
    const renderSlot = vi.fn(() => <div>Injected message center</div>)
    const messageViews = [{ id: 'messages', label: '消息' }] as const
    const injected = actions({
      hooks: {
        panelViews: {
          getSnapshot: () => messageViews,
          subscribe: () => () => {},
        },
      },
    })
    render(<TeamAction {...{
      ...props(injected),
      renderSlot,
    }} />)

    fireEvent.click(screen.getByRole('button', { name: /Agent Team/u }))
    await screen.findByText('Implement runtime')
    expect(screen.getAllByRole('dialog', { name: /Agent Team/u })).toHaveLength(1)
    expect(screen.getByRole('tab', { name: '概览' }).getAttribute('aria-selected')).toBe('true')
    fireEvent.click(screen.getByRole('tab', { name: '消息' }))
    expect(await screen.findByText('Injected message center')).toBeTruthy()
    expect(renderSlot).toHaveBeenLastCalledWith(
      'agent-team.panel.view',
      { teamSessionId: SESSION },
      { only: 'messages' },
    )
  })

  it('ignores a stale Team load after the conversation switches sessions', async () => {
    const nextSession = 'next-lead' as SessionId
    const firstLoad = Promise.withResolvers<{ ok: true; value: TeamView }>()
    const nextView: TeamView = {
      ...view,
      members: [{ id: nextSession, name: 'lead', role: 'lead', status: 'idle', diagnostics: [] }],
      tasks: [{ ...task, id: 'task-next' as TeamTaskId, subject: 'Next session task' }],
    }
    const load = vi.fn((sessionId: SessionId) => sessionId === SESSION
      ? firstLoad.promise
      : Promise.resolve({ ok: true as const, value: nextView }))
    const injected = actions({ load })
    const rendered = render(<TeamAction {...props(injected)} />)
    fireEvent.click(screen.getByRole('button', { name: /Agent Team/u }))
    await waitFor(() => { expect(load).toHaveBeenCalledWith(SESSION) })

    rendered.rerender(<TeamAction {...props(injected, nextSession)} />)
    fireEvent.click(screen.getByRole('button', { name: /Agent Team/u }))
    expect(await screen.findByText('Next session task')).toBeTruthy()
    firstLoad.resolve({ ok: true, value: view })
    await Promise.resolve()

    await waitFor(() => {
      expect(screen.getByText('Next session task')).toBeTruthy()
      expect(screen.queryByText('Implement runtime')).toBeNull()
    })
  })

  it('loads roster/task diagnostics on open and navigates a healthy teammate', async () => {
    const openTeammate = vi.fn(() => Promise.resolve())
    render(<TeamAction {...props(actions({ openTeammate }))} />)
    fireEvent.click(screen.getByRole('button', { name: /Agent Team/u }))
    const worker = await screen.findByRole('button', { name: /worker/u })
    expect(screen.getByText('write scopes overlap with task-2')).toBeTruthy()
    fireEvent.click(worker)
    await waitFor(() => { expect(openTeammate).toHaveBeenCalledWith(SESSION, view.members[1]) })
  })

  it('keeps only the newest overlapping refresh for one session', async () => {
    const older = Promise.withResolvers<TeamActionResult<TeamView>>()
    const newer = Promise.withResolvers<TeamActionResult<TeamView>>()
    const newestView = {
      ...view,
      tasks: [{ ...task, id: 'newest-task' as TeamTaskId, subject: 'Newest task' }],
    }
    const load = vi.fn()
      .mockResolvedValueOnce({ ok: true, value: view })
      .mockImplementationOnce(() => older.promise)
      .mockImplementationOnce(() => newer.promise)
    render(<TeamAction {...props(actions({ load }))} />)
    fireEvent.click(screen.getByRole('button', { name: /Agent Team/u }))
    await screen.findByText('Implement runtime')

    const refresh = screen.getByRole('button', { name: zh.refresh })
    fireEvent.click(refresh)
    fireEvent.click(refresh)
    newer.resolve({ ok: true, value: newestView })
    expect(await screen.findByText('Newest task')).toBeTruthy()
    older.resolve({ ok: true, value: view })
    await Promise.resolve()

    expect(screen.getByText('Newest task')).toBeTruthy()
    expect(screen.queryByText('Implement runtime')).toBeNull()
  })

  it('keeps a successful task mutation newer than an in-flight refresh', async () => {
    const stale = Promise.withResolvers<TeamActionResult<TeamView>>()
    const completedView = { ...view, tasks: [{ ...task, revision: 2, status: 'completed' as const }] }
    const load = vi.fn()
      .mockResolvedValueOnce({ ok: true, value: view })
      .mockImplementationOnce(() => stale.promise)
      .mockResolvedValueOnce({ ok: true, value: completedView })
    const updateTask = vi.fn(() => Promise.resolve(
      taskSuccess({ ...task, revision: 2, status: 'completed' }),
    ))
    render(<TeamAction {...props(actions({ load, updateTask }))} />)
    fireEvent.click(screen.getByRole('button', { name: /Agent Team/u }))
    await screen.findByText('Implement runtime')

    fireEvent.click(screen.getByRole('button', { name: zh.refresh }))
    fireEvent.click(screen.getByRole('button', { name: /完成/u }))
    expect(await screen.findByRole('button', { name: /重开/u })).toBeTruthy()

    stale.resolve({ ok: true, value: view })
    await Promise.resolve()
    expect(screen.getByRole('button', { name: /重开/u })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /完成/u })).toBeNull()
  })

  it('keeps a created task newer than an in-flight refresh', async () => {
    const stale = Promise.withResolvers<TeamActionResult<TeamView>>()
    const createdTask = { ...task, id: TASK_2, subject: 'New task' }
    const load = vi.fn()
      .mockResolvedValueOnce({ ok: true, value: view })
      .mockImplementationOnce(() => stale.promise)
      .mockResolvedValueOnce({ ok: true, value: { ...view, tasks: [...view.tasks, createdTask] } })
    render(<TeamAction {...props(actions({
      load,
      createTask: () => Promise.resolve(taskSuccess(createdTask)),
    }))} />)
    fireEvent.click(screen.getByRole('button', { name: /Agent Team/u }))
    await screen.findByText('Implement runtime')

    fireEvent.click(screen.getByRole('button', { name: zh.refresh }))
    fireEvent.click(screen.getByRole('button', { name: /新建任务/u }))
    fireEvent.change(screen.getByPlaceholderText('任务标题'), { target: { value: 'New task' } })
    fireEvent.change(screen.getByPlaceholderText('任务描述'), { target: { value: 'Details' } })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    expect(await screen.findByText('New task')).toBeTruthy()

    stale.resolve({ ok: true, value: view })
    await Promise.resolve()
    expect(screen.getByText('New task')).toBeTruthy()
  })

  it('keeps task and create failures newer than an in-flight refresh', async () => {
    const staleTask = Promise.withResolvers<TeamActionResult<TeamView>>()
    const taskLoad = vi.fn()
      .mockResolvedValueOnce({ ok: true, value: view })
      .mockImplementationOnce(() => staleTask.promise)
    const first = render(<TeamAction {...props(actions({
      load: taskLoad,
      updateTask: () => Promise.resolve(taskRejected('task rejected')),
    }))} />)
    fireEvent.click(screen.getByRole('button', { name: /Agent Team/u }))
    await screen.findByText('Implement runtime')
    fireEvent.click(screen.getByRole('button', { name: zh.refresh }))
    fireEvent.click(screen.getByRole('button', { name: /完成/u }))
    expect(await screen.findByText('task rejected (team-rejected)')).toBeTruthy()
    staleTask.resolve({ ok: true, value: view })
    await Promise.resolve()
    expect(screen.getByText('task rejected (team-rejected)')).toBeTruthy()
    first.unmount()

    const staleCreate = Promise.withResolvers<TeamActionResult<TeamView>>()
    const createLoad = vi.fn()
      .mockResolvedValueOnce({ ok: true, value: view })
      .mockImplementationOnce(() => staleCreate.promise)
    render(<TeamAction {...props(actions({
      load: createLoad,
      createTask: () => Promise.resolve(taskRejected('create rejected')),
    }))} />)
    fireEvent.click(screen.getByRole('button', { name: /Agent Team/u }))
    await screen.findByText('Implement runtime')
    fireEvent.click(screen.getByRole('button', { name: zh.refresh }))
    fireEvent.click(screen.getByRole('button', { name: /新建任务/u }))
    fireEvent.change(screen.getByPlaceholderText('任务标题'), { target: { value: 'Rejected task' } })
    fireEvent.change(screen.getByPlaceholderText('任务描述'), { target: { value: 'Rejected details' } })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    expect(await screen.findByText('create rejected (team-rejected)')).toBeTruthy()
    staleCreate.resolve({ ok: true, value: view })
    await Promise.resolve()
    expect(screen.getByText('create rejected (team-rejected)')).toBeTruthy()
  })

  it('tracks simultaneous create and task mutations independently', async () => {
    const create = Promise.withResolvers<TeamTaskActionResult>()
    const createdTask = { ...task, id: TASK_2, subject: 'Concurrent task' }
    const completedTask = { ...task, revision: 2, status: 'completed' as const }
    const load = vi.fn()
      .mockResolvedValueOnce({ ok: true, value: view })
      .mockResolvedValueOnce({ ok: true, value: { ...view, tasks: [completedTask] } })
      .mockResolvedValueOnce({ ok: true, value: { ...view, tasks: [completedTask, createdTask] } })
    const createTask = vi.fn(() => create.promise)
    render(<TeamAction {...props(actions({ load, createTask }))} />)
    fireEvent.click(screen.getByRole('button', { name: /Agent Team/u }))
    await screen.findByText('Implement runtime')
    fireEvent.click(screen.getByRole('button', { name: /新建任务/u }))
    fireEvent.change(screen.getByPlaceholderText('任务标题'), { target: { value: 'Concurrent task' } })
    fireEvent.change(screen.getByPlaceholderText('任务描述'), { target: { value: 'Concurrent details' } })
    const save = screen.getByRole<HTMLButtonElement>('button', { name: '保存' })
    fireEvent.click(save)
    await waitFor(() => { expect(save.disabled).toBe(true) })

    const complete = screen.getByRole<HTMLButtonElement>('button', { name: /完成/u })
    expect(complete.disabled).toBe(false)
    fireEvent.click(complete)
    expect(await screen.findByRole('button', { name: /重开/u })).toBeTruthy()
    expect(save.disabled).toBe(true)
    fireEvent.click(save)
    expect(createTask).toHaveBeenCalledTimes(1)

    create.resolve(taskSuccess(createdTask))
    expect(await screen.findByText('Concurrent task')).toBeTruthy()
    expect(screen.queryByRole('button', { name: '保存' })).toBeNull()
  })

  it('reloads derived fields for every task after a mutation', async () => {
    const related = {
      ...task,
      id: TASK_2,
      subject: 'Related task',
      writeScopeWarnings: ['old warning'],
    }
    const completed = { ...task, revision: 2, status: 'completed' as const }
    const refreshed = {
      ...view,
      tasks: [completed, { ...related, writeScopeWarnings: ['derived warning refreshed'] }],
    }
    const load = vi.fn()
      .mockResolvedValueOnce({ ok: true, value: { ...view, tasks: [task, related] } })
      .mockResolvedValueOnce({ ok: true, value: refreshed })
    render(<TeamAction {...props(actions({
      load,
      updateTask: () => Promise.resolve(taskSuccess(completed)),
    }))} />)
    fireEvent.click(screen.getByRole('button', { name: /Agent Team/u }))
    await screen.findByText('old warning')
    fireEvent.click(screen.getAllByRole('button', { name: /完成/u })[0]!)

    expect(await screen.findByText('derived warning refreshed')).toBeTruthy()
    expect(screen.queryByText('old warning')).toBeNull()
    expect(load).toHaveBeenCalledTimes(2)
  })

  it('creates a task from a selected blocker and normalized write-scope list', async () => {
    const createTask = vi.fn(actions().createTask)
    render(<TeamAction {...props(actions({ createTask }))} />)
    fireEvent.click(screen.getByRole('button', { name: /Agent Team/u }))
    await screen.findByText('Implement runtime')
    fireEvent.click(screen.getByRole('button', { name: /新建任务/u }))
    fireEvent.change(screen.getByPlaceholderText('任务标题'), { target: { value: ' New task ' } })
    fireEvent.change(screen.getByPlaceholderText('任务描述'), { target: { value: ' Details ' } })
    fireEvent.click(screen.getByRole('checkbox', { name: 'task-1 · Implement runtime' }))
    fireEvent.change(screen.getByPlaceholderText(/写入范围/u), { target: { value: 'src/a, src/b' } })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => {
      expect(createTask).toHaveBeenCalledWith(SESSION, {
        subject: 'New task',
        description: 'Details',
        blockedBy: ['task-1'],
        writeScopes: ['src/a', 'src/b'],
      })
    })
  })

  it('selects dependencies by real task id and commits one atomic CAS from the shared detail', async () => {
    const first: TeamTask = {
      ...task,
      subject: 'A',
      description: 'First prerequisite',
      status: 'completed',
      ownerName: 'lead',
      ready: false,
      writeScopeWarnings: [],
    }
    const second: TeamTask = {
      ...task,
      id: TASK_2,
      subject: 'B',
      description: 'Second prerequisite',
      status: 'completed',
      ownerName: 'lead',
      ready: false,
      writeScopeWarnings: [],
    }
    let dependent: TeamTask = {
      ...task,
      id: TASK_3,
      revision: 7,
      subject: 'C',
      description: 'Depends on selected prerequisites',
      status: 'pending',
      blockedBy: [TASK_1],
      ready: true,
      writeScopeWarnings: [],
    }
    const load = vi.fn(() => Promise.resolve({
      ok: true as const,
      value: { ...view, tasks: [first, second, dependent] },
    }))
    const updateTask = vi.fn<TeamActionInjected['updateTask']>((_sessionId, input) => {
      dependent = {
        ...dependent,
        revision: dependent.revision + 1,
        subject: input.subject ?? dependent.subject,
        description: input.description ?? dependent.description,
        blockedBy: input.blockedBy ?? dependent.blockedBy,
        writeScopes: input.writeScopes ?? dependent.writeScopes,
      }
      return Promise.resolve(taskSuccess(dependent))
    })
    render(<TeamAction {...props(actions({ load, updateTask }))} />)

    fireEvent.click(screen.getByRole('button', { name: /Agent Team/u }))
    await screen.findByText('First prerequisite')
    fireEvent.click(screen.getByRole('button', { name: 'task-3 · C' }))
    fireEvent.click(screen.getByRole('button', { name: /编辑/u }))

    const dependencies = screen.getByRole('group', { name: zh.blockers })
    const firstChoice = within(dependencies).getByRole<HTMLInputElement>('checkbox', { name: 'task-1 · A' })
    const secondChoice = within(dependencies).getByRole<HTMLInputElement>('checkbox', { name: 'task-2 · B' })
    expect(firstChoice.checked).toBe(true)
    expect(secondChoice.checked).toBe(false)
    expect(within(dependencies).queryByRole('checkbox', { name: 'task-3 · C' })).toBeNull()

    fireEvent.click(firstChoice)
    fireEvent.click(secondChoice)
    expect(updateTask).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: zh.taskGraph }))
    const graph = screen.getByRole('application', { name: zh.taskGraph })
    expect(within(graph).getByLabelText('task-1 → task-3')).toBeTruthy()
    expect(within(graph).queryByLabelText('task-2 → task-3')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: zh.save }))
    await waitFor(() => { expect(updateTask).toHaveBeenCalledTimes(1) })
    expect(updateTask).toHaveBeenCalledWith(SESSION, {
      taskId: TASK_3,
      expectedRevision: 7,
      action: 'edit',
      subject: 'C',
      description: 'Depends on selected prerequisites',
      blockedBy: [TASK_2],
      writeScopes: ['src'],
    })
    await waitFor(() => {
      expect(screen.getByRole('region', { name: zh.taskDetails }).textContent).toContain('依赖: task-2')
      expect(within(graph).getByLabelText('task-2 → task-3')).toBeTruthy()
      expect(within(graph).queryByLabelText('task-1 → task-3')).toBeNull()
    })
  })

  it('assigns, edits, completes, reopens, and deletes with contiguous CAS revisions', async () => {
    const taskZero: TeamTask = {
      ...dependencyOption,
      id: 'task-0' as TeamTaskId,
      subject: 'Prerequisite',
    }
    let current = { ...task }
    const updateTask: TeamActionInjected['updateTask'] = vi.fn((
      _sessionId: SessionId,
      input: Parameters<TeamActionInjected['updateTask']>[1],
    ) => {
      const revision = current.revision + 1
      switch (input.action) {
        case 'reassign':
          current = {
            ...current,
            revision,
            status: 'in_progress',
            ownerName: input.owner ?? 'lead',
          }
          break
        case 'edit':
          current = {
            ...current,
            revision,
            subject: input.subject ?? current.subject,
            description: input.description ?? current.description,
            blockedBy: input.blockedBy ?? current.blockedBy,
            writeScopes: input.writeScopes ?? current.writeScopes,
          }
          break
        case 'set_dependencies':
          current = { ...current, revision, blockedBy: input.blockedBy ?? [] }
          break
        case 'complete':
          current = { ...current, revision, status: 'completed' }
          break
        case 'reopen': {
          const { ownerName: _ownerName, ...unowned } = current
          current = { ...unowned, revision, status: 'pending', ready: true }
          break
        }
        case 'delete':
          current = { ...current, revision, status: 'deleted' }
          break
        default:
          throw new Error(`unexpected action ${input.action}`)
      }
      return Promise.resolve(taskSuccess(current))
    })
    const load = vi.fn(() => Promise.resolve({
      ok: true as const,
      value: { ...view, tasks: current.status === 'deleted' ? [taskZero] : [current, taskZero] },
    }))
    render(<TeamAction {...props(actions({ load, updateTask }))} />)
    fireEvent.click(screen.getByRole('button', { name: /Agent Team/u }))
    await screen.findByText('Implement runtime')

    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'worker' } })
    await waitFor(() => {
      expect(screen.getByRole<HTMLSelectElement>('combobox').value).toBe('worker')
      expect(current).toMatchObject({ revision: 2, ownerName: 'worker' })
    })

    fireEvent.click(screen.getByRole('button', { name: /编辑/u }))
    fireEvent.change(screen.getByPlaceholderText('任务标题'), { target: { value: 'Updated runtime' } })
    fireEvent.change(screen.getByPlaceholderText('任务描述'), { target: { value: 'Updated details' } })
    fireEvent.click(screen.getByRole('checkbox', { name: 'task-0 · Prerequisite' }))
    fireEvent.change(screen.getByPlaceholderText(/写入范围/u), { target: { value: 'src/runtime' } })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    expect(await screen.findByText('Updated runtime')).toBeTruthy()
    expect(current).toMatchObject({
      revision: 3,
      description: 'Updated details',
      blockedBy: ['task-0'],
      writeScopes: ['src/runtime'],
    })

    fireEvent.click(screen.getByRole('button', { name: /完成/u }))
    fireEvent.click(await screen.findByRole('button', { name: /重开/u }))
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: /重开/u })).toBeNull()
      expect(current).toMatchObject({ revision: 5, status: 'pending' })
    })
    fireEvent.click(screen.getByRole('button', { name: /删除/u }))
    await waitFor(() => { expect(screen.queryByText('Updated runtime')).toBeNull() })

    expect(vi.mocked(updateTask).mock.calls.map(([, input]) => [input.action, input.expectedRevision]))
      .toEqual([
        ['reassign', 1],
        ['edit', 2],
        ['complete', 3],
        ['reopen', 4],
        ['delete', 5],
      ])
  })

  it('reloads and warns instead of retrying a stale task mutation', async () => {
    const load = vi.fn()
      .mockResolvedValueOnce({ ok: true, value: view })
      .mockResolvedValueOnce({ ok: true, value: { ...view, tasks: [{ ...task, revision: 2 }] } })
    const updateTask = vi.fn(() => Promise.resolve(taskConflict('stale')))
    render(<TeamAction {...props(actions({ load, updateTask }))} />)
    fireEvent.click(screen.getByRole('button', { name: /Agent Team/u }))
    await screen.findByText('Implement runtime')
    fireEvent.click(screen.getByRole('button', { name: /完成/u }))
    expect(await screen.findByText(zh.conflict)).toBeTruthy()
    expect(load).toHaveBeenCalledTimes(2)
    expect(updateTask).toHaveBeenCalledTimes(1)
  })

  it('reloads the authoritative task while retaining a conflicting client draft as unsaved', async () => {
    const firstBlocker: TeamTask = {
      ...task,
      subject: 'A',
      description: 'First dependency',
      status: 'completed',
      writeScopeWarnings: [],
    }
    const secondBlocker: TeamTask = {
      ...task,
      id: TASK_2,
      subject: 'B',
      description: 'Second dependency',
      status: 'completed',
      writeScopeWarnings: [],
    }
    const initial: TeamTask = {
      ...task,
      id: TASK_3,
      subject: 'C',
      description: 'Shared initial value',
      status: 'pending',
      ownerName: 'lead',
      ready: true,
      writeScopeWarnings: [],
    }
    let authoritative = initial
    const currentView = (): TeamView => ({ ...view, tasks: [firstBlocker, secondBlocker, authoritative] })
    const firstLoad = vi.fn(() => Promise.resolve({ ok: true as const, value: currentView() }))
    const secondLoad = vi.fn()
      .mockResolvedValueOnce({ ok: true as const, value: { ...view, tasks: [firstBlocker, secondBlocker, initial] } })
      .mockImplementation(() => Promise.resolve({ ok: true as const, value: currentView() }))
    const firstUpdate = vi.fn<TeamActionInjected['updateTask']>((_sessionId, input) => {
      authoritative = {
        ...authoritative,
        revision: 2,
        subject: input.subject ?? authoritative.subject,
        description: input.description ?? authoritative.description,
        blockedBy: input.blockedBy ?? authoritative.blockedBy,
      }
      return Promise.resolve(taskSuccess(authoritative))
    })
    const secondUpdate = vi.fn<TeamActionInjected['updateTask']>(() => Promise.resolve(taskConflict('stale revision 1')))
    const firstClient = render(<TeamAction {...props(actions({ load: firstLoad, updateTask: firstUpdate }))} />)
    const secondClient = render(<TeamAction {...props(actions({ load: secondLoad, updateTask: secondUpdate }))} />)

    for (const client of [firstClient, secondClient]) {
      fireEvent.click(within(client.container).getByRole('button', { name: /Agent Team/u }))
      await within(client.container).findByRole('button', { name: 'task-3 · C' })
      fireEvent.click(within(client.container).getByRole('button', { name: 'task-3 · C' }))
      fireEvent.click(within(client.container).getByRole('button', { name: /编辑/u }))
    }
    fireEvent.change(within(firstClient.container).getByPlaceholderText(zh.subject), {
      target: { value: 'Committed by client A' },
    })
    fireEvent.click(within(firstClient.container).getByRole('checkbox', { name: 'task-1 · A' }))
    fireEvent.change(within(secondClient.container).getByPlaceholderText(zh.subject), {
      target: { value: 'Unsaved client B draft' },
    })
    fireEvent.click(within(secondClient.container).getByRole('checkbox', { name: 'task-2 · B' }))

    fireEvent.click(within(firstClient.container).getByRole('button', { name: zh.save }))
    await within(firstClient.container).findByRole('button', { name: 'task-3 · Committed by client A' })
    fireEvent.click(within(secondClient.container).getByRole('button', { name: zh.save }))

    expect(await within(secondClient.container).findByText('任务当前版本已重新加载；你的草稿尚未保存。')).toBeTruthy()
    expect(within(secondClient.container).getByRole('button', {
      name: 'task-3 · Committed by client A',
    })).toBeTruthy()
    expect(within(secondClient.container).getByDisplayValue('Unsaved client B draft')).toBeTruthy()
    expect(within(secondClient.container).getByRole<HTMLInputElement>('checkbox', { name: 'task-1 · A' }).checked).toBe(false)
    expect(within(secondClient.container).getByRole<HTMLInputElement>('checkbox', { name: 'task-2 · B' }).checked).toBe(true)
    expect(secondUpdate).toHaveBeenCalledTimes(1)
    expect(secondUpdate).toHaveBeenCalledWith(SESSION, expect.objectContaining({
      taskId: TASK_3,
      expectedRevision: 1,
      action: 'edit',
      blockedBy: [TASK_2],
    }))
    expect(secondLoad).toHaveBeenCalledTimes(2)
  })

  it('keeps reload failures visible after task and dependency conflicts', async () => {
    const taskLoad = vi.fn()
      .mockResolvedValueOnce({ ok: true, value: view })
      .mockResolvedValueOnce(remoteFailure('task reload failed'))
    const first = render(<TeamAction {...props(actions({
      load: taskLoad,
      updateTask: () => Promise.resolve(taskConflict('stale task')),
    }))} />)
    fireEvent.click(screen.getByRole('button', { name: /Agent Team/u }))
    await screen.findByText('Implement runtime')
    fireEvent.click(screen.getByRole('button', { name: /完成/u }))
    expect(await screen.findByText('task reload failed (gateway/internal)')).toBeTruthy()
    expect(screen.queryByText(zh.conflict)).toBeNull()
    first.unmount()

    const dependencyLoad = vi.fn()
      .mockResolvedValueOnce({ ok: true, value: { ...view, tasks: [task, dependencyOption] } })
      .mockResolvedValueOnce(remoteFailure('dependency reload failed'))
    const dependencyUpdate = vi.fn()
      .mockResolvedValueOnce(taskConflict('stale dependency'))
    render(<TeamAction {...props(actions({ load: dependencyLoad, updateTask: dependencyUpdate }))} />)
    fireEvent.click(screen.getByRole('button', { name: /Agent Team/u }))
    await screen.findByText('Implement runtime')
    fireEvent.click(screen.getByRole('button', { name: /编辑/u }))
    fireEvent.change(screen.getByPlaceholderText('任务标题'), { target: { value: 'Edited' } })
    fireEvent.click(screen.getByRole('checkbox', { name: 'task-2 · Dependency option' }))
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    expect(await screen.findByText('dependency reload failed (gateway/internal)')).toBeTruthy()
    expect(screen.queryByText(zh.conflict)).toBeNull()
  })

  it('renders roster/task state variants and contains navigation, refresh, and close actions', async () => {
    const { ownerName: _ownerName, ...unownedTask } = task
    const richView: TeamView = {
      ...view,
      members: [
        view.members[0]!,
        { ...view.members[1]!, status: 'running' },
        {
          id: 'failed-id' as SessionId,
          name: 'failed-worker',
          role: 'teammate',
          status: 'failed',
          diagnostics: ['provider failed'],
        },
        {
          id: 'provisioning-id' as SessionId,
          name: 'provisioning-worker',
          role: 'teammate',
          status: 'provisioning',
          diagnostics: [],
        },
      ],
      tasks: [
        { ...unownedTask, id: 'ready-task' as TeamTaskId, status: 'pending', ready: true },
        { ...unownedTask, id: 'blocked-task' as TeamTaskId, status: 'pending', ready: false },
        { ...task, id: 'completed-task' as TeamTaskId, status: 'completed' },
      ],
    }
    const load = vi.fn(() => Promise.resolve({ ok: true as const, value: richView }))
    const openTeammate = vi.fn(() => Promise.reject(new Error('navigation failed')))
    render(<TeamAction {...props(actions({ load, openTeammate }))} />)
    fireEvent.click(screen.getByRole('button', { name: /Agent Team/u }))
    expect(await screen.findByText('provider failed')).toBeTruthy()
    expect(screen.getByText(zh.ready)).toBeTruthy()
    expect(screen.getByText(zh.blocked)).toBeTruthy()
    expect(screen.getByRole<HTMLButtonElement>('button', { name: /failed-worker/u }).disabled).toBe(true)
    expect(screen.getByRole<HTMLButtonElement>('button', { name: /provisioning-worker/u }).disabled).toBe(true)

    fireEvent.click(screen.getByRole('button', { name: /^worker运行中/u }))
    expect(await screen.findByText('Error: navigation failed')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: zh.refresh }))
    await waitFor(() => { expect(load).toHaveBeenCalledTimes(2) })
    fireEvent.click(screen.getByRole('button', { name: /Agent Team/u }))
    expect(screen.queryByRole('dialog')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /Agent Team/u }))
    await screen.findByRole('dialog')
    fireEvent.click(screen.getByRole('button', { name: zh.close }))
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('shows load and create failures and ignores a create result after a session switch', async () => {
    const failedLoad = actions({
      load: () => Promise.resolve(remoteFailure('load failed')),
    })
    const first = render(<TeamAction {...props(failedLoad)} />)
    fireEvent.click(screen.getByRole('button', { name: /Agent Team/u }))
    expect(await screen.findByText('load failed (gateway/internal)')).toBeTruthy()
    first.unmount()

    const createTask = vi.fn(() => Promise.resolve(remoteFailure('create failed')))
    const second = render(<TeamAction {...props(actions({ createTask }))} />)
    fireEvent.click(screen.getByRole('button', { name: /Agent Team/u }))
    await screen.findByText('Implement runtime')
    fireEvent.click(screen.getByRole('button', { name: /新建任务/u }))
    fireEvent.change(screen.getByPlaceholderText('任务标题'), { target: { value: 'Task' } })
    fireEvent.change(screen.getByPlaceholderText('任务描述'), { target: { value: 'Description' } })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    expect(await screen.findByText('create failed (gateway/internal)')).toBeTruthy()
    second.unmount()

    const pending = Promise.withResolvers<TeamTaskActionResult>()
    const third = render(<TeamAction {...props(actions({ createTask: () => pending.promise }))} />)
    fireEvent.click(screen.getByRole('button', { name: /Agent Team/u }))
    await screen.findByText('Implement runtime')
    fireEvent.click(screen.getByRole('button', { name: /新建任务/u }))
    fireEvent.change(screen.getByPlaceholderText('任务标题'), { target: { value: 'Late task' } })
    fireEvent.change(screen.getByPlaceholderText('任务描述'), { target: { value: 'Late description' } })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    third.rerender(<TeamAction {...props(actions(), 'next-session' as SessionId)} />)
    pending.resolve(taskSuccess({ ...task, id: 'late-task' as TeamTaskId }))
    await Promise.resolve()
    expect(screen.queryByText('Late task')).toBeNull()
  })

  it('contains stale-session and ordinary task failures without retrying', async () => {
    const pending = Promise.withResolvers<TeamTaskActionResult>()
    const rendered = render(<TeamAction {...props(actions({ updateTask: () => pending.promise }))} />)
    fireEvent.click(screen.getByRole('button', { name: /Agent Team/u }))
    await screen.findByText('Implement runtime')
    fireEvent.click(screen.getByRole('button', { name: /完成/u }))
    rendered.rerender(<TeamAction {...props(actions(), 'next-session' as SessionId)} />)
    pending.resolve(taskSuccess({ ...task, revision: 2, status: 'completed' }))
    await Promise.resolve()
    expect(screen.queryByText('Implement runtime')).toBeNull()
    rendered.unmount()

    render(<TeamAction {...props(actions({
      updateTask: () => Promise.resolve(taskRejected('update failed')),
    }))} />)
    fireEvent.click(screen.getByRole('button', { name: /Agent Team/u }))
    await screen.findByText('Implement runtime')
    fireEvent.click(screen.getByRole('button', { name: /完成/u }))
    expect(await screen.findByText('update failed (team-rejected)')).toBeTruthy()
  })

  it('does not publish a task conflict after its reload switches sessions', async () => {
    const reload = Promise.withResolvers<TeamActionResult<TeamView>>()
    const load = vi.fn()
      .mockResolvedValueOnce({ ok: true, value: view })
      .mockImplementationOnce(() => reload.promise)
    const rendered = render(<TeamAction {...props(actions({
      load,
      updateTask: () => Promise.resolve(taskConflict('stale task')),
    }))} />)
    fireEvent.click(screen.getByRole('button', { name: /Agent Team/u }))
    await screen.findByText('Implement runtime')
    fireEvent.click(screen.getByRole('button', { name: /完成/u }))
    await waitFor(() => { expect(load).toHaveBeenCalledTimes(2) })

    rendered.rerender(<TeamAction {...props(actions(), 'next-session' as SessionId)} />)
    reload.resolve({ ok: true, value: view })
    await Promise.resolve()
    await Promise.resolve()
    expect(screen.queryByText(zh.conflict)).toBeNull()
  })

  it('does not settle a successful task after its reload switches sessions', async () => {
    const reload = Promise.withResolvers<TeamActionResult<TeamView>>()
    const load = vi.fn()
      .mockResolvedValueOnce({ ok: true, value: view })
      .mockImplementationOnce(() => reload.promise)
    const rendered = render(<TeamAction {...props(actions({
      load,
      updateTask: () => Promise.resolve(taskSuccess({ ...task, revision: 2, status: 'completed' })),
    }))} />)
    fireEvent.click(screen.getByRole('button', { name: /Agent Team/u }))
    await screen.findByText('Implement runtime')
    fireEvent.click(screen.getByRole('button', { name: /完成/u }))
    await waitFor(() => { expect(load).toHaveBeenCalledTimes(2) })

    rendered.rerender(<TeamAction {...props(actions(), 'next-session' as SessionId)} />)
    reload.resolve({ ok: true, value: { ...view, tasks: [{ ...task, revision: 2, status: 'completed' }] } })
    await Promise.resolve()
    await Promise.resolve()
    expect(screen.queryByText('Implement runtime')).toBeNull()
  })

  it('contains edit and dependency failures and supports form cancellation and unassignment', async () => {
    const { ownerName: _ownerName, ...unownedTask } = task
    const updateTask = vi.fn()
      .mockResolvedValueOnce(remoteFailure('edit failed'))
      .mockResolvedValueOnce(taskRejected('dependency failed'))
      .mockResolvedValueOnce(taskSuccess({ ...unownedTask, revision: 2 }))
    render(<TeamAction {...props(actions({
      load: () => Promise.resolve({ ok: true, value: { ...view, tasks: [task, dependencyOption] } }),
      updateTask,
    }))} />)
    fireEvent.click(screen.getByRole('button', { name: /Agent Team/u }))
    await screen.findByText('Implement runtime')

    fireEvent.click(screen.getByRole('button', { name: /新建任务/u }))
    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    expect(screen.queryByPlaceholderText('任务标题')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: /编辑/u }))
    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    expect(screen.queryByRole('button', { name: '保存' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /编辑/u }))
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    expect(await screen.findByText('edit failed (gateway/internal)')).toBeTruthy()

    fireEvent.change(screen.getByPlaceholderText('任务标题'), { target: { value: 'Saved edit' } })
    fireEvent.click(screen.getByRole('checkbox', { name: 'task-2 · Dependency option' }))
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    expect(await screen.findByText('dependency failed (team-rejected)')).toBeTruthy()
    expect(updateTask.mock.calls[1]?.[1]).toMatchObject({
      action: 'edit',
      expectedRevision: 1,
      blockedBy: ['task-2'],
    })

    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    fireEvent.change(screen.getByRole('combobox'), { target: { value: '' } })
    await waitFor(() => {
      expect(updateTask).toHaveBeenLastCalledWith(SESSION, expect.objectContaining({
        action: 'reassign',
      }))
      expect(updateTask.mock.calls.at(-1)?.[1]).not.toHaveProperty('owner')
    })
  })

  it('shows a Remote carrier failure from the atomic edit and dependency mutation', async () => {
    const updateTask = vi.fn().mockResolvedValueOnce(remoteFailure('dependency transport failed'))
    render(<TeamAction {...props(actions({
      load: () => Promise.resolve({ ok: true, value: { ...view, tasks: [task, dependencyOption] } }),
      updateTask,
    }))} />)
    fireEvent.click(screen.getByRole('button', { name: /Agent Team/u }))
    await screen.findByText('Implement runtime')
    fireEvent.click(screen.getByRole('button', { name: /编辑/u }))
    fireEvent.change(screen.getByPlaceholderText('任务标题'), { target: { value: 'Edited' } })
    fireEvent.click(screen.getByRole('checkbox', { name: 'task-2 · Dependency option' }))
    fireEvent.click(screen.getByRole('button', { name: '保存' }))

    expect(await screen.findByText('dependency transport failed (gateway/internal)')).toBeTruthy()
  })

  it('skips the dependency mutation when an edit keeps the same blockers', async () => {
    const blockedTask: TeamTask = { ...task, blockedBy: ['task-0' as TeamTaskId] }
    const updateTask = vi.fn().mockResolvedValue(
      taskSuccess({ ...blockedTask, revision: 2, subject: 'Same dependencies' }),
    )
    render(<TeamAction {...props(actions({
      load: () => Promise.resolve({ ok: true, value: { ...view, tasks: [blockedTask] } }),
      updateTask,
    }))} />)
    fireEvent.click(screen.getByRole('button', { name: /Agent Team/u }))
    await screen.findByText('Implement runtime')
    fireEvent.click(screen.getByRole('button', { name: /编辑/u }))
    fireEvent.change(screen.getByPlaceholderText('任务标题'), { target: { value: 'Same dependencies' } })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))

    await waitFor(() => { expect(screen.queryByRole('button', { name: '保存' })).toBeNull() })
    expect(updateTask).toHaveBeenCalledTimes(1)
    expect(updateTask).toHaveBeenCalledWith(SESSION, expect.objectContaining({ action: 'edit' }))
  })

  it('reloads an atomic edit conflict and ignores its settlement after a session switch', async () => {
    const taskView = { ...view, tasks: [task, dependencyOption] }
    const load = vi.fn()
      .mockResolvedValueOnce({ ok: true, value: taskView })
      .mockResolvedValueOnce({
        ok: true,
        value: { ...view, tasks: [{ ...task, revision: 2, subject: 'Current edit' }, dependencyOption] },
      })
    const conflictUpdate = vi.fn().mockResolvedValueOnce(taskConflict('stale dependency'))
    const first = render(<TeamAction {...props(actions({ load, updateTask: conflictUpdate }))} />)
    fireEvent.click(screen.getByRole('button', { name: /Agent Team/u }))
    await screen.findByText('Implement runtime')
    fireEvent.click(screen.getByRole('button', { name: /编辑/u }))
    fireEvent.change(screen.getByPlaceholderText('任务标题'), { target: { value: 'Conflict edit' } })
    fireEvent.click(screen.getByRole('checkbox', { name: 'task-2 · Dependency option' }))
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    expect(await screen.findByText(zh.conflictDraft)).toBeTruthy()
    expect(load).toHaveBeenCalledTimes(2)
    expect(conflictUpdate).toHaveBeenCalledTimes(1)
    first.unmount()

    const dependencyReload = Promise.withResolvers<TeamActionResult<TeamView>>()
    const dependencyLoad = vi.fn()
      .mockResolvedValueOnce({ ok: true, value: taskView })
      .mockImplementationOnce(() => dependencyReload.promise)
    const staleUpdate = vi.fn().mockResolvedValueOnce(taskConflict('stale dependency'))
    const second = render(<TeamAction {...props(actions({ load: dependencyLoad, updateTask: staleUpdate }))} />)
    fireEvent.click(screen.getByRole('button', { name: /Agent Team/u }))
    await screen.findByText('Implement runtime')
    fireEvent.click(screen.getByRole('button', { name: /编辑/u }))
    fireEvent.change(screen.getByPlaceholderText('任务标题'), { target: { value: 'Late edit' } })
    fireEvent.click(screen.getByRole('checkbox', { name: 'task-2 · Dependency option' }))
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => { expect(dependencyLoad).toHaveBeenCalledTimes(2) })
    second.rerender(<TeamAction {...props(actions(), 'next-session' as SessionId)} />)
    dependencyReload.resolve({ ok: true, value: { ...view, tasks: [{ ...task, revision: 3 }, dependencyOption] } })
    await Promise.resolve()
    await Promise.resolve()
    expect(screen.queryByText(zh.conflictDraft)).toBeNull()
    second.unmount()

    const dependency = Promise.withResolvers<TeamTaskActionResult>()
    const lateUpdate = vi.fn().mockImplementationOnce(() => dependency.promise)
    const third = render(<TeamAction {...props(actions({
      load: () => Promise.resolve({ ok: true, value: taskView }),
      updateTask: lateUpdate,
    }))} />)
    fireEvent.click(screen.getByRole('button', { name: /Agent Team/u }))
    await screen.findByText('Implement runtime')
    fireEvent.click(screen.getByRole('button', { name: /编辑/u }))
    fireEvent.change(screen.getByPlaceholderText('任务标题'), { target: { value: 'Late edit' } })
    fireEvent.click(screen.getByRole('checkbox', { name: 'task-2 · Dependency option' }))
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => { expect(lateUpdate).toHaveBeenCalledTimes(1) })
    expect(screen.getByRole<HTMLButtonElement>('button', { name: '保存' }).disabled).toBe(true)
    expect(screen.getByRole<HTMLButtonElement>('button', { name: '取消' }).disabled).toBe(true)
    third.rerender(<TeamAction {...props(actions(), 'next-session' as SessionId)} />)
    dependency.resolve(taskSuccess({ ...task, revision: 2, subject: 'Late dependency' }))
    await Promise.resolve()
    expect(screen.queryByText('Late dependency')).toBeNull()
  })
})
