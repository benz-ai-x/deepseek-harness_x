---
description: "Use and debug the experimental Web Agent Teams roster, task board, teammate navigation, and public child views."
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-client-ui-agent-team

English | [中文](README.zh.md)

## Summary

This package adds one Agent Teams action and dialog to the Web conversation header, where a user can inspect the current roster, switch the shared task board between a list and dependency graph, navigate into a teammate's conversation, and open extension-owned Team views. It reads authoritative Team state through the generated `ctx.remote.agentTeams` contribution and keeps ordinary child-history navigation on the stable addressed-subagent path. Choose it for the experimental source-checkout Web profile; official releases exclude it. The browser projection does not extend the stable API Proxy, store Team state, or register model-facing input.

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

Opening the panel starts `agentTeams/watch` and reads `agentTeams/view`. Roster rows show durable names, runtime status, model, and diagnostics. Selecting a healthy teammate refreshes the existing direct-child catalog and opens the ordinary `{ parentSessionId, childSessionId, mode: 'continuable' }` address. History and later human prompts continue through the stable addressed-subagent conversation path; this package adds no Team-specific address field.

### Manage the task board

The list and dependency graph derive from the same `agentTeams/view` task snapshot and share one selected task, detail panel, and mutation controls. Graph nodes use real task ids and Host-provided owner, status, readiness, and blocker facts; each directed edge runs from a prerequisite to its dependent. The graph provides deterministic automatic layout, bounded zoom and pan, fit-to-view, dependency-aware keyboard navigation, and the native-button list as an equivalent alternative. Filtering hides presentation only, identifies prerequisites omitted by the filter, and never recalculates Host readiness.

A user can create, edit, assign or unassign, complete, reopen, and delete tasks through `agentTeams/createTask` and `agentTeams/updateTask`. Create and edit forms expose current real task ids as native dependency checkboxes, excluding the task being edited. Every update sends the displayed revision, and create or update rejections remain explicit business results.

### Extend the Team panel

The header action owns the only Team dialog and declares the session-scoped list Slot `agent-team.panel.view` inside it. A Client extension contributes a stable id, order, localized label, and component through that public Slot; the Team owner passes the exact Lead `teamSessionId` selected by the current conversation. Contributions appear as tabs beside Overview and need no import from this package's private components. Registration, locale changes, and removal update the navigation list, and disposing either Fiber removes its authority and UI.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The Client export mounts the generated `ctx.remote.agentTeams` contribution from [`@deepseek-ai/dsh-experimental-agent-team/remote`](../agent-team/README.md), then registers its locale dictionaries and one conversation-header entry through Cordis effects. That entry declares `agent-team.panel.view`, observes its public contributions and localized labels, and renders the selected contribution inside the existing dialog. Its Client-registration lifecycle owns every watch control created by React: unmount synchronously starts an idempotent close, while Fiber or service-generation disposal awaits all triggered and live controls before removing the generated Remote. Disposal failures reach the Cordis lifecycle error boundary without retaining the Remote, locale, entry, child Slot, subscriptions, or contribution navigation.

The open panel consumes each reconnecting watch generation as one complete baseline followed by bounded invalidations. A baseline atomically replaces an older unary read; invalidations call the existing authoritative view reader instead of carrying task state. Authority reads are serialized: a burst during one in-flight read records one dirty latch and performs at most one trailing read. Carrier loss retains the last published view with an explicit disconnected or stale status, and reconnect only reads the new baseline. Session changes and service replacement fence late generations, release queued reads, and keep the new generation independent, while closing the panel actively stops its control and the owning Client lifecycle awaits stream quiescence.

Starting a create or update invalidates older refreshes. Success reloads the complete Team view so every task's derived fields stay current. If the selected id disappears from that non-deleted view, the selection remains fixed while generated `agentTeams/getTask` reads its authoritative tombstone; the same detail panel shows the deleted fact without mutation controls, and session or service changes fence late detail reads. Task text, scopes, and the complete dependency draft use one `edit` compare-and-set mutation whose expected revision is captured when editing starts and is not advanced by watch refreshes. A selected draft dependency that disappears from the current view remains an explicit unavailable-or-deleted checkbox until the user removes it or saves. If the edit conflicts, the UI keeps the old form and dependency draft and never retries automatically. A successful conflict-triggered authoritative reload advances the base for the next explicit Save and marks the draft unsaved; a failed reload leaves the base unchanged and keeps the real error visible. List/graph mode, selection, filtering, and viewport transform are disposable component state; neither layout nor visibility creates a task projection or changes readiness.

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

- **Invalidation granularity** — live changes refresh the complete authoritative Team view; the stream intentionally carries no task delta or Client-owned projection.
- **Overview only** — this base package contributes roster and task controls; message and other Team views require a separate `agent-team.panel.view` contribution.
- **Ordinary child continuation** — a human message sent after navigation uses the stable addressed-subagent prompt path, not the Team peer mailbox.
- **No lifecycle or workspace controls** — the panel cannot spawn, rename, delete, or interrupt teammates, and write scopes remain advisory metadata.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>

**Runtime invariant:** No companion is published. RPC is authoritative, and the package owns one disposable header entry, child Slot, and reconnecting Team stream control.
