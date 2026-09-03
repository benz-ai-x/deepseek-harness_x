/** Durable external teammate provider registry and exact-handle operation router. */

import type { Context } from '@deepseek-ai/cordis'
import { Buffer } from 'node:buffer'
import type {
  TeammateEvaluationCreateRequest,
  TeammateEvaluationCreateResult,
  TeammateRuntimeCreateRequest,
  TeammateRuntimeCreateResult,
  TeammateRuntimeDeliverRequest,
  TeammateRuntimeDeliverResult,
  TeammateRuntimeDisposeRequest,
  TeammateRuntimeEvidenceItem,
  TeammateRuntimeEvidenceRequest,
  TeammateRuntimeEvidenceResult,
  TeammateRuntimeInterruptRequest,
  TeammateRuntimeInterruptResult,
  TeammateRuntimePresenceEvent,
  TeammateRuntimeProvider,
  TeammateRuntimeRegistry,
  TeammateRuntimeRegistration,
  TeammateRuntimeResumeRequest,
} from './service-types.ts'
import {
  TeammateLaunchRequestId as toTeammateLaunchRequestId,
  TeammateRuntimeHandle as toTeammateRuntimeHandle,
  TeammateRuntimeTurnId as toTeammateRuntimeTurnId,
} from './brand.ts'
import type {
  TeammateEvaluationHandle,
  TeammateProfileCapability,
  TeammateRuntimeCapability,
  TeammateRuntimeHandle,
  TeammateRuntimeMetadata,
  TeammateRuntimeProfileHook,
  TeammateRuntimeProfileSnapshot,
  TeammateRuntimeProfileTextBlock,
  TeammateRuntimeRequirements,
  TeammateRuntimeTurnId,
} from './types.ts'
import type { TeamRuntimeLifecycle } from './lifecycle.ts'

function normalizedEvidenceUsage(
  usage: TeammateRuntimeEvidenceItem['usage'],
): TeammateRuntimeEvidenceItem['usage'] {
  if (usage === undefined) return undefined
  const required = [usage.inputTokens, usage.outputTokens]
  const optional = [
    usage.totalTokens,
    usage.cacheReadTokens,
    usage.cacheWriteTokens,
    usage.reasoningTokens,
  ].filter((value): value is number => value !== undefined)
  if ([...required, ...optional].some(value => !Number.isSafeInteger(value) || value < 0)) {
    throw new TypeError('teammate runtime evidence usage requires non-negative safe-integer counters')
  }
  return Object.freeze({
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    ...(usage.totalTokens === undefined ? {} : { totalTokens: usage.totalTokens }),
    ...(usage.cacheReadTokens === undefined ? {} : { cacheReadTokens: usage.cacheReadTokens }),
    ...(usage.cacheWriteTokens === undefined ? {} : { cacheWriteTokens: usage.cacheWriteTokens }),
    ...(usage.reasoningTokens === undefined ? {} : { reasoningTokens: usage.reasoningTokens }),
  })
}

const IDENTIFIER = /^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/u
const PROFILE_CAPABILITIES = Object.freeze([
  'persona',
  'mission',
  'context',
  'memory',
  'tool-policy',
  'hooks',
] as const satisfies readonly TeammateProfileCapability[])
const RUNTIME_CAPABILITIES = Object.freeze([
  'exact-call-approval',
  'sandbox',
  'evaluation',
  'evidence',
  'usage',
] as const satisfies readonly TeammateRuntimeCapability[])

/** Stable failures owned by the typed teammate-runtime boundary. */
export class TeammateRuntimeError extends Error {
  constructor(
    message: string,
    readonly code:
      | 'TEAM_RUNTIME_UNAVAILABLE'
      | 'TEAM_RUNTIME_CAPABILITY_MISMATCH'
      | 'TEAM_RUNTIME_IDENTITY_CONFLICT'
      | 'TEAM_RUNTIME_INVALID_PROVIDER',
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = 'TeammateRuntimeError'
  }
}

interface ProviderRecord {
  provider: TeammateRuntimeProvider | undefined
  readonly metadata: TeammateRuntimeMetadata
  readonly lifecycle: AbortController
  readonly inFlight: Set<Promise<unknown>>
  readonly runtimes: Set<TeammateRuntimeHandle>
  readonly evaluations: Set<TeammateEvaluationHandle>
  readonly availabilityChanged: () => void
  stopPresenceObserver: (() => void) | undefined
  cleanupTail: Promise<void>
  retirement: Promise<void> | undefined
  accepting: boolean
  retired: boolean
}

interface PresenceRecord {
  readonly owner: ProviderRecord
  readonly presence: 'running' | 'idle'
}

function uniqueCanonical<T extends string>(
  providerId: string,
  field: string,
  values: readonly T[],
  order: readonly T[],
): readonly T[] {
  if (new Set(values).size !== values.length) {
    throw new TeammateRuntimeError(
      `teammate runtime provider "${providerId}" has invalid ${field}`,
      'TEAM_RUNTIME_INVALID_PROVIDER',
    )
  }
  return Object.freeze([...values].sort((left, right) => order.indexOf(left) - order.indexOf(right)))
}

function normalizeProvider(provider: TeammateRuntimeProvider): TeammateRuntimeMetadata {
  const providerId = provider.id
  if (providerId.length > 200 || !IDENTIFIER.test(providerId)) {
    throw new TeammateRuntimeError(
      'teammate runtime provider id must be a non-empty stable identifier',
      'TEAM_RUNTIME_INVALID_PROVIDER',
    )
  }
  const displayName = provider.displayName.trim()
  if (displayName.length === 0 || displayName.length > 120) {
    throw new TeammateRuntimeError(
      `teammate runtime provider "${providerId}" needs a display name of at most 120 characters`,
      'TEAM_RUNTIME_INVALID_PROVIDER',
    )
  }
  const contextModes = uniqueCanonical(
    providerId,
    'context modes',
    provider.contextModes,
    ['fresh', 'fork'],
  )
  if (contextModes.length === 0) {
    throw new TeammateRuntimeError(
      `teammate runtime provider "${providerId}" has invalid context modes`,
      'TEAM_RUNTIME_INVALID_PROVIDER',
    )
  }
  const profileCapabilities = uniqueCanonical(
    providerId,
    'Profile capabilities',
    provider.profileCapabilities,
    PROFILE_CAPABILITIES,
  )
  const runtimeCapabilities = uniqueCanonical(
    providerId,
    'runtime capabilities',
    provider.runtimeCapabilities,
    RUNTIME_CAPABILITIES,
  )
  if (runtimeCapabilities.includes('evidence') && provider.evidence === undefined) {
    throw new TeammateRuntimeError(
      `teammate runtime provider "${providerId}" advertises evidence without implementing it`,
      'TEAM_RUNTIME_INVALID_PROVIDER',
    )
  }
  if (runtimeCapabilities.includes('evaluation') && provider.createEvaluationHandle === undefined) {
    throw new TeammateRuntimeError(
      `teammate runtime provider "${providerId}" advertises evaluation without implementing it`,
      'TEAM_RUNTIME_INVALID_PROVIDER',
    )
  }
  return Object.freeze({
    id: providerId,
    displayName,
    contextModes,
    profileCapabilities,
    runtimeCapabilities,
  })
}

