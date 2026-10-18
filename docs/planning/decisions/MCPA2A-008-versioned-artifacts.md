# MCPA2A-008: Versioned Zod artifacts with semantic validation

- Status: Accepted
- Date: 2026-10-18
- Source: `ODTF_PLAN.md` §3.18
- Supersedes: none

## Context

Replacement and interoperability depend on stable contracts; free-form agent
output would let invented offers or prices enter the application.

## Decision

Use strict, versioned Zod envelopes and media types for every artifact. Ranked
ids must reference existing offers/candidates of the delegated snapshot;
business fingerprints exclude transport metadata.

## Consequences

- Unknown fields and invented ids are rejected before persistence.
- Contract changes require a new version and coordinated tests.
- Agents return proposals, never authoritative feasibility or booking decisions.

## Evidence

`packages/contracts/src/agent-artifacts.ts`,
`tests/integration/a2a/*`, `docs/protocols/contracts.md`.
