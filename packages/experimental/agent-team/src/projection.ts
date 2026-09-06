/** Host-only Team state projected incrementally from committed Session events. */

import { Buffer } from 'node:buffer'
import { isDeepStrictEqual } from 'node:util'
import { z } from 'zod'
import { brandString } from '@deepseek-ai/dsh-brand'
import { ReasoningEffortId, type ContentBlock } from '@deepseek-ai/dsh-llm'
import type { SessionEvent, SessionEventMap, SessionId } from '@deepseek-ai/dsh-session'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import {
  TeamId as toTeamId,
  TeamMessageId as toTeamMessageId,
  TeamNativeOperationId,
  TeamTaskId as toTeamTaskId,
  TeammateLaunchRequestId,
  TeammateRuntimeHandle,
  TeammateRuntimeTurnId,
  TeammateRuntimeToolCallId,
} from './brand.ts'
import type {
  TeamId,
  TeamMemberSnapshot,
  TeamMemberRouteSnapshot,
  TeamMessageId,
  TeamMessageSnapshot,
  TeamNativeOperationReceipt,
  TeamNativeMessageReceipt,
  TeamNativeTaskReceipt,
  TeamTaskSnapshot,
} from './types.ts'
import { assertTaskGraphCandidate } from './task-graph.ts'
import { prepareTaskUpdate, nativeTaskResult } from './task-state.ts'
import { nativeTaskRequestSchema, nativeOperationFingerprint, nativeOperationId } from './native-operation.ts'

const nonNegativeSafeInteger = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const positiveSafeInteger = nonNegativeSafeInteger.min(1)
const sessionIdSchema = z.string().min(1).transform(value => brandString<SessionId>(value))
const teamIdSchema = z.string().min(1).transform(value => toTeamId(value))
const numericTaskIdPattern = /^task-(\d+)$/u
const teamTaskIdSchema = z.string().min(1).refine((value) => {
  const match = numericTaskIdPattern.exec(value)
  return match === null || Number.isSafeInteger(Number(match[1]))
}, { message: 'numeric task id suffix must be a safe integer' }).transform(value => toTeamTaskId(value))
const teamMessageIdSchema = z.string().min(1).transform(value => toTeamMessageId(value))
const durableOpaqueIdSchema = z.string().min(1).refine(
  value => Buffer.byteLength(value, 'utf8') <= 200,
  { message: 'durable opaque identity must be at most 200 UTF-8 bytes' },
)
const teammateRuntimeTurnIdSchema = durableOpaqueIdSchema.transform(value => TeammateRuntimeTurnId(value))

const teamMemberRouteSnapshotSchema = z.object({
  provider: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
  reasoningEffort: z.string().min(1).transform(value => ReasoningEffortId(value)).optional(),
}).strict() as z.ZodType<TeamMemberRouteSnapshot>

const teammateProfileCapabilities = [
  'persona',
  'mission',
  'context',
  'memory',
  'tool-policy',
  'hooks',
] as const
const teammateRuntimeCapabilities = [
  'exact-call-approval',
  'sandbox',
  'evaluation',
  'evidence',
  'usage',
] as const

const teammateRuntimeRequirementsSchema = z.object({
  contextMode: z.enum(['fresh', 'fork']),
  profileCapabilities: z.array(z.enum(teammateProfileCapabilities)),
  runtimeCapabilities: z.array(z.enum(teammateRuntimeCapabilities)),
}).strict().superRefine((requirements, ctx) => {
  const canonicalProfile = teammateProfileCapabilities.filter(capability =>
    requirements.profileCapabilities.includes(capability))
  const canonicalRuntime = teammateRuntimeCapabilities.filter(capability =>
    requirements.runtimeCapabilities.includes(capability))
  if (canonicalProfile.length !== requirements.profileCapabilities.length
    || canonicalProfile.some((capability, index) => requirements.profileCapabilities[index] !== capability)) {
    ctx.addIssue({ code: 'custom', message: 'external Profile capabilities must be unique and canonical' })
  }
  if (!requirements.profileCapabilities.includes('persona')
    || !requirements.profileCapabilities.includes('mission')) {
    ctx.addIssue({ code: 'custom', message: 'external Profile capabilities must include persona and mission' })
  }
  if (canonicalRuntime.length !== requirements.runtimeCapabilities.length
    || canonicalRuntime.some((capability, index) => requirements.runtimeCapabilities[index] !== capability)) {
    ctx.addIssue({ code: 'custom', message: 'external runtime capabilities must be unique and canonical' })
  }
})

