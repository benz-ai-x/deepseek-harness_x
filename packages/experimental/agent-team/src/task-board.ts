/** Shared Team task DAG commands and runtime-enriched views. */

import type { Agent } from '@deepseek-ai/dsh-agent'
import { TeamId, TeamTaskId as toTeamTaskId } from './brand.ts'
import type { TeamMembership } from './roster.ts'
import { TeamError } from './error.ts'
import type { TeamJournal } from './journal.ts'
import type {
  CreateTeamTaskRequest,
  TeamTaskId,
  TeamTaskSnapshot,
  TeamTaskView,
  UpdateTeamTaskRequest,
  NativeMemberOperationSource,
  NativeMemberTaskRequest,
  NativeMemberTaskResult,
  TeamNativeTaskReceipt,
} from './types.ts'
import type { NativeMemberGrant } from './service-types.ts'
import { nativeOperationFingerprint, nativeOperationId } from './native-operation.ts'
import { requiredText } from './validation.ts'
import { prepareTaskUpdate, taskDependencies, taskWriteScopes, assertTaskGraph, taskView, nativeTaskResult } from './task-state.ts'

/** Owns Team task limits, authorization, transitions, and derived views. */
export class TeamTaskBoard {
  /**
   * @param journal - authoritative Lead-log transaction owner.
   * @param maxTasks - maximum non-deleted tasks retained by one Team.
   */
  constructor(
    private readonly journal: TeamJournal,
    private readonly maxTasks: number,
  ) {}

  /**
   * Create one unowned pending task in the Team Lead log.
   * @param membership - exact caller membership resolved by the Team roster.
   * @param request - task text, blockers, and advisory write scopes.
   * @returns the revision-one task view.
   */
  async create(membership: TeamMembership, request: CreateTeamTaskRequest): Promise<TeamTaskView> {
    const { root } = membership
    return this.journal.transact(root.id, async () => {
      const state = this.journal.state(root)
      const active = state.tasks.filter(task => task.status !== 'deleted').length
      if (active >= this.maxTasks) {
        throw new TeamError(`Team task limit ${this.maxTasks} reached`, 'TEAM_TASK_LIMIT')
      }
      const id = toTeamTaskId(`task-${state.nextTaskNumber}`)
      if (state.tasks.some(task => task.id === id)) {
        throw new TeamError('Team task id space exhausted', 'TEAM_TASK_LIMIT')
      }
      const task: TeamTaskSnapshot = {
        id,
        revision: 1,
        subject: requiredText(request.subject, 'subject', 200),
        description: requiredText(request.description, 'description', 16_384),
        status: 'pending',
        blockedBy: taskDependencies(request.blockedBy ?? [], state),
        writeScopes: taskWriteScopes(request.writeScopes ?? []),
      }
      assertTaskGraph(state, task)
      await this.journal.appendAndFlush(root, 'team/task', { version: 2, teamId: TeamId(root.id), task })
      return taskView(root.id, state, task)
    })
  }

  /**
   * Return one task, including a deleted tombstone.
   * @param membership - exact caller membership resolved by the Team roster.
   * @param id - Team-local task identity.
   * @returns the latest task value and derived readiness diagnostics.
   */
  get(membership: TeamMembership, id: TeamTaskId): TeamTaskView {
    const { root } = membership
    const state = this.journal.state(root)
    const task = state.tasks.find(candidate => candidate.id === id)
    if (task === undefined) throw new TeamError(`team task "${id}" not found`, 'TEAM_TASK_NOT_FOUND')
    return taskView(root.id, state, task)
  }

  /**
   * List current non-deleted tasks in numeric creation order.
   * @param membership - exact caller membership resolved by the Team roster.
   * @returns detached current task views.
   */
  list(membership: TeamMembership): TeamTaskView[] {
    const { root } = membership
    const state = this.journal.state(root)
    return state.tasks
      .filter(task => task.status !== 'deleted')
      .map(task => taskView(root.id, state, task))
  }

  /**
   * Commit a native task transition together with its original acceptance result.
   * @param identity - Team-issued member identity.
   * @param source - trusted turn and tool call identity.
   * @param request - validated task transition.
   * @param authorize - current member and live Lead check, repeated in the write queue.
   * @param signal - cancellation before durable acceptance.
   * @returns the original compact result for an identical accepted call.
   */
  async updateNative(
    identity: NativeMemberGrant['identity'],
    source: NativeMemberOperationSource,
    request: NativeMemberTaskRequest,
    authorize: () => TeamMembership,
    signal: AbortSignal,
  ): Promise<NativeMemberTaskResult> {
    const membership = authorize()
    const id = nativeOperationId(identity, source)
    const inputFingerprint = nativeOperationFingerprint(request)
    return this.journal.transact(membership.root.id, async () => {
      signal.throwIfAborted()
      const current = authorize()
      const state = this.journal.state(current.root)
      const prior = state.nativeOperations.find(receipt => receipt.id === id)
      if (prior !== undefined) {
        if (prior.inputFingerprint !== inputFingerprint || !('request' in prior)) {
          throw new TeamError('The native call already accepted different input.', 'TEAM_NATIVE_OPERATION_CONFLICT')
        }
        await this.journal.flush(current.root)
        return structuredClone(prior.result)
      }
      const task = prepareTaskUpdate(current.root.id, state, identity.memberId, current.role, request)
      const result = nativeTaskResult(current.root.id, state, task)
      const receipt: TeamNativeTaskReceipt = {
        id, memberId: identity.memberId, provider: identity.provider, nativeHandle: identity.nativeHandle,
        source: structuredClone(source), inputFingerprint, request: structuredClone(request), result,
      }
      await this.journal.appendAndFlush(current.root, 'team/native-operation/committed', {
        version: 4, kind: 'task', teamId: identity.teamId, task, receipt,
      })
      return structuredClone(result)
    })
  }

  /**
   * Compare-and-set one authorized task transition.
   * @param caller - exact live Team member authorizing the mutation.
   * @param membership - caller role and exact live Lead.
   * @param request - task identity, expected revision, action, and action fields.
   * @returns the committed next task revision.
   */
  async update(
    caller: Agent,
    membership: TeamMembership,
    request: UpdateTeamTaskRequest,
  ): Promise<TeamTaskView> {
    const root = membership.root
    return this.journal.transact(root.id, async () => {
      const state = this.journal.state(root)
      const task = prepareTaskUpdate(root.id, state, caller.id, membership.role, request)
      await this.journal.appendAndFlush(root, 'team/task', { version: 2, teamId: TeamId(root.id), task })
      return taskView(root.id, state, task)
    })
  }

}