function normalizeRequirements(
  providerId: string,
  required: TeammateRuntimeRequirements,
): TeammateRuntimeRequirements {
  if (new Set(required.profileCapabilities).size !== required.profileCapabilities.length
    || new Set(required.runtimeCapabilities).size !== required.runtimeCapabilities.length) {
    throw new TeammateRuntimeError(
      `teammate runtime provider "${providerId}" received duplicate runtime requirements`,
      'TEAM_RUNTIME_CAPABILITY_MISMATCH',
    )
  }
  return Object.freeze({
    contextMode: required.contextMode,
    profileCapabilities: Object.freeze([...required.profileCapabilities].sort((left, right) =>
      PROFILE_CAPABILITIES.indexOf(left) - PROFILE_CAPABILITIES.indexOf(right))),
    runtimeCapabilities: Object.freeze([...required.runtimeCapabilities].sort((left, right) =>
      RUNTIME_CAPABILITIES.indexOf(left) - RUNTIME_CAPABILITIES.indexOf(right))),
  })
}

function profileText(value: string, name: string): string {
  const normalized = value.trim()
  if (normalized.length === 0) {
    throw new TeammateRuntimeError(
      `teammate runtime Profile ${name} must be non-empty text`,
      'TEAM_RUNTIME_CAPABILITY_MISMATCH',
    )
  }
  return normalized
}

function normalizeProfileBlocks(
  value: readonly TeammateRuntimeProfileTextBlock[],
  name: 'context' | 'memory',
): readonly TeammateRuntimeProfileTextBlock[] {
  const ids = new Set<string>()
  return Object.freeze(value.map((block) => {
    const id = profileText(block.id, `${name} id`)
    if (!IDENTIFIER.test(id) || ids.has(id)) {
      throw new TeammateRuntimeError(
        `teammate runtime Profile ${name} ids must be unique stable identifiers`,
        'TEAM_RUNTIME_CAPABILITY_MISMATCH',
      )
    }
    ids.add(id)
    return Object.freeze({
      id,
      title: profileText(block.title, `${name} title`),
      content: profileText(block.content, `${name} content`),
    })
  }))
}

function normalizeToolPolicy(
  policy: TeammateRuntimeProfileSnapshot['toolPolicy'],
): TeammateRuntimeProfileSnapshot['toolPolicy'] {
  const names = policy.names.map(name => profileText(name, 'tool name'))
  if (new Set(names).size !== names.length || (policy.mode === 'inherit' && names.length !== 0)) {
    throw new TeammateRuntimeError(
      'teammate runtime Profile tool policy is invalid',
      'TEAM_RUNTIME_CAPABILITY_MISMATCH',
    )
  }
  return Object.freeze({ mode: policy.mode, names: Object.freeze(names) })
}

function normalizeProfileHooks(value: readonly TeammateRuntimeProfileHook[]): readonly TeammateRuntimeProfileHook[] {
  return Object.freeze(value.map((hook) => {
    const point = hook.point
    const effect = hook.effect
    const matcher = hook.matcher === undefined ? undefined : profileText(hook.matcher, 'hook matcher')
    if (((point === 'session-start' || point === 'before-step') && (effect !== 'context' || matcher !== undefined))
      || (point === 'before-tool' && (effect !== 'deny' || matcher === undefined))
      || (point === 'after-tool' && (effect !== 'context' || matcher === undefined))) {
      throw new TeammateRuntimeError(
        'teammate runtime Profile hook is invalid',
        'TEAM_RUNTIME_CAPABILITY_MISMATCH',
      )
    }
    return Object.freeze({
      point,
      effect,
      ...(matcher === undefined ? {} : { matcher }),
      text: profileText(hook.text, 'hook text'),
    })
  }))
}

function normalizeProfile(
  profile: TeammateRuntimeProfileSnapshot,
  requirements: TeammateRuntimeRequirements,
  maxBytes: number,
): TeammateRuntimeProfileSnapshot {
  const normalized = Object.freeze({
    persona: profileText(profile.persona, 'persona'),
    mission: profileText(profile.mission, 'mission'),
    context: normalizeProfileBlocks(profile.context, 'context'),
    memory: normalizeProfileBlocks(profile.memory, 'memory'),
    toolPolicy: normalizeToolPolicy(profile.toolPolicy),
    hooks: normalizeProfileHooks(profile.hooks),
  })
  const expected: TeammateProfileCapability[] = [
    'persona',
    'mission',
    ...(normalized.context.length === 0 ? [] : ['context'] as const),
    ...(normalized.memory.length === 0 ? [] : ['memory'] as const),
    ...(normalized.toolPolicy.mode === 'inherit' ? [] : ['tool-policy'] as const),
    ...(normalized.hooks.length === 0 ? [] : ['hooks'] as const),
  ]
  if (expected.length !== requirements.profileCapabilities.length
    || expected.some((capability, index) => requirements.profileCapabilities[index] !== capability)) {
    throw new TeammateRuntimeError(
      'teammate runtime Profile policy does not match its requested capabilities',
      'TEAM_RUNTIME_CAPABILITY_MISMATCH',
    )
  }
  const bytes = Buffer.byteLength(JSON.stringify(normalized), 'utf8')
  if (bytes > maxBytes) {
    throw new TeammateRuntimeError(
      `teammate runtime Profile is ${bytes} UTF-8 bytes; maximum is ${maxBytes}`,
      'TEAM_RUNTIME_CAPABILITY_MISMATCH',
    )
  }
  return normalized
}

