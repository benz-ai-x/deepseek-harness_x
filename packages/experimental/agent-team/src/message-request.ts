/** Canonical identity and input comparison for human-authored Team message requests. */

import { createHash } from 'node:crypto'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { TeamMessageId } from './brand.ts'

/** Exact user input covered by one durable Team message request identity. */
export interface TeamMessageRequestInput {
  readonly recipientId: SessionId
  readonly text: string
  readonly replyTo?: TeamMessageId
}

/**
 * Hash one normalized human message input without retaining a second content copy.
 * @param input - explicit recipient, literal text, and optional prior Team message.
 * @returns lowercase SHA-256 digest of the fixed-field JSON value.
 */
export function teamMessageRequestFingerprint(input: TeamMessageRequestInput): string {
  return createHash('sha256').update(JSON.stringify({
    recipientId: input.recipientId,
    text: input.text,
    replyTo: input.replyTo ?? null,
  }), 'utf8').digest('hex')
}
