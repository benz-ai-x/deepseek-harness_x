---
description: "Run a small team of named agents in one session: durable messages between members and a shared task board, for deployments composing the experimental Team plugins."
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-agent-team

English | [中文](README.zh.md)

## Summary

`dsh-experimental-agent-team` turns one coding session into a small working team: the session's agent becomes the Lead, creates named teammates for delegated work, exchanges durable messages with them, and tracks shared tasks on a common board. Messages and task state survive crashes, reloads, and interruptions, so a teammate that was offline receives its queued messages when it resumes. It provides no tools of its own — mount the sibling `dsh-experimental-tool-agent-team` so the model can create teammates, message them, and use the task board. It is experimental: excluded from official releases, carries no stability promise, and needs durable session storage to activate.

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

Add this package to a composition when one agent should run a small team of named helpers in its own working directory, with messages and task state that survive crashes and restarts. It ships no tools of its own: mount it together with `@deepseek-ai/dsh-experimental-tool-agent-team` so the model can create teammates, message them, and use the task board.

### When to choose it

Choose it when several agents must cooperate on one shared workspace and their roster, messages, and task state must survive crashes and restarts. Avoid it when teammates need separate working directories, when several processes must coordinate over one team, or when a task owner should be released automatically — none of those are supported. The team features need durable session storage to activate.

### Smallest working setup

<a id="smallest-working-setup"></a>

The smallest addition to an existing composition is durable session storage plus both Team packages:

```yaml
# smallest team setup — durable storage plus both Team packages
- name: '@deepseek-ai/dsh-session-persistence-jsonl'
- name: '@deepseek-ai/dsh-experimental-agent-team'
- name: '@deepseek-ai/dsh-experimental-tool-agent-team'
```

With the tools installed, the model does the rest on request — for example, "create a teammate named reviewer to check the diff", then "send reviewer the change summary". All limits are optional and validated at startup:

| Field | Default | Meaning |
|---|---|---|
| `maxMembers` | `8` | Maximum teammates a team may ever create, including failed ones |
| `maxTasks` | `256` | Maximum active tasks on the board |
| `maxPendingMessagesPerMember` | `64` | Maximum queued messages for one member |
| `maxMessageBytes` | `65,536` | Maximum size of one sent message |
| `maxProfileBytes` | `131,072` | Maximum UTF-8 size of one canonical external Profile snapshot |
| `maxEvidenceItems` | `1,000` | Maximum normalized items in one external evidence page |
| `maxEvidenceBytes` | `65,536` | Maximum UTF-8 size of one normalized external evidence page |
| `disposalTimeoutMs` | `5,000` | Grace period before provider-native cleanup receives an abort signal; settlement is still awaited |

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-experimental-agent-team) is the exhaustive source for every accepted field and its JSDoc.

<a id="teammates"></a>

### Teammates

Ask the Lead to create a teammate: give it a unique lowercase name such as `reviewer` and describe its job. A teammate starts fresh with no memory of the Lead's conversation, or as a fork that inherits the Lead's completed turns; the creation request chooses which. Teammate names are permanent — even a teammate whose creation failed keeps its name, and no name is ever reused.

A host can pin a teammate to normalized per-child LLM provider, model, and reasoning-effort options. Agent Teams passes those options unchanged to the continuation manager, records both the requested route and the route resolved into the child descriptor, and rejects creation if an explicitly requested field changed. The descriptor remains the cold-resume authority, so a later Lead or deployment-default route cannot replace the pinned route.

A host can instead register a durable external teammate provider with `ctx.agentTeams.registerTeammateRuntimeProvider()`. The provider advertises only detached context, Profile-policy, and operational capabilities; its credentials, process objects, and native payloads remain Host-only. An external launch carries a caller-minted launch id and the Team's already-reserved member id. Durable launch ids and native handles are non-empty opaque strings of at most 200 UTF-8 bytes and impose no lexical identifier grammar. The provider must durably accept the initial work and return one stable opaque native handle before the roster becomes active; when observable, its stable initial turn id is retained with that active member. Identical launch and mailbox retries keep the same native runtime and turn identities; Agent Teams never substitutes a one-shot subagent. A provider may advertise exact-call approval only with Hook enforcement and evidence that uses one stable Profile policy id plus the same immutable native call and approval ids. Provider removal makes the member inactive, while a later provider generation resumes the exact handle rather than creating a replacement.

