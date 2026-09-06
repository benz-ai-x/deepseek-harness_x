# Agent Note: Commit and recover native Team messages with their replay receipts

Status: implemented

English | [中文](2026-09-06-durable-native-team-operations.zh.md)

## Problem

A native tool response can disappear after the Team accepts its message. Resending without a durable operation identity duplicates work; recording the response after a separate mailbox commit leaves the same failure window. Terminal native output also needs a member-owned route to the Lead without copying the native transcript into another store.

## Decision

The [Team mailbox](../../../../packages/experimental/agent-team/src/mailbox.ts) accepts an intentional text message and its receipt in one required `team/native-operation/committed` event. The receipt binds Team, member, provider, native handle and trusted turn/call correlation. Tool calls and terminal settlement use distinct correlation kinds. Model JSON supplies neither identity nor grant authority.

A canonical operation digest selects the original receipt, and a canonical input fingerprint detects changed input. Target names use the mailbox's whitespace normalization. The [projection](../../../../packages/experimental/agent-team/src/projection.ts) checks the persisted member, message attribution, source kind, operation digest and input fingerprint before reconstructing the mailbox and receipt. Terminal settlement targets the Lead and records completed, failed or interrupted separately from queued acceptance.

The event uses payload version 4 with explicit message/task variants and the Team checkpoint uses stateVersion 5. The reader also accepts payload-3 messages. The generated Session event catalog includes the required event; explicit payload-2 decoders retain readable history. Session format 0 and Ultra's storage generation do not change. These choices implement the local maintained extension's format plan; an older reader cannot ignore the required event or reuse the new checkpoint.

The current grant is checked at admission and again in the write queue. A failed flush returns no success and starts no delivery. Retrying flushes the original event before publishing the receipt and continuing delivery. Durable acceptance transfers settlement to the Team; provider retirement still prevents its old grant from returning a successful response. A verified new grant can replay the accepted receipt.

The verified grant also exposes the Host-only `turns.recover` reader. The Team serializes this read with journal operations, flushes the Lead Session, and returns detached pages grouped as the member's launch correlation, inbound delivery ids, and committed settlements. Incoming message text, sibling and other-Team facts, and raw provider history stay with their owners. Reading publishes no Team activity. Stable launch, delivery, and turn identities let an adapter de-duplicate entries when concurrent appends shift numeric-offset pages.

## Alternatives considered

**Separate mutation and receipt commits.** A crash between them makes the original response unrecoverable and can repeat the mutation. One event makes the two facts inseparable in a readable log prefix.

**An Ultra-owned native outbox.** A second mailbox would split Team authority and recovery across storage owners. The existing Team log and mailbox retain both business acceptance and dispatch.

**Use caller text as an operation identity.** Identical intentional messages can be separate calls. Trusted member/session/turn/call correlation distinguishes them while allowing transport retries to converge.

## Consequences

Receipts survive Host replacement and expose no grant credential or raw provider payload. Queries remain read-only; native message tools and terminal settlement publish only intentional text under the same bounded request policy. A resumed adapter can reconcile its durable history with Host-owned work identities and already committed outcomes without copying prompts into another store. Recovery may wait for the Lead Session flush and fails if that durability check fails. The guarantee covers one Host's explicit retry and recovery paths, not cross-Host exactly-once execution. Native adapters remain responsible for preserving trusted SDK correlations and recovering intentional terminal output from their own durable history.