function stableKey(parts: readonly string[]): string {
  return JSON.stringify(parts)
}

/**
 * Fiber-scoped durable external provider registry. It retains only stable
 * correlations; provider objects, process handles, and native state never
 * leave this Host-only boundary.
 */
export class TeammateRuntimeRegistryHost implements TeammateRuntimeRegistry {
  private readonly providers = new Map<string, ProviderRecord>()
  private readonly records = new Set<ProviderRecord>()
  private readonly creationHandles = new Map<string, TeammateRuntimeHandle>()
  private readonly creationTurns = new Map<string, TeammateRuntimeTurnId>()
  private readonly runtimeIdentities = new Map<string, string>()
  private readonly deliveryTurns = new Map<string, TeammateRuntimeTurnId>()
  private readonly turnIdentities = new Map<string, string>()
  private readonly evaluationHandles = new Map<string, TeammateEvaluationHandle>()
  private readonly evaluationIdentities = new Map<string, string>()
  private readonly presence = new Map<string, PresenceRecord>()
  private closed = false

  constructor(
    private readonly onTopologyChanged: (providerId: string) => void,
    private readonly onPresenceChanged: (providerId: string) => void,
    private readonly onAsyncCleanupFailure: (error: unknown) => void,
    private readonly lifecycle: TeamRuntimeLifecycle,
    private readonly maxProfileBytes: number,
    private readonly maxEvidenceItems: number,
    private readonly maxEvidenceBytes: number,
  ) {}

  /**
   * Register one complete provider contract on the calling Fiber.
   * @param owner - calling Context whose Fiber owns the registration.
   * @param provider - provider operations and detached capability metadata.
   * @returns an async disposer with atomic same-id replacement.
   */
  register(owner: Context, provider: TeammateRuntimeProvider): TeammateRuntimeRegistration {
    if (this.closed) {
      throw new TeammateRuntimeError('teammate runtime registry is disposing', 'TEAM_RUNTIME_UNAVAILABLE')
    }
    const metadata = normalizeProvider(provider)
    if (this.hasProviderGeneration(metadata.id)) {
      throw new TeammateRuntimeError(
        `teammate runtime provider "${metadata.id}" is already registered`,
        'TEAM_RUNTIME_INVALID_PROVIDER',
      )
    }
    const availabilityListeners = new Set<() => void>()
    const notifyAvailability = (): void => {
      for (const listener of [...availabilityListeners]) {
        try {
          listener()
        } catch (error: unknown) {
          this.reportAsyncFailure(error)
        }
      }
    }
    let current = this.record(provider, metadata, notifyAvailability)
    let disposed = false
    let transition = Promise.resolve()
    const replacementUnavailable = (requireAccepting: boolean): boolean => this.closed
      || disposed
      || this.providers.get(metadata.id) !== current
      || (requireAccepting && !current.accepting)
    let effect: () => Promise<void>
    try {
      effect = owner.effect(function* (this: TeammateRuntimeRegistryHost) {
        if (this.providers.has(metadata.id)) {
          throw new TeammateRuntimeError(
            `teammate runtime provider "${metadata.id}" is already registered`,
            'TEAM_RUNTIME_INVALID_PROVIDER',
          )
        }
        this.startPresenceObserver(current)
        this.providers.set(metadata.id, current)
        this.onTopologyChanged(metadata.id)
        yield async () => {
          disposed = true
          current.accepting = false
          current.availabilityChanged()
          current.lifecycle.abort(new TeammateRuntimeError(
            `teammate runtime provider "${metadata.id}" was removed`,
            'TEAM_RUNTIME_UNAVAILABLE',
          ))
          await transition
          /* v8 ignore else -- duplicate registration is rejected, so this effect remains the provider id's unique owner. */
          if (this.providers.get(metadata.id) === current) {
            this.providers.delete(metadata.id)
            this.onTopologyChanged(metadata.id)
          }
          await this.retire(current)
        }
      }.bind(this), 'agentTeams.registerTeammateRuntimeProvider()')
    } catch (error: unknown) {
      this.discardUnpublishedRecord(current)
      throw error
    }

    const registration = (async (): Promise<void> => {
      await effect()
    }) as TeammateRuntimeRegistration
    registration.available = (): boolean => !disposed && this.accepts(current)
    registration.metadata = (): TeammateRuntimeMetadata => current.metadata
    registration.onAvailabilityChanged = (listener): (() => void) => {
      availabilityListeners.add(listener)
      return () => { availabilityListeners.delete(listener) }
    }
    registration.replace = async (replacement): Promise<void> => {
      const nextMetadata = normalizeProvider(replacement)
      if (nextMetadata.id !== metadata.id) {
        throw new TeammateRuntimeError(
          'a teammate runtime replacement must preserve its stable provider id',
          'TEAM_RUNTIME_INVALID_PROVIDER',
        )
      }
      const operation = transition.then(async () => {
        if (replacementUnavailable(true)) {
          throw new TeammateRuntimeError(
            'a disposed teammate runtime registration cannot be replaced',
            'TEAM_RUNTIME_UNAVAILABLE',
          )
        }
        const prior = current
        prior.accepting = false
        prior.availabilityChanged()
        prior.lifecycle.abort(new TeammateRuntimeError(
          `teammate runtime provider "${metadata.id}" was replaced`,
          'TEAM_RUNTIME_UNAVAILABLE',
        ))
        this.onTopologyChanged(metadata.id)
        try {
          await this.retire(prior)
        } catch (error: unknown) {
          /* v8 ignore else -- this serialized registration owns the provider id until replacement commits. */
          if (this.providers.get(metadata.id) === prior) {
            this.providers.delete(metadata.id)
            this.onTopologyChanged(metadata.id)
          }
          throw error
        }
        if (replacementUnavailable(false)) {
          /* v8 ignore else -- this serialized registration owns the provider id until replacement commits. */
          if (this.providers.get(metadata.id) === prior) {
            this.providers.delete(metadata.id)
            this.onTopologyChanged(metadata.id)
          }
          throw new TeammateRuntimeError(
            'a disposed teammate runtime registration cannot publish a replacement',
            'TEAM_RUNTIME_UNAVAILABLE',
          )
        }
        const next = this.record(replacement, nextMetadata, notifyAvailability)
        try {
          this.startPresenceObserver(next)
        } catch (error: unknown) {
          this.discardUnpublishedRecord(next)
          throw error
        }
        current = next
        this.providers.set(metadata.id, next)
        this.onTopologyChanged(metadata.id)
        next.availabilityChanged()
      })
      transition = operation.then(() => undefined, () => undefined)
      await operation
    }
    return registration
  }

