---
description: "Durable Codex App Server backend for source-checkout Agent Teams deployments that need persistent native threads, exact resume, bounded evidence, and fail-closed local execution."
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-agent-team-codex

English | [中文](README.zh.md)

## Summary

`dsh-experimental-agent-team-codex` registers an eligible local Codex installation as a durable external-agent Runtime Backend for Agent Teams. One Digital Employee owns one non-ephemeral Codex thread and a stable opaque native handle. Duplicate launches converge on that thread, Team messages become later turns, and a new Host process resumes the exact handle through Codex App Server's `thread/resume` protocol. The adapter is private, experimental, and source-checkout-only. It is distinct from `@deepseek-ai/dsh-subagent-codex`: the one-shot provider creates ephemeral runs and is never substituted for this durable backend.

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

Mount this package in a local source composition that already provides Agent Teams and the subprocess service. The adapter registers no model tool. Agent Teams selects it only when an external teammate launch names its provider id, which defaults to `codex`.

### When to choose it

Choose this backend when one Codex employee must retain its native conversation and identity across several Team messages or Host restarts. Choose `@deepseek-ai/dsh-subagent-codex` when each delegation is an independent task that returns one final answer. Avoid this backend when the Profile requires forked parent context, tool allowlists, Hooks, per-call approval, evaluation, network access, or a mirrored native transcript.

```yaml
- id: subprocess-local
  name: '@deepseek-ai/dsh-subprocess-local'
- id: agent-team
  name: '@deepseek-ai/dsh-experimental-agent-team'
- id: agent-team-codex
  name: '@deepseek-ai/dsh-experimental-agent-team-codex'
  config:
    sandbox: read-only
```

### Eligibility

Registration occurs only when the package-pinned `@openai/codex` wrapper is exactly version `0.149.1` and its matching platform payload contains an executable native product. An unsupported platform, mismatched wrapper, or missing payload leaves the backend unavailable and emits only a bounded reason. The probe never publishes installation paths. Installing the one-shot Codex subagent provider does not make this Runtime Backend eligible.

### Configuration

| Field | Default | Meaning |
|---|---|---|
| `providerName` | `codex` | Stable Agent Teams Runtime Backend id; mounted instances need distinct ids |
| `cwd` | Host process cwd | Workspace path resolved to absolute and shared by every native thread owned by this instance |
| `model` | native Codex setting | Optional fixed model override sent on thread start and resume |
| `env` | `{}` | Explicit child environment passed through the subprocess seam |
| `sandbox` | `read-only` | Deployment-owned confinement: `read-only` or `workspace-write` |
| `disposeGraceMs` | `3000` | Grace used by exact subprocess-tree termination |
| `maxEvidenceItems` | `512` | Maximum normalized evidence facts retained per attached thread |

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-experimental-agent-team-codex) is the exhaustive source for every accepted field and its source JSDoc.

Both sandbox modes force `networkAccess: false` and `approvalPolicy: never`. The adapter verifies the effective policy returned by Codex and fails before publishing a runtime if Codex reports broader authority. A teammate Profile cannot weaken the deployment setting.

### Supported teammate contract

The backend accepts only `fresh` initial context and non-empty text work. It truthfully advertises Profile support for persona, mission, enabled context blocks, and curated memory blocks. It advertises runtime support for sandbox enforcement, normalized evidence, usage occurrence, and exact interruption.

Tool-policy enforcement, Profile Hooks, forked parent context, exact-call approval, and evaluation handles are not advertised. Agent Teams therefore rejects a launch requiring any of them before Codex starts. Native approval, permission, user-input, and elicitation requests are denied without human interaction; unknown requests fail the protocol closed.

### Durability and recovery

Creation first uses a deterministic launch/member idempotency key to acquire a Codex project, then finds or creates one non-ephemeral native thread. The Codex-generated thread id is the teammate's opaque handle. A repeated launch recovers the recorded initial client id instead of submitting the initial turn again. Stable Team message ids similarly recover their native turn ids.

Normal Host shutdown terminates the owned App Server process tree but does not delete Codex's persisted thread. When Agent Teams replays the member, this adapter starts a new App Server and resumes that exact thread id. A process or protocol-stream failure marks the member inactive, retires the failed process, and preserves only the correlation needed for the next exact-handle repair. A missing or conflicting native identity fails rather than creating a substitute.

### Evidence and diagnostics

Evidence contains only fixed-shape turn, tool-kind, and usage-occurrence facts. Native ids are converted to deterministic evidence ids; raw prompts, tool arguments, command text, output, credentials, filesystem paths, login state, token counts, and protocol payloads are not retained. The oldest fact is discarded at `maxEvidenceItems`. Errors crossing the provider seam contain a fixed lifecycle stage and typed Agent Teams code, while native error content remains Host-local.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Config, minimal App Server connection, durable provider, evidence, recovery, and Fiber cleanup |
| [`src/product.ts`](src/product.ts) | Exact wrapper/platform qualification and package-local executable resolution |
| [`tests/agent-team-codex.spec.ts`](tests/agent-team-codex.spec.ts) | Deterministic protocol fake covering identity, policy, turns, repair, evidence, and cleanup |
| [`tests/real-product.canary.spec.ts`](tests/real-product.canary.spec.ts) | Opt-in real App Server start/restart/resume canary against a local Responses fixture |

