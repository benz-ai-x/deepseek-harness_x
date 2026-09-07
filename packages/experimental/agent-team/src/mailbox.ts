/** Durable Team mailbox admission, target-local dispatch, acknowledgement, and recovery. */

import { randomUUID } from 'node:crypto'
import assert from 'node:assert/strict'
import type { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { steerHostSubagentPrompt } from '@deepseek-ai/dsh-subagent/internal'
import {
  TeamId,
  TeamMessageId as toTeamMessageId,
  TeamMessageRequestId as toTeamMessageRequestId,
} from './brand.ts'
import type { TeammateRuntimeTurnId } from './brand.ts'
import { errorMessage, TeamError } from './error.ts'
import type { TeamJournal } from './journal.ts'
import type { TeamRuntimeLifecycle } from './lifecycle.ts'
import { readPersistedSession } from './persisted.ts'
import type { TeamMembership, TeamRoster } from './roster.ts'
import { resolveActiveMember } from './roster.ts'
import { messageAccepted } from './session-message.ts'
import { nativeOperationFingerprint, nativeOperationId } from './native-operation.ts'
import { teamMessageRequestFingerprint } from './message-request.ts'
import type { NativeMemberGrant, NativeMemberMailboxRequest, NativeMemberRecoveryItem, TeammateRuntimeRegistry } from './service-types.ts'
import type {
  SendTeamMessageRequest,
  SendTeamMessageResult,
  SubmitTeamMessageRequest,
  SubmitTeamMessageValue,
  TeamMessageId,
  TeamMessageDelivery,
  TeamMessageRequestReceipt,
  TeamMessageSnapshot,
  NativeMemberMessageResult,
  NativeMemberOperationSource,
  TeamNativeMessageReceipt,
} from './types.ts'

/** Owns every process-local state transition for the durable Team mailbox. */
export class TeamMailbox {
  private readonly dispatchTails = new Map<SessionId, Promise<void>>()
  private readonly inFlightMessages = new Set<TeamMessageId>()
  private readonly inFlightMessageResults = new Map<TeamMessageId, Promise<boolean>>()
  private readonly inFlightDispatches = new Set<Promise<unknown>>()

  /**
   * @param ctx - Team service context with Agent, Session, persistence, and subagent services.
   * @param journal - authoritative Lead-log transaction owner.
   * @param roster - Team membership and member-name resolver.
   * @param lifecycle - shared Team runtime admission cutoff.
   * @param maxPendingMessagesPerMember - per-target queued-minus-delivered limit.
   * @param maxMessageBytes - maximum complete sender-framed delivery size.
   */
  constructor(
    private readonly ctx: Context,
    private readonly journal: TeamJournal,
    private readonly roster: TeamRoster,
    private readonly lifecycle: TeamRuntimeLifecycle,
    private readonly teammateRuntimes: TeammateRuntimeRegistry,
    private readonly maxPendingMessagesPerMember: number,
    private readonly maxMessageBytes: number,
  ) {}

  /**
   * Queue one durable peer message, then attempt immediate delivery.
   * @param caller - exact live sending Team member.
   * @param request - target name, content, and pre-queue cancellation.
   * @returns durable message identity and immediate-delivery observation.
   */
  async send(caller: Agent, request: SendTeamMessageRequest): Promise<SendTeamMessageResult> {
    if (this.lifecycle.disposed) throw new TeamError('Agent Teams service is disposing', 'TEAM_DISPOSED')
    const operation = this.sendAdmitted(caller, {
      ...request,
      signal: AbortSignal.any([request.signal, this.lifecycle.signal]),
    })
    return await this.trackDispatch(operation)
  }

  /**
   * Commit or replay one Lead-authored message request, then observe its current delivery stage.
   * @param caller - exact live Team Lead; the request cannot assert a sender.
   * @param request - stable request identity, explicit recipient, literal text, and optional prior message.
   * @param signal - caller cancellation that owns work only until a new request is durably accepted.
   * @returns original durable acceptance and current Host-proven delivery stage.
   */
  async submit(
    caller: Agent,
    request: SubmitTeamMessageRequest,
    signal: AbortSignal,
  ): Promise<SubmitTeamMessageValue> {
    if (this.lifecycle.disposed) throw new TeamError('Agent Teams service is disposing', 'TEAM_DISPOSED')
    return await this.trackDispatch(this.submitAdmitted(caller, request, signal))
  }

  /**
   * Commit one native member message and its recoverable receipt before delivery.
   * @param identity - Team-issued member identity, never model arguments.
   * @param source - trusted provider turn and call correlation.
   * @param request - validated target and intentional message text.
   * @param authorize - current grant and exact live Lead check, repeated at the write queue.
   * @param signal - cancellation before durable acceptance.
   * @returns the original queued receipt for an identical native call.
   */
  async sendNative(
    identity: NativeMemberGrant['identity'],
    source: NativeMemberOperationSource,
    request: NativeMemberMailboxRequest,
    authorize: () => TeamMembership,
    signal: AbortSignal,
  ): Promise<NativeMemberMessageResult> {
    const membership = authorize()
    const operationId = nativeOperationId(identity, source)
    const inputFingerprint = nativeOperationFingerprint(request)
    return await this.trackDispatch(this.journal.transact(membership.root.id, async () => {
      signal.throwIfAborted()
      const current = authorize()
      const prior = this.journal.state(current.root).nativeOperations.find(receipt => receipt.id === operationId)
      if (prior !== undefined) {
        if (prior.inputFingerprint !== inputFingerprint || 'request' in prior) {
          throw new TeamError('The native call already accepted different input.', 'TEAM_NATIVE_OPERATION_CONFLICT')
        }
        await this.journal.flush(current.root)
        const message = this.journal.state(current.root).messages.find(candidate => candidate.id === prior.result.value.messageId)
        assert(message !== undefined, 'A native operation receipt must retain its queued message')
        void this.tryDispatch(current.root, message, this.lifecycle.signal)
        return structuredClone(prior.result)
      }
      const message = this.prepareMessage(current, identity.memberId, {
        target: request.operation === 'messages.send' ? request.target : 'lead',
        content: [{ type: 'text', text: request.text }], signal,
      })
      const result: NativeMemberMessageResult = request.operation === 'messages.send'
        ? { ok: true, operation: request.operation, value: { messageId: message.id, status: 'queued' } }
        : { ok: true, operation: request.operation, value: { messageId: message.id, status: 'queued', outcome: request.outcome } }
      const receipt: TeamNativeMessageReceipt = {
        id: operationId, memberId: identity.memberId, provider: identity.provider,
        nativeHandle: identity.nativeHandle, source: structuredClone(source), inputFingerprint,
        result,
      }
      await this.journal.appendAndFlush(current.root, 'team/native-operation/committed', {
        version: 4, kind: 'message', teamId: identity.teamId, message, receipt,
      })
      void this.tryDispatch(current.root, message, this.lifecycle.signal)
      return structuredClone(receipt.result)
    }))
  }

  /**
   * Read work correlations and terminal messages belonging to one authorized native member.
   * @param identity - current Team-issued provider and handle identity.
   * @param authorize - exact current grant check repeated in the read queue and after flushing pending facts.
   * @param signal - cancellation before returning a committed view.
   * @returns detached launch, inbound delivery ids, and committed settlement values; incoming text is excluded.
   */
  async readNativeRecovery(
    identity: NativeMemberGrant['identity'],
    authorize: () => TeamMembership,
    signal: AbortSignal,
  ): Promise<NativeMemberRecoveryItem[]> {
    const membership = authorize()
    return await this.trackDispatch(this.journal.transact(membership.root.id, async () => {
      signal.throwIfAborted()
      const current = authorize()
      await this.ctx.sessions.flush(current.root.session)
      signal.throwIfAborted()
      authorize()
      return this.nativeRecoveryItems(identity, current)
    }))
  }

  private nativeRecoveryItems(identity: NativeMemberGrant['identity'], membership: TeamMembership): NativeMemberRecoveryItem[] {
    const state = this.journal.state(membership.root)
    const external = state.members.find(member => member.id === identity.memberId)?.externalRuntime
    assert(external !== undefined, 'An authorized native member must retain its launch identity')
    const items: NativeMemberRecoveryItem[] = [{ kind: 'launch', launchRequestId: external.launchRequestId,
      ...external.initialTurnId === undefined ? {} : { turnId: external.initialTurnId },
    }]
    for (const message of state.messages) {
      if (message.targetId === identity.memberId) items.push({ kind: 'delivery', deliveryId: message.id })
    }
    for (const receipt of state.nativeOperations) {
      if (receipt.memberId !== identity.memberId || receipt.provider !== identity.provider || receipt.nativeHandle !== identity.nativeHandle
        || receipt.source.kind !== 'settlement' || receipt.result.operation !== 'turns.settle') continue
      const { messageId, outcome } = receipt.result.value
      const message = state.messages.find(message => message.id === messageId)
      assert(message !== undefined, 'A committed native settlement must retain its message')
      const block = message.content[0]
      assert(message.content.length === 1 && block?.type === 'text', 'A native settlement must retain one intentional text block')
      items.push({ kind: 'settlement', turnId: receipt.source.turnId, outcome, text: block.text })
    }
    return structuredClone(items)
  }

  /**
   * Observe target-side durable receipts and checkpoint their Lead-log acknowledgement.
   * @param session - exact target Session receiving the event.
   * @param event - newly appended Session event.
   */
  observeSessionEvent(session: Session, event: SessionEvent): void {
    if (this.lifecycle.disposed || event.type !== 'user/message' || event.data.source.kind !== 'team-message') return
    const source = event.data.source
    const acknowledgement = Promise.resolve().then(async () => {
      const root = this.ctx.agents.get(brandString<SessionId>(source.teamId))
      if (root !== undefined) await this.checkpointDelivered(root, session, source.messageId)
    }).catch((error: unknown) => {
      this.ctx.logger.warn(`Team message "${source.messageId}" acknowledgement failed: ${errorMessage(error)}`)
    })
    void this.trackDispatch(acknowledgement)
  }

  /**
   * Retry durable pending messages relevant to one started Team member.
   * @param agent - newly started exact live Agent.
   * @param signal - shared runtime cancellation.
   */
  async recoverFor(agent: Agent, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    const membership = this.roster.tryMembership(agent)
    if (membership === undefined) return
    const state = this.journal.state(membership.root)
    const messages = state.messages.filter(message =>
      !state.delivered.includes(message.id)
      && (membership.role === 'lead' || message.targetId === agent.id))
    for (const message of messages) {
      signal.throwIfAborted()
      await this.tryDispatch(membership.root, message, signal)
    }
  }

  /**
   * Return admitted dispatch and acknowledgement operations captured for disposal.
   * @returns detached snapshot ordered only by Set insertion.
   */
  pendingDispatches(): readonly Promise<unknown>[] {
    return [...this.inFlightDispatches]
  }

  /** Queue and dispatch one mailbox item admitted before the disposal cutoff. */
  private async sendAdmitted(
    caller: Agent,
    request: SendTeamMessageRequest,
  ): Promise<SendTeamMessageResult> {
    const membership = this.roster.membership(caller)
    request.signal.throwIfAborted()
    const root = membership.root
    const content = structuredClone(request.content)
    const queued = await this.journal.transact(root.id, async () => {
      request.signal.throwIfAborted()
      const queued = this.prepareMessage(membership, caller.id, { ...request, content })
      await this.journal.appendAndFlush(root, 'team/message/queued', {
        version: 2,
        teamId: TeamId(root.id),
        message: queued,
      })
      // Register dispatch before releasing the root transaction so concurrent
      // senders enter the target-local queue in durable mailbox order.
      return { message: queued, dispatch: this.tryDispatch(root, queued, request.signal) }
    })
    const accepted = await queued.dispatch
    return { messageId: queued.message.id, status: accepted ? 'accepted' : 'queued' }
  }

  /** Commit a new request or recover its original receipt inside the Team write queue. */
  private async submitAdmitted(
    caller: Agent,
    request: SubmitTeamMessageRequest,
    signal: AbortSignal,
  ): Promise<SubmitTeamMessageValue> {
    const initial = this.lead(caller)
    const root = initial.root
    let requestId: SubmitTeamMessageRequest['requestId']
    try {
      requestId = toTeamMessageRequestId(request.requestId)
    } catch (error) {
      throw new TeamError(
        'Team message request ID must be non-empty and at most 200 UTF-8 bytes.',
        'TEAM_INVALID_ARGUMENT',
        { cause: error },
      )
    }
    if (typeof request.text !== 'string' || request.text.trim().length === 0) {
      throw new TeamError('Team message text must contain a non-whitespace character.', 'TEAM_INVALID_ARGUMENT')
    }
    const normalized = {
      requestId,
      recipientId: request.recipientId,
      text: request.text,
      ...(request.replyTo === undefined ? {} : { replyTo: request.replyTo }),
    }
    const inputFingerprint = teamMessageRequestFingerprint(normalized)
    const accepted = await this.journal.transact(root.id, async () => {
      const current = this.lead(caller)
      const state = this.journal.state(current.root)
      const prior = state.messageRequests.find(candidate =>
        candidate.senderId === caller.id && candidate.requestId === normalized.requestId)
      if (prior !== undefined) {
        if (prior.inputFingerprint !== inputFingerprint) {
          throw new TeamError(
            'The Team message request already accepted different input.',
            'TEAM_MESSAGE_REQUEST_CONFLICT',
          )
        }
        await this.journal.flush(current.root)
        const message = this.messageForReceipt(current.root, prior)
        return {
          receipt: prior,
          message,
          dispatch: this.tryDispatch(current.root, message, this.lifecycle.signal),
        }
      }

      signal.throwIfAborted()
      const target = this.activeRecipient(current, normalized.recipientId)
      if (normalized.replyTo !== undefined
        && !state.messages.some(candidate => candidate.id === normalized.replyTo)) {
        throw new TeamError('The reply message does not belong to this Team.', 'TEAM_MESSAGE_NOT_FOUND')
      }
      const message = this.prepareMessageForTarget(current, caller.id, target, [
        { type: 'text', text: normalized.text },
      ], normalized.replyTo)
      const receipt: TeamMessageRequestReceipt = {
        requestId: normalized.requestId,
        senderId: caller.id,
        inputFingerprint,
        ...(normalized.replyTo === undefined ? {} : { replyTo: normalized.replyTo }),
        result: { requestId: normalized.requestId, messageId: message.id, status: 'accepted' },
      }
      await this.journal.appendAndFlush(current.root, 'team/message/request-committed', {
        version: 1,
        teamId: TeamId(current.root.id),
        receipt,
        message,
      })
      return {
        receipt,
        message,
        dispatch: this.tryDispatch(current.root, message, this.lifecycle.signal),
      }
    })
    // Delivery is already tracked by the Team lifecycle; the caller owns only the
    // durable submission acknowledgement and may disconnect after this point.
    void accepted.dispatch
    return {
      submission: structuredClone(accepted.receipt.result),
      delivery: this.delivery(root, accepted.message.id),
    }
  }

  /** Resolve the exact current Lead at both Remote admission and serialized write time. */
  private lead(caller: Agent): TeamMembership & { readonly role: 'lead' } {
    const membership = this.roster.membership(caller)
    if (membership.role !== 'lead') {
      throw new TeamError('only the Team Lead can submit human-authored messages', 'TEAM_LEAD_REQUIRED')
    }
    return { ...membership, role: 'lead' }
  }

  /** Resolve an explicit durable recipient without accepting a caller-supplied name. */
  private activeRecipient(
    membership: TeamMembership,
    recipientId: SessionId,
  ): { readonly id: SessionId; readonly name: string } {
    const member = this.journal.state(membership.root).members.find(candidate =>
      candidate.id === recipientId && candidate.phase === 'active')
    if (member === undefined) {
      throw new TeamError('The message recipient is not an active member of this Team.', 'TEAM_MEMBER_NOT_FOUND')
    }
    return { id: member.id, name: member.name }
  }

  /** Recover the message retained by one already accepted request receipt. */
  private messageForReceipt(root: Agent, receipt: TeamMessageRequestReceipt): TeamMessageSnapshot {
    const message = this.journal.state(root).messages.find(candidate => candidate.id === receipt.result.messageId)
    assert(message !== undefined, 'A Team message request receipt must retain its queued message')
    return message
  }

  /** Read delivery only from the authoritative acknowledgement projection. */
  private delivery(root: Agent, messageId: TeamMessageId): TeamMessageDelivery {
    const state = this.journal.state(root)
    const index = state.messageIndex.find(candidate => candidate.messageId === messageId)
    assert(index !== undefined, 'An accepted Team message must retain its queue index')
    if (!state.delivered.includes(messageId)) return { stage: 'pending' }
    assert(index.deliveredAt !== undefined, 'A delivered Team message must retain its delivery time')
    return { stage: 'delivered', deliveredAt: index.deliveredAt }
  }

  /** Apply the same target, capacity and delivered-content limits for DSH and native senders. */
  private prepareMessage(
    membership: TeamMembership,
    senderId: SessionId,
    request: SendTeamMessageRequest,
  ): TeamMessageSnapshot {
    const state = this.journal.state(membership.root)
    const target = resolveActiveMember(membership.root.id, state, request.target)
    return this.prepareMessageForTarget(membership, senderId, target, request.content)
  }

  /** Apply shared capacity and delivered-content limits after resolving one exact target. */
  private prepareMessageForTarget(
    membership: TeamMembership,
    senderId: SessionId,
    target: { readonly id: SessionId; readonly name: string },
    content: readonly ContentBlock[],
    replyTo?: TeamMessageId,
  ): TeamMessageSnapshot {
    const state = this.journal.state(membership.root)
    if (target.id === senderId) throw new TeamError('a Team member cannot message itself', 'TEAM_SELF_MESSAGE')
    const pending = state.messages.filter(candidate =>
      candidate.targetId === target.id && !state.delivered.includes(candidate.id)).length
    if (pending >= this.maxPendingMessagesPerMember) {
      throw new TeamError(`teammate "${target.name}" has ${pending} pending messages`, 'TEAM_MAILBOX_FULL')
    }
    const message: TeamMessageSnapshot = {
      id: toTeamMessageId(`team-message-${randomUUID()}`), senderId, senderName: membership.name,
      targetId: target.id, content: structuredClone([...content]),
    }
    if (Buffer.byteLength(JSON.stringify(this.deliveryContent(message, replyTo)), 'utf8') > this.maxMessageBytes) {
      throw new TeamError(`team message exceeds ${this.maxMessageBytes} bytes`, 'TEAM_MESSAGE_TOO_LARGE')
    }
    return message
  }

  /** Attempt one queued message exactly once in this process at a time. */
  private tryDispatch(root: Agent, message: TeamMessageSnapshot, signal: AbortSignal): Promise<boolean> {
    if (this.lifecycle.disposed) return Promise.resolve(false)
    const existing = this.inFlightMessageResults.get(message.id)
    if (existing !== undefined) return existing
    this.inFlightMessages.add(message.id)
    const operation = this.trackDispatch(
      this.tryDispatchAdmitted(
        root,
        message,
        AbortSignal.any([signal, this.lifecycle.signal]),
      ),
    )
    this.inFlightMessageResults.set(message.id, operation)
    const forget = (): void => {
      this.inFlightMessages.delete(message.id)
      this.inFlightMessageResults.delete(message.id)
    }
    void operation.then(forget, forget)
    return operation
  }

  /** Track one dispatch transaction through delivery admission or contained failure. */
  private trackDispatch<T>(operation: Promise<T>): Promise<T> {
    this.inFlightDispatches.add(operation)
    void operation.then(() => {
      this.inFlightDispatches.delete(operation)
    }, () => {
      this.inFlightDispatches.delete(operation)
    })
    return operation
  }

  /** Attempt one queued message admitted before the service lifecycle cutoff. */
  private async tryDispatchAdmitted(
    root: Agent,
    message: TeamMessageSnapshot,
    signal: AbortSignal,
  ): Promise<boolean> {
    return await this.serializeDispatch(message, () => this.dispatchThrough(root, message, signal))
  }

  /** Serialize delivery admission for one durable target in queued order. */
  private async serializeDispatch(
    message: TeamMessageSnapshot,
    operation: () => Promise<boolean>,
  ): Promise<boolean> {
    const targetId = message.targetId
    const prior = this.dispatchTails.get(targetId) ?? Promise.resolve()
    /* v8 ignore next -- dispatch tails absorb rejection, so the recovery callback is a fail-safe backstop. */
    const run = prior.then(operation, operation)
    /* v8 ignore next -- dispatchOnce contains delivery failures and serializeDispatch itself does not throw. */
    const tail = run.then(() => undefined, () => undefined)
    this.dispatchTails.set(targetId, tail)
    try {
      return await run
    } finally {
      if (this.dispatchTails.get(targetId) === tail) this.dispatchTails.delete(targetId)
    }
  }

  /** Deliver every pending target message through `message` in durable queue order. */
  private async dispatchThrough(
    root: Agent,
    message: TeamMessageSnapshot,
    signal: AbortSignal,
  ): Promise<boolean> {
    const state = this.journal.state(root)
    const pending = state.messages.filter(candidate =>
      candidate.targetId === message.targetId && !state.delivered.includes(candidate.id))
    const requested = pending.findIndex(candidate => candidate.id === message.id)
    if (requested < 0) return state.delivered.includes(message.id)
    for (const candidate of pending.slice(0, requested + 1)) {
      const ownsInFlight = !this.inFlightMessages.has(candidate.id)
      if (ownsInFlight) this.inFlightMessages.add(candidate.id)
      try {
        if (!await this.dispatchOnce(root, candidate, signal)) return false
      } finally {
        if (ownsInFlight) this.inFlightMessages.delete(candidate.id)
      }
    }
    return true
  }

  /** Attempt one queued delivery after target-local ordering admits it. */
  private async dispatchOnce(root: Agent, message: TeamMessageSnapshot, signal: AbortSignal): Promise<boolean> {
    try {
      const replyTo = this.replyTo(root, message.id)
      const externalMember = this.journal.state(root).members.find(member =>
        member.id === message.targetId
        && member.phase === 'active'
        && member.externalRuntime?.nativeHandle !== undefined)
      if (externalMember?.externalRuntime?.nativeHandle !== undefined) {
        if (this.teammateRuntimes.runtimePresence(externalMember.provider, externalMember.externalRuntime.nativeHandle) === 'inactive') {
          await this.roster.recoverFor(root, signal)
        }
        const delivered = await this.teammateRuntimes.deliver(externalMember.provider, {
          nativeHandle: externalMember.externalRuntime.nativeHandle,
          deliveryId: message.id,
          senderId: message.senderId,
          senderName: message.senderName,
          content: this.deliveryContent(message, replyTo),
          signal,
        })
        await this.markDelivered(root, message.id, message.targetId, delivered.turnId)
        return true
      }
      const target = message.targetId === root.id ? root : this.ctx.agents.get(message.targetId)
      if (target !== undefined && this.targetRecorded(target.session, message.id)) {
        return await this.checkpointDelivered(root, target.session, message.id)
      }
      const source = {
        kind: 'team-message' as const,
        teamId: TeamId(root.id),
        messageId: message.id,
        senderId: message.senderId,
        senderName: message.senderName,
      }
      const content = this.deliveryContent(message, replyTo)
      if (message.targetId === root.id) {
        const input = createUserMessage({ content, source })
        root.steer(input)
        return await this.checkpointDelivered(root, root.session, message.id)
      }
      if (target === undefined) {
        const recorded = await this.persistedTargetRecorded(message.targetId, message.id, signal)
        if (recorded === undefined) return false
        if (recorded) {
          await this.markDelivered(root, message.id, message.targetId)
          return true
        }
      }
      await steerHostSubagentPrompt(this.ctx.subagents, root, message.targetId, content, source, signal)
      return target === undefined
        ? true
        : await this.checkpointDelivered(root, target.session, message.id)
    } catch (error: unknown) {
      this.ctx.logger.warn(`team message "${message.id}" remains queued: ${errorMessage(error)}`)
      return false
    }
  }

  /** Flush one live target receipt before the Lead records its delivered edge. */
  private async checkpointDelivered(
    root: Agent,
    target: Session,
    messageId: TeamMessageId,
  ): Promise<boolean> {
    await this.ctx.sessions.flush(target)
    if (!this.targetRecorded(target, messageId)) return false
    await this.markDelivered(root, messageId, target.id)
    return true
  }

  /** Record delivery unless the acknowledgement already exists. */
  private async markDelivered(
    root: Agent,
    messageId: TeamMessageId,
    targetId: SessionId,
    nativeTurnId?: TeammateRuntimeTurnId,
  ): Promise<void> {
    await this.journal.transact(root.id, async () => {
      const state = this.journal.state(root)
      if (state.delivered.includes(messageId)) return
      const queued = state.messages.find(message => message.id === messageId)
      if (queued === undefined || queued.targetId !== targetId) return
      await this.journal.appendAndFlush(root, 'team/message/delivered', {
        version: 2,
        teamId: TeamId(root.id),
        messageId,
        targetId,
        ...(nativeTurnId === undefined ? {} : { nativeTurnId }),
      })
    })
  }

  /** Whether a target Session already contains the durable message identity. */
  private targetRecorded(session: Session, messageId: TeamMessageId): boolean {
    const suffix = session.snapshotEvents(session.inheritedEventCount)
    return messageAccepted(suffix, message => message.source.kind === 'team-message'
      && message.source.messageId === messageId)
  }

  /** Frame peer content with stable sender and message identity for the receiving model. */
  private deliveryContent(message: TeamMessageSnapshot, replyTo?: TeamMessageId): ContentBlock[] {
    return [
      {
        type: 'text',
        text: replyTo === undefined
          ? `Team message ${message.id} from ${message.senderName}:`
          : `Team message ${message.id} in reply to ${replyTo} from ${message.senderName}:`,
      },
      ...structuredClone(message.content),
    ]
  }

  /** Find the optional reply correlation stored with one human-authored message. */
  private replyTo(root: Agent, messageId: TeamMessageId): TeamMessageId | undefined {
    return this.journal.state(root).messageRequests.find(receipt =>
      receipt.result.messageId === messageId)?.replyTo
  }

  /** Read an inactive target's durable log before cold resume; uncertainty keeps the mailbox queued. */
  private async persistedTargetRecorded(
    targetId: SessionId,
    messageId: TeamMessageId,
    signal: AbortSignal,
  ): Promise<boolean | undefined> {
    try {
      const stored = await readPersistedSession(this.ctx.sessionPersistence, targetId, signal)
      const suffix = stored.events.slice(stored.inheritedEventCount)
      return messageAccepted(suffix, message => message.source.kind === 'team-message'
        && message.source.messageId === messageId)
    } catch (error: unknown) {
      this.ctx.logger.warn(`cannot read Team message target "${targetId}": ${errorMessage(error)}`)
      return undefined
    }
  }
}
