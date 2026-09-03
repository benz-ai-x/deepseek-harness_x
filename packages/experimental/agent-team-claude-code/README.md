---
description: "Durable Claude Code Agent SDK backend for source-checkout Agent Teams deployments that need stable native Sessions, exact resume, bounded evidence, and fail-closed read-only execution."
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-agent-team-claude-code

English | [中文](README.zh.md)

## Summary

`dsh-experimental-agent-team-claude-code` registers the package-pinned Claude Agent SDK as a durable external-agent Runtime Backend for Agent Teams. One Digital Employee owns one deterministic Claude Code Session id. Duplicate launches converge on that Session, Team messages become later resumed turns, and a new Host process recovers the same native transcript. The adapter is private, experimental, and source-checkout-only. It is not the one-shot `@deepseek-ai/dsh-subagent-claude-code` provider.

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

Mount this Host package in a local source composition that already provides Agent Teams and the subprocess service. It registers no model tool. Agent Teams selects it only when an external teammate launch names its provider id, which defaults to `claude-code`.

```yaml
- id: subprocess-local
  name: '@deepseek-ai/dsh-subprocess-local'
- id: agent-team
  name: '@deepseek-ai/dsh-experimental-agent-team'
- id: agent-team-claude-code
  name: '@deepseek-ai/dsh-experimental-agent-team-claude-code'
  config:
    sandbox: read-only
```

### Eligibility

Registration occurs only when `@anthropic-ai/claude-agent-sdk` is exactly version `0.3.241`, its manifest identifies Claude Code `2.1.241`, and the matching package-local platform payload contains the executable native product. The adapter supports the SDK's declared Linux glibc and musl, macOS, and Windows x64/arm64 payloads. It never resolves `claude` from `PATH`, and an unavailable product reports only a bounded reason without installation paths.

### Configuration

| Field | Default | Meaning |
|---|---|---|
| `providerName` | `claude-code` | Stable Agent Teams Runtime Backend id; mounted instances need distinct ids |
| `cwd` | Host process cwd | Absolute workspace root fixed for every native Session owned by this instance |
| `model` | native Claude default | Optional deployment-pinned model for new and resumed turns |
| `sandbox` | `read-only` | Fixed confinement marker; every other value is rejected |
| `disposeGraceMs` | `3000` | Grace used by exact subprocess-tree termination |
| `maxEvidenceItems` | `512` | Maximum normalized evidence facts retained per attached Session |

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-experimental-agent-team-claude-code) is the exhaustive source for accepted fields and source JSDoc.

### Supported teammate contract

The backend accepts only `fresh` context and non-empty text work. It enforces persona, mission, enabled context blocks, and curated memory in the first native prompt. Runtime metadata advertises only sandbox enforcement, bounded evidence, and usage occurrence. Profile tool policies, Profile Hooks, forked parent context, exact-call approval, and evaluation are not advertised, so Agent Teams rejects those requirements before launch.

Every turn disables filesystem settings, skills, plugins, and ambient MCP servers. The native tool set is fixed to `Read`, `Glob`, and `Grep`; interactive permission, elicitation, and dialog requests are denied. The SDK sandbox fails closed when unavailable, denies writes, denies reads outside the configured workspace, disallows unsandboxed commands, and gives sandboxed commands no network allowlist. A Profile cannot weaken these deployment-owned values.

### Durability and recovery

The adapter derives a UUID Session id from the provider id, launch request id, and reserved Team member id. The first prompt contains a hashed launch marker and the immutable Profile snapshot. A later Host checks the SDK-owned transcript for that marker before attaching the handle. An existing Session without the expected marker is an identity conflict, not a recovery candidate.

Each Team delivery carries a hashed marker derived from its durable message id. A retry scans the native transcript and returns the same deterministic Team turn id without querying Claude again. Delivery admission is serialized per Session before native lookup, so concurrent messages cannot start overlapping Queries. New deliveries use the Agent SDK `resume` option with the original Session id, so conversation history remains native rather than being reconstructed in DSH.

One managed Claude Code process exists per active native turn. The SDK transport remains official; only process creation and termination are projected through `ctx.subprocess`. Caller cancellation remains armed until the SDK publishes the matching Session identity. Runtime interruption closes the exact active Query, aborts its controller, terminates its process tree, and cannot affect another Session.

### Evidence and diagnostics

Evidence contains only fixed-shape turn outcomes, normalized `read`/`glob`/`grep` tool occurrences, permission-denial facts, and usage occurrence. Raw prompts, model output, reasoning, tool arguments, native summaries, credentials, filesystem paths, token totals, login state, stderr, and SDK payloads are never copied into evidence or Team persistence. The oldest fact is discarded at `maxEvidenceItems`.