const externalRuntimeSchema = z.object({
  kind: z.literal('external-agent'),
  launchRequestId: durableOpaqueIdSchema
    .transform(value => TeammateLaunchRequestId(value)),
  requestFingerprint: z.string().regex(/^[0-9a-f]{64}$/u),
  requirements: teammateRuntimeRequirementsSchema,
  nativeHandle: durableOpaqueIdSchema
    .transform(value => TeammateRuntimeHandle(value)).optional(),
  initialTurnId: teammateRuntimeTurnIdSchema.optional(),
}).strict()

const coreContentBlockTypes = new Set(['text', 'reasoning', 'image', 'tool-call', 'tool-result'])
const imageAttachmentSchema = z.object({
  attachmentId: z.string().min(1),
  mediaType: z.enum(['image/png', 'image/jpeg', 'image/webp', 'image/gif']),
  bytes: nonNegativeSafeInteger,
  width: positiveSafeInteger,
  height: positiveSafeInteger,
  name: z.string().optional(),
}).strict()

// ContentBlockMap is merge-extensible. Validate every core variant exactly,
// while retaining JSON-decoded plugin variants under an unknown type tag.
const contentBlockSchema: z.ZodType<ContentBlock> = z.lazy(() => z.union([
  z.object({ type: z.literal('text'), text: z.string() }).strict(),
  z.object({ type: z.literal('reasoning'), text: z.string() }).strict(),
  z.object({ type: z.literal('image'), attachment: imageAttachmentSchema }).strict(),
  z.object({
    type: z.literal('tool-call'),
    id: z.string().min(1),
    name: z.string(),
    arguments: z.string(),
  }).strict(),
  z.object({
    type: z.literal('tool-result'),
    toolCallId: z.string().min(1),
    content: z.array(contentBlockSchema),
    isError: z.boolean().optional(),
  }).strict(),
  z.object({ type: z.string().min(1) }).loose().refine(
    block => !coreContentBlockTypes.has(block.type),
    { message: 'known content block types must match their declared fields' },
  ),
])) as z.ZodType<ContentBlock>

const teamMemberSnapshotSchema = z.object({
  id: sessionIdSchema,
  name: z.string(),
  description: z.string(),
  provider: z.string(),
  context: z.enum(['fresh', 'fork']),
  requestedRoute: teamMemberRouteSnapshotSchema.optional(),
  resolvedRoute: teamMemberRouteSnapshotSchema.optional(),
  externalRuntime: externalRuntimeSchema.optional(),
  phase: z.enum(['provisioning', 'active', 'failed']),
  error: z.string().optional(),
}).strict().superRefine((member, ctx) => {
  if (member.externalRuntime !== undefined
    && (member.requestedRoute !== undefined || member.resolvedRoute !== undefined)) {
    ctx.addIssue({ code: 'custom', message: 'external teammates cannot carry DSH route snapshots' })
  }
  if (member.externalRuntime !== undefined
    && member.phase === 'active'
    && member.externalRuntime.nativeHandle === undefined) {
    ctx.addIssue({ code: 'custom', message: 'active external teammates require a native handle' })
  }
  if (member.externalRuntime?.nativeHandle !== undefined && member.phase === 'provisioning') {
    ctx.addIssue({ code: 'custom', message: 'provisioning external teammates cannot own a native handle' })
  }
  if (member.externalRuntime?.requirements.contextMode !== undefined
    && member.externalRuntime.requirements.contextMode !== member.context) {
    ctx.addIssue({ code: 'custom', message: 'external runtime context must match the roster member context' })
  }
}) as z.ZodType<TeamMemberSnapshot>

const teamTaskSnapshotSchema = z.object({
  id: teamTaskIdSchema,
  revision: positiveSafeInteger,
  subject: z.string(),
  description: z.string(),
  status: z.enum(['pending', 'in_progress', 'completed', 'deleted']),
  ownerId: sessionIdSchema.optional(),
  blockedBy: z.array(teamTaskIdSchema),
  writeScopes: z.array(z.string()),
}).strict()

