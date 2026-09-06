/** Native member operations use the Team owner's current authority, readers, and durable mailbox. */

import { Buffer } from 'node:buffer'
import { z } from 'zod'
import { TeamTaskId } from './brand.ts'
import { nativeTaskRequestSchema } from './native-operation.ts'
import { TeamError } from './error.ts'
import type { NativeMemberGrant, NativeMemberOperationResult } from './service-types.ts'
import type { TeamMembership } from './roster.ts'
import type { TeamTaskBoard } from './task-board.ts'
import type { NativeMemberOperationSource, TeamMemberView } from './types.ts'
import type { TeamMailbox } from './mailbox.ts'
import type { TeamActivity } from './activity.ts'

const taskId = z.string().min(1).max(128)
const requestSchema = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('members.list') }).strict(),
  z.object({
    operation: z.literal('tasks.list'),
    limit: z.number().int().min(1).max(100).default(20),
    cursor: taskId.optional(),
  }).strict(),
  z.object({ operation: z.literal('tasks.get'), taskId }).strict(),
  nativeTaskRequestSchema,
  z.object({ operation: z.literal('wait'), timeoutMs: z.number() }).strict(),
  z.object({ operation: z.literal('messages.send'), target: z.string().trim().min(1), text: z.string().min(1) }).strict(),
  z.object({ operation: z.literal('turns.settle'), outcome: z.enum(['completed', 'failed', 'interrupted']),
    text: z.string().min(1) }).strict(),
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
 * @param tasks - existing task readers and native mutation admission.
 * @param mailbox - authoritative Team mailbox and durable operation receipts.
 * @param activity - existing Team activity observation without work scheduling.
 * @returns the nonserializable member grant.
 */
export function createNativeMemberGrant(
  identity: NativeMemberGrant['identity'],
  signal: AbortSignal,
  authorize: () => TeamMembership,
  members: (membership: TeamMembership) => TeamMemberView[],
  tasks: Pick<TeamTaskBoard, 'list' | 'get' | 'updateNative'>,
  mailbox: Pick<TeamMailbox, 'sendNative'>,
  activity: Pick<TeamActivity, 'wait'>,
): NativeMemberGrant {
  return Object.freeze({
    identity: Object.freeze({ ...identity }),
    signal,
    execute(input: unknown, callerSignal: AbortSignal, source?: NativeMemberOperationSource): Promise<NativeMemberOperationResult> {
      return Promise.resolve().then(async (): Promise<NativeMemberOperationResult> => {
        let membership: TeamMembership
        try {
          signal.throwIfAborted()
          membership = authorize()
        } catch {
          // Authorization failures expose neither stale objects nor provider diagnostics.
          return { ok: false, error: { code: 'TEAM_NATIVE_GRANT_REVOKED', message: 'This Team authorization is no longer active.' } }
        }
        try {
          callerSignal.throwIfAborted()
        } catch {
          return { ok: false, error: { code: 'TEAM_NATIVE_CANCELLED', message: 'The Team query was cancelled.' } }
        }
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
            case 'wait': {
              const value = await activity.wait(membership.id, request.timeoutMs, AbortSignal.any([signal, callerSignal]))
              signal.throwIfAborted()
              authorize()
              return { ok: true, operation: 'wait', value }
            }
            case 'tasks.update':
            case 'messages.send':
            case 'turns.settle': {
              if (source?.kind !== (request.operation === 'turns.settle' ? 'settlement' : 'tool')) return { ok: false, error: {
                code: 'TEAM_NATIVE_CORRELATION_REQUIRED', message: 'The native call has no trusted operation identity.',
              } }
              const operationSignal = AbortSignal.any([signal, callerSignal])
              const result = request.operation === 'tasks.update'
                ? await tasks.updateNative(identity, source, {
                  operation: request.operation, taskId: request.taskId, expectedRevision: request.expectedRevision,
                  action: request.action,
                  ...request.subject === undefined ? {} : { subject: request.subject },
                  ...request.description === undefined ? {} : { description: request.description },
                  ...request.blockedBy === undefined ? {} : { blockedBy: request.blockedBy },
                  ...request.writeScopes === undefined ? {} : { writeScopes: request.writeScopes },
                  ...request.owner === undefined ? {} : { owner: request.owner },
                }, authorize, operationSignal)
                : await mailbox.sendNative(identity, source, request, authorize, operationSignal)
              if (signal.aborted) return { ok: false, error: {
                code: 'TEAM_NATIVE_GRANT_REVOKED', message: 'This Team authorization is no longer active.',
              } }
              authorize()
              return result
            }
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
          if (request.operation === 'wait' || request.operation === 'tasks.update'
            || request.operation === 'messages.send' || request.operation === 'turns.settle') {
            if (signal.aborted) return { ok: false, error: {
              code: 'TEAM_NATIVE_GRANT_REVOKED', message: 'This Team authorization is no longer active.',
            } }
            if (callerSignal.aborted) return { ok: false, error: {
              code: 'TEAM_NATIVE_CANCELLED', message: 'The Team operation was cancelled before acceptance.',
            } }
            if (error instanceof TeamError) return { ok: false, error: {
              code: error.code, message: error.message,
              ...error.currentRevision === undefined ? {} : { currentRevision: error.currentRevision },
            } }
            return { ok: false, error: {
              code: 'TEAM_NATIVE_OPERATION_FAILED', message: 'The Team operation could not be committed; retry the same call.',
            } }
          }
          /* v8 ignore else -- validated in-memory roster/task readers only throw task-not-found; contain invariant faults. */
          if (error instanceof TeamError && error.code === 'TEAM_TASK_NOT_FOUND') {
            return { ok: false, error: { code: error.code, message: 'The task does not exist in this Team.' } }
          }
          /* v8 ignore next -- defensive containment for reader invariant faults; expected task absence is handled above. */
          return { ok: false, error: { code: 'TEAM_NATIVE_QUERY_FAILED', message: 'The Team query could not be completed.' } }
        }
      })
    },
  })
}