Errors crossing the provider seam contain a fixed lifecycle stage and typed Agent Teams code. Original SDK and subprocess error text is discarded after classification. Native transcript lookup values are used only for identity verification and are not retained by the adapter.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Config, Session identity, Query lifecycle, recovery, evidence, and Fiber cleanup |
| [`src/process.ts`](src/process.ts) | Projection from official SDK spawn requests to the shared subprocess owner |
| [`src/product.ts`](src/product.ts) | Exact SDK/native-version qualification and package-local executable resolution |
| [`tests/agent-team-claude-code.spec.ts`](tests/agent-team-claude-code.spec.ts) | Deterministic SDK fake covering identity, turns, recovery, policy, evidence, and cleanup |
| [`tests/real-product.canary.spec.ts`](tests/real-product.canary.spec.ts) | Opt-in real Agent SDK start/restart/resume canary |

### Ownership

Claude Code owns its Session transcript. Agent Teams owns roster and mailbox durability. This adapter retains only attached Session handles, delivery correlations, presence, and bounded normalized evidence in memory. It does not create a second transcript store.

Provider registration belongs to the package Fiber. Disposal closes admission, interrupts active Queries, waits for every managed process tree, clears in-memory indexes, emits inactive presence, and removes the registration. It intentionally does not delete the SDK-owned Session, because Host restart must be able to resume it. Explicit Team runtime removal detaches the same resources.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Agent Teams package](../agent-team/README.md) — durable roster, mailbox, Runtime Backend seam, and capability validation.
- [Agent Teams subsystem](../../../docs/subsystems/agent-team.md) — Host service types and ownership boundaries.
- [One-shot Claude Code provider](../../subagent/subagent-claude-code/README.md) — the intentionally non-durable sibling integration.
- [Generated configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-experimental-agent-team-claude-code) — exhaustive fields generated from source JSDoc.

-----

<a id="model-experience"></a>
## Model Experience

### Native Digital Employee

#### What the model sees

The first native turn receives the Digital Employee persona, mission, enabled context, curated memory, and initial text work. Later accepted Team messages become user turns in the same Claude Code Session. The model can use only `Read`, `Glob`, and `Grep` inside the deployment workspace and receives no interactive approval channel.

#### Token effect

Claude Code owns native token accounting. The adapter records only that usage occurred and does not copy counts or native content into the Team log.

#### KV Cache effect

Turns resume the same native Session, so cache behavior belongs to Claude Code and the selected model. Host restart verifies and reattaches the Session instead of replaying its content through DSH.

### Lead and Team surfaces

#### What the model sees

The Lead sees ordinary Agent Teams roster status and mailbox acceptance. This package does not bridge Claude answers, reasoning, tool payloads, stderr, or transcript content into a DSH Session. Evidence queries expose only the bounded facts described above.

#### Token effect

The backend adds no model-facing tool schema and no native transcript to DSH context. Only the surrounding Agent Teams tools and messages affect Lead tokens.

#### KV Cache effect

Agent Teams appends roster and mailbox correlations without rewriting the Lead's earlier conversation prefix. Native Claude cache state remains separate.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Private experimental source package** — it is excluded from official releases and carries no compatibility promise.
- **One pinned product baseline** — only Agent SDK `0.3.241` with Claude Code `2.1.241` is eligible.
- **Fresh context only** — parent Session fork is unsupported.
- **Partial Profile surface** — tool policy and Hooks are rejected; persona, mission, context, and memory are supported.
- **No exact-call approval or evaluation** — those capabilities remain separate roadmap work.
- **Fixed read-only authority** — there is no workspace-write or network-enabled mode.
- **No answer bridge** — native responses remain in Claude Code; Team surfaces expose state and scrubbed evidence.
- **Transcript scan for retry repair** — delivery replay checks the SDK-owned transcript and is bounded by the native SDK's read operation rather than a DSH-side delivery journal.
- **Real canary uses configured Claude access** — enabling it can consume model quota and requires a working native login; it is skipped by default.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Maintainer verification — click to expand</summary>

Run deterministic correctness tests normally. Enable the separately gated product canary only with an account intended for test usage:

```sh
pnpm exec vitest run packages/experimental/agent-team-claude-code/tests/agent-team-claude-code.spec.ts
DSH_CLAUDE_AGENT_SDK_CANARY=1 pnpm exec vitest run packages/experimental/agent-team-claude-code/tests/real-product.canary.spec.ts
```

The canary creates one real native Session, disposes the Host, resumes the same handle in another Host, runs a second turn, and deletes that exact test Session afterward. Deterministic SDK fakes remain the branch-complete correctness gate.

</details>

**Runtime invariant:** No runtime invariant companion is published; provider registration and every active Query/process tree are owned and removed by the same Fiber lifecycle.