Provider adapters with an optional catalog owner use `mountTeammateRuntimeProvider()` so this Host-only package owns the shared owner contract, dynamic service generations, exact-once registration cleanup, and provider teardown ordering.

Native providers can query members and tasks, change authorized tasks, wait for activity, and send member-owned messages through their own tool channel. A provider declares `memberOperations` and implements `bindMemberOperations`; the Team owner delivers a nonserializable grant only after accepting the durable member and native handle. Recovery verifies the same identity before granting current access. Every call acts as that teammate through the existing roster, task board or mailbox; model arguments cannot select a Team, member, handle, or Lead role. Evaluation handles receive no production grant.

A provider adapter can call the grant's Host-only `turns.recover` reader after verified resume; this operation is not advertised as a model tool. The reader flushes the Lead Session before returning detached facts for the granted member: its launch request and optional initial turn, inbound delivery ids, and committed settlement outcome and text. Incoming message text, sibling and other-Team facts, raw provider history, and grant credentials remain excluded. The read publishes no Team activity.

Recovery pages default to 10 items and accept limits from 1 to 100. The numeric offset indexes the current list, ordered as launch, inbound deliveries, then settlements; an offset at the current length returns an empty page and a larger offset is invalid. Concurrent appends can repeat a stable item across pages, so adapters de-duplicate launch, delivery, and turn identities until `nextOffset` is absent.