  /**
   * Return a deep-detached complete provider topology snapshot.
   * @returns available provider metadata in stable display order.
   */
  snapshot(): readonly TeammateRuntimeMetadata[] {
    return Object.freeze([...this.providers.values()]
      .filter(record => record.accepting)
      .map(record => record.metadata)
      .sort((left, right) => left.displayName.localeCompare(right.displayName) || left.id.localeCompare(right.id)))
  }

  /**
   * Whether one provider currently accepts new operations.
   * @param providerId - stable provider identity.
   * @returns true only while that provider generation accepts work.
   */
  available(providerId: string): boolean {
    return this.providers.get(providerId)?.accepting === true
  }

  /** Close all future provider and operation admission before ordered settlement. */
  closeAdmission(): void {
    if (this.closed) return
    this.closed = true
    const providers = [...this.providers.entries()]
    this.providers.clear()
    for (const [providerId, record] of providers) {
      record.accepting = false
      record.availabilityChanged()
      record.lifecycle.abort(new TeammateRuntimeError(
        'teammate runtime registry is disposing',
        'TEAM_RUNTIME_UNAVAILABLE',
      ))
      this.onTopologyChanged(providerId)
    }
  }

  /**
   * Reject unavailable or insufficient providers before any durable partial work.
   * @param providerId - stable provider identity.
   * @param requirements - context and capabilities the provider must enforce.
   * @returns the canonical detached requirements passed to provider operations.
   */
  validate(providerId: string, requirements: TeammateRuntimeRequirements): TeammateRuntimeRequirements {
    return this.assertRequirements(this.requireProvider(providerId).metadata, requirements)
  }

  /** Validate and detach the complete launch-time Profile policy before Team reservation. */
  validateLaunch(
    providerId: string,
    requirements: TeammateRuntimeRequirements,
    profile: TeammateRuntimeProfileSnapshot,
  ): { readonly requirements: TeammateRuntimeRequirements; readonly profile: TeammateRuntimeProfileSnapshot } {
    const normalizedRequirements = this.validate(providerId, requirements)
    return Object.freeze({
      requirements: normalizedRequirements,
      profile: normalizeProfile(profile, normalizedRequirements, this.maxProfileBytes),
    })
  }

  /**
   * Read cached process-local presence for one exact provider-native runtime.
   * @param providerId - stable provider identity.
   * @param nativeHandle - exact provider-owned runtime identity.
   * @returns running or idle for an attached runtime; otherwise inactive.
   */
  runtimePresence(providerId: string, nativeHandle: TeammateRuntimeHandle): 'running' | 'idle' | 'inactive' {
    const record = this.providers.get(providerId)
    const presence = this.presence.get(stableKey([providerId, nativeHandle]))
    return record !== undefined && record.accepting && presence?.owner === record
      ? presence.presence
      : 'inactive'
  }

  /**
   * Create or reattach one idempotent external teammate identity.
   * @param providerId - stable provider identity.
   * @param request - reserved Team identity, initial work, requirements, and cancellation.
   * @returns the stable native handle after the provider durably accepts initial work.
   */
  async create(providerId: string, request: TeammateRuntimeCreateRequest): Promise<TeammateRuntimeCreateResult> {
    const record = this.requireProvider(providerId)
    const provider = this.providerFor(record)
    const launchRequestId = toTeammateLaunchRequestId(request.launchRequestId)
    const requirements = this.assertRequirements(record.metadata, request.requirements)
    const profile = normalizeProfile(request.profile, requirements, this.maxProfileBytes)
    const result = await this.invoke(record, request.signal, signal => provider.create({
      ...request,
      launchRequestId,
      initialWork: structuredClone(request.initialWork),
      profile,
      requirements,
      signal,
    }), async (late) => { await this.releaseLateRuntime(record, late) })
    try {
      return this.acceptRuntimeResult(record, providerId, launchRequestId, request.memberId, result)
    } catch (error: unknown) {
      return await this.quarantine(record, error)
    }
  }

  /**
   * Recover one durable native identity without creating a replacement.
   * @param providerId - stable provider identity.
   * @param request - durable Team correlation and optional expected native handle.
   * @returns the reattached runtime, or undefined when the provider has not accepted it.
   */
  async resume(
    providerId: string,
    request: TeammateRuntimeResumeRequest,
  ): Promise<TeammateRuntimeCreateResult | undefined> {
    const record = this.requireProvider(providerId)
    const provider = this.providerFor(record)
    const launchRequestId = toTeammateLaunchRequestId(request.launchRequestId)
    const expectedNativeHandle = request.nativeHandle === undefined
      ? undefined
      : toTeammateRuntimeHandle(request.nativeHandle)
    const requirements = this.assertRequirements(record.metadata, request.requirements)
    const result = await this.invoke(record, request.signal, signal => provider.resume({
      ...request,
      launchRequestId,
      ...(expectedNativeHandle === undefined ? {} : { nativeHandle: expectedNativeHandle }),
      requirements,
      signal,
    }), async (late) => {
      if (late !== undefined) await this.releaseLateRuntime(record, late)
    })
    if (result === undefined) {
      if (expectedNativeHandle === undefined) return undefined
      return await this.quarantine(record, new TeammateRuntimeError(
        `provider "${providerId}" denied its persisted native runtime during resume`,
        'TEAM_RUNTIME_IDENTITY_CONFLICT',
      ))
    }
    try {
      return this.acceptRuntimeResult(
        record,
        providerId,
        launchRequestId,
        request.memberId,
        result,
        expectedNativeHandle,
      )
    } catch (error: unknown) {
      return await this.quarantine(record, error)
    }
  }

