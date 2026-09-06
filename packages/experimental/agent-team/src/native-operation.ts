/** Canonical native identities and inputs shared by admission and durable replay validation. */

import { createHash } from 'node:crypto'
import { z } from 'zod'
import { TeamTaskId, TeamNativeOperationId } from './brand.ts'
import { writeScope } from './validation.ts'
import type { NativeMemberGrant, NativeMemberMailboxRequest } from './service-types.ts'
import type { NativeMemberOperationSource, NativeMemberTaskRequest } from './types.ts'

/** Model JSON and persisted task receipts use the same explicit task fields. */
export const nativeTaskRequestSchema = z.object({
  operation: z.literal('tasks.update'),
  taskId: z.string().min(1).max(128).transform(value => TeamTaskId(value)),
  expectedRevision: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  action: z.enum(['claim', 'release', 'edit', 'set_dependencies', 'complete', 'reopen', 'reassign', 'delete']),
  subject: z.string().optional(),
  description: z.string().optional(),
  blockedBy: z.array(z.string().min(1).max(128).transform(value => TeamTaskId(value))).optional(),
  writeScopes: z.array(z.string()).optional(),
  owner: z.string().optional(),
}).strict()

/**
 * Correlate one tool call or terminal settlement within an accepted native member.
 * @param identity - Team, member, provider and native session identity.
 * @param source - trusted native work turn and call or settlement kind.
 * @returns the stable digest selecting one durable receipt.
 */
export function nativeOperationId(
  identity: NativeMemberGrant['identity'],
  source: NativeMemberOperationSource,
): TeamNativeOperationId {
  return TeamNativeOperationId(createHash('sha256').update(JSON.stringify([
    identity.teamId, identity.memberId, identity.provider, identity.nativeHandle,
    source.kind, source.turnId, source.kind === 'tool' ? source.callId : null,
  ])).digest('hex'))
}

/**
 * Fingerprint normalized intentional content without depending on JSON property order.
 * @param request - validated mailbox or task input.
 * @returns the canonical SHA-256 input fingerprint.
 */
export function nativeOperationFingerprint(request: NativeMemberMailboxRequest | NativeMemberTaskRequest): string {
  const normalized = request.operation === 'tasks.update'
    ? { operation: request.operation, taskId: request.taskId, expectedRevision: request.expectedRevision,
      action: request.action, subject: request.subject?.trim(), description: request.description?.trim(),
      blockedBy: request.blockedBy,
      writeScopes: request.writeScopes === undefined ? undefined : [...new Set(request.writeScopes.map(writeScope))],
      owner: request.owner?.trim() }
    : request.operation === 'messages.send'
      ? { operation: request.operation, target: request.target, text: request.text }
      : { operation: request.operation, outcome: request.outcome, text: request.text }
  return createHash('sha256').update(JSON.stringify(normalized)).digest('hex')
}
