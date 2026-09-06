import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { runLoaderSmoke } from '@deepseek-ai/dsh-loader-smoke'

it('executes, persists and revokes native operations in the shipped profile Loader', { retry: 0 }, async () => {
  const fixture = fileURLToPath(new URL('./fixtures/native-loader/', import.meta.url))
  const { stdout, stderr } = await runLoaderSmoke({
    label: 'native Team member operations', tempDirPrefix: 'dsh-native-member-loader-',
    binScript: join(fixture, 'driver.ts'), libBinScript: join(fixture, 'driver.ts'),
    configPath: join(fixture, 'team.patch.yml'),
    tsconfigPath: fileURLToPath(new URL('../../../../tsconfig.json', import.meta.url)),
    processTimeoutMs: 60_000,
  })
  expect(stderr).toBe('')
  await expect(stdout).toMatchFileSnapshot('./expected/native-member-query.json')
})