  /**
   * Deliver one Team mailbox item idempotently to an exact native handle.
   * @param providerId - stable provider identity.
   * @param request - exact handle, durable delivery identity, content, and cancellation.
   * @returns the provider-native turn correlation after durable delivery acceptance.
   */
  async deliver(
    providerId: string,
    request: TeammateRuntimeDeliverRequest,
  ): Promise<TeammateRuntimeDeliverResult> {
    const record = this.requireAttachedRuntime(providerId, request.nativeHandle)
    const provider = this.providerFor(record)
    const result = await this.invoke(record, request.signal, signal => provider.deliver({
      ...request,
      content: structuredClone(request.content),
      signal,
    }))
    try {
      this.assertObservablePresence(record, result.presence)
      const normalized: TeammateRuntimeDeliverResult = Object.freeze({
        turnId: result.turnId,
        presence: result.presence,
      })
      const key = stableKey([providerId, request.nativeHandle, request.deliveryId])
      const known = this.deliveryTurns.get(key)
      if (known !== undefined && known !== normalized.turnId) {
        throw new TeammateRuntimeError(
          `provider "${providerId}" changed the native turn for an identical delivery`,
          'TEAM_RUNTIME_IDENTITY_CONFLICT',
        )
      }
      this.claimIdentity(
        this.turnIdentities,
        stableKey([providerId, request.nativeHandle, normalized.turnId]),
        key,
        `provider "${providerId}" reused one native turn for different deliveries`,
      )
      this.deliveryTurns.set(key, normalized.turnId)
      this.attachRuntime(record, providerId, {
        nativeHandle: request.nativeHandle,
        presence: normalized.presence,
      })
      return normalized
    } catch (error: unknown) {
      return await this.quarantine(record, error)
    }
  }

  /**
   * Interrupt only an attached exact native handle.
   * @param providerId - stable provider identity.
   * @param request - exact provider-owned runtime identity.
   * @returns the runtime state sampled before interruption.
   */
  interrupt(
    providerId: string,
    request: TeammateRuntimeInterruptRequest,
  ): TeammateRuntimeInterruptResult {
    const record = this.requireAttachedRuntime(providerId, request.nativeHandle)
    const provider = this.providerFor(record)
    const result = provider.interrupt(request)
    if (!this.accepts(record)) {
      throw new TeammateRuntimeError(
        `teammate runtime provider "${providerId}" retired during interrupt`,
        'TEAM_RUNTIME_UNAVAILABLE',
        { cause: record.lifecycle.signal.reason },
      )
    }
    if (result.previousStatus === 'inactive') {
      this.forgetPresence(record, providerId, request.nativeHandle)
    } else {
      this.attachRuntime(record, providerId, {
        nativeHandle: request.nativeHandle,
        presence: 'idle',
      })
    }
    return Object.freeze({ previousStatus: result.previousStatus })
  }

  /**
   * Read one bounded detached evidence page from an exact native handle.
   * @param providerId - stable provider identity.
   * @param request - exact runtime, cursor, page limit, and cancellation.
   * @returns normalized evidence that excludes provider payloads and prompts.
   */
  async evidence(
    providerId: string,
    request: TeammateRuntimeEvidenceRequest,
  ): Promise<TeammateRuntimeEvidenceResult> {
    const record = this.requireAttachedRuntime(providerId, request.nativeHandle)
    const provider = this.providerFor(record)
    if (!record.metadata.runtimeCapabilities.includes('evidence')) {
      throw new TeammateRuntimeError(
        `teammate runtime provider "${providerId}" cannot enforce evidence collection`,
        'TEAM_RUNTIME_CAPABILITY_MISMATCH',
      )
    }
    const evidence = provider.evidence?.bind(provider)
    /* v8 ignore next -- registration requires the operation whenever the capability is advertised. */
    if (evidence === undefined) {
      throw new TeammateRuntimeError(
        `teammate runtime provider "${providerId}" cannot collect evidence`,
        'TEAM_RUNTIME_CAPABILITY_MISMATCH',
      )
    }
    if (!Number.isSafeInteger(request.limit) || request.limit < 1 || request.limit > this.maxEvidenceItems) {
      throw new TypeError(
        `teammate runtime evidence limit must be an integer from 1 through ${this.maxEvidenceItems}`,
      )
    }
    const result = await this.invoke(record, request.signal, signal => evidence({
      ...request,
      signal,
    }))
    try {
      if (result.nativeHandle !== request.nativeHandle
        || result.items.length > request.limit
        || result.items.length > this.maxEvidenceItems) {
        throw new TeammateRuntimeError(
          `provider "${providerId}" returned evidence for a different or unbounded runtime`,
          'TEAM_RUNTIME_IDENTITY_CONFLICT',
        )
      }
      const items: TeammateRuntimeEvidenceItem[] = result.items.map((item) => {
        const usage = normalizedEvidenceUsage(item.usage)
        return Object.freeze({
          id: item.id,
          kind: item.kind,
          timestamp: item.timestamp,
          ...(item.turnId === undefined ? {} : { turnId: item.turnId }),
          ...(item.name === undefined ? {} : { name: item.name }),
          ...(item.outcome === undefined ? {} : { outcome: item.outcome }),
          ...(usage === undefined ? {} : { usage }),
        })
      })
      const normalized: TeammateRuntimeEvidenceResult = Object.freeze({
        nativeHandle: result.nativeHandle,
        items: Object.freeze(items),
        ...(result.nextCursor === undefined
          ? {}
          : { nextCursor: result.nextCursor }),
        complete: result.complete,
      })
      const bytes = Buffer.byteLength(JSON.stringify(normalized), 'utf8')
      if (bytes > this.maxEvidenceBytes) {
        throw new TeammateRuntimeError(
          `provider "${providerId}" returned an evidence page of ${bytes} UTF-8 bytes; maximum is ${this.maxEvidenceBytes}`,
          'TEAM_RUNTIME_IDENTITY_CONFLICT',
        )
      }
      return normalized
    } catch (error: unknown) {
      return await this.quarantine(record, error)
    }
  }

