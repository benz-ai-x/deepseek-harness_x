# Agent Note: Preserve maintained Team contracts on Session v2

Status: implemented

English | [中文](2026-09-08-maintained-team-on-session-v2.zh.md)

## Problem

The maintained Team service owns fixed routes, durable external members, native operation receipts, human message requests, and one navigable task panel. Replacing that service with the official baseline would remove accepted product behavior. Keeping the older Session representation would omit embedded Assistant streams and released-format restoration.

## Decision

The integration combines the fixed official Session v2 implementation with the complete maintained Team owner. Session representation and Team payload versions remain independent: the Team schemas and projection retain their existing identities, and current restoration uses the generated installed event inventory, including required native-operation and message-request records.

Historical restoration remains subject to the [adjacent-format rules](2026-08-31-released-session-format-migrations.md). The frozen edge explicitly validates maintained Team fields and required receipts without importing the current Team service. Unknown fields, malformed identities, and conflicting external-member metadata refuse restoration. Only the test replay adapter materializes and restores the native receipt's authored identity token; production format readers accept no such placeholder. Cross-domain migration and external application release qualification remain separate from this source integration.

The authored [Team panel scenario](../../../../snapshots/web/agent-team-panel/snapshot.yml) owns a v2 scene with the same task dependencies and controls. Its title cites the actual earlier user event. The historical authored scene receives the same fixture-only reference correction; this is source-tree test curation, not a runtime migration. The shared navigation scene references its owner's selected v2 generation. The Python SDK scenario records current output through the built CLI while retaining native receipt and task CAS assertions.

## Alternatives considered

**Replace the maintained Team service with stock Team.** This removes fixed-route and durable native behavior; the public owner remains the maintained service.

**Keep old Session writers or rename v0 files without conversion.** This misrepresents durable representation and cannot supply the v2 stream and lineage semantics.

**Give all Team payloads one new version.** Session encoding does not itself change the business fields or justify collapsing independently versioned operation receipts.

## Consequences

The integration is a maintained fork, not a claim of extension-free official compatibility. Current Team, generated Remote, browser, and SDK checks exercise the combined runtime. Historical maintained-format migration, complete external package upgrade, and authenticated native acceptance require their own evidence; this decision does not mark those checks complete.