### Protocol and identity

Each attached native thread owns one Fiber-bounded App Server subprocess and one JSON-RPC line transport. Initialization explicitly enables the experimental API. `project/create` receives a SHA-256 idempotency key derived from provider, launch, and member identity; later thread operations always use the opaque project id returned by Codex. Thread start requires `ephemeral: false`. Resume validates thread, project, persistence, approval, sandbox type, and disabled network before attaching the session.

The connection admits one native turn at a time. Early terminal notifications are held until `turn/start` supplies the authoritative turn id, and mismatched thread or turn notifications cannot settle another employee's work. Team mailbox dispatch already serializes immediate deliveries per target; an overlapping direct provider call fails closed at the connection guard.

### Lifecycle

Provider registration and every attached process belong to the package Fiber. Disposal closes admission, interrupts an active exact turn, closes transport streams, terminates the process tree through `ctx.subprocess`, waits for exit, clears evidence and delivery indexes, and removes the registration. Concurrent disposal shares one settlement. Cleanup failures are aggregated and remain visible instead of being discarded.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Agent Teams package](../agent-team/README.md) — durable roster, mailbox, Runtime Backend seam, and capability validation.
- [Agent Teams subsystem](../../../docs/subsystems/agent-team.md) — Host service types and ownership boundaries.
- [One-shot Codex provider](../../subagent/subagent-codex/README.md) — the intentionally ephemeral sibling backend.
- [Generated configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-experimental-agent-team-codex) — exhaustive fields generated from source JSDoc.

-----

<a id="model-experience"></a>
## Model Experience

### Native Digital Employee

#### What the model sees

The first Codex turn receives persona, mission, enabled context, and curated memory through the native `developerInstructions` field, plus the launch's text work. Later accepted Team messages become text turns on the same native thread. The model sees the configured workspace and native Codex settings within the fixed deployment sandbox; it receives no interactive approval channel and no network access from this adapter.

#### Token effect

Codex owns the native thread's token accounting. The adapter exposes only that a usage update occurred; it does not copy token counts or native prompts into the Team log.

#### KV Cache effect

Turns append to the same persistent Codex thread, so native cache behavior is controlled by Codex and the selected model. Host restart resumes the thread instead of reconstructing its transcript in DSH.

### Lead and Team surfaces

#### What the model sees

The Lead sees the teammate's durable roster status and accepted or queued mailbox results. This package does not copy Codex answers, reasoning, commentary, tool payloads, stderr, or workspace diffs into a DSH Session. Evidence queries expose only the bounded normalized facts described above.

#### Token effect

This backend adds no tool schema and no native transcript to DSH model context. Only the ordinary Agent Teams tool results and messages chosen by the surrounding composition affect the Lead's tokens.

#### KV Cache effect

Agent Teams records append-only roster and mailbox correlations without rewriting the Lead's earlier conversation prefix. Native Codex cache state remains separate.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Private experimental source package** — it is excluded from official releases and carries no compatibility promise.
- **One pinned product baseline** — only `@openai/codex@0.149.1` and its exact matching native payload are eligible.
- **Fresh context only** — parent-session forking is unsupported.
- **Partial Profile surface** — tool policies and Hooks are rejected; only persona, mission, context, and memory are enforced.
- **No exact-call approval or evaluation** — the adapter is unattended, denies native interaction requests, and publishes no evaluation handle.
- **No network-enabled sandbox** — only read-only or workspace-write filesystem authority is selectable, both with native network access disabled.
- **No answer bridge** — native answers and reasoning stay in Codex; the shared Team surface exposes status, messaging acceptance, and scrubbed evidence rather than a transcript.
- **Process-local ownership** — each provider generation owns local App Server processes; cross-process concurrent ownership of one Team is unsupported.
- **Coarse evidence** — usage evidence records occurrence, not token totals, and tool evidence records only normalized kind and outcome.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Maintainer verification — click to expand</summary>

Run deterministic correctness tests normally. Enable the separately gated real-product canary only when validating the package-pinned App Server:

```sh
pnpm exec vitest run packages/experimental/agent-team-codex/tests/agent-team-codex.spec.ts
DSH_CODEX_APP_SERVER_CANARY=1 pnpm exec vitest run packages/experimental/agent-team-codex/tests/real-product.canary.spec.ts
```

The canary uses a local loopback Responses fixture, creates a real persistent thread, disposes the entire Host, resumes the same opaque handle in a new Host, and runs a second turn. It is protocol evidence, not the deterministic correctness gate.

</details>

**Runtime invariant:** No runtime invariant companion is published; provider registration, native connections, and subprocess trees are owned and removed by the same Fiber lifecycle.
