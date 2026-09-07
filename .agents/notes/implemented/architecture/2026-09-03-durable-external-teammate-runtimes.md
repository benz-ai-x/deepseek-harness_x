# Agent Note: Durable external teammate runtimes

Status: implemented

English | [中文](2026-09-03-durable-external-teammate-runtimes.zh.md)

## Problem

The [original Agent Teams decision](../feature/2026-08-05-agent-teams.md) made every teammate a continuable DSH child Session. That preserves DSH conversation and Activation semantics, but it cannot represent an external agent system that owns a durable native session, policy enforcement, evidence, or evaluation lifecycle. Routing such work through a one-shot subagent would lose exact identity across turns and restarts.

Agent Teams must keep its Lead log authoritative for membership, mailbox order, and task ownership without persisting provider processes, credentials, prompts beyond the existing Team events, or provider-native state. It must also distinguish temporary provider absence from member failure and settle every accepted native resource when a provider Fiber or the Team service is removed.

## Decision

One roster member selects exactly one typed runtime branch. The existing DSH branch remains a continuable direct child. The external branch stores a detached `externalRuntime` correlation containing a caller-minted launch id, a canonical request fingerprint, exact requirements, and—only after native acceptance—the provider's opaque runtime handle. Launch ids and native handles are non-empty strings of at most 200 UTF-8 bytes; they have no lexical identifier grammar, so provider values such as paths or Unicode remain byte-for-byte opaque.

Hosts register external implementations through `ctx.agentTeams.registerTeammateRuntimeProvider()` on the owning Fiber. A registration publishes detached identity and capability metadata plus create, resume, deliver, interrupt, evidence, evaluation, presence, and dispose operations. Agent Teams validates the requested context, Profile-policy, and operational capabilities before reserving a roster name or sending work. Exact-call approval can be advertised only together with Hook enforcement and normalized evidence; an ask Hook has one stable Profile policy id, and approval evidence must preserve that policy plus the same immutable native call and approval identities. The complete normalized Profile crosses the Host-only seam, while provider credentials, process objects, native state, and evidence payloads never enter the Team log.

Operational capability labels remain orthogonal. `full-collaboration` attests the complete durable Team participation contract and is rejected unless the provider advertises and binds all six bounded native member operations; required create, resume, delivery, interruption, disposal, and terminal-result paths provide the remaining lifecycle. `workspace-write` independently attests that the runtime can mutate its assigned workspace, but never grants permission or overrides the effective sandbox and Profile tool policy. This lets a read-only runtime truthfully provide full collaboration without claiming write access.

Creation records and flushes the provisioning correlation before invoking the selected provider. The provider must durably accept the initial work and return one stable native handle before Agent Teams records the active member. Repeating the same launch/member identity must return that handle; reusing a handle for another identity or changing it on resume quarantines the provider generation. The registry validates returned durable handles, and a rejected result remains cleanup-owned so even an invalid accepted handle is disposed exactly.

External mailbox delivery uses the durable Team message id and exact provider/native handle. It has no `quiet`/`wakeup` selector: like every current Agent Teams message, it follows the single Steer contract and the provider durably admits it as the next native turn while preserving target-local order. The provider returns a stable native turn id before the Team records delivery. Runtime delivery, interrupt, presence, evidence, and disposal route only through the exact recorded native handle; there is no fallback to a DSH or one-shot provider. The four Team event payloads remain version 2; external correlation extends that current pre-release shape, while strict replay rejects version 1. Evidence may include normalized approval facts and a complete current pending set, but never proposed arguments; a non-empty pending set is valid only while the exact runtime reports `running`, and an unmatched ask is never inferred to remain pending after restart. Isolated evaluation is a separate Lead-owned operation: it requires fresh context, a detached Profile, a read-only sandbox, no approvals, bounded resources, and a unique allowlist contained by a provider-published tool inventory. The provider runs the caller-owned evaluation id and declared input to a normalized outcome on a distinct native handle. Agent Teams invokes the caller's optional durable commit while that exact handle remains attached, then disposes it in `finally` before the public operation settles. The evaluation never creates a roster identity, production workspace, transcript, or activation. The reusable provider conformance suite fixes idempotent creation and delivery, caller cancellation, restart resume, evidence, evaluation, exact interruption, and exact disposal behavior for implementations.

