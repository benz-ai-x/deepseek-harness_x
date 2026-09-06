/** Committed, Lead-authorized read model for persisted Team messages. */

import { createHash } from 'node:crypto'
import { Buffer } from 'node:buffer'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { TeamMessageCursor as toTeamMessageCursor } from './brand.ts'
import { TeamError } from './error.ts'
import type { TeamJournal } from './journal.ts'
import type { TeamRuntimeLifecycle } from './lifecycle.ts'
import type { TeamMessageIndexEntry, TeamState } from './projection.ts'
import type { TeamMembership, TeamRoster } from './roster.ts'
import type {
  GetTeamMessageRequest,
  ListTeamMessagesRequest,
  TeamMessageContent,
  TeamMessageCursor,
  TeamMessageDelivery,
  TeamMessageDetail,
  TeamMessageFilters,
  TeamMessagePage,
  TeamMessageParticipant,
  TeamMessageSnapshot,
  TeamMessageSummary,
} from './types.ts'

const DEFAULT_PAGE_SIZE = 20
const MAX_PAGE_SIZE = 100
const MAX_CURSOR_BYTES = 2_048
const CURSOR_VERSION = 1

interface NormalizedFilters {
  readonly memberId?: SessionId
  readonly direction?: 'sent' | 'received'
  readonly delivery?: 'pending' | 'delivered' | 'unknown'
}

interface CursorPayload {
  readonly version: typeof CURSOR_VERSION
  readonly teamId: string
  readonly filters: NormalizedFilters
  readonly through: number
  readonly before?: number
}

interface IndexedMessage {
  readonly message: TeamMessageSnapshot
  readonly index: TeamMessageIndexEntry
}

/** Owns stable message paging without exposing mailbox payloads in list responses. */
export class TeamMessageReader {
  private readonly inFlight = new Set<Promise<unknown>>()

  /**
   * @param ctx - Host services used for the durable read barrier.
   * @param journal - serialized Team transaction and authoritative projection owner.
   * @param roster - exact live caller and Team-role authority.
   * @param lifecycle - shared read-admission cutoff used by Team disposal.
   */
  constructor(
    private readonly ctx: Context,
    private readonly journal: TeamJournal,
    private readonly roster: TeamRoster,
    private readonly lifecycle: TeamRuntimeLifecycle,
  ) {}

  /** Snapshot every accepted read that has not settled yet. */
  pendingReads(): readonly Promise<unknown>[] {
    return [...this.inFlight]
  }

  /**
   * Read one newest-first metadata page from a fixed committed window.
   * @param caller - exact live Team Lead.
   * @param request - bounded filters and optional continuation.
   * @returns metadata only, plus committed and next-page cursors.
   */
  async list(caller: Agent, request: ListTeamMessagesRequest): Promise<TeamMessagePage> {
    return await this.admit(async () => {
      const initial = this.lead(caller)
      return await this.journal.transact(initial.root.id, async () => {
        this.lifecycle.signal.throwIfAborted()
        const beforeFlush = this.lead(caller)
        const lastSeq = beforeFlush.root.session.snapshotEvents().at(-1)?.seq ?? -1
        await this.ctx.sessions.flush(beforeFlush.root.session)
        this.lifecycle.signal.throwIfAborted()
        const current = this.lead(caller)
        const state = this.journal.state(current.root)
        const filters = this.filters(request.filters, state, current.root.id)
        const limit = this.pageSize(request.limit)
        const cursor = request.cursor === undefined
          ? { version: CURSOR_VERSION, teamId: current.id, filters, through: lastSeq } satisfies CursorPayload
          : this.decodeCursor(request.cursor, current.id, filters, lastSeq)
        const candidates = this.indexed(state, current.root.id)
          .filter(candidate => candidate.index.queuedSeq <= cursor.through
            && (cursor.before === undefined || candidate.index.queuedSeq < cursor.before)
            && this.matches(candidate, filters, cursor.through))
          .sort((left, right) => right.index.queuedSeq - left.index.queuedSeq)
        const window = candidates.slice(0, limit)
        const committedCursor = this.encodeCursor({
          version: cursor.version,
          teamId: cursor.teamId,
          filters: cursor.filters,
          through: cursor.through,
        })
        const next = candidates.length > limit ? window.at(-1) : undefined
        return {
          items: window.map(candidate => this.summary(candidate, state, current.root.id, cursor.through)),
          committedCursor,
          ...(next === undefined ? {} : { nextCursor: this.encodeCursor({
            ...cursor,
            before: next.index.queuedSeq,
          }) }),
          complete: true,
        }
      })
    })
  }

