# Agent Note: Catalog-owned durable runtime registration

Status: implemented

English | [中文](2026-09-04-catalog-owned-durable-runtime-registration.zh.md)

## Problem

The durable Codex adapter registered its provider directly with Agent Teams. A composition that also owned a user-visible Runtime Backend catalog could not publish that provider through its own atomic registration operation because Agent Teams exposes neither provider enumeration nor a registration event. Registering the same provider again caused an identity collision, while catalog mirroring would split routing authority from displayed metadata.

## Decision

The Codex adapter accepts an optional `catalogOwnerService` name. When omitted, the adapter registers directly with Agent Teams. When configured, a child `ctx.inject()` waits for that service and calls its `registerExternalRuntimeProvider(provider)` operation, which owns catalog publication and the corresponding Agent Teams registration as one generation. The adapter validates that the operation exists and returns a callable synchronous or asynchronous disposer. It contains no deployment-specific service name.

The child injection unloads before the configured service disappears and invokes the returned disposer through a once guard. A replacement service starts a fresh registration generation with the same provider object. Adapter teardown waits for the registration generation to disappear before closing provider admission and native resources.

## Alternatives considered

**Mirror Agent Teams providers into the composition catalog.** Rejected because Agent Teams has no enumeration or observation API for registrations, and a second metadata store could diverge from the provider generation that owns routing.

**Replace or proxy the Agent Teams service.** Rejected because one catalog consumer would then wrap the Team authority, roster, mailbox, evaluation, and runtime operations instead of owning only its catalog registration.

**Hard-code the composition service name in the adapter.** Rejected because an experimental provider must remain usable in standalone compositions and must not depend on one out-of-tree product package.

## Consequences

A deployment can make one service the atomic owner of Runtime Backend discovery and Agent Teams routing without a partial direct registration. Missing catalog owners defer registration without fallback; service replacement and adapter disposal remove each generation once. Standalone Codex behavior, provider capabilities, native qualification, durable identities, and persisted formats remain unchanged. Real Cordis lifecycle tests cover service absence, appearance, replacement, and Fiber disposal.