Provider registration is Fiber-scoped. Removal closes new admission, aborts admitted work, waits for operations to settle, stops presence observation, and disposes every attached runtime and evaluation handle before the registration is gone. Cleanup uses an abort deadline to request cancellation but still waits for actual quiescence; a timeout is not reported as successful disposal. Other provider ids remain available. A persisted member whose provider is absent stays active but derives unavailable/inactive runtime state. Re-registering the same provider id resumes the recorded native handle and queued mailbox work without creating a replacement.

The public testkit, TypeScript SDK notification snapshot, Python single-file runtime snapshot, and real headless Agent Teams profile composition project the same `team/member.externalRuntime` shape. These surfaces expose only the durable correlation and never provider secrets.

## Alternatives considered

**Model external agents as continuable DSH children.** Rejected because DSH would appear to own a conversation and Activation that actually belong to another runtime, and could not preserve that runtime's exact native identity.

**Use one-shot subagent providers for each turn.** Rejected because separate runs cannot provide stable native identity, idempotent mailbox delivery, exact interruption, or cold resume.

**Persist provider state or credentials in Team events.** Rejected because the Lead log owns portable coordination facts, not provider implementation state or secrets. Only bounded detached correlations are durable.

**Fail or replace members when a provider disappears.** Rejected because registration is process-local availability, while the member and native session may remain durable. Reattachment must use the same provider id and exact handle.

**Treat an abort deadline as completed cleanup.** Rejected because returning while provider work or disposal remains unsettled would violate Fiber removal and could leak an accepted native runtime.

**Trust an exact-call capability flag without native correlation evidence.** Rejected because a label alone cannot prove that approval covered the proposed call or that a waiting state is still live; missing or malformed correlations must fail closed and quarantine that provider generation.

**Evaluate through an active production teammate.** Rejected because the candidate run could inherit production conversation or workspace state, mutate operational resources, and make it impossible to prove which isolated native execution produced the committed result.

## Consequences

The Agent Teams package now owns a typed provider registry in addition to its DSH continuation integration. Provider authors must implement the full durable contract and prove it with the conformance suite. An active external member may be unavailable and inactive until its provider is registered again, and recovery latency belongs to that provider.

The Lead log remains inspectable and secret-free, but it cannot reconstruct native state independently. Recovery therefore depends on a provider that can resolve the persisted launch/member/handle tuple exactly. Malformed approval or pending correlations quarantine the provider generation; pending approval state is process-live evidence rather than a resumable fact. Quarantining a contract-violating generation can temporarily make every member on that provider unavailable until cleanup and explicit replacement finish.

Each evaluation consumes a fresh provider-native execution resource, and providers must publish a bounded inventory of tools they can confine. Callers that need durable evidence must write it inside the commit callback; a callback failure fails the operation but still cannot leak the evaluation handle. The API does not make evaluation output durable and does not couple evaluation success to activation.

## Testing

Package tests cover capability preflight, rejection of incomplete full-collaboration claims, detached Profile transfer, exact-call approval capability gating, approval and pending correlation, opaque UTF-8 identities, request and handle conflicts, two turns around a cold Host restart, provider disappearance and exact reattachment, queued delivery, presence, evidence, fresh-context evaluation confinement, bounded tool inventories, commit-before-dispose ordering, cancellation ownership transfer, quarantine, same-id replacement, and quiescent cleanup. The provider conformance suite repeats the portable contract against a reopenable durable fixture. Headless composition and both SDK projections pin the public event shape and verify that `externalRuntime` contains only bounded durable correlation data.