  /**
   * Read sanitized intentional content for one row in a committed list window.
   * @param caller - exact live Team Lead.
   * @param request - message identity and the list window that exposed it.
   * @returns metadata and content with omissions reported explicitly.
   */
  async get(caller: Agent, request: GetTeamMessageRequest): Promise<TeamMessageDetail> {
    return await this.admit(async () => {
      const initial = this.lead(caller)
      return await this.journal.transact(initial.root.id, async () => {
        this.lifecycle.signal.throwIfAborted()
        const beforeFlush = this.lead(caller)
        const lastSeq = beforeFlush.root.session.snapshotEvents().at(-1)?.seq ?? -1
        await this.ctx.sessions.flush(beforeFlush.root.session)
        this.lifecycle.signal.throwIfAborted()
        const current = this.lead(caller)
        const state = this.journal.state(current.root)
        const cursor = this.decodeCursor(request.committedCursor, current.id, undefined, lastSeq)
        if (cursor.before !== undefined) {
          throw new TeamError('message detail requires a committed window cursor', 'TEAM_MESSAGE_CURSOR_INVALID')
        }
        this.filters(cursor.filters, state, current.root.id)
        const selected = this.indexed(state, current.root.id).find(candidate => candidate.message.id === request.messageId
          && candidate.index.queuedSeq <= cursor.through
          && this.matches(candidate, cursor.filters, cursor.through))
        if (selected === undefined) {
          throw new TeamError('Team message is not part of the committed query window', 'TEAM_MESSAGE_NOT_FOUND')
        }
        return {
          ...this.summary(selected, state, current.root.id, cursor.through),
          content: this.content(selected.message.content),
        }
      })
    })
  }

  /** Admit one read before the shared cutoff and retain it until either outcome settles. */
  private admit<T>(operation: () => Promise<T>): Promise<T> {
    this.lifecycle.signal.throwIfAborted()
    const admitted = operation()
    this.inFlight.add(admitted)
    void admitted.then(
      () => { this.inFlight.delete(admitted) },
      () => { this.inFlight.delete(admitted) },
    )
    return admitted
  }

  /** Resolve and enforce the exact current Lead identity at each read edge. */
  private lead(caller: Agent): TeamMembership & { readonly role: 'lead' } {
    const membership = this.roster.membership(caller)
    if (membership.role !== 'lead') {
      throw new TeamError('only the Team Lead can read persisted Team messages', 'TEAM_LEAD_REQUIRED')
    }
    return { ...membership, role: 'lead' }
  }

  /** Validate wire-facing filters and retained participant membership. */
  private filters(filters: TeamMessageFilters | undefined, state: TeamState, rootId: SessionId): NormalizedFilters {
    const memberId = filters?.memberId
    const direction: unknown = filters?.direction
    const delivery: unknown = filters?.delivery
    if (direction !== undefined && direction !== 'sent' && direction !== 'received') {
      throw new TeamError('message direction is invalid', 'TEAM_MESSAGE_QUERY_INVALID')
    }
    if (delivery !== undefined && delivery !== 'pending' && delivery !== 'delivered' && delivery !== 'unknown') {
      throw new TeamError('message delivery stage is invalid', 'TEAM_MESSAGE_QUERY_INVALID')
    }
    if (direction !== undefined && memberId === undefined) {
      throw new TeamError('message direction requires a selected Team member', 'TEAM_MESSAGE_QUERY_INVALID')
    }
    if (memberId !== undefined && memberId !== rootId
      && !state.members.some(member => member.id === memberId)) {
      throw new TeamError('selected Team member does not belong to this Team', 'TEAM_MEMBER_NOT_FOUND')
    }
    return {
      ...(memberId === undefined ? {} : { memberId }),
      ...(direction === undefined ? {} : { direction }),
      ...(delivery === undefined ? {} : { delivery }),
    }
  }

