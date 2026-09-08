# Agent Note: Enforce required member collaboration

Status: implemented

English | [中文](2026-09-08-enforce-required-member-collaboration.zh.md)

## Problem

A provider can install all Team operations for new native sessions while an existing session retains fewer operations. Checking only its catalog permits an explicitly required capability that the accepted handle cannot provide.

## Decision

The runtime registry checks the normalized request against exact-handle operation proof before accepting create or resume. A `full-collaboration` requirement needs all six operations; absent proof does not satisfy it. Failure uses the existing result-violation quarantine and quiescent cleanup, revoking the affected provider generation without retiring other providers. Retained roster and mailbox facts permit a fresh registration to recover the same identity when it supplies complete proof.

## Alternatives considered

**Use the catalog alone.** Rejected because the catalog describes provider support, not the operations installed on one durable handle.

**Only downgrade the Studio label.** Rejected because direct Host callers also require enforcement and must not deliver queued work to an incompatible resumed handle.

**Reject limited sessions unconditionally.** Rejected because requests without a full-collaboration requirement may legitimately retain limited or unknown operations, including unprovable cold recovery.

## Consequences

Explicit full-collaboration demand fails closed without adding persistent fields or replacing native identities. A violating generation must be registered again after cleanup; its original registration cannot be reused. Public Team tests cover insufficient create proof, exact-handle recovery refusal, queued delivery, unaffected providers, and recovery without creating another native session.
