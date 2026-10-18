# MCPA2A-004: One MCP host with three distinct server endpoints

- Status: Accepted
- Date: 2026-10-18
- Source: `ODTF_PLAN.md` §3.18
- Supersedes: none

## Context

The demo needs clearly separated MCP capabilities without multiplying processes
or exposing write/booking tools.

## Decision

Run one `apps/mcp-server` host with three endpoints: `/geography/mcp`,
`/travel-data/mcp` and `/itinerary-tools/mcp`. Each endpoint has its own
identity allowlist, tools/resources and read-only scope.

## Consequences

- A host outage affects all three capabilities, which the recovery tests model.
- Capability boundaries stay visible in the registry and inspector.
- No MCP tool can create, change or book a reservation.

## Evidence

`tests/integration/mcp/*`, `docs/protocols/mcp.md`.
