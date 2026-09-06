import { describe, expect, it } from 'vitest'
import { SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionEventMap, SessionEventType } from '@deepseek-ai/dsh-session'
import { teamProjectionDefinition } from '../src/projection.ts'
import type { TeamProjectionState, TeamState } from '../src/projection.ts'
import {
  TeamId,
  TeamMessageId,
  TeamNativeOperationId,
  TeamTaskId,
  TeammateLaunchRequestId,
  TeammateRuntimeHandle,
  TeammateRuntimeTurnId,
  TeammateRuntimeToolCallId,
} from '../src/brand.ts'
import type { TeamMemberSnapshot, TeamMessageSnapshot, TeamTaskSnapshot } from '../src/types.ts'

const ROOT = SessionId('team-root')
const TEAM = TeamId(ROOT)
const CHILD = SessionId('child-a')

function event<T extends SessionEventType, D extends SessionEventMap[T]>(type: T, data: D, seq: SessionSeq): SessionEvent<T> & { data: D } {
  return { type, data, seq, time: seq } as SessionEvent<T> & { data: D }
}

function project(rootId: SessionId, events: readonly SessionEvent[]): TeamProjectionState {
  let state = teamProjectionDefinition.init({ version: 0, id: rootId, createdAt: 0, isSeeded: false })
  for (const event of events) state = teamProjectionDefinition.apply(state, event)
  return state
}

function teamState(projected: TeamProjectionState): TeamState {
  if (projected.failure !== undefined) throw new Error(projected.failure)
  return projected
}

function projectTeam(rootId: SessionId, events: readonly SessionEvent[]): TeamState {
  return teamState(project(rootId, events))
}

/** Queued-minus-delivered mail retained by the projection. */
function pending(state: TeamState): TeamMessageSnapshot[] {
  return state.messages.filter(message => !state.delivered.includes(message.id))
}

/** Whether one Team state contains no projected records. */
function isEmptyState(state: TeamState): boolean {
  return state.members.length === 0 && state.tasks.length === 0
    && state.messages.length === 0 && state.delivered.length === 0
}

function member(overrides: Partial<TeamMemberSnapshot> = {}): TeamMemberSnapshot {
  return {
    id: CHILD,
    name: 'worker-a',
    description: 'worker',
    provider: 'spawn',
    context: 'fresh',
    phase: 'provisioning',
    ...overrides,
  }
}

function externalRuntime(
  overrides: Partial<NonNullable<TeamMemberSnapshot['externalRuntime']>> = {},
): NonNullable<TeamMemberSnapshot['externalRuntime']> {
  return {
    kind: 'external-agent',
    launchRequestId: TeammateLaunchRequestId('external-launch-1'),
    requestFingerprint: '1'.repeat(64),
    requirements: {
      contextMode: 'fresh',
      profileCapabilities: ['persona', 'mission'],
      runtimeCapabilities: ['evaluation', 'evidence'],
    },
    ...overrides,
  }
}

function task(overrides: Partial<TeamTaskSnapshot> = {}): TeamTaskSnapshot {
  return {
    id: TeamTaskId('task-1'),
    revision: 1,
    subject: 'subject',
    description: 'description',
    status: 'pending',
    blockedBy: [],
    writeScopes: [],
    ...overrides,
  }
}

function message(overrides: Partial<TeamMessageSnapshot> = {}): TeamMessageSnapshot {
  return {
    id: TeamMessageId('message-1'),
    senderId: ROOT,
    senderName: 'lead',
    targetId: CHILD,
    content: [{ type: 'text', text: 'hello' }],
    ...overrides,
  }
}

