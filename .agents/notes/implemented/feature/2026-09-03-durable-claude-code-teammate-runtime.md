# Agent Note: Durable Claude Code teammate runtime

Status: implemented

English | [中文](2026-09-03-durable-claude-code-teammate-runtime.zh.md)

## Problem

The [durable external teammate runtime](../architecture/2026-09-03-durable-external-teammate-runtimes.md) preserves provider-native identity across turns and Host restarts, but the existing [Claude Code subagent backend](2026-08-04-claude-code-and-codex-subagent-backends.md) is intentionally one-shot. Repeating that provider for a Digital Employee would create unrelated Sessions, lose native conversational state, and make launch and mailbox retry ambiguous.

Eligibility must prove one exact official SDK/native pair rather than the presence of a `claude` command. Deployment confinement must remain stronger than Profile requests. Recovery, evidence, diagnostics, and browser-visible Team values must not copy native prompts, model output, tool payloads, credentials, paths, login state, or transcript content into DSH. Cancellation and Fiber disposal must still quiesce the exact managed process tree.

## Decision

`@deepseek-ai/dsh-experimental-agent-team-claude-code` is a private Host plugin implementing the durable teammate provider contract through `@anthropic-ai/claude-agent-sdk@0.3.241` and its Claude Code `2.1.241` platform payload. Registration fails closed unless the exact SDK manifest, native version, supported platform package, file, and POSIX executable bit qualify. The adapter resolves only the package-local executable and never falls back to `PATH` or the one-shot provider.

The provider derives a valid UUID Session id from provider, launch request, and reserved member identity. It supplies that id through the SDK `sessionId` option for the first turn and through `resume` for every later turn. The first prompt contains a SHA-256 launch marker plus persona, mission, enabled context, curated memory, and initial work. Host replay uses `getSessionInfo` and `getSessionMessages` to require the same Session and marker before attachment. An occupied id without that marker is an identity conflict.

Each Team message receives a SHA-256 marker derived from the stable message id and a deterministic Team turn id. Retry finds the marker in the SDK-owned transcript and returns the same turn without another native query. Delivery admission is serialized per Session before native lookup, and each delivery waits for the exact preceding turn. One official SDK Query and one `ctx.subprocess`-owned process tree exist per active turn; idle Sessions retain native transcript state but no child process.

The backend supports only fresh context, non-empty text work, persona, mission, context, and memory. It does not advertise Profile tool policy, Hooks, exact-call approval, or evaluation. Every Query disables filesystem settings, skills, plugins, and ambient MCP servers; fixes the tools to `Read`, `Glob`, and `Grep`; denies interactive permission and elicitation paths; and applies a fail-closed read-only sandbox with no unsandboxed command or network allowlist. Configuration exposes no weaker mode.

The provider retains only bounded normalized turn outcomes, read/glob/grep occurrences, permission-denial facts, and usage occurrence. Native ids are replaced by deterministic evidence ids. Product and process failures cross the seam only as a fixed lifecycle stage and typed Team runtime code; original error text is discarded after classification. Transcript values are inspected for markers and discarded.

An interrupt aborts and closes only the exact active Query and terminates its managed process tree. A failed accepted turn returns the Session to idle so a later `resume` can repair from native persistence; a failure before acceptance removes the unpublished attachment. Runtime and provider disposal share active-turn settlement, clear local indexes and evidence, emit inactive presence, and leave the SDK-owned Session available for Host restart. Cordis owns registration removal on the same Fiber.

## Alternatives considered

**Reuse the one-shot Claude Code subagent.** Rejected because it disables persistence and exposes no stable Session resume contract.

**Let the SDK generate Session ids.** Rejected because a Host crash between native acceptance and Team publication would leave no deterministic identity for an idempotent launch retry.

**Persist prompts, responses, or a second transcript in DSH.** Rejected because Claude Code already owns the native transcript and copying it would create competing history authority plus a sensitive-data surface.

**Load user/project settings or Profile-selected tools.** Rejected because settings, plugins, MCP servers, and prompt-level policy could broaden authority or make two equal launches execute differently. Unsupported capability requests fail before Query creation.

**Advertise approval or evaluation through prompt conventions.** Rejected because text cannot enforce exact-call decisions or isolated evaluation lifecycle. Those capabilities remain explicit follow-up work.

**Keep one long-lived streaming Query.** Rejected because the durable identity belongs to the persisted Session, while a process-per-turn design gives exact subprocess ownership, bounded idle resource use, and straightforward crash repair through the official resume API.

## Consequences

Agent Teams can host a Claude Code Digital Employee whose native identity and conversation survive Host restart without storing a native transcript in DSH. Stable launch and delivery markers prevent duplicate native work, exact handles contain interruption, and fixed policy prevents Profile authority escalation. Idle employees own no process.

The backend is private, source-checkout-only, and coupled to one SDK/native baseline. Upgrades require requalifying manifests, platform payloads, Session APIs, Query options, sandbox semantics, and the real-product canary. It offers only fresh context and fixed read-only tools; it exposes neither an answer bridge nor exact-call approval or evaluation. Native account setup remains Claude Code's responsibility.

## Testing

Deterministic SDK fakes cover exact product qualification, UUID identity, launch and delivery replay, concurrent delivery serialization, failed-admission retry, multi-turn resume, Host restart, collision rejection, capability checks before spawn, fixed Query policy, environment scrubbing, marker traversal bounds, evidence normalization and paging, cancellation, exact-handle interruption, pre-attachment close, process and teardown failures, concurrent disposal, registration removal, and four-axis per-file 100% coverage. A production-Loader test verifies source and built-library registration plus Fiber removal with an empty `PATH`. The opt-in real-product canary creates a Session with configured Claude access, disposes the Host, resumes the same handle in another Host, runs a second turn, and deletes that exact canary Session.
