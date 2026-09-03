/** Runtime constructors for public Agent Teams branded identities. */

import { Buffer } from 'node:buffer'
import { brandString, type Branded } from '@deepseek-ai/dsh-brand'
import type { SessionId } from '@deepseek-ai/dsh-session/types'

/** Identifies the implicit team rooted at one top-level Session. */
export type TeamId = Branded<'TeamId'>

/** Stable identifier for one task in a Team. */
export type TeamTaskId = Branded<'TeamTaskId'>

/** Stable identifier for one durable peer message. */
export type TeamMessageId = Branded<'TeamMessageId'>

/** Non-empty opaque caller identity, at most 200 UTF-8 bytes, retained across launch retries. */
export type TeammateLaunchRequestId = Branded<'TeammateLaunchRequestId'>

/** Stable non-empty opaque provider-native identity of at most 200 UTF-8 bytes. */
export type TeammateRuntimeHandle = Branded<'TeammateRuntimeHandle'>

/** Stable provider-native identity of one accepted work turn. */
export type TeammateRuntimeTurnId = Branded<'TeammateRuntimeTurnId'>

/** Caller-owned idempotency identity of one isolated evaluation request. */
export type TeammateEvaluationId = Branded<'TeammateEvaluationId'>

/** Stable provider-native identity of one isolated evaluation runtime. */
export type TeammateEvaluationHandle = Branded<'TeammateEvaluationHandle'>

/** Stable provider-native identity of one detached evidence fact. */
export type TeammateRuntimeEvidenceId = Branded<'TeammateRuntimeEvidenceId'>

/** Stable provider-native audit identity of one exact approval request. */
export type TeammateRuntimeApprovalId = Branded<'TeammateRuntimeApprovalId'>

/** Stable provider-native identity of one immutable proposed tool call. */
export type TeammateRuntimeToolCallId = Branded<'TeammateRuntimeToolCallId'>

/** Opaque continuation identity for one provider-native evidence window. */
export type TeammateRuntimeEvidenceCursor = Branded<'TeammateRuntimeEvidenceCursor'>

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
  return brandString<TeammateEvaluationId>(boundedDurableOpaqueId(id, 'TeammateEvaluationId'))
}

/**
 * Brand one provider-validated native evaluation identity.
 * @param id - Provider-validated opaque evaluation identity.
 * @returns the same string branded as a native evaluation handle.
 */
export function TeammateEvaluationHandle(id: string): TeammateEvaluationHandle {
  return brandString<TeammateEvaluationHandle>(boundedDurableOpaqueId(id, 'TeammateEvaluationHandle'))
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
 * Admit one provider-native approval audit identity without imposing lexical grammar.
 * @param id - Non-empty opaque identity of at most 200 UTF-8 bytes.
 * @returns the same string branded as a native approval audit identity.
 * @throws {TypeError} when the durable identity is empty or exceeds 200 UTF-8 bytes.
 */
export function TeammateRuntimeApprovalId(id: string): TeammateRuntimeApprovalId {
  return brandString<TeammateRuntimeApprovalId>(boundedDurableOpaqueId(id, 'TeammateRuntimeApprovalId'))
}

/**
 * Admit one immutable provider-native tool-call identity without imposing lexical grammar.
 * @param id - Non-empty opaque identity of at most 200 UTF-8 bytes.
 * @returns the same string branded as an immutable native tool-call identity.
 * @throws {TypeError} when the durable identity is empty or exceeds 200 UTF-8 bytes.
 */
export function TeammateRuntimeToolCallId(id: string): TeammateRuntimeToolCallId {
  return brandString<TeammateRuntimeToolCallId>(boundedDurableOpaqueId(id, 'TeammateRuntimeToolCallId'))
}

/**
 * Brand one provider-validated evidence continuation cursor.
 * @param id - Provider-validated opaque continuation identity.
 * @returns the same string branded as an evidence cursor.
 */
export function TeammateRuntimeEvidenceCursor(id: string): TeammateRuntimeEvidenceCursor {
  return brandString<TeammateRuntimeEvidenceCursor>(id)
}
