---
description: "Use and debug the experimental Web Agent Teams roster, task board, teammate navigation, and public child views."
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-client-ui-agent-team

English | [中文](README.zh.md)

## Summary

This package adds one Agent Teams action and dialog to the Web conversation header, where a user can inspect the current roster, manage the shared task board, navigate into a teammate's conversation, and open extension-owned Team views. It reads authoritative Team state through the generated `ctx.remote.agentTeams` contribution and keeps ordinary child-history navigation on the stable addressed-subagent path. Choose it for the experimental source-checkout Web profile; official releases exclude it. The browser projection does not extend the stable API Proxy, store Team state, or register model-facing input.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Install the package through [`@deepseek-ai/dsh-experimental-agent-team-web-profile`](../agent-team-web-profile/README.md) after the stable Web bundle and the Host-side Agent Teams profile. The Web Client loader mounts the `/client` export; the root Host export is inert, and the package has no user configuration fields.

### Inspect and navigate the roster

Opening the panel calls `agentTeams/view`. Roster rows show durable names, runtime status, model, and diagnostics. Selecting a healthy teammate refreshes the existing direct-child catalog and opens the ordinary `{ parentSessionId, childSessionId, mode: 'continuable' }` address. History and later human prompts continue through the stable addressed-subagent conversation path; this package adds no Team-specific address field.

### Manage the task board

The task board shows task identity, owner, blockers, readiness, advisory write scopes, and overlap warnings. A user can create, edit, assign or unassign, complete, reopen, and delete tasks through `agentTeams/createTask` and `agentTeams/updateTask`. Every update sends the displayed revision, and create or update rejections remain explicit business results.

### Extend the Team panel

The header action owns the only Team dialog and declares the session-scoped list Slot `agent-team.panel.view` inside it. A Client extension contributes a stable id, order, localized label, and component through that public Slot; the Team owner passes the exact Lead `teamSessionId` selected by the current conversation. Contributions appear as tabs beside Overview and need no import from this package's private components. Registration, locale changes, and removal update the navigation list, and disposing either Fiber removes its authority and UI.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The Client export mounts the generated `ctx.remote.agentTeams` contribution from [`@deepseek-ai/dsh-experimental-agent-team/remote`](../agent-team/README.md), then registers its locale dictionaries and one conversation-header entry through Cordis effects. That entry declares `agent-team.panel.view`, observes its public contributions and localized labels, and renders the selected contribution inside the existing dialog. Disposing the plugin Fiber removes the Remote, locale, entry, child Slot, subscriptions, and contribution navigation.

Starting a create or update invalidates older refreshes. Success reloads the complete Team view so every task's derived fields stay current. A `team-task-conflict` result displays a stale-state notice only after that reload succeeds; a reload failure remains visible instead. Editing task text or scopes and changing dependencies use two sequential compare-and-set mutations because the Team service exposes them as separate actions.

| File | Role |
|---|---|
| [`src/client/mount.ts`](src/client/mount.ts) | Generated Remote, locale, navigation, public child-view projection, and slot registration |
| [`src/client/TeamAction.tsx`](src/client/TeamAction.tsx) | Team dialog, child-view tabs, roster, and task-board interaction state |
| [`src/client/locales.ts`](src/client/locales.ts) | English and Chinese panel copy |
| [`src/index.ts`](src/index.ts) | Inert Host entry |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Agent Teams Web profile](../agent-team-web-profile/README.md) — the source-checkout bundle that mounts this Client plugin.
- [Agent Teams service](../agent-team/README.md) — authoritative roster, task, and Remote behavior.
- [Conversation UI](../../client/ui-conversation/README.md) — the stable header slot and addressed-subagent navigation surface.
- [Experimental packages](../README.md) — incubation status and release exclusion.

-----

<a id="model-experience"></a>
## Model Experience

None, as this browser projection and task control surface registers no model-facing input.

#### KV Cache effect

No direct effect; the Team tools and ordinary conversation submission own any later model-visible use.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Snapshot refresh** — the Overview refreshes on open, explicit refresh, and mutations; it has no live event subscription.
- **Overview only** — this base package contributes roster and task controls; message and other Team views require a separate `agent-team.panel.view` contribution.
- **Ordinary child continuation** — a human message sent after navigation uses the stable addressed-subagent prompt path, not the Team peer mailbox.
- **No lifecycle or workspace controls** — the panel cannot spawn, rename, delete, or interrupt teammates, and write scopes remain advisory metadata.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>

**Runtime invariant:** No companion is published. RPC is authoritative, and the package owns one disposable header entry that declares and renders the public Team child Slot.