  /**
   * Create one idempotent isolated provider-native evaluation handle.
   * @param providerId - stable provider identity.
   * @param request - evaluation identity, enforced requirements, input, and cancellation.
   * @returns the stable provider-owned evaluation identity.
   */
  async createEvaluationHandle(
    providerId: string,
    request: TeammateEvaluationCreateRequest,
  ): Promise<TeammateEvaluationCreateResult> {
    const record = this.requireProvider(providerId)
    const provider = this.providerFor(record)
    const requirements = this.assertRequirements(record.metadata, request.requirements)
    if (!requirements.runtimeCapabilities.includes('evaluation')) {
      throw new TeammateRuntimeError(
        'evaluation creation requires the evaluation capability',
        'TEAM_RUNTIME_CAPABILITY_MISMATCH',
      )
    }
    const createEvaluationHandle = provider.createEvaluationHandle?.bind(provider)
    /* v8 ignore next -- registration requires the operation whenever the capability is advertised. */
    if (createEvaluationHandle === undefined) {
      throw new TeammateRuntimeError(
        `teammate runtime provider "${providerId}" cannot create evaluations`,
        'TEAM_RUNTIME_CAPABILITY_MISMATCH',
      )
    }
    const profile = normalizeProfile(request.profile, requirements, this.maxProfileBytes)
    const result = await this.invoke(record, request.signal, signal => createEvaluationHandle({
      ...request,
      profile,
      requirements,
      input: structuredClone(request.input),
      signal,
    }), async (late) => { await this.releaseLateEvaluation(record, late) })
    try {
      record.evaluations.add(result.evaluationHandle)
      const normalized: TeammateEvaluationCreateResult = Object.freeze({
        evaluationHandle: result.evaluationHandle,
      })
      const key = stableKey([providerId, request.evaluationId])
      const known = this.evaluationHandles.get(key)
      if (known !== undefined && known !== normalized.evaluationHandle) {
        throw new TeammateRuntimeError(
          `provider "${providerId}" changed an idempotent evaluation handle`,
          'TEAM_RUNTIME_IDENTITY_CONFLICT',
        )
      }
      this.claimIdentity(
        this.evaluationIdentities,
        stableKey([providerId, normalized.evaluationHandle]),
        key,
        `provider "${providerId}" reused one evaluation handle for different evaluations`,
      )
      this.evaluationHandles.set(key, normalized.evaluationHandle)
      return normalized
    } catch (error: unknown) {
      return await this.quarantine(record, error)
    }
  }

  /**
   * Release one exact attached runtime or evaluation resource.
   * @param providerId - stable provider identity.
   * @param request - exact provider-owned resource and cancellation.
   */
  async dispose(providerId: string, request: TeammateRuntimeDisposeRequest): Promise<void> {
    const record = this.requireProvider(providerId)
    const provider = this.providerFor(record)
    if (request.kind === 'runtime') this.requireAttachedRuntime(providerId, request.nativeHandle)
    else if (!record.evaluations.has(request.evaluationHandle)) {
      throw new TeammateRuntimeError(
        `evaluation handle does not belong to provider "${providerId}"`,
        'TEAM_RUNTIME_IDENTITY_CONFLICT',
      )
    }
    const forget = (): void => { this.forgetDisposed(record, providerId, request) }
    await this.invoke(
      record,
      request.signal,
      signal => provider.dispose({ ...request, signal }),
      () => { forget() },
    )
    forget()
  }