  /** Validate the bounded page-size protocol constant. */
  private pageSize(limit: number | undefined): number {
    const resolved = limit ?? DEFAULT_PAGE_SIZE
    if (!Number.isSafeInteger(resolved) || resolved < 1 || resolved > MAX_PAGE_SIZE) {
      throw new TeamError(`message page size must be from 1 through ${MAX_PAGE_SIZE}`, 'TEAM_MESSAGE_QUERY_INVALID')
    }
    return resolved
  }

  /** Join message payloads to their event-owned index and refuse inconsistent durable state. */
  private indexed(state: TeamState, rootId: SessionId): IndexedMessage[] {
    if (state.messages.length !== state.messageIndex.length) {
      throw new TeamError('persisted Team message index is inconsistent', 'TEAM_MESSAGE_STATE_INVALID')
    }
    return state.messageIndex.map((index, position) => {
      const message = state.messages[position]
      if (message === undefined || message.id !== index.messageId) {
        throw new TeamError('persisted Team message index is inconsistent', 'TEAM_MESSAGE_STATE_INVALID')
      }
      this.participant(state, message.senderId, rootId, message.senderName)
      this.participant(state, message.targetId, rootId)
      this.delivery(index, Number.MAX_SAFE_INTEGER)
      return { message, index }
    })
  }

  /** Test one message against its participant-relative filters and as-of delivery fact. */
  private matches(
    candidate: IndexedMessage,
    filters: NormalizedFilters,
    through: number,
  ): boolean {
    const { message, index } = candidate
    if (filters.memberId !== undefined) {
      if (filters.direction === 'sent' && message.senderId !== filters.memberId) return false
      if (filters.direction === 'received' && message.targetId !== filters.memberId) return false
      if (filters.direction === undefined
        && message.senderId !== filters.memberId && message.targetId !== filters.memberId) return false
    }
    const stage = this.delivery(index, through).stage
    if (filters.delivery !== undefined && stage !== filters.delivery) return false
    return true
  }

  /** Build one detached metadata result and revalidate both persisted participants. */
  private summary(
    candidate: IndexedMessage,
    state: TeamState,
    rootId: SessionId,
    through: number,
  ): TeamMessageSummary {
    return {
      id: candidate.message.id,
      sender: this.participant(state, candidate.message.senderId, rootId, candidate.message.senderName),
      recipient: this.participant(state, candidate.message.targetId, rootId),
      sentAt: candidate.index.queuedAt,
      delivery: this.delivery(candidate.index, through),
    }
  }

  /** Resolve a Host-owned participant name and reject a forged persisted sender label. */
  private participant(
    state: TeamState,
    id: SessionId,
    rootId: SessionId,
    assertedName?: string,
  ): TeamMessageParticipant {
    const name = id === rootId ? 'lead' : state.members.find(member => member.id === id)?.name
    if (name === undefined || (assertedName !== undefined && assertedName !== name)) {
      throw new TeamError('persisted Team message participant is invalid', 'TEAM_MESSAGE_STATE_INVALID')
    }
    return { id, name }
  }

  /** Derive delivery strictly from an acknowledgement inside the fixed committed cutoff. */
  private delivery(index: TeamMessageIndexEntry, through: number): TeamMessageDelivery {
    if (index.deliveredSeq === undefined) {
      if (index.deliveredAt === undefined) return { stage: 'pending' }
      throw new TeamError('persisted Team message delivery index is inconsistent', 'TEAM_MESSAGE_STATE_INVALID')
    }
    if (index.deliveredAt === undefined) {
      throw new TeamError('persisted Team message delivery index is inconsistent', 'TEAM_MESSAGE_STATE_INVALID')
    }
    return index.deliveredSeq > through
      ? { stage: 'pending' }
      : { stage: 'delivered', deliveredAt: index.deliveredAt }
  }

  /** Retain literal text and detached image facts while replacing private or unknown blocks. */
  private content(blocks: readonly ContentBlock[]): TeamMessageContent {
    let omittedCount = 0
    let visibleCount = 0
    const parts = blocks.map((block) => {
      if (block.type === 'text') {
        visibleCount += 1
        return { type: 'text' as const, text: block.text }
      }
      if (block.type === 'image') {
        visibleCount += 1
        const { mediaType, bytes, width, height } = block.attachment
        return { type: 'image' as const, mediaType, bytes, width, height }
      }
      omittedCount += 1
      return { type: 'omitted' as const }
    })
    return {
      completeness: omittedCount === 0 ? 'complete' : visibleCount === 0 ? 'unavailable' : 'partial',
      omittedCount,
      parts,
    }
  }

