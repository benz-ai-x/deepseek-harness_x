import { afterEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { Buffer } from 'node:buffer'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { ToolCallId, type ContentBlock } from '@deepseek-ai/dsh-llm'
import { SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SubagentService from '@deepseek-ai/dsh-subagent'
import * as SubagentFork from '@deepseek-ai/dsh-subagent-fork-in-process'
import * as SubagentSpawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import { MockAdapter } from '../../../core/agent-loop/tests/mock-adapter.ts'
import TeamService, { TeamId, TeamMessageCursor, TeamMessageId } from '../src/index.ts'
import type { TeamMemberSnapshot, TeamMessageSnapshot } from '../src/types.ts'
import { TestSessionQuery } from './test-session-query.ts'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

async function mount(storageRoot: string, script: ConstructorParameters<typeof MockAdapter>[0] = []) {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(JsonlSessionPersistence, { root: storageRoot })
  await ctx.plugin(TestSessionQuery)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(SubagentService)
  await ctx.plugin(SubagentSpawn, { providerName: 'spawn' })
  await ctx.plugin(SubagentFork, { providerName: 'fork' })
  const teamFiber = ctx.plugin(TeamService)
  await teamFiber
  ctx.llm.registerAdapter(['mock'], new MockAdapter(script))
  return { ctx, teamFiber }
}

async function setup(rootId = 'message-read-lead', script: ConstructorParameters<typeof MockAdapter>[0] = []) {
  const storageRoot = mkdtempSync(join(tmpdir(), 'dsh-team-message-read-'))
  roots.push(storageRoot)
  const { ctx, teamFiber } = await mount(storageRoot, script)
  const lead = await ctx.agentLoop.create(SessionId(rootId), { provider: 'mock', model: 'mock' })
  return { ctx, lead, storageRoot, teamFiber }
}

function cursorEnvelope(payload: unknown, checksum?: string): TeamMessageCursor {
  const value = JSON.stringify(payload)
  const digest = checksum ?? createHash('sha256').update(value, 'utf8').digest('hex')
  return TeamMessageCursor(Buffer.from(JSON.stringify([value, digest]), 'utf8').toString('base64url'))
}

function rawCursorEnvelope(value: unknown): TeamMessageCursor {
  return TeamMessageCursor(Buffer.from(JSON.stringify(value), 'utf8').toString('base64url'))
}

function cursorPayload(cursor: TeamMessageCursor): { readonly through: number } {
  const outer = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as [string, string]
  return JSON.parse(outer[0]) as { readonly through: number }
}

function activeMember(id: SessionId, name: string): [TeamMemberSnapshot, TeamMemberSnapshot] {
  const provisioning: TeamMemberSnapshot = {
    id,
    name,
    description: `${name} responsibility`,
    provider: 'spawn',
    context: 'fresh',
    phase: 'provisioning',
  }
  return [provisioning, { ...provisioning, phase: 'active' }]
}

function appendMember(lead: Agent, id: SessionId, name: string): void {
  for (const member of activeMember(id, name)) {
    lead.session.append('team/member', { version: 2, teamId: TeamId(lead.id), member })
  }
}

function appendMessage(
  lead: Agent,
  id: string,
  senderId: SessionId,
  senderName: string,
  targetId: SessionId,
  content: ContentBlock[],
): TeamMessageSnapshot {
  const message: TeamMessageSnapshot = {
    id: TeamMessageId(id), senderId, senderName, targetId, content,
  }
  lead.session.append('team/message/queued', {
    version: 2,
    teamId: TeamId(lead.id),
    message,
  })
  return message
}

function eventTime(lead: Agent, type: 'team/message/queued' | 'team/message/delivered', id: string): number {
  const found = lead.session.ownEvents().find((event) => {
    if (type === 'team/message/queued' && event.type === type) return event.data.message.id === id
    if (type === 'team/message/delivered' && event.type === type) return event.data.messageId === id
    return false
  })
  if (found === undefined || found.type !== type) throw new Error(`${type} ${id} is missing`)
  return found.time
}

describe('Agent Teams committed message reader', () => {
  it('pages a fixed committed window and reveals only safe intentional content on demand', async () => {
    const { ctx, lead } = await setup()
    const alpha = SessionId('message-read-alpha')
    appendMember(lead, alpha, 'alpha')
    const oldest = appendMessage(lead, 'message-oldest', lead.id, 'lead', alpha, [
      { type: 'text', text: 'oldest visible body' },
    ])
    lead.session.append('team/message/delivered', {
      version: 2, teamId: TeamId(lead.id), messageId: oldest.id, targetId: alpha,
    })
    const mixed = appendMessage(lead, 'message-mixed', alpha, 'alpha', lead.id, [
      { type: 'text', text: 'visible progress' },
      { type: 'reasoning', text: 'private chain of thought' },
      {
        type: 'tool-call', id: ToolCallId('private-call'), name: 'secret-tool', arguments: '{"token":"credential"}',
      },
      {
        type: 'image',
        attachment: {
          attachmentId: '/private/attachment/path' as never,
          mediaType: 'image/png',
          bytes: 12,
          width: 3,
          height: 4,
        },
      },
      { type: 'provider/private', credential: 'plugin-secret' } as never,
    ])
    const newest = appendMessage(lead, 'message-newest', lead.id, 'lead', alpha, [
      { type: 'text', text: 'newest visible body' },
    ])
    await ctx.sessions.flush(lead.session)

    const first = await ctx.agentTeams.listMessages(lead, { limit: 2 })
    expect(first.complete).toBe(true)
    expect(first.items).toEqual([
      {
        id: newest.id,
        sender: { id: lead.id, name: 'lead' },
        recipient: { id: alpha, name: 'alpha' },
        sentAt: eventTime(lead, 'team/message/queued', newest.id),
        delivery: { stage: 'pending' },
      },
      {
        id: mixed.id,
        sender: { id: alpha, name: 'alpha' },
        recipient: { id: lead.id, name: 'lead' },
        sentAt: eventTime(lead, 'team/message/queued', mixed.id),
        delivery: { stage: 'pending' },
      },
    ])
    expect(first.nextCursor).toEqual(expect.any(String))
    expect(first.committedCursor).toEqual(expect.any(String))
    expect(JSON.stringify(first)).not.toMatch(/visible body|visible progress|chain of thought|credential|attachment\/path|plugin-secret/u)

    const detail = await ctx.agentTeams.getMessage(lead, {
      messageId: mixed.id,
      committedCursor: first.committedCursor,
    })
    expect(detail).toEqual({
      ...first.items[1],
      content: {
        completeness: 'partial',
        omittedCount: 3,
        parts: [
          { type: 'text', text: 'visible progress' },
          { type: 'omitted' },
          { type: 'omitted' },
          { type: 'image', mediaType: 'image/png', bytes: 12, width: 3, height: 4 },
          { type: 'omitted' },
        ],
      },
    })
    expect(JSON.stringify(detail)).not.toMatch(/chain of thought|credential|private-call|secret-tool|attachment\/path|plugin-secret/u)
    const completeDetail = await ctx.agentTeams.getMessage(lead, {
      messageId: newest.id,
      committedCursor: first.committedCursor,
    })
    expect(completeDetail.content).toEqual({
      completeness: 'complete',
      omittedCount: 0,
      parts: [{ type: 'text', text: 'newest visible body' }],
    })
    await expect(ctx.agentTeams.getMessage(lead, {
      messageId: oldest.id,
      committedCursor: first.nextCursor!,
    })).rejects.toMatchObject({ code: 'TEAM_MESSAGE_CURSOR_INVALID' })

    lead.session.append('team/message/delivered', {
      version: 2, teamId: TeamId(lead.id), messageId: newest.id, targetId: alpha,
    })
    const later = appendMessage(lead, 'message-later', alpha, 'alpha', lead.id, [
      { type: 'text', text: 'later body' },
    ])
    await ctx.sessions.flush(lead.session)

    const oldDetail = await ctx.agentTeams.getMessage(lead, {
      messageId: newest.id,
      committedCursor: first.committedCursor,
    })
    expect(oldDetail.delivery).toEqual({ stage: 'pending' })
    const second = await ctx.agentTeams.listMessages(lead, { limit: 2, cursor: first.nextCursor! })
    expect(second.items).toEqual([
      {
        id: oldest.id,
        sender: { id: lead.id, name: 'lead' },
        recipient: { id: alpha, name: 'alpha' },
        sentAt: eventTime(lead, 'team/message/queued', oldest.id),
        delivery: {
          stage: 'delivered',
          deliveredAt: eventTime(lead, 'team/message/delivered', oldest.id),
        },
      },
    ])
    expect(second.nextCursor).toBeUndefined()
    expect(second.committedCursor).toBe(first.committedCursor)

    const fresh = await ctx.agentTeams.remoteListMessages(lead, { limit: 3 })
    expect(fresh.items.map(item => item.id)).toEqual([later.id, newest.id, mixed.id])
    expect(fresh.items[1]?.delivery.stage).toBe('delivered')

    const privateOnly = appendMessage(lead, 'message-private-only', lead.id, 'lead', alpha, [
      { type: 'reasoning', text: 'private only' },
    ])
    await ctx.sessions.flush(lead.session)
    const privatePage = await ctx.agentTeams.listMessages(lead, { limit: 1 })
    const unavailable = await ctx.agentTeams.remoteGetMessage(lead, {
      messageId: privateOnly.id,
      committedCursor: privatePage.committedCursor,
    })
    expect(unavailable.content).toEqual({
      completeness: 'unavailable',
      omittedCount: 1,
      parts: [{ type: 'omitted' }],
    })
  })

  it('binds filters and cursors to one Team and exact live Lead', async () => {
    const { ctx, lead } = await setup('message-auth-lead')
    const alpha = SessionId('message-auth-alpha')
    appendMember(lead, alpha, 'alpha')
    const inbound = appendMessage(lead, 'message-inbound', lead.id, 'lead', alpha, [
      { type: 'text', text: 'inbound' },
    ])
    const outbound = appendMessage(lead, 'message-outbound', alpha, 'alpha', lead.id, [
      { type: 'text', text: 'outbound' },
    ])
    await ctx.sessions.flush(lead.session)

    const received = await ctx.agentTeams.listMessages(lead, {
      filters: { memberId: alpha, direction: 'received', delivery: 'pending' },
    })
    expect(received.items.map(item => item.id)).toEqual([inbound.id])
    const sent = await ctx.agentTeams.listMessages(lead, {
      filters: { memberId: alpha, direction: 'sent' },
    })
    expect(sent.items.map(item => item.id)).toEqual([outbound.id])
    const beta = SessionId('message-auth-beta')
    appendMember(lead, beta, 'beta')
    expect((await ctx.agentTeams.listMessages(lead, {
      filters: { memberId: beta },
    })).items).toEqual([])
    expect((await ctx.agentTeams.listMessages(lead, {
      filters: { memberId: alpha, direction: 'received', delivery: 'delivered' },
    })).items).toEqual([])
    await expect(ctx.agentTeams.listMessages(lead, {
      cursor: received.committedCursor,
      filters: { memberId: alpha, direction: 'sent' },
    })).rejects.toMatchObject({ code: 'TEAM_MESSAGE_CURSOR_QUERY_MISMATCH' })
    await expect(ctx.agentTeams.listMessages(lead, {
      filters: { memberId: SessionId('foreign-member') },
    })).rejects.toMatchObject({ code: 'TEAM_MEMBER_NOT_FOUND' })
    await expect(ctx.agentTeams.listMessages(lead, {
      filters: { direction: 'sent' },
    })).rejects.toMatchObject({ code: 'TEAM_MESSAGE_QUERY_INVALID' })
    await expect(ctx.agentTeams.listMessages(lead, {
      filters: { direction: 'sideways' as never, memberId: alpha },
    })).rejects.toMatchObject({ code: 'TEAM_MESSAGE_QUERY_INVALID' })
    await expect(ctx.agentTeams.listMessages(lead, {
      filters: { delivery: 'read' as never },
    })).rejects.toMatchObject({ code: 'TEAM_MESSAGE_QUERY_INVALID' })
    for (const limit of [0, 101, 1.5]) {
      await expect(ctx.agentTeams.listMessages(lead, { limit }))
        .rejects.toMatchObject({ code: 'TEAM_MESSAGE_QUERY_INVALID' })
    }
    await expect(ctx.agentTeams.listMessages(lead, { cursor: 'not-a-cursor' as never }))
      .rejects.toMatchObject({ code: 'TEAM_MESSAGE_CURSOR_INVALID' })

    const otherLead = await ctx.agentLoop.create(SessionId('message-other-lead'), { provider: 'mock', model: 'mock' })
    await expect(ctx.agentTeams.listMessages(otherLead, { cursor: received.committedCursor }))
      .rejects.toMatchObject({ code: 'TEAM_MESSAGE_CURSOR_SCOPE' })
    await expect(ctx.agentTeams.getMessage(otherLead, {
      messageId: inbound.id,
      committedCursor: received.committedCursor,
    })).rejects.toMatchObject({ code: 'TEAM_MESSAGE_CURSOR_SCOPE' })
    await expect(ctx.agentTeams.getMessage(lead, {
      messageId: TeamMessageId('foreign-message'),
      committedCursor: received.committedCursor,
    })).rejects.toMatchObject({ code: 'TEAM_MESSAGE_NOT_FOUND' })

    const impostor = { ...lead } as Agent
    await expect(ctx.agentTeams.listMessages(impostor, {}))
      .rejects.toMatchObject({ code: 'TEAM_NOT_MEMBER' })

    const workerId = SessionId('message-auth-worker')
    appendMember(lead, workerId, 'live-worker')
    const workerHandle = await ctx.agents.create({
      sessionId: workerId,
      meta: { parentSession: lead.id },
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    await expect(ctx.agentTeams.listMessages(workerHandle.agent, {}))
      .rejects.toMatchObject({ code: 'TEAM_LEAD_REQUIRED' })
    await workerHandle.dispose()
  })

  it('rejects malformed, forged, future and query-drift cursors at the Remote boundary', async () => {
    const { ctx, lead } = await setup('message-cursor-lead')
    const alpha = SessionId('message-cursor-alpha')
    appendMember(lead, alpha, 'alpha')
    appendMessage(lead, 'message-cursor-row', lead.id, 'lead', alpha, [
      { type: 'text', text: 'cursor row' },
    ])
    await ctx.sessions.flush(lead.session)
    const page = await ctx.agentTeams.listMessages(lead, {
      filters: { memberId: alpha, direction: 'received', delivery: 'pending' },
    })
    const lastSeq = lead.session.snapshotEvents().at(-1)!.seq
    const base = { version: 1, teamId: lead.id, filters: {}, through: lastSeq }
    const malformed = [
      '' as TeamMessageCursor,
      'not-a-cursor' as TeamMessageCursor,
      '%' as TeamMessageCursor,
      'a'.repeat(2_049) as TeamMessageCursor,
      42 as unknown as TeamMessageCursor,
      rawCursorEnvelope({}),
      rawCursorEnvelope([JSON.stringify(base)]),
      rawCursorEnvelope([0, 'checksum']),
      cursorEnvelope(base, '0'.repeat(64)),
    ]
    for (const cursor of malformed) {
      await expect(ctx.agentTeams.listMessages(lead, { cursor }))
        .rejects.toMatchObject({ code: 'TEAM_MESSAGE_CURSOR_INVALID' })
    }

    const invalidPayloads: unknown[] = [
      null,
      [],
      {},
      { ...base, extra: true },
      { ...base, version: 2 },
      { ...base, teamId: '' },
      { ...base, through: 1.5 },
      { ...base, through: -2 },
      { ...base, before: -1 },
      { ...base, before: lastSeq + 1 },
      { ...base, filters: null },
      { ...base, filters: [] },
      { ...base, filters: { extra: true } },
      { ...base, filters: { memberId: 1 } },
      { ...base, filters: { memberId: alpha, direction: 'sideways' } },
      { ...base, filters: { delivery: 'read' } },
      { ...base, filters: { direction: 'sent' } },
    ]
    for (const payload of invalidPayloads) {
      await expect(ctx.agentTeams.listMessages(lead, { cursor: cursorEnvelope(payload) }))
        .rejects.toMatchObject({ code: 'TEAM_MESSAGE_CURSOR_INVALID' })
    }
    await expect(ctx.agentTeams.listMessages(lead, {
      cursor: cursorEnvelope({ ...base, through: lastSeq + 1 }),
    })).rejects.toMatchObject({ code: 'TEAM_MESSAGE_CURSOR_INVALID' })
    await expect(ctx.agentTeams.listMessages(lead, {
      cursor: page.committedCursor,
      filters: { memberId: lead.id, direction: 'received', delivery: 'pending' },
    })).rejects.toMatchObject({ code: 'TEAM_MESSAGE_CURSOR_QUERY_MISMATCH' })
    await expect(ctx.agentTeams.listMessages(lead, {
      cursor: cursorEnvelope(base),
      filters: { delivery: 'pending' },
    })).rejects.toMatchObject({ code: 'TEAM_MESSAGE_CURSOR_QUERY_MISMATCH' })
  })

  it('rejects forged participants and inconsistent projected message indexes before filtering', async () => {
    const { ctx, lead } = await setup('message-state-lead')
    const alpha = SessionId('message-state-alpha')
    const beta = SessionId('message-state-beta')
    appendMember(lead, alpha, 'alpha')
    appendMember(lead, beta, 'beta')
    appendMessage(lead, 'message-state-row', lead.id, 'forged-lead', alpha, [
      { type: 'text', text: 'forged sender label' },
    ])
    await ctx.sessions.flush(lead.session)
    await expect(ctx.agentTeams.listMessages(lead, { filters: { memberId: beta } }))
      .rejects.toMatchObject({ code: 'TEAM_MESSAGE_STATE_INVALID' })

    const state = ctx.sessionProjections.stateOf(lead.session, 'agentTeam')!
    const message = state.messages[0]!
    ;(message as { senderName: string }).senderName = 'lead'
    ;(message as { targetId: SessionId }).targetId = SessionId('foreign-target')
    await expect(ctx.agentTeams.listMessages(lead, {}))
      .rejects.toMatchObject({ code: 'TEAM_MESSAGE_STATE_INVALID' })
    ;(message as { targetId: SessionId }).targetId = alpha

    const index = state.messageIndex[0]!
    state.messageIndex.splice(0, 1)
    await expect(ctx.agentTeams.listMessages(lead, {}))
      .rejects.toMatchObject({ code: 'TEAM_MESSAGE_STATE_INVALID' })
    state.messageIndex.push(index)
    ;(index as { messageId: ReturnType<typeof TeamMessageId> }).messageId = TeamMessageId('wrong-message')
    await expect(ctx.agentTeams.listMessages(lead, {}))
      .rejects.toMatchObject({ code: 'TEAM_MESSAGE_STATE_INVALID' })
    ;(index as { messageId: ReturnType<typeof TeamMessageId> }).messageId = message.id

    index.deliveredSeq = SessionSeq(index.queuedSeq + 1)
    delete index.deliveredAt
    await expect(ctx.agentTeams.listMessages(lead, {}))
      .rejects.toMatchObject({ code: 'TEAM_MESSAGE_STATE_INVALID' })
    delete index.deliveredSeq
    index.deliveredAt = Date.now()
    await expect(ctx.agentTeams.listMessages(lead, {}))
      .rejects.toMatchObject({ code: 'TEAM_MESSAGE_STATE_INVALID' })
  })

  it('reuses committed cursors and rebuilt message indexes after a cold Host restart', async () => {
    const storageRoot = mkdtempSync(join(tmpdir(), 'dsh-team-message-restart-'))
    roots.push(storageRoot)
    const leadId = SessionId('message-restart-lead')
    const alpha = SessionId('message-restart-alpha')
    const first = await mount(storageRoot)
    const lead = await first.ctx.agentLoop.create(leadId, { provider: 'mock', model: 'mock' })
    appendMember(lead, alpha, 'alpha')
    const message = appendMessage(lead, 'message-restart-row', lead.id, 'lead', alpha, [
      { type: 'text', text: 'survives restart' },
    ])
    await first.ctx.sessions.flush(lead.session)
    const before = await first.ctx.agentTeams.listMessages(lead, {})
    await first.ctx.fiber.dispose()

    const restarted = await mount(storageRoot)
    const handle = await restarted.ctx.agents.resume({
      resumeSessionId: leadId,
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    const after = await restarted.ctx.agentTeams.listMessages(handle.agent, { cursor: before.committedCursor })
    expect(after.items).toEqual(before.items)
    expect((await restarted.ctx.agentTeams.getMessage(handle.agent, {
      messageId: message.id,
      committedCursor: before.committedCursor,
    })).content.parts).toEqual([{ type: 'text', text: 'survives restart' }])
    await handle.dispose()
    await restarted.ctx.fiber.dispose()
  })

  it('returns a complete empty window for an eventless Team Lead', async () => {
    const { ctx, lead } = await setup('message-empty-lead')
    const page = await ctx.agentTeams.listMessages(lead, { filters: { memberId: lead.id } })
    expect(page).toMatchObject({ items: [], complete: true })
  })

  it('flushes before reads and publishes no Team event or activity', async () => {
    const { ctx, lead } = await setup('message-barrier-lead')
    const alpha = SessionId('message-barrier-alpha')
    appendMember(lead, alpha, 'alpha')
    const message = appendMessage(lead, 'message-uncommitted', lead.id, 'lead', alpha, [
      { type: 'text', text: 'must wait for persistence' },
    ])
    const eventCount = lead.session.snapshotEvents().length
    vi.spyOn(ctx.sessions, 'flush').mockRejectedValueOnce(new Error('persistence unavailable'))

    await expect(ctx.agentTeams.listMessages(lead, {})).rejects.toThrow('persistence unavailable')
    expect(lead.session.snapshotEvents()).toHaveLength(eventCount)
    const page = await ctx.agentTeams.listMessages(lead, {})
    expect(page.items.map(item => item.id)).toEqual([message.id])
    expect(lead.session.snapshotEvents()).toHaveLength(eventCount)

    const changed = ctx.agentTeams.waitForChange(lead, 10_000, AbortSignal.timeout(20))
    await ctx.agentTeams.getMessage(lead, {
      messageId: message.id,
      committedCursor: page.committedCursor,
    })
    await expect(changed).rejects.toMatchObject({ name: 'TimeoutError' })
  })

  it('pins a new committed cursor to the live cutoff captured before the durability barrier', async () => {
    const { ctx, lead } = await setup('message-cursor-cutoff-lead')
    const alpha = SessionId('message-cursor-cutoff-alpha')
    appendMember(lead, alpha, 'alpha')
    const message = appendMessage(lead, 'message-cursor-cutoff-row', lead.id, 'lead', alpha, [
      { type: 'text', text: 'durable at the read barrier' },
    ])
    const through = lead.session.snapshotEvents().at(-1)!.seq
    const flush = ctx.sessions.flush.bind(ctx.sessions)
    vi.spyOn(ctx.sessions, 'flush').mockImplementationOnce(async (session) => {
      const participated = await flush(session)
      session.append('turn/start', { turn: 1 })
      return participated
    })

    const page = await ctx.agentTeams.listMessages(lead, {})

    expect(page.items.map(item => item.id)).toEqual([message.id])
    expect(cursorPayload(page.committedCursor).through).toBe(through)
    expect(lead.session.snapshotEvents().at(-1)!.seq).toBe(through + 1)
  })

  it('closes read admission and settles an accepted read before Team disposal completes', async () => {
    const { ctx, lead, teamFiber } = await setup('message-reader-lifecycle-lead')
    const service = ctx.agentTeams
    const flushStarted = Promise.withResolvers<undefined>()
    const releaseFlush = Promise.withResolvers<undefined>()
    const flush = ctx.sessions.flush.bind(ctx.sessions)
    vi.spyOn(ctx.sessions, 'flush').mockImplementationOnce(async (session) => {
      flushStarted.resolve(undefined)
      await releaseFlush.promise
      return await flush(session)
    })

    const read = service.listMessages(lead, {})
    await flushStarted.promise
    let disposed = false
    const disposal = teamFiber.dispose().then(() => { disposed = true })
    await Promise.resolve()
    const disposedBeforeRelease = disposed
    releaseFlush.resolve(undefined)
    const outcome = await read.then(
      value => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error }),
    )
    await disposal

    expect(disposedBeforeRelease).toBe(false)
    expect(outcome).toMatchObject({ ok: false, error: { code: 'TEAM_DISPOSED' } })
    await expect(service.listMessages(lead, {})).rejects.toMatchObject({ code: 'TEAM_DISPOSED' })
  })
})
