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
import { createMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-cordis-host-runner'
import {
  assertFixtureInventory, captureStableAria, compareOrRefreshGolden,
  launchWebScaffold, seedSession, watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { connectFreshWorkspace, newEnglishPage, saveFailureShot } from './support.ts'

const SNAPSHOT_DIR = fileURLToPath(new URL('./snapshots/agent-team-panel', import.meta.url))
const PANEL_EXPECTED = join(SNAPSHOT_DIR, 'task.expected.md')
const NAVIGATION_SNAPSHOT_DIR = fileURLToPath(
  new URL('../../../snapshots/web/agent-team-panel-navigation', import.meta.url),
)
const NAVIGATION_EXPECTED = join(NAVIGATION_SNAPSHOT_DIR, 'navigation.expected.md')
const NAVIGATION_SEED = fileURLToPath(new URL('../../../snapshots/web/fresh-round-trip/session.jsonl', import.meta.url))
const NAVIGATION_SESSION = 'agent-team-navigation-web-e2e'
const OVERLAY = fileURLToPath(new URL('./agent-team-panel.overlay.yml', import.meta.url))
const HOST_PATCH = fileURLToPath(new URL('../../../packages/experimental/agent-team-profile/cordis.patch.yml', import.meta.url))
const WEB_PATCH = fileURLToPath(new URL('../../../packages/experimental/agent-team-web-profile/cordis.patch.yml', import.meta.url))
const INSTALL_ANCHORS = [
  fileURLToPath(new URL('../../../packages/experimental/agent-team-profile/package.json', import.meta.url)),
  fileURLToPath(new URL('../../../packages/experimental/agent-team-web-profile/package.json', import.meta.url)),
]
const MODE = webSnapshotMode()

const NAVIGATION_CLIENT_CODE = `return {
  inject: ["slots", "agentTeamPanelNavigation"],
  apply(ctx) {
    const AddressedMessages = ({ teamSessionId, selectedMemberId, navigationRevision }) => React.createElement(
      "section",
      { "aria-label": "Addressed Team messages" },
      React.createElement("p", null, "Team: " + teamSessionId),
      React.createElement("p", null, "Member: " + (selectedMemberId || "none")),
      React.createElement("p", null, "Navigation revision: " + navigationRevision),
    )
    const OpenMessages = ({ sessionId }) => React.createElement(
      "button",
      {
        type: "button",
        onClick: () => ctx.agentTeamPanelNavigation.open({
          teamSessionId: sessionId,
          viewId: "messages",
          memberId: "addressed-member",
        }),
      },
      "Open addressed Team messages",
    )
    ctx.slots.inject("agent-team.panel.view", () => ctx.slots.register(
      { name: "agent-team.panel.view", id: "messages", order: 10, label: "Messages" },
      AddressedMessages,
    ))
    ctx.slots.inject("conversation.session.header.actions", () => ctx.slots.register(
      { name: "conversation.session.header.actions", id: "team-message-link", order: 21 },
      OpenMessages,
    ))
  },
}`

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
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    await connectFreshWorkspace(page, scaffold.workspaceCwd)
    const agent = scaffold.ctx.agents.list()[0]
    if (agent === undefined) throw new Error('connected Team workspace did not create an Agent')
    agent.session.append('turn/start', { turn: 1 })
    agent.session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'Open the Agent Team controls.' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    agent.session.append('step/start', { turn: 1, step: 1 })
    agent.session.append('assistant/message', {
      turn: 1,
      step: 1,
      message: createMessage({
        role: 'assistant',
        content: [{ type: 'text', text: 'Ready.' }],
        source: { kind: 'model', provider: 'fixture', model: 'fixture' },
      }),
    }, { surfaceOp: 'append' })
    agent.session.append('step/end', { turn: 1, step: 1 })
    agent.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    await scaffold.ctx.sessions.flush(agent.session)
    await page.getByText('Ready.').waitFor({ timeout: 10_000 })
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
  })

  it('loads the roster and creates one shared task through the single navigable Team panel', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-agent-team-panel'))
    const action = page.locator('[data-team-action]')
    await action.getByRole('button', { name: /Agent Team/iu }).click()
    await action.getByRole('tablist', { name: 'Agent Team views', exact: true }).waitFor()
    expect(await action.getByRole('tab', { name: 'Overview' }).getAttribute('aria-selected')).toBe('true')
    await action.getByText('No shared tasks yet').waitFor()
    await action.getByText('lead').waitFor()

    await action.getByRole('button', { name: 'New task' }).click()
    await action.getByPlaceholder('Task subject').fill('Browser task')
    await action.getByPlaceholder('Task description').fill('Created through the assembled browser')
    await action.getByPlaceholder(/Write scopes/iu).fill('src/web')
    await action.getByRole('button', { name: 'Save' }).click()
    await action.getByText('Browser task').waitFor()

    const snapshot = await captureStableAria(page, '[data-team-action]', scaffold.workspaceCwd)
    await compareOrRefreshGolden(PANEL_EXPECTED, snapshot, MODE)
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  }, 60_000)

  it.skipIf(MODE === 'record')('keeps the fixture inventory closed', async () => {
    await assertFixtureInventory(SNAPSHOT_DIR, ['task.expected.md'])
  })
})

