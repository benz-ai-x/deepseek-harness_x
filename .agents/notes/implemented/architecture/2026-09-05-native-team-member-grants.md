# Agent Note: Authorize native Team members with revocable Host grants

Status: implemented

English | [中文](2026-09-05-native-team-member-grants.zh.md)

## Problem

Provider-native teammates have durable Team identities but no live DSH Agent object. Passing a Lead Agent to a native tool would give the tool the Lead's authority; accepting model-supplied member or native handle strings would let the model select its own identity. Provider replacement and Lead recovery also make an otherwise correct authorization stale.

## Decision

The Team owner issues a nonserializable [NativeMemberGrant](../../../../docs/subsystems/agent-team.md#native-member-authorization) after the roster accepts the native handle. The grant captures the exact live Lead, immutable member/provider/handle correlation, and current provider registration. Verified recovery issues current authority; ordinary DSH entry points still require exact live Agent objects. Isolated evaluations never receive a production grant.

The provider receives the grant through `bindMemberOperations`. The registry admits only the generation attached to the accepted handle. Registration retirement, handle disposal, inactive native presence, and the Lead's `agent/disposed` event abort its signal before further queries can return data. A later presence report cannot revive the old grant; verified recovery must bind a new grant. A throwing provider binder revokes its grant and quarantines that generation while retaining already accepted Team facts.

Read operations use the existing roster and task board. Strict JSON schemas reject authority fields and unsupported operations; complete requests and results have byte bounds, and task lists have bounded pages. The [package contract](../../../../packages/experimental/agent-team/README.md#teammates) owns limits and cursor semantics. Queries add no durable Team facts; [native mutations](2026-09-06-durable-native-team-operations.md) use the authoritative mailbox and durable operation receipts.

## Alternatives considered

**Execute as the Lead.** This bypasses member authorization and makes later member mutations unsafe. The grant derives a teammate membership while keeping the existing Lead-only APIs closed.

**Authenticate model-provided identities.** A string handle or role cannot establish current in-process ownership. The Host binds authority to the exact registration and runtime attachment instead.

**Store a parallel native Team state.** A copied roster or task board would diverge after recovery and compare-and-set mutations. Native queries read the same authoritative Team state as DSH callers.

## Consequences

Adapters must bind the current grant to their exact native connection and enforce their own protocol correlation, cancellation, and complete tool-response limits. Advertising operations requires a binder; the metadata describes only operations the adapter actually implements. Filesystem, approval, and network policies remain adapter responsibilities and are not broadened by a grant.

The [public grant tests](../../../../packages/experimental/agent-team/tests/native-member-operations.spec.ts) exercise current Team reads, pagination, bounds, cancellation, identity rejection, retirement before cleanup, Lead recovery, and evaluation separation with real Team persistence. The [recorded headless scenario](../../../../snapshots/session/agent-team-profile/snapshot.yml) retains native member-query requests, complete canonical results and subsequent model context through the shipped profile. The [Loader scenario](../../../../packages/experimental/agent-team/tests/native-member-loader.e2e.ts) also verifies revocation. Authenticated native product execution belongs to the consuming adapter's acceptance tests.
