/** Native member queries consume the Team owner's current authorization and roster. */

import { Buffer } from 'node:buffer'
import { z } from 'zod'
import { TeamTaskId } from './brand.ts'
import { TeamError } from './error.ts'
import type { NativeMemberGrant, NativeMemberOperationResult } from './service-types.ts'
import type { TeamMembership } from './roster.ts'
import type { TeamTaskBoard } from './task-board.ts'
import type { TeamMemberView } from './types.ts'

const taskId = z.string().min(1).max(128)
const requestSchema = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('members.list') }).strict(),
  z.object({
    operation: z.literal('tasks.list'),
    limit: z.number().int().min(1).max(100).default(20),
    cursor: taskId.optional(),
  }).strict(),
  z.object({ operation: z.literal('tasks.get'), taskId }).strict(),
])

/** Bound the complete JSON value, including the operation and page metadata. */
function boundedResult(result: NativeMemberOperationResult): NativeMemberOperationResult {
  if (Buffer.byteLength(JSON.stringify(result), 'utf8') <= 65_536) return result
  return { ok: false, error: {
    code: 'TEAM_NATIVE_RESULT_LIMIT', message: 'The Team query result exceeds 65536 UTF-8 bytes; request a smaller task page.',
  } }
}

/**
 * Bind current member authority without constructing an Agent or exposing an issuer.
 * @param identity - accepted Team, member, provider and native handle.
 * @param signal - registration and handle lifetime.
 * @param authorize - rechecks exact registration, durable member and live Lead.
 * @param members - existing roster reader under the granted membership.
 * @param tasks - existing task board readers under the granted membership.
 * @returns the nonserializable member grant.
 */
export function createNativeMemberGrant(
  identity: NativeMemberGrant['identity'],
  signal: AbortSignal,
  authorize: () => TeamMembership,
  members: (membership: TeamMembership) => TeamMemberView[],
  tasks: Pick<TeamTaskBoard, 'list' | 'get'>,
): NativeMemberGrant {
  return Object.freeze({
    identity: Object.freeze({ ...identity }),
    signal,
    execute(input: unknown, callerSignal: AbortSignal): Promise<NativeMemberOperationResult> {
      return Promise.resolve().then((): NativeMemberOperationResult => {
        let membership: TeamMembership
        try {
          if (signal.aborted) throw new Error('revoked')
          membership = authorize()
        } catch {
          // Authorization failures expose neither stale objects nor provider diagnostics.
          return { ok: false, error: { code: 'TEAM_NATIVE_GRANT_REVOKED', message: 'This Team authorization is no longer active.' } }
        }
        if (callerSignal.aborted) return { ok: false, error: { code: 'TEAM_NATIVE_CANCELLED', message: 'The Team query was cancelled.' } }
        try {
          const encoded = JSON.stringify(input)
          if (Buffer.byteLength(encoded, 'utf8') > 4_096) {
            return { ok: false, error: { code: 'TEAM_NATIVE_REQUEST_LIMIT', message: 'The Team query request exceeds 4096 UTF-8 bytes.' } }
          }
        } catch {
          return { ok: false, error: { code: 'TEAM_NATIVE_INVALID_REQUEST', message: 'The Team query arguments are invalid.' } }
        }
        const parsed = requestSchema.safeParse(input)
        if (!parsed.success) {
          return { ok: false, error: { code: 'TEAM_NATIVE_INVALID_REQUEST', message: 'The Team query arguments are invalid.' } }
        }
        const request = parsed.data
        try {
          switch (request.operation) {
            case 'members.list':
              return boundedResult({ ok: true, operation: request.operation, value: { members: members(membership) } })
            case 'tasks.get':
              return boundedResult({ ok: true, operation: request.operation,
                value: { task: tasks.get(membership, TeamTaskId(request.taskId)) } })
            case 'tasks.list': {
              const values = tasks.list(membership)
              const cursor = request.cursor
              const start = cursor === undefined ? 0 : values.findIndex(task => task.id === cursor) + 1
              if (cursor !== undefined && start === 0) {
                return { ok: false, error: { code: 'TEAM_NATIVE_INVALID_CURSOR', message: 'The task cursor is no longer available.' } }
              }
              const page = values.slice(start, start + request.limit)
              const last = page.at(-1)
              return boundedResult({ ok: true, operation: request.operation, value: {
                tasks: page,
                ...(last !== undefined && start + page.length < values.length ? { nextCursor: last.id } : {}),
              } })
            }
          }
        } catch (error: unknown) {
          if (error instanceof TeamError && error.code === 'TEAM_TASK_NOT_FOUND') {
            return { ok: false, error: { code: error.code, message: 'The task does not exist in this Team.' } }
          }
          return { ok: false, error: { code: 'TEAM_NATIVE_QUERY_FAILED', message: 'The Team query could not be completed.' } }
        }
      })
    },
  })
}
