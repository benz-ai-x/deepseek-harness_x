/** Reusable provider conformance suite for durable external teammate runtimes. */

import { randomUUID } from 'node:crypto'
import { SessionId } from '@deepseek-ai/dsh-session'
import { TeamMessageId, TeammateEvaluationId, TeammateLaunchRequestId } from './brand.ts'
import type {
  TeammateRuntimeCreateRequest,
  TeammateRuntimeProvider,
} from './service-types.ts'
import type { TeamMessageId as TeamMessageIdValue, TeammateRuntimeHandle, TeammateRuntimeTurnId } from './types.ts'

/** Native fixture hooks required to prove idempotency and complete cleanup. */
export interface TeammateRuntimeConformanceFixture {
  readonly provider: TeammateRuntimeProvider
  readonly createRequest: TeammateRuntimeCreateRequest
  /** Arm a create call to pause after admission; resolves once abort can exercise in-flight cancellation. */
  armCreateCancellation(): Promise<void>
  /** Arm a delivery call to pause after admission; resolves once abort can exercise in-flight cancellation. */
  armDeliveryCancellation(): Promise<void>
  /** Construct a fresh provider generation over the same durable native state. */
  reopen(): TeammateRuntimeProvider | Promise<TeammateRuntimeProvider>
  /** Prove one retried logical launch created only one durable native identity. */
  assertSingleRuntime(nativeHandle: TeammateRuntimeHandle): void | Promise<void>
  /** Prove one exact runtime retained the stable provider-native turn correlation. */
  assertTurn(
    nativeHandle: TeammateRuntimeHandle,
    deliveryId: TeamMessageIdValue,
    turnId: TeammateRuntimeTurnId,
  ): void | Promise<void>
  /** Prove interrupt targeted and cancelled work for the exact native runtime. */
  assertInterrupted(nativeHandle: TeammateRuntimeHandle): void | Promise<void>
  /** Prove the current generation retains no attached native resources. */
  assertDetached(): void | Promise<void>
}

/** Name and fixture factory for one provider implementation's shared suite. */
export interface TeammateRuntimeConformanceOptions {
  readonly name: string
  readonly testApi: Pick<typeof import('vitest'), 'describe' | 'expect' | 'it'>
  createFixture(): TeammateRuntimeConformanceFixture | Promise<TeammateRuntimeConformanceFixture>
}

/**
 * Install the provider-level suite shared by fake, Codex-backed, and Claude-backed
 * durable implementations. Registry, Agent Team, and product integrations add
 * their own ownership and projection checks around this native contract.
 * @param options - Provider name and native-state fixture hooks.
 * @returns nothing; the function registers tests with the active Vitest suite.
 */
