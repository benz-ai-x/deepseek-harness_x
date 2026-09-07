# Agent Note: Commit human Team message requests with their queued message

Status: implemented

English | [中文](2026-09-07-durable-human-team-message-requests.zh.md)

## Problem

A browser submission can lose its response after the Team accepts the work. Reissuing an ordinary mailbox send creates another message, while storing reply correlation or a replay receipt in a second event leaves a crash window. The Host must also derive the human sender from the exact live Team authority rather than accept an identity asserted by Client data.

## Decision

The [Team service](../../../../packages/experimental/agent-team/src/index.ts) exposes one Lead-only `submitMessage()` operation and the generated `agentTeams/sendMessage` Remote. Its input carries a caller-owned request id, an explicit active recipient, literal text, and an optional earlier message id. The injected live `Agent` supplies the sender and Team; neither is accepted from the request.

The request identity is a non-empty opaque string of at most 200 UTF-8 bytes. Within the Team projection, `(senderId, requestId)` selects one receipt. A SHA-256 fingerprint covers the exact recipient, text, and nullable reply id: matching retries return the original message id, while changed input conflicts without appending. Team-scoped projection state makes the same request id independent in another Team.

One required `team/message/request-committed` payload-version-1 event stores the request receipt, optional reply relation, and queued message atomically. The projection requires the sender to be the Team Lead, the recipient to be active, and a reply target to be an earlier real message in the same Team. It recomputes the fingerprint and rejects duplicate request or message identities. Projection stateVersion 7 rebuilds these facts from the Lead log; older queue and delivery payloads remain readable, while future request versions fail closed.

Caller cancellation owns a new request only until the durable append begins. After acceptance, Team lifecycle cancellation owns delivery, so a disconnected caller cannot erase queued work. Submission acceptance and the current `pending` or `delivered` delivery fact remain separate. Provider absence retains the same queued message; provider return and Host recovery dispatch that identity, while target-side Session de-duplication prevents another delivery fact.

## Alternatives considered

**Reuse ordinary `sendMessage()` and let the Client infer success.** A retry would allocate a fresh message id, so double-clicks and unknown transport outcomes could duplicate work.

**Store request receipts or replies in separate events.** A crash between commits could leave an unrepeatable acceptance or an uncorrelated reply. One required event makes every readable log prefix self-consistent.

**Let the Client provide sender or Team ids.** This would turn presentation state into an authority credential. Host injection and exact-live membership checks keep authorization at the Team owner.

## Consequences

Human sends can be retried after double-clicks, transport loss, persistence uncertainty, and restart without allocating another message. The receipt adds a durable SHA-256 digest and request id per human-authored message, and required-event readers must understand payload version 1 and projection stateVersion 7. Delivery is still process-local retry plus target-owned de-duplication, not cross-Host exactly-once execution, and continuous Client watching remains outside this decision.