const teamMessageSnapshotSchema = z.object({
  id: teamMessageIdSchema,
  senderId: sessionIdSchema,
  senderName: z.string(),
  targetId: sessionIdSchema,
  content: z.array(contentBlockSchema),
}).strict() as z.ZodType<TeamMessageSnapshot>

const teamEventSelectorSchema = z.object({
  version: nonNegativeSafeInteger,
  teamId: teamIdSchema,
}).loose()

const teamMemberEventSchema = z.object({
  version: z.literal(2),
  teamId: teamIdSchema,
  member: teamMemberSnapshotSchema,
}).strict() as z.ZodType<SessionEventMap['team/member']>

const teamTaskEventSchema = z.object({
  version: z.literal(2),
  teamId: teamIdSchema,
  task: teamTaskSnapshotSchema,
}).strict() as z.ZodType<SessionEventMap['team/task']>

const teamMessageQueuedEventSchema = z.object({
  version: z.literal(2),
  teamId: teamIdSchema,
  message: teamMessageSnapshotSchema,
}).strict() as z.ZodType<SessionEventMap['team/message/queued']>

const teamMessageDeliveredEventSchema = z.object({
  version: z.literal(2),
  teamId: teamIdSchema,
  messageId: teamMessageIdSchema,
  targetId: sessionIdSchema,
  nativeTurnId: teammateRuntimeTurnIdSchema.optional(),
}).strict() as z.ZodType<SessionEventMap['team/message/delivered']>

const nativeOperationReceiptFields = {
  id: z.string().regex(/^[0-9a-f]{64}$/u).transform(value => TeamNativeOperationId(value)),
  memberId: sessionIdSchema,
  provider: z.string().min(1),
  nativeHandle: durableOpaqueIdSchema.transform(value => TeammateRuntimeHandle(value)),
  source: z.discriminatedUnion('kind', [
    z.object({
      kind: z.literal('tool'), turnId: teammateRuntimeTurnIdSchema,
      callId: durableOpaqueIdSchema.transform(value => TeammateRuntimeToolCallId(value)),
    }).strict(),
    z.object({ kind: z.literal('settlement'), turnId: teammateRuntimeTurnIdSchema }).strict(),
  ]),
  inputFingerprint: z.string().regex(/^[0-9a-f]{64}$/u),
}

const nativeMessageReceiptSchema = z.object({
  ...nativeOperationReceiptFields,
  result: z.discriminatedUnion('operation', [
    z.object({
      ok: z.literal(true), operation: z.literal('messages.send'),
      value: z.object({ messageId: teamMessageIdSchema, status: z.literal('queued') }).strict(),
    }).strict(),
    z.object({
      ok: z.literal(true), operation: z.literal('turns.settle'),
      value: z.object({ messageId: teamMessageIdSchema, status: z.literal('queued'),
        outcome: z.enum(['completed', 'failed', 'interrupted']) }).strict(),
    }).strict(),
  ]),
}).strict() as z.ZodType<TeamNativeMessageReceipt>

const nativeTaskReceiptSchema = z.object({
  ...nativeOperationReceiptFields,
  request: nativeTaskRequestSchema,
  result: z.object({
    ok: z.literal(true), operation: z.literal('tasks.update'),
    value: z.object({ task: teamTaskSnapshotSchema.pick({ id: true, revision: true, status: true }).extend({
      ownerName: z.string().optional(), ready: z.boolean(),
    }).strict() }).strict(),
  }).strict(),
}).strict() as z.ZodType<TeamNativeTaskReceipt>

const nativeOperationReceiptSchema = z.union([nativeMessageReceiptSchema, nativeTaskReceiptSchema])

const legacyNativeMessageEventSchema = z.object({
  version: z.literal(3), teamId: teamIdSchema,
  receipt: nativeMessageReceiptSchema, message: teamMessageSnapshotSchema,
}).strict()

