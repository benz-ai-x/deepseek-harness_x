/** Host-only lifecycle ownership for durable external teammate providers. */

import type { Context } from '@deepseek-ai/cordis'
import type { TeammateRuntimeProvider } from './service-types.ts'

/** Callable cleanup returned by a Runtime Backend catalog owner or provider adapter. */
export type RuntimeCatalogRegistration = () => void | Promise<void>

/** Structural contract implemented by a configured Runtime Backend catalog owner. */
export interface RuntimeCatalogOwnerService {
  /**
   * Publish one provider generation through the owning catalog and Agent Teams registry.
   * @param provider - complete Host-only provider generation to publish atomically.
   * @returns the callable synchronous or asynchronous disposer for that exact generation.
   */
  registerExternalRuntimeProvider(provider: TeammateRuntimeProvider): RuntimeCatalogRegistration
}

function registerWithCatalogOwner(
  owner: unknown,
  serviceName: string,
  provider: TeammateRuntimeProvider,
): RuntimeCatalogRegistration {
  const register: unknown = Reflect.get(Object(owner), 'registerExternalRuntimeProvider')
  if (typeof register !== 'function') {
    throw new TypeError(
      `teammate runtime "${provider.id}": catalog owner service "${serviceName}" must expose registerExternalRuntimeProvider(provider)`,
    )
  }
  const dispose: unknown = Reflect.apply(register, owner, [provider])
  if (typeof dispose !== 'function') {
    throw new TypeError(
      `teammate runtime "${provider.id}": catalog owner service "${serviceName}" registerExternalRuntimeProvider(provider) must return a disposer`,
    )
  }
  return dispose as RuntimeCatalogRegistration
}

function injectCatalogOwnerRegistration(
  ctx: Context,
  serviceName: string,
  provider: TeammateRuntimeProvider,
): () => Promise<void> {
  const disposalFailures: unknown[] = []
  const ownerFiber = ctx.inject([serviceName], (ownerCtx) => {
    const dispose = registerWithCatalogOwner(ownerCtx.get(serviceName), serviceName, provider)
    return async () => {
      try {
        await dispose()
      } catch (error: unknown) {
        disposalFailures.push(error)
        throw error
      }
    }
  })
  return async () => {
    await ownerFiber.dispose()
    if (disposalFailures.length > 0) {
      throw new AggregateError(
        [...disposalFailures],
        `teammate runtime "${provider.id}": catalog owner service "${serviceName}" registration cleanup failed`,
      )
    }
  }
}

async function disposeProviderGeneration(
  disposeRegistration: () => Promise<void>,
  disposeProvider: RuntimeCatalogRegistration,
  providerId: string,
): Promise<void> {
  try {
    await disposeRegistration()
  } catch (registrationError: unknown) {
    try {
      await disposeProvider()
    } catch (providerError: unknown) {
      throw new AggregateError(
        [registrationError, providerError],
        `teammate runtime "${providerId}" registration and provider cleanup failed`,
      )
    }
    throw registrationError
  }
  await disposeProvider()
}

/**
 * Mount one provider generation with direct or catalog-owned registration and ordered cleanup.
 * @param ctx - exact adapter Context whose Fiber owns the provider generation.
 * @param provider - complete Host-only provider generation.
 * @param disposeProvider - adapter cleanup invoked after registration removal.
 * @param catalogOwnerService - optional dynamic service that atomically owns catalog publication and routing.
 */
export function mountTeammateRuntimeProvider(
  ctx: Context,
  provider: TeammateRuntimeProvider,
  disposeProvider: RuntimeCatalogRegistration,
  catalogOwnerService?: string,
): void {
  const disposeRegistration = catalogOwnerService === undefined
    ? ctx.agentTeams.registerTeammateRuntimeProvider(provider)
    : injectCatalogOwnerRegistration(ctx, catalogOwnerService, provider)
  ctx.effect(
    () => async () => {
      await disposeProviderGeneration(disposeRegistration, disposeProvider, provider.id)
    },
    `agentTeams.mountTeammateRuntimeProvider(${provider.id})`,
  )
}