describe.skipIf(MODE === 'record')('web snapshot: addressed Agent Team panel navigation', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>

  beforeAll(async () => {
    scaffold = await launchWebScaffold({ extraOverlayPath: OVERLAY, extraInstallAnchors: INSTALL_ANCHORS })
    await seedSession(scaffold, readFileSync(NAVIGATION_SEED, 'utf8'), NAVIGATION_SESSION)
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
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
  })

  it('opens one public child for the recorded Session and forwards the addressed member', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-agent-team-navigation'))
    await expect.poll(
      () => scaffold.ctx.agents.get(SessionId(NAVIGATION_SESSION)),
      { timeout: 30_000 },
    ).toBeDefined()
    const agent = scaffold.ctx.agents.get(SessionId(NAVIGATION_SESSION))
    if (agent === undefined) throw new Error('recorded Team Session did not publish a live Agent')
    const defined = scaffold.ctx.dynamicCordisRunner.define({
      sessionId: agent.id,
      plugin: { kind: 'new', idPrefix: 'team' },
      name: 'Team message link snapshot',
      purpose: 'Exercise public addressed Team panel navigation',
      code: { client: NAVIGATION_CLIENT_CODE },
    })
    await expect(scaffold.ctx.dynamicCordisRunner.run(
      agent,
      defined.pluginId,
      defined.packageId,
      'run',
    )).resolves.toMatchObject({ ok: true, status: 'awaiting-approval' })

    const approve = page.locator('[data-cordis-approve]').first()
    await approve.waitFor({ timeout: 30_000 })
    await approve.click()
    const trigger = page.getByRole('button', { name: 'Open addressed Team messages', exact: true })
    await trigger.waitFor({ timeout: 30_000 })
    await trigger.click()

    const action = page.locator('[data-team-action]')
    await action.getByRole('dialog', { name: 'Agent Team', exact: true }).waitFor()
    expect(await action.getByRole('tab', { name: 'Messages', exact: true }).getAttribute('aria-selected')).toBe('true')
    await action.getByRole('region', { name: 'Addressed Team messages', exact: true }).waitFor()
    const snapshot = (await captureStableAria(page, '[data-team-action]', scaffold.workspaceCwd))
      .split(NAVIGATION_SESSION).join('{{sessionId}}')
    await compareOrRefreshGolden(NAVIGATION_EXPECTED, snapshot, MODE)
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  }, 90_000)

  it('keeps the recorded-session snapshot inventory closed', async () => {
    await assertFixtureInventory(NAVIGATION_SNAPSHOT_DIR, ['navigation.expected.md'])
  })
})