const nativeOperationEventSchema = z.union([
  legacyNativeMessageEventSchema,
  z.object({ version: z.literal(4), kind: z.literal('message'), teamId: teamIdSchema,
    receipt: nativeMessageReceiptSchema, message: teamMessageSnapshotSchema }).strict(),
  z.object({ version: z.literal(4), kind: z.literal('task'), teamId: teamIdSchema,
    receipt: nativeTaskReceiptSchema, task: teamTaskSnapshotSchema }).strict(),
]) as z.ZodType<SessionEventMap['team/native-operation/committed']>

/** Current Team state selected by durable Team identity. */
export interface TeamState {
  readonly id: TeamId
  readonly members: TeamMemberSnapshot[]
  readonly tasks: TeamTaskSnapshot[]
  readonly messages: TeamMessageSnapshot[]
  readonly delivered: TeamMessageId[]
  readonly nativeOperations: TeamNativeOperationReceipt[]
  nextTaskNumber: number
}

/**
 * Construct empty state for one Team identity.
 * @param rootId - root Session identity.
 * @returns mutable empty Team state.
 */
export function emptyTeamState(rootId: SessionId): TeamProjectionState {
  return {
    id: toTeamId(rootId),
    members: [],
    tasks: [],
    messages: [],
    delivered: [],
    nativeOperations: [],
    nextTaskNumber: 1,
  }
}

/** Checkpoint-safe state for the Team owned by the projected Session. */
export interface TeamProjectionState extends TeamState {
  failure?: string
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    agentTeam: TeamProjectionState
  }
}

const teamProjectionEntrySchema = z.object({
  id: teamIdSchema,
  members: z.array(teamMemberSnapshotSchema),
  tasks: z.array(teamTaskSnapshotSchema),
  messages: z.array(teamMessageSnapshotSchema),
  delivered: z.array(teamMessageIdSchema),
  nativeOperations: z.array(nativeOperationReceiptSchema),
  nextTaskNumber: positiveSafeInteger,
  failure: z.string().optional(),
}).strict() as z.ZodType<TeamProjectionState>

/** Whether one event belongs to the Team domain. */
export type TeamEventType =
  | 'team/member'
  | 'team/task'
  | 'team/message/queued'
  | 'team/message/delivered'
  | 'team/native-operation/committed'

/** One event owned by the Team domain. */
type TeamSessionEvent = SessionEvent<TeamEventType>

/**
 * Test whether a Session event belongs to the Team domain.
 * @param event - candidate Session event.
 * @returns whether the event has a Team-owned type.
 */
export function isTeamEvent(event: SessionEvent): event is TeamSessionEvent {
  return event.type === 'team/member'
    || event.type === 'team/task'
    || event.type === 'team/message/queued'
    || event.type === 'team/message/delivered'
    || event.type === 'team/native-operation/committed'
}

/** Decode one persisted Team value and retain the schema failure as its cause. */
function parsePersisted<T>(type: TeamEventType, schema: z.ZodType<T>, value: unknown): T {
  try {
    return schema.parse(value)
  } catch (error: unknown) {
    throw new Error(`persisted Agent Teams ${type} payload is invalid`, { cause: error })
  }
}

/** Decode the complete current-version payload selected by one Team event type. */
function parseCurrentTeamEvent(event: TeamSessionEvent): TeamSessionEvent {
  switch (event.type) {
    case 'team/member':
      return { ...event, data: parsePersisted(event.type, teamMemberEventSchema, event.data) }
    case 'team/task':
      return { ...event, data: parsePersisted(event.type, teamTaskEventSchema, event.data) }
    case 'team/message/queued':
      return { ...event, data: parsePersisted(event.type, teamMessageQueuedEventSchema, event.data) }
    case 'team/message/delivered':
      return { ...event, data: parsePersisted(event.type, teamMessageDeliveredEventSchema, event.data) }
    case 'team/native-operation/committed':
      return { ...event, data: parsePersisted(event.type, nativeOperationEventSchema, event.data) }
    /* v8 ignore next 2 -- TeamEventType is closed and every member is handled above. */
    default:
      return event
  }
}