describe('Agent Teams projection events', () => {
  it.each([
    'operation-id', 'call-id', 'input-fingerprint', 'member', 'provider', 'handle', 'sender',
    'sender-name', 'result-message', 'source-kind', 'target', 'self-message', 'content',
    'duplicate-operation', 'duplicate-message',
  ] as const)('rejects a native receipt with a changed %s', (corruption) => {
    const provisioning = member({ provider: 'native', externalRuntime: externalRuntime() })
    const prefix = [
      event('team/member', { version: 2, teamId: TEAM, member: provisioning }, SessionSeq(0)),
      event('team/member', { version: 2, teamId: TEAM, member: { ...provisioning, phase: 'active',
        externalRuntime: { ...provisioning.externalRuntime!, nativeHandle: TeammateRuntimeHandle('handle-1') },
      } }, SessionSeq(1)),
    ]
    const committed = event('team/native-operation/committed', {
      version: 3, teamId: TEAM,
      message: message({ senderId: CHILD, senderName: 'worker-a', targetId: ROOT }),
      receipt: {
        id: TeamNativeOperationId('2e57e0ef07a7b8566bad1d2bfa654b3b8d3054c6474bf4ac361b32c2ab2c0df5'),
        memberId: CHILD, provider: 'native', nativeHandle: TeammateRuntimeHandle('handle-1'),
        source: { kind: 'tool', turnId: TeammateRuntimeTurnId('turn-1'), callId: TeammateRuntimeToolCallId('call-1') },
        inputFingerprint: '0f36bd40cf1f1795f9a1a7fba7e085abf11a0c4400a6b005ae146770f3274147',
        result: { ok: true, operation: 'messages.send', value: { messageId: TeamMessageId('message-1'), status: 'queued' } },
      },
    }, SessionSeq(2))
    expect(projectTeam(ROOT, [...prefix, committed]).nativeOperations).toHaveLength(1)
    expect(projectTeam(ROOT, [...prefix, { ...committed, data: { ...committed.data, version: 4, kind: 'message' } }])
      .nativeOperations).toHaveLength(1)
    const changed: unknown = {
      ...committed,
      data: { ...committed.data,
        message: { ...committed.data.message,
          ...(corruption === 'sender' ? { senderId: ROOT } : {}),
          ...(corruption === 'sender-name' ? { senderName: 'lead' } : {}),
          ...(corruption === 'target' ? { targetId: 'another-team' } : {}),
          ...(corruption === 'self-message' ? { targetId: CHILD } : {}),
          ...(corruption === 'content' ? { content: [{ type: 'reasoning', text: 'Do not publish reasoning.' }] } : {}),
        }, receipt: { ...committed.data.receipt,
          ...(corruption === 'operation-id' ? { id: 'f'.repeat(64) } : {}),
          ...(corruption === 'call-id' ? { source: { ...committed.data.receipt.source, callId: 'different-call' } } : {}),
          ...(corruption === 'input-fingerprint' ? { inputFingerprint: 'f'.repeat(64) } : {}),
          ...(corruption === 'member' ? { memberId: ROOT } : {}),
          ...(corruption === 'provider' ? { provider: 'other-native' } : {}),
          ...(corruption === 'handle' ? { nativeHandle: 'another-handle' } : {}),
          ...(corruption === 'source-kind' ? { source: { kind: 'settlement', turnId: 'turn-1' } } : {}),
          ...(corruption === 'result-message' ? { result: { ...committed.data.receipt.result,
            value: { messageId: 'different-message', status: 'queued' },
          } } : {}),
          ...(corruption === 'duplicate-message' ? {
            id: 'a52b11fd04b2cb845ffa0fad7c0268f43174b8491ecb550ae29180f3259d6f78',
            source: { kind: 'tool', turnId: 'turn-1', callId: 'call-2' },
          } : {}),
        } },
    }
    const events = corruption.startsWith('duplicate-') ? [...prefix, committed] : prefix
    expect(project(ROOT, [...events, changed as SessionEvent]).failure).toContain('native operation')
  })

  it.each([
    'operation-id', 'fingerprint', 'member', 'provider', 'handle', 'source-kind', 'input',
    'task-revision', 'task-owner', 'task-status', 'result-revision', 'result-owner', 'result-ready',
    'lead-action', 'duplicate',
  ] as const)('rejects a native task receipt with changed %s before applying its task', (corruption) => {
    const provisioning = member({ provider: 'native', externalRuntime: externalRuntime() })
    const prefix = [
      event('team/member', { version: 2, teamId: TEAM, member: provisioning }, SessionSeq(0)),
      event('team/member', { version: 2, teamId: TEAM, member: { ...provisioning, phase: 'active',
        externalRuntime: { ...provisioning.externalRuntime!, nativeHandle: TeammateRuntimeHandle('handle-1') },
      } }, SessionSeq(1)),
      event('team/task', { version: 2, teamId: TEAM, task: task() }, SessionSeq(2)),
    ]
    const claimed = task({ revision: 2, ownerId: CHILD, status: 'in_progress' })
    const committed = event('team/native-operation/committed', {
      version: 4, kind: 'task', teamId: TEAM, task: claimed,
      receipt: {
        id: TeamNativeOperationId('2e57e0ef07a7b8566bad1d2bfa654b3b8d3054c6474bf4ac361b32c2ab2c0df5'),
        memberId: CHILD, provider: 'native', nativeHandle: TeammateRuntimeHandle('handle-1'),
        source: { kind: 'tool', turnId: TeammateRuntimeTurnId('turn-1'), callId: TeammateRuntimeToolCallId('call-1') },
        inputFingerprint: '5090d5c28388e647056383198afb55bfb9ac84fe74116b1ae87346ee4bdcaed1',
        request: { operation: 'tasks.update', taskId: claimed.id, expectedRevision: 1, action: 'claim' },
        result: { ok: true, operation: 'tasks.update', value: {
          task: { id: claimed.id, revision: 2, status: 'in_progress', ownerName: 'worker-a', ready: false },
        } },
      },
    }, SessionSeq(3))
    const valid = projectTeam(ROOT, [...prefix, committed])
    expect(valid.tasks).toEqual([claimed])
    expect(teamProjectionDefinition.stateSchema.parse(JSON.parse(JSON.stringify(valid)))).toEqual(valid)
    const changed: unknown = { ...committed, data: { ...committed.data,
      task: { ...committed.data.task,
        ...corruption === 'task-revision' ? { revision: 3 } : {},
        ...corruption === 'task-owner' ? { ownerId: ROOT } : {},
        ...corruption === 'task-status' ? { status: 'completed' } : {},
      },
      receipt: { ...committed.data.receipt,
        ...corruption === 'operation-id' ? { id: 'f'.repeat(64) } : {},
        ...corruption === 'fingerprint' ? { inputFingerprint: 'f'.repeat(64) } : {},
        ...corruption === 'member' ? { memberId: ROOT } : {},
        ...corruption === 'provider' ? { provider: 'another' } : {},
        ...corruption === 'handle' ? { nativeHandle: 'another' } : {},
        ...corruption === 'source-kind' ? { source: { kind: 'settlement', turnId: 'turn-1' } } : {},
        ...corruption === 'input' ? { request: { ...committed.data.receipt.request, expectedRevision: 2 } } : {},
        ...corruption === 'lead-action' ? {
          request: { ...committed.data.receipt.request, action: 'reassign', owner: 'worker-a' },
          inputFingerprint: 'db64bdd5a740acec0da724dc59ab87b7b3b24665e6448ac3f2d84448b8a9fe83',
        } : {},
        result: { ...committed.data.receipt.result, value: { task: { ...committed.data.receipt.result.value.task,
          ...corruption === 'result-revision' ? { revision: 3 } : {},
          ...corruption === 'result-owner' ? { ownerName: 'lead' } : {},
          ...corruption === 'result-ready' ? { ready: true } : {},
        } } },
      },
    } }
    const projected = project(ROOT, [...prefix, ...corruption === 'duplicate' ? [committed] : [], changed as SessionEvent])
    expect(projected.failure).toBeDefined()
    expect(projected.tasks).toEqual(corruption === 'duplicate' ? [claimed] : [task()])
    expect(projected.nativeOperations).toHaveLength(corruption === 'duplicate' ? 1 : 0)
  })

  it('round-trips bounded opaque external launch and native identities', () => {
    const launchRequestId = TeammateLaunchRequestId('launch/request/请求')
    const nativeHandle = TeammateRuntimeHandle('native/session/运行')
    const provisioning = member({
      provider: 'native',
      externalRuntime: externalRuntime({ launchRequestId }),
    })
    const projected = projectTeam(ROOT, [
      event('team/member', { version: 2, teamId: TEAM, member: provisioning }, SessionSeq(0)),
      event('team/member', {
        version: 2,
        teamId: TEAM,
        member: {
          ...provisioning,
          phase: 'active',
          externalRuntime: { ...provisioning.externalRuntime!, nativeHandle },
        },
      }, SessionSeq(1)),
    ])

    expect(teamProjectionDefinition.stateSchema.parse(JSON.parse(JSON.stringify(projected))))
      .toEqual(projected)
  })

  it('projects current-team records independently from inherited records', () => {
    const records: SessionEvent[] = [
      event('team/member', { version: 2, teamId: TeamId('ancestor'), member: member() }, SessionSeq(0)),
      event('team/member', { version: 2, teamId: TEAM, member: member() }, SessionSeq(1)),
      event('team/member', {
        version: 2,
        teamId: TEAM,
        member: member({ phase: 'active' }),
      }, SessionSeq(2)),
      event('team/task', { version: 2, teamId: TEAM, task: task({ id: TeamTaskId('task-7') }) }, SessionSeq(3)),
      event('team/message/queued', { version: 2, teamId: TEAM, message: message() }, SessionSeq(4)),
    ]
    const projected = project(ROOT, records)
    const state = teamState(projected)

    expect(state).toMatchObject({ id: TEAM })
    expect(state.members).toHaveLength(1)
    expect(state.tasks).toHaveLength(1)
    expect(pending(state)).toHaveLength(1)
    expect(state.nextTaskNumber).toBe(8)
    expect(state.members.find(member => member.id === CHILD)?.name).toBe('worker-a')
    expect(teamProjectionDefinition.stateSchema.parse(JSON.parse(JSON.stringify(projected))))
      .toEqual(projected)
  })

  it('enforces teammate identity and lifecycle', () => {
    const base = event('team/member', { version: 2, teamId: TEAM, member: member() }, SessionSeq(0))
    expect(() => projectTeam(ROOT, [event('team/member', {
      version: 2,
      teamId: TEAM,
      member: member({ phase: 'active' }),
    }, SessionSeq(0))])).toThrow(/must begin provisioning/)
    expect(() => projectTeam(ROOT, [base, event('team/member', {
      version: 2,
      teamId: TEAM,
      member: member({ name: 'renamed', phase: 'active' }),
    }, SessionSeq(1))])).toThrow(/immutable identity/)
    expect(() => projectTeam(ROOT, [base, event('team/member', {
      version: 2,
      teamId: TEAM,
      member: member({ description: 'changed responsibility', phase: 'active' }),
    }, SessionSeq(1))])).toThrow(/immutable identity/)
    expect(() => projectTeam(ROOT, [base, event('team/member', {
      version: 2,
      teamId: TEAM,
      member: member({ phase: 'active' }),
    }, SessionSeq(1)), event('team/member', {
      version: 2,
      teamId: TEAM,
      member: member({ phase: 'failed' }),
    }, SessionSeq(2))])).toThrow(/invalid active -> failed/)

    const duplicateName = member({ id: SessionId('child-b') })
    expect(() => projectTeam(ROOT, [base, event('team/member', {
      version: 2,
      teamId: TEAM,
      member: duplicateName,
    }, SessionSeq(1))])).toThrow(/name .* reused/)

    const duplicateExternalLaunch = member({
      id: SessionId('child-b'),
      name: 'worker-b',
      provider: 'native',
      externalRuntime: externalRuntime(),
    })
    expect(() => projectTeam(ROOT, [event('team/member', {
      version: 2,
      teamId: TEAM,
      member: member({ provider: 'native', externalRuntime: externalRuntime() }),
    }, SessionSeq(0)), event('team/member', {
      version: 2,
      teamId: TEAM,
      member: duplicateExternalLaunch,
    }, SessionSeq(1))])).toThrow(/launch request .* reused/)

    const secondExternal = member({
      id: SessionId('child-b'),
      name: 'worker-b',
      provider: 'native',
      externalRuntime: externalRuntime({ launchRequestId: TeammateLaunchRequestId('external-launch-2') }),
    })
    expect(() => projectTeam(ROOT, [
      event('team/member', {
        version: 2,
        teamId: TEAM,
        member: member({ provider: 'native', externalRuntime: externalRuntime() }),
      }, SessionSeq(0)),
      event('team/member', {
        version: 2,
        teamId: TEAM,
        member: member({
          provider: 'native',
          phase: 'active',
          externalRuntime: externalRuntime({ nativeHandle: TeammateRuntimeHandle('shared-native') }),
        }),
      }, SessionSeq(1)),
      event('team/member', { version: 2, teamId: TEAM, member: secondExternal }, SessionSeq(2)),
      event('team/member', {
        version: 2,
        teamId: TEAM,
        member: {
          ...secondExternal,
          phase: 'active',
          externalRuntime: {
            ...secondExternal.externalRuntime!,
            nativeHandle: TeammateRuntimeHandle('shared-native'),
          },
        },
      }, SessionSeq(3)),
    ])).toThrow(/native handle .* reused/)

    const externalProvisioning = event('team/member', {
      version: 2,
      teamId: TEAM,
      member: member({ provider: 'native', externalRuntime: externalRuntime() }),
    }, SessionSeq(0))
    const externalActive = event('team/member', {
      version: 2,
      teamId: TEAM,
      member: member({
        provider: 'native',
        externalRuntime: externalRuntime({ nativeHandle: TeammateRuntimeHandle('native-1') }),
        phase: 'active',
      }),
    }, SessionSeq(1))
    expect(() => projectTeam(ROOT, [externalProvisioning, externalActive, event('team/member', {
      version: 2,
      teamId: TEAM,
      member: member({
        provider: 'native',
        externalRuntime: externalRuntime({ nativeHandle: TeammateRuntimeHandle('native-2') }),
        phase: 'failed',
      }),
    }, SessionSeq(2))])).toThrow(/immutable identity/)
    const withTurn = { ...externalActive, data: { ...externalActive.data, member: {
      ...externalActive.data.member,
      externalRuntime: { ...externalActive.data.member.externalRuntime!, initialTurnId: TeammateRuntimeTurnId('original-turn') },
    } } }
    expect(() => projectTeam(ROOT, [externalProvisioning, withTurn, event('team/member', {
      version: 2, teamId: TEAM, member: { ...withTurn.data.member, phase: 'failed',
        externalRuntime: { ...withTurn.data.member.externalRuntime, initialTurnId: TeammateRuntimeTurnId('substituted-turn') },
      },
    }, SessionSeq(2))])).toThrow(/immutable identity/)
  })

  it('enforces task revision continuity', () => {
    const first = event('team/task', { version: 2, teamId: TEAM, task: task() }, SessionSeq(0))
    expect(() => projectTeam(ROOT, [event('team/task', {
      version: 2,
      teamId: TEAM,
      task: task({ revision: 2 }),
    }, SessionSeq(0))])).toThrow(/begin at revision 1/)
    expect(() => projectTeam(ROOT, [first, event('team/task', {
      version: 2,
      teamId: TEAM,
      task: task({ revision: 3 }),
    }, SessionSeq(1))])).toThrow(/revision is not contiguous/)
  })

  it('rejects every invalid persisted task dependency relation', () => {
    const first = event('team/task', { version: 2, teamId: TEAM, task: task() }, SessionSeq(0))
    const second = event('team/task', {
      version: 2,
      teamId: TEAM,
      task: task({
        id: TeamTaskId('task-2'),
        blockedBy: [TeamTaskId('task-1')],
      }),
    }, SessionSeq(1))
    const invalid: Array<{ records: SessionEvent[]; message: RegExp }> = [
      {
        records: [event('team/task', {
          version: 2,
          teamId: TEAM,
          task: task({ blockedBy: [TeamTaskId('missing')] }),
        }, SessionSeq(0))],
        message: /blocker task "missing" .* is missing or deleted/,
      },
      {
        records: [event('team/task', {
          version: 2,
          teamId: TEAM,
          task: task({ blockedBy: [TeamTaskId('task-1')] }),
        }, SessionSeq(0))],
        message: /cannot block itself/,
      },
      {
        records: [first, event('team/task', {
          ...second.data,
          task: { ...second.data.task, blockedBy: [TeamTaskId('task-1'), TeamTaskId('task-1')] },
        }, SessionSeq(1))],
        message: /repeats blocker/,
      },
      {
        records: [first, second, event('team/task', {
          version: 2,
          teamId: TEAM,
          task: task({ revision: 2, blockedBy: [TeamTaskId('task-2')] }),
        }, SessionSeq(2))],
        message: /dependency cycle/,
      },
      {
        records: [first, second, event('team/task', {
          version: 2,
          teamId: TEAM,
          task: task({ revision: 2, status: 'deleted' }),
        }, SessionSeq(2))],
        message: /blocker task "task-1" .* is missing or deleted/,
      },
    ]

    for (const { records, message: expected } of invalid) {
      expect(() => projectTeam(ROOT, records)).toThrow(expected)
    }
  })

  it('leaves numeric allocation unchanged for a branded nonstandard task id', () => {
    const state = projectTeam(ROOT, [event('team/task', {
      version: 2,
      teamId: TEAM,
      task: task({ id: TeamTaskId('external-task') }),
    }, SessionSeq(0))])
    expect(state.nextTaskNumber).toBe(1)
  })

  it('rejects a persisted numeric task id outside the safe integer range', () => {
    expect(() => projectTeam(ROOT, [event('team/task', {
      version: 2,
      teamId: TEAM,
      task: task({ id: TeamTaskId('task-9007199254740992') }),
    }, SessionSeq(0))])).toThrow(/persisted Agent Teams team\/task payload is invalid/)
  })

  it('enforces mailbox queue and acknowledgement relations', () => {
    const queued = event('team/message/queued', { version: 2, teamId: TEAM, message: message() }, SessionSeq(0))
    const delivered = event('team/message/delivered', {
      version: 2,
      teamId: TEAM,
      messageId: TeamMessageId('message-1'),
      targetId: CHILD,
    }, SessionSeq(1))
    expect(pending(projectTeam(ROOT, [queued, delivered]))).toEqual([])
    expect(() => projectTeam(ROOT, [queued, queued])).toThrow(/queued twice/)
    expect(() => projectTeam(ROOT, [delivered])).toThrow(/delivered before queueing/)
    expect(() => projectTeam(ROOT, [queued, event('team/message/delivered', {
      ...delivered.data,
      targetId: SessionId('other'),
    }, SessionSeq(1))])).toThrow(/target changed/)
    expect(() => projectTeam(ROOT, [queued, delivered, { ...delivered, seq: SessionSeq(2) }])).toThrow(/delivered twice/)
  })

  it('validates every current-version persisted payload before projecting it', () => {
    const invalidExternalMembers = [
      member({
        provider: 'native',
        requestedRoute: { provider: 'mock' },
        externalRuntime: externalRuntime(),
      }),
      member({
        provider: 'native',
        phase: 'active',
        externalRuntime: externalRuntime(),
      }),
      member({
        provider: 'native',
        phase: 'provisioning',
        externalRuntime: externalRuntime({ nativeHandle: TeammateRuntimeHandle('premature-handle') }),
      }),
      member({
        provider: 'native',
        context: 'fork',
        externalRuntime: externalRuntime(),
      }),
      member({
        provider: 'native',
        externalRuntime: externalRuntime({
          requirements: {
            contextMode: 'fresh',
            profileCapabilities: ['persona'],
            runtimeCapabilities: [],
          },
        }),
      }),
      member({
        provider: 'native',
        externalRuntime: externalRuntime({
          requirements: {
            contextMode: 'fresh',
            profileCapabilities: ['mission', 'persona'],
            runtimeCapabilities: ['evaluation', 'evidence'],
          },
        }),
      }),
      member({
        provider: 'native',
        externalRuntime: externalRuntime({
          requirements: {
            contextMode: 'fresh',
            profileCapabilities: ['persona', 'mission'],
            runtimeCapabilities: ['evidence', 'evaluation'],
          },
        }),
      }),
    ]
    const malformed = [
      {
        ...event('team/member', { version: 2, teamId: TEAM, member: member() }, SessionSeq(0)),
        data: { version: 2, teamId: TEAM, member: { ...member(), name: 42 } },
      },
      {
        ...event('team/task', { version: 2, teamId: TEAM, task: task() }, SessionSeq(0)),
        data: { version: 2, teamId: TEAM, task: { ...task(), blockedBy: [42] } },
      },
      {
        ...event('team/message/queued', { version: 2, teamId: TEAM, message: message() }, SessionSeq(0)),
        data: {
          version: 2,
          teamId: TEAM,
          message: { ...message(), content: [{ type: 'text', text: 42 }] },
        },
      },
      {
        ...event('team/message/delivered', {
          version: 2,
          teamId: TEAM,
          messageId: TeamMessageId('message-1'),
          targetId: CHILD,
        }, SessionSeq(0)),
        data: {
          version: 2,
          teamId: TEAM,
          messageId: TeamMessageId('message-1'),
          targetId: 42,
        },
      },
      {
        ...event('team/member', { version: 2, teamId: TEAM, member: member() }, SessionSeq(0)),
        data: { version: 2, teamId: TEAM, member: member(), unexpected: true },
      },
      {
        ...event('team/task', { version: 2, teamId: TEAM, task: task() }, SessionSeq(0)),
        data: { version: 2, teamId: 42, task: task() },
      },
      ...invalidExternalMembers.map(invalidMember => ({
        ...event('team/member', { version: 2, teamId: TEAM, member: member() }, SessionSeq(0)),
        data: { version: 2, teamId: TEAM, member: invalidMember },
      })),
    ] as unknown as SessionEvent[]

    for (const candidate of malformed) {
      expect(() => projectTeam(ROOT, [candidate]))
        .toThrow(/persisted Agent Teams .* payload is invalid/)
    }
  })

  it('retains merge-extensible content blocks while rejecting malformed core variants', () => {
    const extension = { type: 'plugin/custom', payload: { value: 1 } } as never
    const state = projectTeam(ROOT, [event('team/message/queued', {
      version: 2,
      teamId: TEAM,
      message: message({ content: [extension] }),
    }, SessionSeq(0))])
    expect(pending(state)[0]?.content).toEqual([extension])
  })

  it('records unsupported event versions without applying them', () => {
    const invalid = event('team/task', {
      version: 1 as 2,
      teamId: TEAM,
      task: task(),
    }, SessionSeq(0))
    const later = event('team/task', {
      version: 2,
      teamId: TEAM,
      task: task(),
    }, SessionSeq(1))
    const state = project(ROOT, [invalid, later])
    expect(state.failure).toMatch(/unsupported Agent Teams event version 1/)
    expect(isEmptyState(state)).toBe(true)
  })

  it('isolates unsupported inherited Team records from the current Team', () => {
    const inherited = event('team/task', {
      version: 1 as 2,
      teamId: TeamId('ancestor'),
      task: task(),
    }, SessionSeq(0))
    const projected = project(ROOT, [inherited])
    expect(projected.failure).toBeUndefined()
    expect(isEmptyState(teamState(projected))).toBe(true)
  })

  it('ignores malformed current-version records inherited from another Team', () => {
    const inherited = {
      ...event('team/task', {
        version: 2,
        teamId: TeamId('ancestor'),
        task: task(),
      }, SessionSeq(0)),
      data: {
        version: 2,
        teamId: TeamId('ancestor'),
        task: { ...task(), subject: 42 },
      },
    } as unknown as SessionEvent
    expect(isEmptyState(projectTeam(ROOT, [inherited]))).toBe(true)
  })
})