  /** Encode a deterministic restart-safe cursor with a corruption checksum. */
  private encodeCursor(payload: CursorPayload): TeamMessageCursor {
    const value = JSON.stringify(payload)
    const checksum = createHash('sha256').update(value, 'utf8').digest('hex')
    return toTeamMessageCursor(Buffer.from(JSON.stringify([value, checksum]), 'utf8').toString('base64url'))
  }

  /** Decode and validate Team scope, query identity, bounds, and checksum. */
  private decodeCursor(
    cursor: TeamMessageCursor,
    teamId: string,
    expectedFilters: NormalizedFilters | undefined,
    lastSeq: number,
  ): CursorPayload {
    try {
      if (typeof cursor !== 'string' || cursor.length === 0
        || Buffer.byteLength(cursor, 'utf8') > MAX_CURSOR_BYTES || !/^[A-Za-z0-9_-]+$/u.test(cursor)) {
        throw new Error('invalid cursor encoding')
      }
      const outer: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'))
      if (!Array.isArray(outer) || outer.length !== 2
        || typeof outer[0] !== 'string' || typeof outer[1] !== 'string') {
        throw new Error('invalid cursor envelope')
      }
      const checksum = createHash('sha256').update(outer[0], 'utf8').digest('hex')
      if (outer[1] !== checksum) throw new Error('invalid cursor checksum')
      const value: unknown = JSON.parse(outer[0])
      if (!isCursorPayload(value)) throw new Error('invalid cursor payload')
      if (value.teamId !== teamId) {
        throw new TeamError('message cursor belongs to another Team', 'TEAM_MESSAGE_CURSOR_SCOPE')
      }
      if (value.through > lastSeq) throw new Error('message cursor is ahead of committed history')
      if (expectedFilters !== undefined && !sameFilters(value.filters, expectedFilters)) {
        throw new TeamError('message cursor belongs to another query', 'TEAM_MESSAGE_CURSOR_QUERY_MISMATCH')
      }
      return value
    } catch (error: unknown) {
      if (error instanceof TeamError) throw error
      throw new TeamError('message cursor is invalid', 'TEAM_MESSAGE_CURSOR_INVALID', { cause: error })
    }
  }
}

/** Cursor payload validator for the untrusted Remote string. */
function isCursorPayload(value: unknown): value is CursorPayload {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const candidate = value as Record<string, unknown>
  const keys = Object.keys(candidate).sort()
  const expectedKeys = candidate.before === undefined
    ? ['filters', 'teamId', 'through', 'version']
    : ['before', 'filters', 'teamId', 'through', 'version']
  if (keys.length !== expectedKeys.length || keys.some((key, index) => key !== expectedKeys[index])) return false
  if (candidate.version !== CURSOR_VERSION || typeof candidate.teamId !== 'string' || candidate.teamId.length === 0
    || !Number.isSafeInteger(candidate.through) || (candidate.through as number) < -1
    || (candidate.before !== undefined && (!Number.isSafeInteger(candidate.before)
      || (candidate.before as number) < 0 || (candidate.before as number) > (candidate.through as number)))) return false
  if (candidate.filters === null || typeof candidate.filters !== 'object' || Array.isArray(candidate.filters)) return false
  const filters = candidate.filters as Record<string, unknown>
  const filterKeys = Object.keys(filters)
  if (filterKeys.some(key => key !== 'memberId' && key !== 'direction' && key !== 'delivery')) return false
  return (filters.memberId === undefined || typeof filters.memberId === 'string')
    && (filters.direction === undefined || filters.direction === 'sent' || filters.direction === 'received')
    && (filters.delivery === undefined || filters.delivery === 'pending'
      || filters.delivery === 'delivered' || filters.delivery === 'unknown')
    && !(filters.direction !== undefined && filters.memberId === undefined)
}

/** Compare canonical optional filter fields without depending on object identity. */
function sameFilters(left: NormalizedFilters, right: NormalizedFilters): boolean {
  return left.memberId === right.memberId
    && left.direction === right.direction
    && left.delivery === right.delivery
}
