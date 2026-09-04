#!/usr/bin/env node
/** Inspect durable Claude Code provider registration through a production Loader tree. */

import type {} from '@deepseek-ai/dsh-experimental-agent-team'
import { bootProductionProfile } from '../../../../../test-support/loader-smoke/tests/fixtures/production-profile.ts'

const configPath = process.argv[2]
if (configPath === undefined) {
  throw new Error('agent-team-claude-code Loader composition driver requires a config path')
}

const ctx = await bootProductionProfile({
  binName: 'agent-team-claude-code-loader-composition',
  profile: 'headless',
  overlayPaths: [configPath],
})
const registry = (ctx.agentTeams as unknown as {
  teammateRuntimeRegistry: {
    snapshot(): readonly unknown[]
  }
}).teammateRuntimeRegistry
const stats = ctx.claudeCodeCatalogOwner.stats
const active = registry.snapshot()
await ctx.fiber.dispose()

process.stdout.write(`${JSON.stringify({
  ownerRegistrations: stats.registrations,
  active,
  ownerDisposals: stats.disposals,
  afterDispose: registry.snapshot(),
})}\n`)
