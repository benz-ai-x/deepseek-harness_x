/** Runtime constructors for public Agent Teams branded identities. */

import { Buffer } from 'node:buffer'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type {
  TeamId as TeamIdType,
  TeamMessageId as TeamMessageIdType,
  TeamTaskId as TeamTaskIdType,
  TeammateEvaluationHandle as TeammateEvaluationHandleType,
  TeammateEvaluationId as TeammateEvaluationIdType,
  TeammateLaunchRequestId as TeammateLaunchRequestIdType,
  TeammateRuntimeEvidenceCursor as TeammateRuntimeEvidenceCursorType,
  TeammateRuntimeEvidenceId as TeammateRuntimeEvidenceIdType,
  TeammateRuntimeHandle as TeammateRuntimeHandleType,
  TeammateRuntimeTurnId as TeammateRuntimeTurnIdType,
} from './types.ts'

/** Public Team identity paired with its runtime constructor. */
export type TeamId = TeamIdType
/** Public durable message identity paired with its runtime constructor. */
export type TeamMessageId = TeamMessageIdType
/** Public Team task identity paired with its runtime constructor. */
export type TeamTaskId = TeamTaskIdType
/** Public native evaluation handle paired with its runtime constructor. */
export type TeammateEvaluationHandle = TeammateEvaluationHandleType
/** Public evaluation request identity paired with its runtime constructor. */
export type TeammateEvaluationId = TeammateEvaluationIdType
/** Public durable launch identity paired with its runtime constructor. */
export type TeammateLaunchRequestId = TeammateLaunchRequestIdType
/** Public evidence cursor paired with its runtime constructor. */
export type TeammateRuntimeEvidenceCursor = TeammateRuntimeEvidenceCursorType
/** Public evidence identity paired with its runtime constructor. */
export type TeammateRuntimeEvidenceId = TeammateRuntimeEvidenceIdType
/** Public provider-native runtime handle paired with its runtime constructor. */
export type TeammateRuntimeHandle = TeammateRuntimeHandleType
/** Public provider-native turn identity paired with its runtime constructor. */
export type TeammateRuntimeTurnId = TeammateRuntimeTurnIdType

const MAX_DURABLE_OPAQUE_ID_BYTES = 200

function boundedDurableOpaqueId(id: string, label: string): string {
  if (id.length === 0 || Buffer.byteLength(id, 'utf8') > MAX_DURABLE_OPAQUE_ID_BYTES) {
    throw new TypeError(`${label} must be non-empty and at most 200 UTF-8 bytes`)
  }
  return id
}

/**
 * Brand one root Session identity as its implicit Team identity.
 * @param id - Root Session identity.
 * @returns the same string branded as a Team identity.
 */
export function TeamId(id: SessionId | string): TeamId {
  return id as TeamId
}

/**
 * Brand a validated task id.
 * @param id - Team-local task identity.
 * @returns the same string branded as a Team task identity.
 */
export function TeamTaskId(id: string): TeamTaskId {
  return id as TeamTaskId
}

/**
 * Brand a generated peer-message id.
 * @param id - Durable mailbox message identity.
 * @returns the same string branded as a Team message identity.
 */
export function TeamMessageId(id: string): TeamMessageId {
  return id as TeamMessageId
}

/**
 * Admit one external launch identity without changing its opaque wire value.
 * @param id - Non-empty opaque identity of at most 200 UTF-8 bytes.
 * @returns the same string branded as an external launch identity.
 * @throws {TypeError} when the durable identity is empty or exceeds 200 UTF-8 bytes.
 */
export function TeammateLaunchRequestId(id: string): TeammateLaunchRequestId {
  return brandString<TeammateLaunchRequestId>(boundedDurableOpaqueId(id, 'TeammateLaunchRequestId'))
}

/**
 * Admit one provider-native runtime identity without imposing lexical grammar.
 * @param id - Non-empty opaque identity of at most 200 UTF-8 bytes.
 * @returns the same string branded as a native runtime handle.
 * @throws {TypeError} when the durable identity is empty or exceeds 200 UTF-8 bytes.
 */
export function TeammateRuntimeHandle(id: string): TeammateRuntimeHandle {
  return brandString<TeammateRuntimeHandle>(boundedDurableOpaqueId(id, 'TeammateRuntimeHandle'))
}

/**
 * Brand one provider-validated native turn identity.
 * @param id - Provider-validated opaque turn identity.
 * @returns the same string branded as a native turn identity.
 */
export function TeammateRuntimeTurnId(id: string): TeammateRuntimeTurnId {
  return brandString<TeammateRuntimeTurnId>(id)
}

/**
 * Brand one validated evaluation request identity.
 * @param id - Caller-minted opaque evaluation identity.
 * @returns the same string branded as an evaluation request identity.
 */
export function TeammateEvaluationId(id: string): TeammateEvaluationId {
  return brandString<TeammateEvaluationId>(id)
}

/**
 * Brand one provider-validated native evaluation identity.
 * @param id - Provider-validated opaque evaluation identity.
 * @returns the same string branded as a native evaluation handle.
 */
export function TeammateEvaluationHandle(id: string): TeammateEvaluationHandle {
  return brandString<TeammateEvaluationHandle>(id)
}

/**
 * Brand one provider-validated evidence identity.
 * @param id - Provider-validated opaque evidence identity.
 * @returns the same string branded as an evidence identity.
 */
export function TeammateRuntimeEvidenceId(id: string): TeammateRuntimeEvidenceId {
  return brandString<TeammateRuntimeEvidenceId>(id)
}

/**
 * Brand one provider-validated evidence continuation cursor.
 * @param id - Provider-validated opaque continuation identity.
 * @returns the same string branded as an evidence cursor.
 */
export function TeammateRuntimeEvidenceCursor(id: string): TeammateRuntimeEvidenceCursor {
  return brandString<TeammateRuntimeEvidenceCursor>(id)
}
