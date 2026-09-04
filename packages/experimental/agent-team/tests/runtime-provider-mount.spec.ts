import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context, Service } from '@deepseek-ai/cordis'
import {
  mountTeammateRuntimeProvider,
  type RuntimeCatalogRegistration,
  type TeammateRuntimeProvider,
} from '../src/index.ts'

const contexts: Context[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(async (ctx) => { await ctx.fiber.dispose() }))
})

function provider(): TeammateRuntimeProvider {
  return {
    id: 'fixture-runtime',
    displayName: 'Fixture Runtime',
    contextModes: ['fresh'],
    profileCapabilities: [],
    runtimeCapabilities: [],
  } as unknown as TeammateRuntimeProvider
}

function agentTeamsFixture(registration: (provider: TeammateRuntimeProvider) => RuntimeCatalogRegistration) {
  return class AgentTeamsFixture extends Service {
    readonly registerTeammateRuntimeProvider = registration

    constructor(ctx: Context) {
      super(ctx, 'agentTeams')
    }
  }
}

function runtimeCatalogFixture(registration: unknown) {
  return class RuntimeCatalogFixture extends Service {
    readonly registerExternalRuntimeProvider = registration

    constructor(ctx: Context) {
      super(ctx, 'runtimeCatalog')
    }
  }
}

function runtimePlugin(
  runtime: TeammateRuntimeProvider,
  disposeProvider: RuntimeCatalogRegistration,
  catalogOwnerService?: string,
) {
  return {
    inject: ['agentTeams'],
    apply(ctx: Context): void {
      mountTeammateRuntimeProvider(ctx, runtime, disposeProvider, catalogOwnerService)
    },
  }
}