export function defineTeammateRuntimeProviderConformance(
  options: TeammateRuntimeConformanceOptions,
): void {
  options.testApi.describe(`${options.name} durable teammate-runtime conformance`, () => {
    options.testApi.it('deduplicates and isolates identities, resumes after detach, and releases exact handles', async () => {
      const fixture = await options.createFixture()
      const { provider, createRequest } = fixture
      const evidence = provider.evidence?.bind(provider)
      const createEvaluationHandle = provider.createEvaluationHandle?.bind(provider)
      options.testApi.expect(provider.runtimeCapabilities)
        .toEqual(options.testApi.expect.arrayContaining(['evidence', 'evaluation']))
      if (evidence === undefined || createEvaluationHandle === undefined) {
        throw new Error('conformance requires advertised evidence and evaluation operations')
      }

      const aborted = new AbortController()
      aborted.abort(new Error('caller cancelled before provider acceptance'))
      await options.testApi.expect(provider.create({
        ...createRequest,
        launchRequestId: TeammateLaunchRequestId(randomUUID()),
        signal: aborted.signal,
      })).rejects.toThrow()

      const createCancellation = new AbortController()
      const createStarted = fixture.armCreateCancellation()
      const cancelledCreate = provider.create({
        ...createRequest,
        launchRequestId: TeammateLaunchRequestId(randomUUID()),
        memberId: SessionId(randomUUID()),
        signal: createCancellation.signal,
      })
      await createStarted
      createCancellation.abort(new Error('caller cancelled in-flight provider creation'))
      await options.testApi.expect(cancelledCreate).rejects.toThrow()

      const first = await provider.create(createRequest)
      const replay = await provider.create(createRequest)
      options.testApi.expect(replay.nativeHandle).toBe(first.nativeHandle)
      await fixture.assertSingleRuntime(first.nativeHandle)
      const distinctCreateRequest = {
        ...createRequest,
        launchRequestId: TeammateLaunchRequestId(randomUUID()),
        memberId: SessionId(randomUUID()),
      }
      const distinct = await provider.create(distinctCreateRequest)
      options.testApi.expect(distinct.nativeHandle).not.toBe(first.nativeHandle)

      const delivery = {
        nativeHandle: first.nativeHandle,
        deliveryId: TeamMessageId('conformance-delivery-1'),
        senderId: createRequest.memberId,
        senderName: 'lead',
        content: [{ type: 'text' as const, text: 'Conformance turn.' }],
        delivery: 'wakeup' as const,
        signal: createRequest.signal,
      }
      const deliveryCancellation = new AbortController()
      const deliveryStarted = fixture.armDeliveryCancellation()
      const cancelledDelivery = provider.deliver({
        ...delivery,
        deliveryId: TeamMessageId('conformance-delivery-in-flight-cancelled'),
        signal: deliveryCancellation.signal,
      })
      await deliveryStarted
      deliveryCancellation.abort(new Error('caller cancelled in-flight provider delivery'))
      await options.testApi.expect(cancelledDelivery).rejects.toThrow()
      const firstTurn = await provider.deliver(delivery)
      const replayedTurn = await provider.deliver(delivery)
      options.testApi.expect(replayedTurn.turnId).toBe(firstTurn.turnId)
      await fixture.assertTurn(first.nativeHandle, delivery.deliveryId, firstTurn.turnId)
      const distinctTurn = await provider.deliver({
        ...delivery,
        deliveryId: TeamMessageId('conformance-delivery-2'),
      })
      options.testApi.expect(distinctTurn.turnId).not.toBe(firstTurn.turnId)
      options.testApi.expect(provider.interrupt({ nativeHandle: first.nativeHandle }).previousStatus)
        .toMatch(/^(running|idle|inactive)$/u)
      await fixture.assertInterrupted(first.nativeHandle)
      await options.testApi.expect(evidence({
        nativeHandle: first.nativeHandle,
        limit: 100,
        signal: createRequest.signal,
      })).resolves.toMatchObject({ nativeHandle: first.nativeHandle })

      const evaluationRequest = {
        evaluationId: TeammateEvaluationId('conformance-evaluation-1'),
        profile: createRequest.profile,
        requirements: {
          ...createRequest.requirements,
          runtimeCapabilities: ['evaluation', 'evidence'] as const,
        },
        input: [{ type: 'text' as const, text: 'Conformance evaluation.' }],
        signal: createRequest.signal,
      }
      const evaluation = await createEvaluationHandle(evaluationRequest)
      const replayedEvaluation = await createEvaluationHandle(evaluationRequest)
      options.testApi.expect(replayedEvaluation.evaluationHandle).toBe(evaluation.evaluationHandle)
      const distinctEvaluation = await createEvaluationHandle({
        ...evaluationRequest,
        evaluationId: TeammateEvaluationId('conformance-evaluation-2'),
      })
      options.testApi.expect(distinctEvaluation.evaluationHandle).not.toBe(evaluation.evaluationHandle)

      await provider.dispose({ kind: 'runtime', nativeHandle: first.nativeHandle, signal: createRequest.signal })
      await provider.dispose({ kind: 'runtime', nativeHandle: distinct.nativeHandle, signal: createRequest.signal })
      await provider.dispose({
        kind: 'evaluation',
        evaluationHandle: evaluation.evaluationHandle,
        signal: createRequest.signal,
      })
      await provider.dispose({
        kind: 'evaluation',
        evaluationHandle: distinctEvaluation.evaluationHandle,
        signal: createRequest.signal,
      })
      await fixture.assertDetached()

      const reopened = await fixture.reopen()
      await options.testApi.expect(reopened.resume({
        launchRequestId: createRequest.launchRequestId,
        memberId: createRequest.memberId,
        nativeHandle: first.nativeHandle,
        requirements: createRequest.requirements,
        signal: createRequest.signal,
      })).resolves.toMatchObject({ nativeHandle: first.nativeHandle })
      const resumedDelivery = {
        ...delivery,
        deliveryId: TeamMessageId('conformance-delivery-after-restart'),
        content: [{ type: 'text' as const, text: 'Conformance turn after restart.' }],
      }
      const resumedTurn = await reopened.deliver(resumedDelivery)
      const replayedResumedTurn = await reopened.deliver(resumedDelivery)
      options.testApi.expect(replayedResumedTurn.turnId).toBe(resumedTurn.turnId)
      options.testApi.expect(resumedTurn.turnId).not.toBe(firstTurn.turnId)
      await fixture.assertTurn(first.nativeHandle, resumedDelivery.deliveryId, resumedTurn.turnId)
      await options.testApi.expect(reopened.resume({
        launchRequestId: TeammateLaunchRequestId(randomUUID()),
        memberId: SessionId(randomUUID()),
        requirements: createRequest.requirements,
        signal: createRequest.signal,
      })).resolves.toBeUndefined()
      await reopened.dispose({ kind: 'runtime', nativeHandle: first.nativeHandle, signal: createRequest.signal })
      await fixture.assertDetached()
    })
  })
}
