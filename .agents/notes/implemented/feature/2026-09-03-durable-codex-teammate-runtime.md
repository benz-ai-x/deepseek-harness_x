# Agent Note: Durable Codex teammate runtime

Status: implemented

English | [中文](2026-09-03-durable-codex-teammate-runtime.zh.md)

## Problem

The [durable external teammate runtime](../architecture/2026-09-03-durable-external-teammate-runtimes.md) lets Agent Teams preserve a provider-native identity across turns and Host restarts, but it does not make a one-shot product integration durable. The existing [Codex subagent backend](2026-08-04-claude-code-and-codex-subagent-backends.md) deliberately creates an ephemeral thread and process for one self-contained result. Reusing it for a Digital Employee would discard native history, manufacture a new identity for each mailbox item, and make exact resume and interruption impossible.

A Codex implementation must also distinguish an eligible native App Server from an installed package name, keep deployment sandbox authority stronger than Profile requests, and expose useful runtime state without writing native prompts, credentials, paths, login state, or protocol payloads into the Team log or browser values. Process failure and plugin removal must leave no attached process while preserving only the durable correlation needed for exact recovery.

## Decision

`@deepseek-ai/dsh-experimental-agent-team-codex` is a private Host plugin and the first product implementation of the durable teammate provider contract. It registers only when the package-local `@openai/codex` wrapper and matching executable platform payload are exactly version `0.149.1`. It never resolves a host `codex` from `PATH`, never treats the one-shot provider as a fallback, and reports ineligibility without an installation path.

Each attached employee owns one package-local `codex app-server --stdio` process and one non-ephemeral native thread. Initialization enables App Server's experimental API. The adapter derives a SHA-256 idempotency key from provider, launch, and reserved member identity, sends it through `project/create`, and uses the opaque project id returned by Codex for thread discovery, start, and resume. The Codex-generated thread id is the stable teammate runtime handle; the adapter rejects a changed thread, project, persistence mode, or effective policy rather than accepting a replacement.

The provider supports only fresh context. It enforces persona, mission, enabled context blocks, and curated memory as native developer instructions, and accepts only non-empty text work. It does not advertise Profile tool-policy or Hook enforcement, exact-call approval, or evaluation. Agent Teams rejects launches requiring those capabilities before the process starts. Deployment configuration fixes either `read-only` or `workspace-write`; both force native `approvalPolicy: never` and `networkAccess: false`. The adapter validates Codex's effective response and rejects broader authority. Native approval, permission, user-input, and elicitation requests receive unattended denials, while unknown requests fail the connection.

Launch and mailbox idempotency use caller-owned ids as native client message ids. A repeated launch finds the recorded initial id and does not submit another initial turn. A repeated Team delivery returns its recorded native turn id. The connection admits one turn at a time, correlates notifications to the exact thread and turn, retains an early terminal until `turn/start` establishes its id, and rejects identity mismatch. Team mailbox serialization supplies ordered delivery; overlapping direct provider admission fails closed.

The provider retains a bounded in-memory evidence window containing only normalized turn outcome, tool kind and outcome, and usage occurrence. Deterministic evidence ids replace native ids. Prompts, message text, tool arguments and output, commands, paths, credentials, login state, token totals, stderr, and raw protocol values never enter evidence or Team persistence. Failures crossing the provider contract contain a fixed lifecycle stage and typed Team runtime code; native causes remain internal.

An App Server exit removes the live attachment and emits inactive presence while retaining the launch-to-handle correlation. The next delivery or Host replay starts a new App Server and calls `thread/resume` for that exact handle. A protocol-stream failure also terminates the failed process before permitting repair. Normal runtime disposal removes the correlation. Provider Fiber disposal closes admission, interrupts the exact active turn, closes the transport, terminates and awaits every owned process tree, clears evidence and delivery indexes, and removes registration. Concurrent disposal shares one settlement, and independent cleanup failures remain visible as an aggregate.

## Alternatives considered

**Invoke the one-shot Codex provider for every turn.** Rejected because ephemeral runs cannot preserve native conversation identity, de-duplicate mailbox turns, resume after Host restart, or interrupt the exact current turn.

**Resolve any installed `codex` executable.** Rejected because a package name or host binary does not prove the pinned App Server protocol or matching native payload. Exact package qualification makes eligibility deterministic and keeps the runtime closure local.

**Persist native transcripts or protocol payloads for recovery.** Rejected because Codex owns its thread state and the Team log owns coordination. Copying product state would create a second history owner and expose sensitive native values; recovery uses the opaque handle instead.

**Allow Profile requests or native prompts to broaden sandbox authority.** Rejected because confinement belongs to deployment configuration. Unsupported Profile policy fails before launch, and an effective native-policy mismatch fails before attachment.

**Advertise capabilities by emulating them in prompts.** Rejected because prompt text cannot enforce tool allowlists, Hooks, exact approval, or isolated evaluation lifecycle. Capability metadata includes only behavior the adapter verifies.

**Use the real product canary as the correctness suite.** Rejected because product execution is slower and less exhaustive than a deterministic protocol peer. The canary proves compatibility with the pinned distribution; the fake owns branch-complete lifecycle and failure semantics.

## Consequences

Agent Teams can host a Codex-backed Digital Employee whose native identity and conversation survive Host restarts without storing the native transcript in DSH. Stable launch and delivery ids prevent duplicate native work, and exact-handle routing prevents silent replacement. Deployment retains sandbox authority, and the browser-visible Team state remains bounded and free of native secrets.

The backend is private, source-checkout-only, and coupled to one Codex protocol baseline. Upgrading Codex requires requalifying its wrapper and platform payload, protocol fields, effective policy response, restart behavior, and real-product canary. The strict unattended policy provides no human approval or network-enabled mode. Codex answers and reasoning stay in the native thread; Team consumers receive presence, mailbox acceptance, and coarse scrubbed evidence rather than a mirrored transcript.

## Testing

The package's deterministic App Server peer covers eligibility, capability rejection before spawn, non-ephemeral creation, project and thread identity, launch and delivery replay, multiple turns, early and mismatched notifications, denied server requests, sandbox validation, bounded evidence, interruption, crash and protocol repair, cancellation, concurrent cleanup, cleanup failure, registration removal, and four-axis per-file coverage. The package's production-Loader composition verifies registration, exact capability metadata, and Fiber removal without starting Codex in both source and built-library modes. Built-library mode keeps workspace paths disabled; only a relative TypeScript test driver falls back to the package-owned tsx hook when the Node binary omits native type stripping. The opt-in real-product canary starts the pinned App Server against a loopback Responses fixture, creates one thread, disposes the complete Host, resumes the same opaque handle in another Host, and completes a second turn. The Ultra source profile verifies the private dependency closure.
