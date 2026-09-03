import type { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'

const eligibility = vi.hoisted(() => vi.fn(() => ({
  eligible: false as const,
  product: 'claude-code' as const,
  reason: 'native-product-missing' as const,
})))

vi.mock('../src/product.ts', async importOriginal => ({
  ...await importOriginal<typeof import('../src/product.ts')>(),
  claudeCodeProductEligibility: eligibility,
}))

import { apply } from '../src/index.ts'

describe('Claude Code product availability gate', () => {
  it('does not register when the exact native product is unavailable', () => {
    const warn = vi.fn()
    const register = vi.fn()
    const ctx = {
      logger: { warn },
      agentTeams: { registerTeammateRuntimeProvider: register },
      effect: vi.fn(),
    } as unknown as Context

    apply(ctx, {})

    expect(warn).toHaveBeenCalledWith(
      'agent-team-claude-code: durable provider unavailable (native-product-missing)',
    )
    expect(register).not.toHaveBeenCalled()
  })

  it('rejects a weaker direct-call policy even when the native product is unavailable', () => {
    const warn = vi.fn()
    const register = vi.fn()
    const ctx = {
      logger: { warn },
      agentTeams: { registerTeammateRuntimeProvider: register },
      effect: vi.fn(),
    } as unknown as Context

    expect(() => { apply(ctx, { sandbox: 'workspace-write' as never }) }).toThrow(
      'sandbox cannot be weaker than read-only',
    )
    expect(warn).not.toHaveBeenCalled()
    expect(register).not.toHaveBeenCalled()
  })
})
