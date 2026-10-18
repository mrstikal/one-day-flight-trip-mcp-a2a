# MCPA2A-003: Existing worker as coordinator; three primary agent processes

- Status: Accepted
- Date: 2026-10-18
- Source: `ODTF_PLAN.md` §3.18
- Supersedes: none

## Context

The existing deployment already has a dedicated worker and independent
specialist processes. A new generic orchestration service would add deployment
and failure surface without improving the demo.

## Decision

Keep `apps/worker` as the durable coordinator. Run Flight, Accommodation and City
Guide as independent A2A services; Accommodation B is an optional replacement.
The coordinator exposes no public HTTP port.

## Consequences

- Operations remain queue/lease/fence based in PostgreSQL.
- Specialists can be restarted, replaced or scaled independently.
- Process supervision and health checks stay explicit in `npm run dev`/E2E.

## Evidence

`apps/worker`, `docs/architecture/coordinator.md`,
`tests/integration/coordinator/*`.
