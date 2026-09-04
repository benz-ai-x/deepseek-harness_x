import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { runLoaderSmoke } from '@deepseek-ai/dsh-loader-smoke'

const PROCESS_TIMEOUT_MS = 60_000
const TEST_TIMEOUT_MS = PROCESS_TIMEOUT_MS + 15_000
const fixtureDir = fileURLToPath(new URL('./fixtures/loader/', import.meta.url))
const driver = join(fixtureDir, 'driver.ts')
const configPath = join(fixtureDir, 'agent-team-claude-code.patch.yml')
const repoTsconfig = fileURLToPath(new URL('../../../../tsconfig.json', import.meta.url))

describe('durable Claude Code provider Loader composition', () => {
  it('registers exact capabilities and removes them with the production Loader tree', async () => {
    const { stdout, stderr } = await runLoaderSmoke({
      label: 'agent-team-claude-code Loader composition',
      tempDirPrefix: 'dsh-agent-team-claude-code-loader-',
      binScript: driver,
      libBinScript: driver,
      configPath,
      tsconfigPath: repoTsconfig,
      processTimeoutMs: PROCESS_TIMEOUT_MS,
      env: { PATH: '' },
    })

    expect(stderr).toBe('')
    expect(JSON.parse(stdout)).toEqual({
      ownerRegistrations: 1,
      active: [{
        id: 'claude-code-loader',
        displayName: 'Claude Code',
        contextModes: ['fresh'],
        profileCapabilities: ['persona', 'mission', 'context', 'memory'],
        runtimeCapabilities: ['sandbox', 'evidence', 'usage'],
      }],
      ownerDisposals: 1,
      afterDispose: [],
    })
  }, TEST_TIMEOUT_MS)
})
