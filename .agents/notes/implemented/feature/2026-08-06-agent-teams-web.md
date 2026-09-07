# Agent Note: Experimental Agent Teams Web controls

Status: implemented

English | [中文](2026-08-06-agent-teams-web.zh.md)

## Problem

The durable Agent Teams runtime owns roster, mailbox, and task state but exposes only model tools and Host service methods. Web users need to inspect teammate activity, manage shared tasks with the same compare-and-set rules, open a teammate conversation, and browse the persisted messages that explain Team coordination. Agent Teams is still experimental, so these capabilities must not add Team-specific contracts or dependencies to the stable API Proxy, Session Controller, Client UI packages, or Web bundle.

## Decision

The private `ctx.agentTeams` service owns generated `agentTeams/view`, `agentTeams/listMessages`, `agentTeams/getMessage`, `agentTeams/createTask`, and `agentTeams/updateTask` Remote methods beside its domain operations. The Team package owns the browser-safe view, committed-message, sanitized-content, and mutation-result types. The Team view contains roster and current task state but omits pending mailbox content and deleted task tombstones. Message pages contain metadata only; details require a stable id and the committed cursor from the list window, then expose literal intentional text and image facts while replacing private or unsupported blocks with explicit omissions. Create and update rejections cross Remote as closed business results; message read and unexpected failures remain ordinary `RemoteResult` failures.

Only the exact live Lead can read the Team message index. Each read serializes with the Team journal and flushes the Lead Session before fixing an event-sequence cutoff. Cursors bind that cutoff to the Team and normalized query, survive a cold projection rebuild, and reject corruption, future history, another Team, or changed filters. The reader validates Host-owned participants before filtering, so a query cannot conceal a forged sender. Queue and delivery event sequence and time are projected separately from body content. Delivery facts do not assert that a person read a message or that related work completed.

`@deepseek-ai/dsh-experimental-client-ui-agent-team` mounts the `@deepseek-ai/dsh-experimental-agent-team/remote` contribution through the stable `ctx.remote` service, then consumes the generated `ctx.remote.agentTeams` methods without an additional Client result wrapper. It owns one Team dialog for roster status, model diagnostics, task controls, and extension views. The dialog's header entry declares the public session-scoped `agent-team.panel.view` list Slot, projects localized contribution labels into tabs, and passes the exact Lead `teamSessionId` at the render site. A contribution uses only the public Slot and generated Remote types; disposing either Fiber removes its UI and authority.

Every task update sends the displayed revision. Each create or update owns an independent pending token, invalidates older refreshes before starting, and reloads the complete Team view after success. A conflict asks the user to review only after its reload succeeds; a reload failure remains visible. Overlapping refreshes publish only the latest request for the selected Session.

Teammate navigation uses the existing `{ parentSessionId, childSessionId, mode: 'continuable' }` Subagent address without a Team tag. The UI refreshes the direct-child catalog, rechecks the selected Session, and opens the addressed conversation. History and ordinary addressed-child continuations follow the stable Subagent path. The [durable human Team message request decision](../architecture/2026-09-07-durable-human-team-message-requests.md) partially supersedes this note's original no-send/no-reply and addressed-child-only boundary: the current message composer uses the generated `agentTeams/sendMessage` Remote for explicit human work and replies. This note remains the current owner of message reads, pagination, tasks, teammate navigation, and Client Slot composition.

`@deepseek-ai/dsh-experimental-agent-team-web-profile` inserts only the UI after the stable Web bundle. It is applied alongside the Host-side `@deepseek-ai/dsh-experimental-agent-team-profile`, which already inserts `ctx.agentTeams` and the model tools. Neither stable bundle contains disabled Team rows or dependencies.

Stable Web presets still register continuable Subagent controls inside their preset scope. Top-level Agent Teams profile overrides cannot replace those registrations, so this experimental composition may expose both the Team roster and legacy child controls. A Team-aware Web preset is deferred; the [Web profile README](../../../../packages/experimental/agent-team-web-profile/README.md#known-limitations-and-deferred-work) owns the current limitation.

## Boundaries

The Web message read methods remain list/detail-only and have no read-receipt or live-subscription operation. A separate Lead-only generated `agentTeams/sendMessage` Remote and message composer provide explicit sends and replies without turning a read into a mutation or inferring completion. The reader never copies message bodies into the Team view, a global Client store, or a run index. The Web UI has no worktree or Git controls, teammate creation, rename, deletion, interruption, or automatic merge behavior. It does not infer filesystem authority from task ownership or write scopes. An ordinary continuation after teammate navigation remains an addressed-child prompt; only an explicit message-composer submission is a Team mailbox message.

## Alternatives considered

**Extend the legacy API Proxy Team RPC map.** Rejected because it would put an experimental domain in a stable wire package and duplicate the generated Remote vocabulary and validation.

**Introduce a separate browser Remote service.** Rejected because the methods have no state, lifecycle, or policy owner distinct from `ctx.agentTeams`; a second Cordis service would duplicate Team injection and require another package for the same Typert namespace.

**Add Team metadata to the stable Subagent address and prompt routing.** Rejected because ordinary child navigation already identifies the conversation. A Team tag would couple stable Client and Subagent contracts to experimental mailbox policy.

**Put disabled Team rows in the stable Web bundle.** Rejected because a disabled row still creates release dependencies and makes the experimental package part of shipped composition.

**Import private Team components into each extension.** Rejected because it duplicates panel ownership and couples extensions to implementation files. The owner-declared child Slot keeps one dialog and one public composition point.

**Return message bodies in `agentTeams/view` or list pages.** Rejected because broad snapshots and routine refreshes would retain sensitive content and enlarge every response. On-demand detail keeps authority and content selection at the Host read.

## Testing

Team-service tests cover fixed-window pagination, filters, detail authorization, sanitized content, participant forgery, stale identity, cursor scope and corruption, persistence failure, no-activity reads, and cold restart. Per-file coverage fixes every message-reader path; generation plus a plain-Node built-artifact smoke verifies exported Remote descriptors. Client typechecking and browser component tests cover owner-declared child navigation, dynamic registration and disposal, the mounted namespace, Lead routing, task controls, stale async results, and status or error presentation. The keyless Agent Team profile snapshot exercises metadata and sanitized-detail reads through the real Host service, and the Web end-to-end test pins the single navigable panel over the real Remote composition.

## Consequences

The Team service is the single Cordis owner for domain state, read authority, and the Remote operations that expose selected Team values. The Team UI owns one extensible dialog while message content remains an on-demand Host result. This adds a projection index and opaque cursor protocol, and extensions must register through the owner Slot. The stable API Proxy, Session Controller, Client UI packages, and Web bundle remain Team-agnostic. Promotion renames the experimental npm packages but does not require a new generated namespace.
