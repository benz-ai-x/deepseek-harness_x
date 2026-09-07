// Keyless assembled-browser coverage for the private Agent Teams Web profiles
// over the real Host Typert Remote flow.
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { readFileSync } from 'node:fs'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import * as yaml from 'js-yaml'
import { entryListSchema } from '@deepseek-ai/cordis-plugin-include'
import {
  assertFixtureInventory, captureStableAria, compareOrRefreshGolden,
  launchWebScaffold, seedSession, watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { newEnglishPage, saveFailureShot } from './support.ts'

const SNAPSHOT_DIR = fileURLToPath(new URL('../../../snapshots/web/agent-team-panel', import.meta.url))
const SESSION = join(SNAPSHOT_DIR, 'session.jsonl')
const LIST_EXPECTED = join(SNAPSHOT_DIR, 'task-list.expected.md')
const GRAPH_EXPECTED = join(SNAPSHOT_DIR, 'task-graph.expected.md')
const OVERLAY = fileURLToPath(new URL('./agent-team-panel.overlay.yml', import.meta.url))
const HOST_PATCH = fileURLToPath(new URL('../../../packages/experimental/agent-team-profile/cordis.patch.yml', import.meta.url))
const WEB_PATCH = fileURLToPath(new URL('../../../packages/experimental/agent-team-web-profile/cordis.patch.yml', import.meta.url))
const INSTALL_ANCHORS = [
  fileURLToPath(new URL('../../../packages/experimental/agent-team-profile/package.json', import.meta.url)),
  fileURLToPath(new URL('../../../packages/experimental/agent-team-web-profile/package.json', import.meta.url)),
]
const MODE = webSnapshotMode()
const SEEDED_ID = 'agent-team-panel-web-e2e'

function profileEntries(path: string): unknown[] {
  const parsed = yaml.load(readFileSync(path, 'utf8'), { schema: entryListSchema })
  if (!Array.isArray(parsed)) throw new Error(`profile layer at ${path} must be a list`)
  return parsed
}

describe('Agent Teams panel overlay', () => {
  it('matches the shipped Host and Web profile layers', () => {
    expect(profileEntries(OVERLAY)).toEqual([
      ...profileEntries(HOST_PATCH),
      ...profileEntries(WEB_PATCH),
    ])
  })
})

describe('web e2e: Agent Teams panel', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>

  beforeAll(async () => {
    scaffold = await launchWebScaffold({ extraOverlayPath: OVERLAY, extraInstallAnchors: INSTALL_ANCHORS })
    await seedSession(scaffold, readFileSync(SESSION, 'utf8'), SEEDED_ID)
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    const groupRow = page.locator('[role="treeitem"]').first()
    await groupRow.waitFor({ timeout: 15_000 })
    await groupRow.click()
    const sessionRow = page.locator('[role="treeitem"]').nth(1)
    await sessionRow.waitFor({ timeout: 10_000 })
    await sessionRow.click()
    await page.getByText('Team graph ready.', { exact: true }).waitFor({ timeout: 15_000 })
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
  })

  it('renders one authoritative task list and dependency graph through the single navigable Team panel', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-agent-team-panel'))
    const action = page.locator('[data-team-action]').last()
    await action.getByRole('button', { name: /Agent Team/iu }).click()
    await action.getByRole('tablist', { name: 'Agent Team views', exact: true }).waitFor()
    expect(await action.getByRole('tab', { name: 'Overview' }).getAttribute('aria-selected')).toBe('true')
    await action.getByRole('button', { name: 'task-1 · Prepare inputs' }).waitFor()
    await action.getByRole('button', { name: 'task-2 · Publish result' }).waitFor()
    await action.getByRole('button', { name: /lead Idle/iu }).waitFor()
    await action.getByText('Blocked by: task-1').first().waitFor()

    const listSnapshot = await captureStableAria(page, '[data-team-action]', scaffold.workspaceCwd)
    await compareOrRefreshGolden(LIST_EXPECTED, listSnapshot, MODE)

    await action.getByRole('button', { name: 'Task dependency graph' }).click()
    const graph = action.getByRole('application', { name: 'Task dependency graph' })
    await graph.waitFor()
    expect(await graph.locator('[data-from-task-id="task-1"][data-to-task-id="task-2"]').count()).toBe(1)
    const graphSnapshot = await captureStableAria(page, '[data-team-action]', scaffold.workspaceCwd)
    await compareOrRefreshGolden(GRAPH_EXPECTED, graphSnapshot, MODE)
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  }, 60_000)

  it.skipIf(MODE === 'record')('keeps the fixture inventory closed', async () => {
    await assertFixtureInventory(SNAPSHOT_DIR, [
      'session.jsonl', 'system-prompt.expected.md', 'task-graph.expected.md',
      'task-list.expected.md', 'tool-schemas.expected.json',
    ])
  })
})
