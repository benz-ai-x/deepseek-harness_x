# Agent Note: Persist native task changes with their original acceptance

Status: implemented

English | [中文](2026-09-06-native-task-operation-receipts.zh.md)

## Problem

A native task call can commit before its response reaches the native process. Retrying against the resulting task revision must recover the original acceptance without executing another transition. Native members also need the same ownership and dependency rules as DSH members without receiving a fabricated Agent or Lead authority.

## Decision

The [task board](../../../../packages/experimental/agent-team/src/task-board.ts) serializes native task writes in the existing Lead journal. Current grant and cancellation checks run again in the write queue. Receipt lookup precedes expectedRevision comparison: matching input returns the original acceptance after flush, and changed input conflicts. The [shared task rules](../../../../packages/experimental/agent-team/src/task-state.ts) govern both exact live-Agent calls and granted native member calls, including Lead-only reassignment, ownership, DAG validation and tombstones.

One required payload-4 task event stores the changed task and its receipt together. The receipt retains the validated request and a compact result containing task id, revision, status, owner name and readiness. Task text and dependency lists remain available through task reads; excluding them from mutation responses bounds escaped native text envelopes even when a task has a large description. Projection version 5 checks member identity, canonical call/input digests, the authorized transition and the original result before changing state. Explicit payload-3 message and payload-2 readers retain existing history; Session format 0 remains unchanged.

The same grant observes later activity through the existing waiter with a ten-second to one-hour timeout. Waiting has no receipt and starts no member work. Caller cancellation and grant revocation release the wait. Claiming or unblocking tasks acquires no file lock, and interrupted native turns preserve task ownership until an explicit authorized transition changes it.

## Alternatives considered

**Separate task and receipt events.** A readable prefix between the two cannot reconstruct the committed response. A single required event makes the mutation and original result inseparable.

**Repeat CAS before receipt lookup.** The original successful call would conflict with its own revision. Receipt lookup first preserves retry semantics even after later valid task changes.

**Use a native-only task state machine or fabricated Agent.** Separate transitions drift from DSH rules, while an Agent-shaped identity could accidentally acquire live-Agent authority. Shared pure task rules accept a roster-authorized role and durable member id below both admission paths.

**Return the entire task in a mutation receipt.** Native text responses JSON-encode the result again; escaped descriptions can exceed the transport limit after commitment. Compact acceptance preserves the committed revision while full task reads retain their explicit result limits.

## Consequences

The Team journal remains the only task authority. Host receipt recovery does not restore a dead native process's RPC callback; adapters validate current native turns and settle interrupted cold work separately. Public service tests, persisted-event corruption tests, the real profile Loader and both SDK event recordings exercise the operation and replay paths. Native adapters remain responsible for matching this grant to their trusted current turn and call identities.
