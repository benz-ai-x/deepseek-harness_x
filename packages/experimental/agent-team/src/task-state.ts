/** Shared task transitions and derived views used by commands and durable receipt validation. */

import type { SessionId } from '@deepseek-ai/dsh-session'
import { TeamError } from './error.ts'
import type { TeamState } from './projection.ts'
import { resolveActiveMember } from './roster.ts'
import { assertTaskGraphCandidate, TeamTaskGraphError } from './task-graph.ts'
import type { TeamTaskGraphViolation } from './task-graph.ts'
import type { TeamTaskId, TeamTaskSnapshot, TeamTaskView, UpdateTeamTaskRequest, NativeMemberTaskResult } from './types.ts'
import { requiredText, writeScope } from './validation.ts'

/** Whether two normalized file or directory prefixes overlap on path components. */
function scopesOverlap(left: string, right: string): boolean {
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`)
}

const TASK_GRAPH_ERROR_CODES: Record<TeamTaskGraphViolation, string> = {
  missing: 'TEAM_TASK_NOT_FOUND',
  duplicate: 'TEAM_INVALID_ARGUMENT',
  cycle: 'TEAM_TASK_DEPENDENCY_CYCLE',
}

/**
 * Calculate a task transition under already-resolved member authority.
 * @param rootId - durable Team Lead identity.
 * @param state - authoritative state before the transition.
 * @param actorId - exact Agent or granted native member identity.
 * @param role - authority resolved by the roster, never model input.
 * @param request - compare-and-set action and fields.
 * @returns the next snapshot after all task rules pass.
 */
export function prepareTaskUpdate(
  rootId: SessionId,
  state: TeamState,
  actorId: SessionId,
  role: 'lead' | 'teammate',
  request: UpdateTeamTaskRequest,
): TeamTaskSnapshot {
  const current = state.tasks.find(task => task.id === request.taskId)
  if (current === undefined) throw new TeamError(`team task "${request.taskId}" not found`, 'TEAM_TASK_NOT_FOUND')
  if (current.revision !== request.expectedRevision) {
    throw new TeamError(
      `stale team task "${current.id}" revision ${request.expectedRevision}; current revision is ${current.revision}`,
      'TEAM_TASK_STALE_REVISION',
      { currentRevision: current.revision },
    )
  }
  if (current.status === 'deleted') throw new TeamError(`team task "${current.id}" is deleted`, 'TEAM_TASK_DELETED')
  const lead = role === 'lead'
  const owner = current.ownerId === actorId
  const authorizeOwner = (): void => {
    if (!lead && !owner) throw new TeamError('task mutation requires its owner or Team Lead', 'TEAM_TASK_UNAUTHORIZED')
  }
  let next: TeamTaskSnapshot
  switch (request.action) {
    case 'claim':
      if (current.ownerId !== undefined && current.ownerId !== actorId) {
        throw new TeamError(`team task "${current.id}" is owned by another member`, 'TEAM_TASK_ALREADY_CLAIMED')
      }
      if (current.status !== 'pending' || !taskReady(state, current)) {
        throw new TeamError(`team task "${current.id}" is not ready to claim`, 'TEAM_TASK_BLOCKED')
      }
      next = { ...current, status: 'in_progress', ownerId: actorId }
      break
    case 'release':
      authorizeOwner()
      if (current.status !== 'in_progress') throw new TeamError('only an in-progress task can be released', 'TEAM_TASK_INVALID_TRANSITION')
      next = withoutOwner({ ...current, status: 'pending' })
      break
    case 'edit':
      authorizeOwner()
      if (request.subject === undefined && request.description === undefined && request.writeScopes === undefined) {
        throw new TeamError('task edit requires subject, description, or write_scopes', 'TEAM_INVALID_ARGUMENT')
      }
      next = {
        ...current,
        ...request.subject === undefined ? {} : { subject: requiredText(request.subject, 'subject', 200) },
        ...request.description === undefined
          ? {}
          : { description: requiredText(request.description, 'description', 16_384) },
        ...request.writeScopes === undefined ? {} : { writeScopes: taskWriteScopes(request.writeScopes) },
      }
      break
    case 'set_dependencies':
      authorizeOwner()
      if (request.blockedBy === undefined) throw new TeamError('set_dependencies requires blocked_by', 'TEAM_INVALID_ARGUMENT')
      next = { ...current, blockedBy: taskDependencies(request.blockedBy, state, current.id) }
      break
    case 'complete':
      authorizeOwner()
      if (current.status !== 'in_progress') throw new TeamError('only an in-progress task can complete', 'TEAM_TASK_INVALID_TRANSITION')
      next = { ...current, status: 'completed' }
      break
    case 'reopen':
      authorizeOwner()
      if (current.status !== 'completed') throw new TeamError('only a completed task can reopen', 'TEAM_TASK_INVALID_TRANSITION')
      next = withoutOwner({ ...current, status: 'pending' })
      break
    case 'reassign': {
      if (!lead) throw new TeamError('only the Team Lead can reassign tasks', 'TEAM_LEAD_REQUIRED')
      if (current.status !== 'pending' && current.status !== 'in_progress') {
        throw new TeamError(
          'only a pending or in-progress task can be reassigned',
          'TEAM_TASK_INVALID_TRANSITION',
        )
      }
      if (request.owner === undefined || request.owner.trim().length === 0) {
        next = withoutOwner({ ...current, status: 'pending' })
        break
      }
      if (!taskReady(state, current)) throw new TeamError(`team task "${current.id}" is blocked`, 'TEAM_TASK_BLOCKED')
      const assignee = resolveActiveMember(rootId, state, request.owner)
      next = { ...current, status: 'in_progress', ownerId: assignee.id }
      break
    }
    case 'delete': {
      authorizeOwner()
      const dependent = state.tasks.find(task =>
        task.status !== 'deleted' && task.id !== current.id && task.blockedBy.includes(current.id))
      if (dependent !== undefined) {
        throw new TeamError(`team task "${current.id}" still blocks "${dependent.id}"`, 'TEAM_TASK_HAS_DEPENDENTS')
      }
      next = { ...current, status: 'deleted' }
      break
    }
    /* v8 ignore next 2 -- TeamTaskAction is closed and every member is handled above. */
    default:
      throw new TeamError(`unsupported task action ${String(request.action)}`, 'TEAM_INVALID_ARGUMENT')
  }
  const task: TeamTaskSnapshot = {
    ...next,
    revision: current.revision + 1,
  }
  assertTaskGraph(state, task)

  return task
}

/**
 * Validate dependency ids against the current task graph, rejecting duplicates.
 * @param values - requested blockers.
 * @param state - current Team tasks.
 * @param self - task being updated, absent during creation.
 * @returns validated blocker identities.
 */
export function taskDependencies(
  values: readonly TeamTaskId[],
  state: TeamState,
  self?: TeamTaskId,
): TeamTaskId[] {
  const seen = new Set<TeamTaskId>()
  const result: TeamTaskId[] = []
  for (const id of values) {
    if (id === self) throw new TeamError('a team task cannot block itself', 'TEAM_TASK_DEPENDENCY_CYCLE')
    if (seen.has(id)) throw new TeamError(`duplicate blocker "${id}"`, 'TEAM_INVALID_ARGUMENT')
    const task = state.tasks.find(candidate => candidate.id === id)
    if (task === undefined || task.status === 'deleted') {
      throw new TeamError(`blocker task "${id}" not found`, 'TEAM_TASK_NOT_FOUND')
    }
    seen.add(id)
    result.push(id)
  }
  return result
}

/**
 * Normalize and de-duplicate advisory task write scopes.
 * @param values - requested file or directory prefixes.
 * @returns normalized scopes without acquiring locks.
 */
export function taskWriteScopes(values: readonly string[]): string[] {
  return [...new Set(values.map(writeScope))]
}

/**
 * Map shared task-graph validation onto stable command error codes.
 * @param state - current Team tasks.
 * @param candidate - proposed replacement snapshot.
 */
export function assertTaskGraph(state: TeamState, candidate: TeamTaskSnapshot): void {
  try {
    assertTaskGraphCandidate(state.tasks, candidate)
  } catch (error: unknown) {
    /* v8 ignore next -- the shared validator is the only statement in the try and throws this exact error. */
    if (!(error instanceof TeamTaskGraphError)) throw error
    throw new TeamError(error.message, TASK_GRAPH_ERROR_CODES[error.violation], { cause: error })
  }
}

/** Whether all current blockers completed. */
function taskReady(state: TeamState, task: TeamTaskSnapshot): boolean {
  return task.blockedBy.every(id => state.tasks.find(candidate => candidate.id === id)?.status === 'completed')
}

/** Remove an optional owner field under exactOptionalPropertyTypes. */
function withoutOwner(task: TeamTaskSnapshot): TeamTaskSnapshot {
  const { ownerId: _ownerId, ...without } = task
  return without
}

/**
 * Build one task view with owner name, readiness, and advisory write overlaps.
 * A committing caller may pass its pre-append state because `task` supplies the
 * new value explicitly; owner names, blocker readiness, and other task scopes
 * do not change when that snapshot is appended.
 * @param rootId - durable Lead identity used to render ownership.
 * @param state - current Team roster and tasks.
 * @param task - snapshot whose derived diagnostics are requested.
 * @returns detached task fields with owner name, readiness, and advisory overlaps.
 */
export function taskView(rootId: SessionId, state: TeamState, task: TeamTaskSnapshot): TeamTaskView {
  const ownerName = task.ownerId === undefined
    ? undefined
    : task.ownerId === rootId
      ? 'lead'
      : state.members.find(member => member.id === task.ownerId)?.name
  const warnings = new Set<string>()
  for (const other of state.tasks) {
    if (other.id === task.id || other.status !== 'in_progress') continue
    if (task.writeScopes.some(left => other.writeScopes.some(right => scopesOverlap(left, right)))) {
      warnings.add(`write scopes overlap with ${other.id}`)
    }
  }
  return {
    id: task.id,
    revision: task.revision,
    subject: task.subject,
    description: task.description,
    status: task.status,
    blockedBy: structuredClone(task.blockedBy),
    writeScopes: structuredClone(task.writeScopes),
    ...ownerName === undefined ? {} : { ownerName },
    ready: task.status === 'pending' && taskReady(state, task),
    writeScopeWarnings: [...warnings],
  }
}

/**
 * Render a task acceptance without copying task text or dependency lists into the receipt.
 * @param rootId - durable Lead identity used to render ownership.
 * @param state - authoritative Team state before the transition.
 * @param task - accepted task snapshot.
 * @returns bounded original mutation result suitable for native text transports.
 */
export function nativeTaskResult(rootId: SessionId, state: TeamState, task: TeamTaskSnapshot): NativeMemberTaskResult {
  const { id, revision, status, ownerName, ready } = taskView(rootId, state, task)
  return { ok: true, operation: 'tasks.update', value: { task: {
    id, revision, status, ready, ...ownerName === undefined ? {} : { ownerName },
  } } }
}