Native operations accept at most 4,096 UTF-8 bytes of complete JSON and return at most 65,536 bytes, including operation and page metadata. Task lists default to 20 entries and accept limits from 1 to 100; a cursor identifies the last returned task and becomes invalid when that task is absent from the current list. Oversized results return a fixed error instead of partial JSON; request a smaller page. Caller cancellation refuses that invocation. Lead disposal, handle disposal, inactive native presence, or provider retirement revokes the grant permanently; a later presence report alone grants no access. These grants expose neither arbitrary RPC nor DSH Agent credentials. The [native authorization reference](../../../docs/subsystems/agent-team.md#native-member-authorization) owns the Host types.

Task writes use the same ownership, expectedRevision, DAG and tombstone rules as DSH members; Lead-only reassignment remains forbidden. A stale write reports currentRevision. A mutation receipt contains only task id, revision, status, owner name and readiness; task reads return full details. Waiting observes later Team activity for ten seconds through one hour and starts no work.

The exact live Lead may call `ctx.agentTeams.readTeammateRuntimeEvidence()` for one active external teammate. Agent Teams supplies the roster-owned native handle and returns only a bounded normalized page of turn, tool, approval, outcome, timestamp, and provider-reported usage facts. An approval fact retains the stable turn, tool, call, approval, and Profile policy identities but no proposed arguments; a non-empty pending set is accepted only while that exact runtime reports `running`. Prompts, replies, tool arguments/results, files, environment values, credentials, and raw provider payloads never cross the service boundary.

The exact live Lead may also call `ctx.agentTeams.runTeammateEvaluation()` without creating a roster member or reserving a teammate name. Every request requires fresh context and evaluation capability, carries a detached Profile plus declared input and text fixtures, and is confined to a read-only sandbox, `approval: never`, positive resource ceilings, and a unique allowlist drawn from the provider's published evaluation-tool inventory. That inventory is limited to 256 unique identifiers of at most 128 UTF-8 bytes each. Agent Teams normalizes and bounds the terminal result, output, evidence, timestamps, and identities. An optional commit callback runs while the exact evaluation handle is still attached; the handle is disposed in `finally` before the API resolves or rejects, including commit failure and cancellation paths. Evaluation output is transient runner input, not a Team transcript or activation.

The roster shows every member with its role (`lead` or `teammate`) and current status: `running`, `idle`, `inactive` (a member that exists but is not loaded), `provisioning`, or `failed`. DSH teammate rows expose detached requested and resolved route snapshots; external rows expose only their durable provider correlation and opaque native handle. A member that is not loaded receives its messages when it wakes.

Only the Lead can create teammates or interrupt them.

### Messages between teammates

Any member can send a message to any other member or to the Lead. A live member receives it immediately; an offline member's messages queue and arrive when it resumes. Durable queues and target receipt identities preserve messages and suppress duplicate delivery across a single Host’s retries and recovery.

Every message uses Steer: a running target receives it at the nearest step boundary, an idle target starts a turn, and an inactive teammate cold-resumes. The sender always sees the outcome — accepted by the target inbox, or retained as queued when delivery is temporarily unavailable. A queued message is already safely stored; sending a new message would create separate work.

Native message calls carry a trusted work-turn and tool-call identity outside model arguments. The Team stores one message and its replayable acceptance receipt in a single required event before acknowledging or delivering it. Retrying the same call with normalized identical input returns the original queued receipt; changing input conflicts. Queued records express durable acceptance, not delivery or completed work. Provider terminal settlement uses one separate identity per work turn and publishes intentional final text or a failure/interruption notification to the Lead through the same mailbox. Recovery replays the receipt after verifying the current grant.

### Browse persisted messages

The exact live Lead can read persisted Team messages through `listMessages()` and `getMessage()`. Metadata pages are newest-first, default to 20 rows, accept limits from 1 through 100, and filter by retained member, direction relative to that member, and delivery stage. The first page fixes a committed event cutoff; every continuation retains that cutoff, Team identity, and normalized filters. Malformed, future, cross-Team, or changed-query cursors are rejected. A detail request must use the stable message id and the committed cursor from the list window that exposed it.

List results contain only sender, recipient, queue time, and delivery facts. Detail reads return literal intentional text and detached image media type, dimensions, and byte size. Reasoning, tool calls and results, attachment identities, provider extensions, and other unsupported blocks become explicit omission markers; `complete`, `partial`, or `unavailable` reports the resulting content coverage. The reader validates every persisted participant before filtering, derives names from the current Host-owned roster, and publishes no Team activity. `pending` and `delivered` are delivery facts, while `unknown` is reserved for a client that cannot obtain a current fact; none of these states means read, acknowledged by a person, or task completion.

### Shared task board

Any member can add a task with a title, details, optional dependencies on other tasks, and optional hints about which files it will touch. A task is claimable only when everything it depends on is complete.

Tasks have an owner: a member claims a task to start work, completes it when done, releases it back, or reopens it; the Lead can assign a task to any member. Every change is compare-and-set: an update based on an outdated copy is rejected, so two members cannot silently overwrite each other's work.

File hints produce warnings when two in-progress tasks plan to touch overlapping paths — they never block anything. Deleted tasks remain in history but disappear from the active list.

### Waiting and interruption

A member can wait for the next team change — a teammate's status, an incoming message, or a task update — instead of polling repeatedly; the wait reports only whether it timed out, and the caller re-reads the current state afterward.

The Lead can stop a teammate's current turn without deleting its queued messages; task ownership is unchanged.

### What success and failure look like

Success looks like a teammate appearing in the roster, a message reporting `accepted` or `queued`, and task revisions advancing with each change. Likely failures are reported as specific errors instead of silently corrupting state: sending to a name that is not a member, claiming a task that is not ready, editing with an outdated revision, or creating a teammate beyond the member limit.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains the design decisions behind the service and points at the code that realizes them; the observable behavior is fully covered in [Use this package](#use-this-package).

### Design philosophy

The service is built on one separation and three commitments:

- **Durable log, derived state.** The Lead Session log is the single source of truth; roster, mailbox, and task state are replayed from it on every read.
- **Process-local ownership.** All coordination lives in one process; the guarantee is retry plus de-duplication, never cross-process consensus.
- **Explicit authority.** Every service method takes the exact live calling `Agent`; only the Lead spawns, reassigns, or interrupts.
- **Bounds that fail loud.** Every limit is a validated deployment value, and exhaustion reports a typed error instead of reusing an id or name.

The [Agent Teams Agent Note](../../../.agents/notes/implemented/feature/2026-08-05-agent-teams.md) owns the identity, mailbox, task, and shared-checkout decisions.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: `Config` schema, service registration, recovery scheduling |
| [`src/roster.ts`](src/roster.ts) | Team identity, route correlation, provisioning, recovery, and roster teardown |
| [`src/mailbox.ts`](src/mailbox.ts) | Durable queue, target-local dispatch, acknowledgement, and recovery |
| [`src/message-reader.ts`](src/message-reader.ts) | Lead-authorized committed pagination and sanitized on-demand content |
| [`src/task-board.ts`](src/task-board.ts) | Task commands and atomic native receipts; shared transitions and views live in [`task-state.ts`](src/task-state.ts) |
| [`src/journal.ts`](src/journal.ts) | Serialized Lead-log transactions and commit notification |
| [`src/projection.ts`](src/projection.ts) | Strict replay projection that decodes and validates Team events |
| [`src/activity.ts`](src/activity.ts) | One-shot change waiters and disposal release |
| [`src/lifecycle.ts`](src/lifecycle.ts) | Shared admission cutoff and quiescent cleanup with an abort grace period |
| [`src/teammate-runtime.ts`](src/teammate-runtime.ts) | Fiber-scoped durable provider registry, capability gate, exact-handle routing, and cleanup |
| [`src/service-types.ts`](src/service-types.ts) | Host-only DSH and external teammate request/provider contracts |
| [`src/invariant.ts`](src/invariant.ts) | Invariant companion that replays candidate events before append |

### Team identity and roster

Every ordinary runtime root is the implicit Lead of a Team whose `TeamId` equals its `SessionId`; there is no creation event, and durable state begins with the first member, message, or task record. `spawnTeammate()` first appends and flushes a `provisioning` member record with its requested child route, then asks the configured continuation provider to create the reserved child with the same options. The launch caller owns cancellation through the initial inbox durability checkpoint. Once that item is durable, cancellation ownership transfers to the Team lifecycle: a disconnected caller cannot interrupt descriptor correlation or the terminal roster commit, while Team disposal still can. The service then reads the child's descriptor, rejects an altered explicit route, and writes the resolved route into the `active` member record. A fresh child starts with no Lead history; a fork child captures the Lead's completed-turn prefix once. Recovery reconciles an unterminated provisioning record against the child's independently persisted Session: a matching direct parent, continuation provider, requested route, continuable descriptor, and recorded initial user message produces `active`, while anything else produces `failed`. If recovery wins a same-process race, the creator accepts the terminal state or reports `TEAM_PROVISIONING_CONFLICT` and drains the child. Names are reserved by the first provisioning record and never reused.

The external branch validates the requested context, Profile-policy, approval, sandbox, evaluation, evidence, and usage capabilities before reserving a member. Exact-call approval additionally requires Hook enforcement and normalized evidence; an ask Hook carries its stable Profile id, and malformed approval or pending correlations quarantine the provider generation. The branch records a canonical request fingerprint and provider correlation, calls `create()` with the launch id plus reserved member identity, and records the validated native handle in the same terminal `active` snapshot. Before native acceptance the caller owns cancellation; afterward the Team lifecycle owns the roster commit. Recovery calls `resume()` with the stored launch/member/handle tuple, and a missing provider leaves provisioning or active state intact and unavailable. Provider generations own native sessions, evidence, isolated evaluation handles, and disposal; Agent Teams owns roster names, member ids, mailbox ordering, and stable correlations. The reusable provider suite exported from [`@deepseek-ai/dsh-experimental-agent-team/testkit`](src/testkit.ts) fixes the common idempotency, cancellation, evidence, evaluation, and exact-disposal contract for future implementations. Its fixture must arm in-flight create and delivery cancellation, reopen the same durable native store, and prove single-runtime identity, stable turns, exact interruption, and complete detachment through `armCreateCancellation`, `armDeliveryCancellation`, `reopen`, `assertSingleRuntime`, `assertTurn`, `assertInterrupted`, and `assertDetached`.

### Durable mailbox

`sendMessage()` validates peer membership, appends `team/message/queued`, and flushes before attempting delivery. The target message begins with `Team message <id> from <name>:` and keeps the same id and sender in `TeamMessageSource`. A target receipt is acknowledged with `team/message/delivered` only after the target Session durably holds the message identity in its pending inbox or recorded history. Immediate admissions are serialized per target in durable queue order; recovery dispatches queued-minus-delivered records in the same order. Delivery folds both live and persisted target inbox/history state before retrying, so a crash between inbox acceptance and model claim does not duplicate the message. The guarantee is process-local retry plus target-Session de-duplication, not cross-process exactly-once delivery.

Lead delivery calls `Agent.steer()` directly. DSH teammate delivery uses the continuation owner's host-only Steer path, which preserves the Team sender source while authorizing the Lead-to-child edge and cold-resuming inactive targets. Sibling messages never impersonate the Lead through the public adjacent-Agent messaging operation. For an external teammate, the same durable queue routes through `deliver()` with its exact provider/native handle and stable Team message id. The provider returns a stable native turn id before Agent Teams records delivery. Provider absence keeps the item queued; re-registration and exact-handle resume retry it without a one-shot fallback.

The projection retains a position-aligned message index containing the queue event's sequence and time plus an optional delivery event sequence and time. The committed reader uses those event-owned facts rather than copying body content or mutable runtime status into a second store. Projection state version 6 rebuilds the index from the Lead log after a cold restart.

### Shared task board

Tasks are complete versioned snapshots; every mutation carries `expectedRevision`, and a stale caller receives `TEAM_TASK_STALE_REVISION` instead of overwriting a newer value. Numeric `task-<n>` ids require a safe-integer suffix, and id-space exhaustion reports `TEAM_TASK_LIMIT` instead of reusing the final id. Deleted tasks remain tombstones for replay and id stability but do not consume `maxTasks` or appear in `listTasks()`. `writeScopes` are normalized workspace-relative prefixes; views warn on overlap with in-progress tasks but never block claim or authorize writes.

### Waiting and interruption

`waitForChange()` waits for one roster, task, mailbox, or live-status edge that occurs after registration, from ten seconds through one hour, and reports only whether it timed out; runtime disposal releases current waits. Cancellation preserves an Error reason or reports a non-Error reason through `TEAM_WAIT_ABORTED`. `interrupt()` is Lead-only: DSH children use the continuable-subagent path with `keepInbox`, while external teammates use their exact provider/native handle. Neither path releases task ownership nor deletes durable mail.

### Durability model

Team events are appended to the exact live Lead Session and flushed before the operation reports success or wakes waiters. `team/member`, `team/task`, `team/message/queued`, `team/message/delivered`, and `team/native-operation/committed` are log-only: they never enter the conversation surface, so derived model history is untouched by coordination records. Session event `seq` and `time` own ordering and timing; snapshots do not duplicate them. The `./invariant` companion replays each candidate Team event against its committed prefix and rejects invalid transitions before append.

### Disposal

Disposal closes admission, aborts and awaits admitted creation and mailbox-dispatch transactions, then asks the continuation owner to release the roster's exact live direct children and their descendants. Each removed external-provider Fiber closes its own admission immediately, removes its catalog presence, and disposes only that generation's attached runtime and evaluation handles. After the `disposalTimeoutMs` grace period, provider-native cleanup receives an abort signal, but Agent Teams still awaits its actual settlement; the value is not a total shutdown deadline. Other providers and non-Team continuable children remain untouched. Cleanup failures make disposal fail visibly.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the package-level contract is not enough. They move from the shared subsystem types to the tool surface and the decisions behind the design.

- [Agent Teams subsystem](../../../docs/subsystems/agent-team.md) — durable Team types and the `ctx.agentTeams` service API.
- [tool-agent-team package](../tool-agent-team/README.md) — the tools that let the model create, message, and coordinate teammates.
- [Agent Teams Agent Note](../../../.agents/notes/implemented/feature/2026-08-05-agent-teams.md) — identity, mailbox, task, and shared-checkout decisions.
- [Experimental package decision](../../../.agents/notes/implemented/architecture/2026-08-18-experimental-agent-teams-packages.md) — placement, release exclusion, and dependency isolation.

-----

<a id="model-experience"></a>

### Browser Remote

`TeamService` owns the generated `agentTeams/view`, `agentTeams/listMessages`, `agentTeams/getMessage`, `agentTeams/createTask`, and `agentTeams/updateTask` Remote methods beside the roster, mailbox, task, and lifecycle operations. The `./remote` export supplies the Client contribution mounted by the Web UI, while `./client` re-exports browser-safe view, message-query, sanitized-content, and task-mutation types. Message list and detail failures remain ordinary outer `RemoteResult` failures. Create and update rejections remain explicit domain results inside a successful transport response, with stale update revisions distinguished as task conflicts.

## Model Experience

### Peer messages

#### What the model sees

For a DSH teammate, each delivered peer message is a user-role message. A short first text block names its stable message id and sender; the sender's original content blocks follow unchanged. For an external teammate, Agent Teams passes the detached Profile snapshot and initial work to provider `create()`, then passes peer content to provider `deliver()` with stable launch, member, handle, message, and turn correlations. The provider owns how those inputs become native model requests and history; its conversation is not written into a DSH child Session. Roster, task, and mailbox records remain log-only.

#### Token effect

Each DSH peer delivery adds the sender prefix plus message content to the target history. An external provider defines the model calls and token cost of initial work, Profile policy, and deliveries. Task, roster, and route-correlation mutations add no DSH model-history tokens; their model-facing representation belongs to `@deepseek-ai/dsh-experimental-tool-agent-team` results.

#### KV Cache effect

For a DSH teammate, peer messages append after the reusable history prefix, and cold resume reuses the persisted conversation before appending a previously undelivered item. External history and KV-cache behavior are provider-defined; Agent Teams preserves only the stable native handle and delivery identities needed for exact resume and de-duplication.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits describe what a team cannot do yet or what needs special operational care. They are current package constraints, not a comparison with other coordination mechanisms.

- **Experimental prototype with no stability promise** — the package is private, excluded from official releases, and its contracts change freely while it incubates.
- **One process and one shared checkout** — members share cwd and observe edits immediately; this package provides no worktree, remote member, merge, or filesystem lock.
- **Advisory write scopes** — Bash, formatters, code generators, and direct external writers can bypass filesystem version checks; Leads must coordinate ownership and review the final diff.
- **Flat immutable roster** — only the Lead creates direct teammates; there is no nested Team, rename, deletion, or name reuse.
- **No automatic ownership release** — idle, interruption, process exit, and failed work do not release a task owner.
- **Mailbox is not cross-process exactly-once** — concurrent harness processes over one Team are unsupported.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is working context for maintainers and is explicitly non-authoritative.

#### Promotion

Promotion to a product-role group requires reviewing the public contract, limitations, test evidence, release payload, runtime dependents, and a named stable owner, per the [experimental subtree rules](../AGENTS.md).

#### Future directions

Undecided directions include nested Teams, automatic ownership release policies, cross-process mailbox transactions, and filesystem isolation via worktrees; none of these are committed.

</details>