  /** Release all currently attached handles during Team service disposal. */
  async disposeAttached(): Promise<void> {
    this.closeAdmission()
    const outcomes = await Promise.allSettled([...this.records].map(record => this.retire(record)))
    const failures = outcomes
      .filter((outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected')
      .map((outcome): unknown => outcome.reason)
    if (failures.length > 0) throw new AggregateError(failures, 'teammate runtime cleanup failed')
    if (this.records.size === 0) this.clearCorrelations()
  }

  private record(
    provider: TeammateRuntimeProvider,
    metadata: TeammateRuntimeMetadata,
    availabilityChanged: () => void,
  ): ProviderRecord {
    const record: ProviderRecord = {
      provider,
      metadata,
      lifecycle: new AbortController(),
      inFlight: new Set(),
      runtimes: new Set(),
      evaluations: new Set(),
      availabilityChanged,
      stopPresenceObserver: undefined,
      cleanupTail: Promise.resolve(),
      retirement: undefined,
      accepting: true,
      retired: false,
    }
    this.records.add(record)
    return record
  }

  private startPresenceObserver(record: ProviderRecord): void {
    const provider = this.providerFor(record)
    const observePresence = provider.onPresenceChanged?.bind(provider)
    if (observePresence !== undefined) {
      record.stopPresenceObserver = observePresence((event) => { this.receivePresence(record, event) })
    }
  }

  private discardUnpublishedRecord(record: ProviderRecord): void {
    try {
      record.stopPresenceObserver?.()
    } catch (error: unknown) {
      this.reportAsyncFailure(error)
    }
    record.stopPresenceObserver = undefined
    record.accepting = false
    record.retired = true
    record.provider = undefined
    this.records.delete(record)
  }

  private hasProviderGeneration(providerId: string): boolean {
    return [...this.records].some(record => record.metadata.id === providerId)
  }

  private claimIdentity(
    index: Map<string, string>,
    resourceKey: string,
    identityKey: string,
    conflictMessage: string,
  ): void {
    const knownIdentity = index.get(resourceKey)
    if (knownIdentity !== undefined && knownIdentity !== identityKey) {
      throw new TeammateRuntimeError(conflictMessage, 'TEAM_RUNTIME_IDENTITY_CONFLICT')
    }
    index.set(resourceKey, identityKey)
  }

  private requireProvider(providerId: string): ProviderRecord {
    const record = this.providers.get(providerId)
    if (record === undefined || !record.accepting) {
      throw new TeammateRuntimeError(
        `teammate runtime provider "${providerId}" is not available`,
        'TEAM_RUNTIME_UNAVAILABLE',
      )
    }
    return record
  }

  private providerFor(record: ProviderRecord): TeammateRuntimeProvider {
    const provider = record.provider
    if (provider === undefined) {
      throw new TeammateRuntimeError(
        `teammate runtime provider "${record.metadata.id}" was released`,
        'TEAM_RUNTIME_UNAVAILABLE',
      )
    }
    return provider
  }

  private requireAttachedRuntime(providerId: string, handle: TeammateRuntimeHandle): ProviderRecord {
    const record = this.requireProvider(providerId)
    if (!record.runtimes.has(handle)) {
      throw new TeammateRuntimeError(
        `native runtime handle does not belong to provider "${providerId}"`,
        'TEAM_RUNTIME_IDENTITY_CONFLICT',
      )
    }
    return record
  }

  private assertRequirements(
    metadata: TeammateRuntimeMetadata,
    required: TeammateRuntimeRequirements,
  ): TeammateRuntimeRequirements {
    const normalized = normalizeRequirements(metadata.id, required)
    const missingProfile = normalized.profileCapabilities.filter(capability =>
      !metadata.profileCapabilities.includes(capability))
    const missingRuntime = normalized.runtimeCapabilities.filter(capability =>
      !metadata.runtimeCapabilities.includes(capability))
    if (!normalized.profileCapabilities.includes('persona')
      || !normalized.profileCapabilities.includes('mission')
      || !metadata.contextModes.includes(normalized.contextMode)
      || missingProfile.length > 0
      || missingRuntime.length > 0) {
      throw new TeammateRuntimeError(
        `teammate runtime provider "${metadata.id}" cannot enforce the requested context or capabilities`,
        'TEAM_RUNTIME_CAPABILITY_MISMATCH',
      )
    }
    return normalized
  }

  private canonicalRuntimeResult(
    record: ProviderRecord,
    result: TeammateRuntimeCreateResult,
  ): TeammateRuntimeCreateResult {
    record.runtimes.add(result.nativeHandle)
    const nativeHandle = toTeammateRuntimeHandle(result.nativeHandle)
    const turnId = result.turnId === undefined ? undefined : toTeammateRuntimeTurnId(result.turnId)
    this.assertObservablePresence(record, result.presence)
    return Object.freeze({
      nativeHandle,
      ...(turnId === undefined ? {} : { turnId }),
      presence: result.presence,
    })
  }

  private acceptRuntimeResult(
    record: ProviderRecord,
    providerId: string,
    launchRequestId: TeammateRuntimeCreateRequest['launchRequestId'],
    memberId: TeammateRuntimeCreateRequest['memberId'],
    result: TeammateRuntimeCreateResult,
    expectedNativeHandle?: TeammateRuntimeHandle,
  ): TeammateRuntimeCreateResult {
    const normalized = this.canonicalRuntimeResult(record, result)
    if (expectedNativeHandle !== undefined && expectedNativeHandle !== normalized.nativeHandle) {
      throw new TeammateRuntimeError(
        `provider "${providerId}" resumed a different native runtime`,
        'TEAM_RUNTIME_IDENTITY_CONFLICT',
      )
    }
    const key = stableKey([providerId, launchRequestId, memberId])
    const known = this.creationHandles.get(key)
    if (known !== undefined && known !== normalized.nativeHandle) {
      throw new TeammateRuntimeError(
        `provider "${providerId}" changed the native handle for a durable teammate`,
        'TEAM_RUNTIME_IDENTITY_CONFLICT',
      )
    }
    this.claimIdentity(
      this.runtimeIdentities,
      stableKey([providerId, normalized.nativeHandle]),
      key,
      `provider "${providerId}" reused one native runtime handle for different teammate identities`,
    )
    const knownTurn = this.creationTurns.get(key)
    if (knownTurn !== undefined && normalized.turnId !== undefined && knownTurn !== normalized.turnId) {
      throw new TeammateRuntimeError(
        `provider "${providerId}" changed the native turn for an identical launch`,
        'TEAM_RUNTIME_IDENTITY_CONFLICT',
      )
    }
    if (normalized.turnId !== undefined) {
      this.claimIdentity(
        this.turnIdentities,
        stableKey([providerId, normalized.nativeHandle, normalized.turnId]),
        key,
        `provider "${providerId}" reused one native turn for different accepted work`,
      )
      this.creationTurns.set(key, normalized.turnId)
    }
    this.creationHandles.set(key, normalized.nativeHandle)
    this.attachRuntime(record, providerId, normalized)
    return normalized
  }

  private attachRuntime(
    record: ProviderRecord,
    providerId: string,
    result: TeammateRuntimeCreateResult,
  ): void {
    record.runtimes.add(result.nativeHandle)
    const key = stableKey([providerId, result.nativeHandle])
    const previous = this.presence.get(key)
    this.presence.set(key, {
      owner: record,
      presence: result.presence,
    })
    if (previous?.owner !== record || previous.presence !== result.presence) {
      this.onPresenceChanged(providerId)
    }
  }

  private assertObservablePresence(record: ProviderRecord, presence: 'running' | 'idle'): void {
    if (presence === 'running' && record.stopPresenceObserver === undefined) {
      throw new TeammateRuntimeError(
        `provider "${record.metadata.id}" returned running without a presence observer`,
        'TEAM_RUNTIME_IDENTITY_CONFLICT',
      )
    }
  }

  private receivePresence(record: ProviderRecord, event: TeammateRuntimePresenceEvent): void {
    if (!this.accepts(record)) return
    if (!record.runtimes.has(event.nativeHandle)) return
    if (event.presence === 'inactive') {
      this.forgetPresence(record, record.metadata.id, event.nativeHandle)
    } else {
      this.attachRuntime(record, record.metadata.id, {
        nativeHandle: event.nativeHandle,
        presence: event.presence,
      })
    }
  }

  private async invoke<T>(
    record: ProviderRecord,
    callerSignal: AbortSignal,
    operation: (signal: AbortSignal) => Promise<T>,
    releaseLateResult?: (result: T) => void | Promise<void>,
  ): Promise<T> {
    /* v8 ignore next -- requireProvider or requireAttachedRuntime admits the record immediately before invoke. */
    if (!record.accepting) {
      throw new TeammateRuntimeError(
        `teammate runtime provider "${record.metadata.id}" is not available`,
        'TEAM_RUNTIME_UNAVAILABLE',
      )
    }
    const signal = AbortSignal.any([callerSignal, record.lifecycle.signal])
    signal.throwIfAborted()
    const promise = (async (): Promise<T> => {
      const result = await operation(signal)
      if (this.accepts(record)) return result
      try {
        await releaseLateResult?.(result)
      } catch (error: unknown) {
        throw new TeammateRuntimeError(
          `teammate runtime provider "${record.metadata.id}" retired before its late result was released`,
          'TEAM_RUNTIME_UNAVAILABLE',
          { cause: error },
        )
      }
      throw new TeammateRuntimeError(
        `teammate runtime provider "${record.metadata.id}" retired before its operation settled`,
        'TEAM_RUNTIME_UNAVAILABLE',
      )
    })()
    record.inFlight.add(promise)
    try {
      return await promise
    } finally {
      record.inFlight.delete(promise)
      this.completeRetiredRecord(record)
    }
  }

  private retire(record: ProviderRecord): Promise<void> {
    if (record.retirement !== undefined) return record.retirement
    const operation = this.retirePass(record)
    record.retirement = operation
    void operation.then(
      () => {
        /* v8 ignore else -- only this settlement callback clears its exact retirement promise. */
        if (record.retirement === operation) record.retirement = undefined
        this.completeRetiredRecord(record)
      },
      () => {
        /* v8 ignore else -- only this settlement callback clears its exact retirement promise. */
        if (record.retirement === operation) record.retirement = undefined
      },
    )
    return operation
  }

  private async retirePass(record: ProviderRecord): Promise<void> {
    const failures: unknown[] = []
    if (!record.retired) {
      record.retired = true
      record.accepting = false
      record.lifecycle.abort(new TeammateRuntimeError(
        `teammate runtime provider "${record.metadata.id}" was removed`,
        'TEAM_RUNTIME_UNAVAILABLE',
      ))
    }
    const stopPresenceObserver = record.stopPresenceObserver
    if (stopPresenceObserver !== undefined) {
      try {
        stopPresenceObserver()
        record.stopPresenceObserver = undefined
      } catch (error: unknown) {
        failures.push(error)
      }
    }
    try {
      const outcomes = await Promise.allSettled([...record.inFlight])
      for (const outcome of outcomes) {
        if (outcome.status === 'rejected' && !record.lifecycle.signal.aborted) failures.push(outcome.reason)
      }
    } catch (error: unknown) {
      failures.push(error)
    }
    try {
      await this.detach(record)
    } catch (error: unknown) {
      failures.push(error)
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, `teammate runtime provider "${record.metadata.id}" retirement failed`)
    }
  }

  private detach(record: ProviderRecord): Promise<void> {
    const operation = record.cleanupTail.then(async () => { await this.detachPass(record) })
    record.cleanupTail = operation.then(() => undefined, () => undefined)
    return operation
  }

  private async detachPass(record: ProviderRecord): Promise<void> {
    const runtimes = [...record.runtimes]
    const evaluations = [...record.evaluations]
    if (runtimes.length === 0 && evaluations.length === 0) {
      this.completeRetiredRecord(record)
      return
    }
    const provider = this.providerFor(record)
    const outcomes = await this.lifecycle.settleWithAbortDeadline(async signal => await Promise.allSettled([
      ...runtimes.map(nativeHandle => Promise.resolve().then(async () => {
        await provider.dispose({ kind: 'runtime', nativeHandle, signal })
        this.forgetDisposed(record, record.metadata.id, { kind: 'runtime', nativeHandle, signal })
      })),
      ...evaluations.map(evaluationHandle => Promise.resolve().then(async () => {
        await provider.dispose({ kind: 'evaluation', evaluationHandle, signal })
        this.forgetDisposed(record, record.metadata.id, { kind: 'evaluation', evaluationHandle, signal })
      })),
    ]))
    const failures = outcomes
      .filter((outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected')
      .map((outcome): unknown => outcome.reason)
    if (failures.length > 0) {
      throw new AggregateError(failures, `teammate runtime provider "${record.metadata.id}" cleanup failed`)
    }
    this.completeRetiredRecord(record)
  }

  private async releaseLateRuntime(record: ProviderRecord, result: TeammateRuntimeCreateResult): Promise<void> {
    record.runtimes.add(result.nativeHandle)
    await this.detach(record)
  }

  private async releaseLateEvaluation(
    record: ProviderRecord,
    result: TeammateEvaluationCreateResult,
  ): Promise<void> {
    record.evaluations.add(result.evaluationHandle)
    await this.detach(record)
  }

  private forgetDisposed(
    record: ProviderRecord,
    providerId: string,
    request: TeammateRuntimeDisposeRequest,
  ): void {
    if (request.kind === 'runtime') {
      this.forgetRuntime(record, providerId, request.nativeHandle)
    } else {
      record.evaluations.delete(request.evaluationHandle)
    }
  }

  private forgetRuntime(
    record: ProviderRecord,
    providerId: string,
    nativeHandle: TeammateRuntimeHandle,
  ): void {
    record.runtimes.delete(nativeHandle)
    this.forgetPresence(record, providerId, nativeHandle)
  }

  private forgetPresence(
    record: ProviderRecord,
    providerId: string,
    nativeHandle: TeammateRuntimeHandle,
  ): void {
    const key = stableKey([providerId, nativeHandle])
    if (this.presence.get(key)?.owner === record) {
      this.presence.delete(key)
      if (this.providers.get(providerId) === record && record.accepting) {
        this.onPresenceChanged(providerId)
      }
    }
  }

  private async quarantine(record: ProviderRecord, violation: unknown): Promise<never> {
    this.closeViolatedGeneration(record, violation)
    try {
      await this.retire(record)
    } catch (cleanupError: unknown) {
      throw new AggregateError(
        [violation, cleanupError],
        `teammate runtime provider "${record.metadata.id}" violated its result contract and cleanup failed`,
      )
    }
    throw violation
  }

  private reportAsyncFailure(error: unknown): void {
    try {
      this.onAsyncCleanupFailure(error)
    } catch {
      // A diagnostic sink cannot reopen a failed provider generation.
    }
  }

  private closeViolatedGeneration(record: ProviderRecord, violation: unknown): void {
    record.accepting = false
    record.availabilityChanged()
    record.lifecycle.abort(violation)
    if (this.providers.get(record.metadata.id) === record) {
      this.providers.delete(record.metadata.id)
      this.onTopologyChanged(record.metadata.id)
    }
  }

  private accepts(record: ProviderRecord): boolean {
    return record.accepting && this.providers.get(record.metadata.id) === record
  }

  private completeRetiredRecord(record: ProviderRecord): void {
    if (record.retired
      && record.inFlight.size === 0
      && record.runtimes.size === 0
      && record.evaluations.size === 0
      && record.stopPresenceObserver === undefined) {
      record.provider = undefined
      this.records.delete(record)
    }
  }

  private clearCorrelations(): void {
    this.creationHandles.clear()
    this.creationTurns.clear()
    this.runtimeIdentities.clear()
    this.deliveryTurns.clear()
    this.turnIdentities.clear()
    this.evaluationHandles.clear()
    this.evaluationIdentities.clear()
    this.presence.clear()
  }
}
