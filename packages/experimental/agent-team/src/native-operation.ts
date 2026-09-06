/** Canonical native identities and inputs shared by admission and durable replay validation. */

import { createHash } from 'node:crypto'
import { TeamNativeOperationId } from './brand.ts'
import type { NativeMemberGrant, NativeMemberMailboxRequest } from './service-types.ts'
import type { NativeMemberOperationSource } from './types.ts'

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
 * @param request - validated message or terminal settlement input.
 * @returns the canonical SHA-256 input fingerprint.
 */
export function nativeOperationFingerprint(request: NativeMemberMailboxRequest): string {
  const normalized = request.operation === 'messages.send'
    ? { operation: request.operation, target: request.target, text: request.text }
    : { operation: request.operation, outcome: request.outcome, text: request.text }
  return createHash('sha256').update(JSON.stringify(normalized)).digest('hex')
}