describe('teammate runtime provider mounting', () => {
  it('owns direct registration and provider cleanup in deterministic order exactly once', async () => {
    const events: string[] = []
    const registrationDisposal = vi.fn(async () => { events.push('registration') })
    const directRegistration = vi.fn(() => registrationDisposal)
    const disposeProvider = vi.fn(async () => { events.push('provider') })
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(agentTeamsFixture(directRegistration))
    const runtime = provider()

    const fiber = await ctx.plugin(runtimePlugin(runtime, disposeProvider))

    expect(directRegistration).toHaveBeenCalledWith(runtime)
    await fiber.dispose()
    await fiber.dispose()
    expect(registrationDisposal).toHaveBeenCalledTimes(1)
    expect(disposeProvider).toHaveBeenCalledTimes(1)
    expect(events).toEqual(['registration', 'provider'])
  })

  it('tracks owner absence, appearance, disappearance, replacement, and adapter unload without fallback', async () => {
    const events: string[] = []
    const directRegistration = vi.fn()
    const firstDisposal = vi.fn(async () => { events.push('first-registration') })
    const secondDisposal = vi.fn(async () => { events.push('second-registration') })
    const catalogRegistration = vi.fn()
      .mockReturnValueOnce(firstDisposal)
      .mockReturnValueOnce(secondDisposal)
    const disposeProvider = vi.fn(async () => { events.push('provider') })
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(agentTeamsFixture(directRegistration))
    const runtime = provider()
    const fiber = await ctx.plugin(runtimePlugin(runtime, disposeProvider, 'runtimeCatalog'))

    expect(catalogRegistration).not.toHaveBeenCalled()
    expect(directRegistration).not.toHaveBeenCalled()
    const RuntimeCatalogFixture = runtimeCatalogFixture(catalogRegistration)
    const firstOwner = await ctx.plugin(RuntimeCatalogFixture)
    await vi.waitFor(() => { expect(catalogRegistration).toHaveBeenCalledWith(runtime) })
    await firstOwner.dispose()
    expect(firstDisposal).toHaveBeenCalledTimes(1)

    const secondOwner = await ctx.plugin(RuntimeCatalogFixture)
    await vi.waitFor(() => { expect(catalogRegistration).toHaveBeenCalledTimes(2) })
    await fiber.dispose()
    await fiber.dispose()
    expect(firstDisposal).toHaveBeenCalledTimes(1)
    expect(secondDisposal).toHaveBeenCalledTimes(1)
    expect(disposeProvider).toHaveBeenCalledTimes(1)
    expect(events).toEqual(['first-registration', 'second-registration', 'provider'])
    await secondOwner.dispose()
    expect(secondDisposal).toHaveBeenCalledTimes(1)
    expect(directRegistration).not.toHaveBeenCalled()
  })

  it('normalizes synchronous registration cleanup failures and still disposes the provider once', async () => {
    const registrationError = new Error('direct registration disposal failed')
    const registrationDisposal = vi.fn(() => { throw registrationError })
    const directRegistration = vi.fn(() => registrationDisposal)
    const disposeProvider = vi.fn(async () => {})
    const ctx = new Context()
    contexts.push(ctx)
    const logged = vi.spyOn(ctx.logger, 'error').mockImplementation(() => undefined)
    await ctx.plugin(agentTeamsFixture(directRegistration))
    const fiber = await ctx.plugin(runtimePlugin(provider(), disposeProvider))

    await fiber.dispose()
    await fiber.dispose()

    expect(logged.mock.calls.some(call => call[0] === registrationError)).toBe(true)
    expect(registrationDisposal).toHaveBeenCalledTimes(1)
    expect(disposeProvider).toHaveBeenCalledTimes(1)
  })

  it('reports malformed owner contracts without creating a direct registration', async () => {
    for (const invalid of [
      { registration: undefined, diagnostic: 'must expose registerExternalRuntimeProvider(provider)' },
      { registration: vi.fn(() => undefined), diagnostic: 'must return a disposer' },
    ]) {
      const directRegistration = vi.fn()
      const ctx = new Context()
      contexts.push(ctx)
      const logged = vi.spyOn(ctx.logger, 'error').mockImplementation(() => undefined)
      await ctx.plugin(agentTeamsFixture(directRegistration))
      const fiber = await ctx.plugin(runtimePlugin(provider(), vi.fn(), 'runtimeCatalog'))

      await ctx.plugin(runtimeCatalogFixture(invalid.registration))

      await vi.waitFor(() => {
        expect(logged).toHaveBeenCalled()
        const error: unknown = logged.mock.calls.at(-1)?.[0]
        expect(error).toBeInstanceOf(TypeError)
        expect((error as Error).message).toContain(invalid.diagnostic)
      })
      expect(directRegistration).not.toHaveBeenCalled()
      await fiber.dispose()
    }
  })

  it('retains owner cleanup failures and aggregates them with provider cleanup failures', async () => {
    const registrationError = new Error('owned registration disposal failed')
    const providerError = new Error('provider cleanup failed')
    const directRegistration = vi.fn()
    const catalogRegistration = vi.fn(() => async () => { throw registrationError })
    const disposeProvider = vi.fn(async () => { throw providerError })
    const ctx = new Context()
    contexts.push(ctx)
    const logged = vi.spyOn(ctx.logger, 'error').mockImplementation(() => undefined)
    await ctx.plugin(agentTeamsFixture(directRegistration))
    await ctx.plugin(runtimeCatalogFixture(catalogRegistration))
    const fiber = await ctx.plugin(runtimePlugin(
      provider(),
      disposeProvider,
      'runtimeCatalog',
    ))

    await fiber.dispose()

    const failure = logged.mock.calls
      .map(call => call[0] as unknown)
      .find((error): error is AggregateError => error instanceof AggregateError
        && error.errors[0] instanceof AggregateError
        && error.errors[0].errors[0] === registrationError
        && error.errors[1] === providerError)
    expect(failure).toBeInstanceOf(AggregateError)
    expect(disposeProvider).toHaveBeenCalledTimes(1)
    expect(directRegistration).not.toHaveBeenCalled()
  })
})