function applyProjectionEvent(state: TeamProjectionState, event: SessionEvent): void {
  if (state.failure !== undefined) return
  if (!isTeamEvent(event)) return
  try {
    const selector = parsePersisted(event.type, teamEventSelectorSchema, event.data)
    if (selector.teamId !== state.id) return
    if (!(event.type === 'team/native-operation/committed'
      ? selector.version === 3 || selector.version === 4 : selector.version === 2)) {
      throw new Error(`unsupported Agent Teams event version ${String(selector.version)}`)
    }
    applyCurrentTeamEvent(state, parseCurrentTeamEvent(event))
  } catch (error: unknown) {
    /* v8 ignore next -- the owned Team transition throws Error instances. */
    state.failure = error instanceof Error ? error.message : String(error)
  }
}

function applyCurrentTeamEvent(state: TeamState, event: TeamSessionEvent): void {
  switch (event.type) {
    case 'team/member': {
      const member = event.data.member
      const index = state.members.findIndex(candidate => candidate.id === member.id)
      const prior = state.members[index]
      const named = state.members.find(candidate => candidate.name === member.name)
      if (named !== undefined && named.id !== member.id) {
        throw new Error(`teammate name "${member.name}" is reused by another member`)
      }
      const externalLaunch = member.externalRuntime?.launchRequestId
      const launchOwner = externalLaunch === undefined
        ? undefined
        : state.members.find(candidate => candidate.externalRuntime?.launchRequestId === externalLaunch)
      if (launchOwner !== undefined && launchOwner.id !== member.id) {
        throw new Error(`external launch request "${externalLaunch}" is reused by another member`)
      }
      const externalHandle = member.externalRuntime?.nativeHandle
      const handleOwner = externalHandle === undefined
        ? undefined
        : state.members.find(candidate => candidate.provider === member.provider
          && candidate.externalRuntime?.nativeHandle === externalHandle)
      if (handleOwner !== undefined && handleOwner.id !== member.id) {
        throw new Error(`external native handle "${externalHandle}" is reused by another member`)
      }
      if (prior === undefined) {
        if (member.phase !== 'provisioning') throw new Error(`teammate "${member.name}" must begin provisioning`)
      } else {
        const priorExternal = prior.externalRuntime
        const nextExternal = member.externalRuntime
        if (prior.name !== member.name
          || prior.description !== member.description
          || prior.provider !== member.provider
          || prior.context !== member.context
          || JSON.stringify(prior.requestedRoute) !== JSON.stringify(member.requestedRoute)
          || priorExternal?.kind !== nextExternal?.kind
          || priorExternal?.launchRequestId !== nextExternal?.launchRequestId
          || priorExternal?.requestFingerprint !== nextExternal?.requestFingerprint
          || JSON.stringify(priorExternal?.requirements) !== JSON.stringify(nextExternal?.requirements)
          || (priorExternal?.nativeHandle !== undefined
            && priorExternal.nativeHandle !== nextExternal?.nativeHandle)
          || (priorExternal?.initialTurnId !== undefined
            && priorExternal.initialTurnId !== nextExternal?.initialTurnId)) {
          throw new Error(`teammate "${member.id}" changed immutable identity fields`)
        }
        if (prior.phase !== 'provisioning' || member.phase === 'provisioning') {
          throw new Error(`teammate "${member.name}" has an invalid ${prior.phase} -> ${member.phase} transition`)
        }
      }
      if (index < 0) state.members.push(member)
      else state.members[index] = member
      break
    }
    case 'team/task': {
      const task = event.data.task
      const index = state.tasks.findIndex(candidate => candidate.id === task.id)
      const prior = state.tasks[index]
      if (prior === undefined && task.revision !== 1) {
        throw new Error(`team task "${task.id}" must begin at revision 1`)
      }
      if (prior !== undefined && task.revision !== prior.revision + 1) {
        throw new Error(`team task "${task.id}" revision is not contiguous`)
      }
      assertTaskGraphCandidate(state.tasks, task)
      const match = numericTaskIdPattern.exec(task.id)
      if (match !== null) {
        const number = Number(match[1])
        state.nextTaskNumber = Math.max(
          state.nextTaskNumber,
          number === Number.MAX_SAFE_INTEGER ? number : number + 1,
        )
      }
      if (index < 0) state.tasks.push(task)
      else state.tasks[index] = task
      break
    }
    case 'team/message/queued': {
      const message = event.data.message
      if (state.messages.some(candidate => candidate.id === message.id)) {
        throw new Error(`team message "${message.id}" was queued twice`)
      }
      state.messages.push(message)
      break
    }
    case 'team/native-operation/committed': {
      if ('task' in event.data) {
        const { receipt, task } = event.data
        const member = state.members.find(candidate => candidate.id === receipt.memberId)
        if (member?.phase !== 'active' || member.provider !== receipt.provider
          || member.externalRuntime?.nativeHandle !== receipt.nativeHandle || receipt.source.kind !== 'tool') {
          throw new Error('native operation does not match its accepted Team member and task')
        }
        if (receipt.id !== nativeOperationId({ teamId: state.id, ...receipt }, receipt.source)
          || receipt.inputFingerprint !== nativeOperationFingerprint(receipt.request)) {
          throw new Error('native operation identity or input fingerprint is not canonical')
        }
        if (state.nativeOperations.some(candidate => candidate.id === receipt.id)) {
          throw new Error('native operation was committed twice')
        }
        const rootId = brandString<SessionId>(state.id)
        const expected = prepareTaskUpdate(rootId, state, member.id, 'teammate', receipt.request)
        if (!isDeepStrictEqual(task, expected)
          || !isDeepStrictEqual(receipt.result, nativeTaskResult(rootId, state, expected))) {
          throw new Error('native operation task or result does not match its accepted transition')
        }
        const index = state.tasks.findIndex(candidate => candidate.id === task.id)
        state.tasks[index] = task
        state.nativeOperations.push(receipt)
        break
      }
      const { receipt, message } = event.data
      const member = state.members.find(candidate => candidate.id === receipt.memberId)
      const target = toTeamId(message.targetId) === state.id
        ? 'lead' : state.members.find(candidate => candidate.id === message.targetId && candidate.phase === 'active')?.name
      const text = message.content[0]
      if (member?.phase !== 'active' || member.provider !== receipt.provider
        || member.externalRuntime?.nativeHandle !== receipt.nativeHandle
        || message.senderId !== member.id || message.senderName !== member.name
        || receipt.result.value.messageId !== message.id
        || receipt.source.kind !== (receipt.result.operation === 'messages.send' ? 'tool' : 'settlement')
        || (receipt.result.operation === 'turns.settle' && toTeamId(message.targetId) !== state.id)
        || target === undefined || message.targetId === message.senderId
        || message.content.length !== 1 || text?.type !== 'text') {
        throw new Error('native operation does not match its accepted Team member and message')
      }
      const fingerprint = nativeOperationFingerprint(receipt.result.operation === 'messages.send'
        ? { operation: receipt.result.operation, target, text: text.text }
        : { operation: receipt.result.operation, outcome: receipt.result.value.outcome, text: text.text })
      if (receipt.id !== nativeOperationId({ teamId: state.id, ...receipt }, receipt.source)
        || receipt.inputFingerprint !== fingerprint) {
        throw new Error('native operation identity or input fingerprint is not canonical')
      }
      if (state.nativeOperations.some(candidate => candidate.id === receipt.id)
        || state.messages.some(candidate => candidate.id === message.id)) {
        throw new Error('native operation or its message was committed twice')
      }
      state.messages.push(message)
      state.nativeOperations.push(receipt)
      break
    }
    case 'team/message/delivered': {
      const queued = state.messages.find(message => message.id === event.data.messageId)
      if (queued === undefined) throw new Error(`team message "${event.data.messageId}" was delivered before queueing`)
      if (queued.targetId !== event.data.targetId) throw new Error(`team message "${event.data.messageId}" target changed`)
      if (state.delivered.includes(event.data.messageId)) throw new Error(`team message "${event.data.messageId}" was delivered twice`)
      state.delivered.push(event.data.messageId)
      break
    }
    /* v8 ignore next 2 -- TeamEventType is closed and every member is handled above. */
    default:
      return
  }
}

/** Host-only Team projection selected by the projected Session identity. */
export const teamProjectionDefinition = {
  key: 'agentTeam',
  stateVersion: 5,
  stateSchema: teamProjectionEntrySchema,
  init: header => emptyTeamState(header.id),
  apply: (state, event) => {
    applyProjectionEvent(state, event)
    return state
  },
} satisfies ProjectionDefinition<'agentTeam', TeamProjectionState>
