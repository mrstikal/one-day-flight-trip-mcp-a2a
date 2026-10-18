# MCPA2A-007: Trusted registry, bearer identity and delegated least privilege

- Status: Accepted
- Date: 2026-10-18
- Source: `ODTF_PLAN.md` §3.18
- Supersedes: none

## Context

The local POC must demonstrate agent/tool security without browser secrets or
unrestricted agent access.

## Decision

Discovery is trusted-registry-only with pinned origins and card URLs. Callers
authenticate with bearer tokens resolved from environment `credentialRef`s; the
identity always comes from the token. Agents use restricted database roles, and
MCP scenario reads require a non-revoked delegation for the exact snapshot.

## Consequences

- No dynamic or open discovery; registry edits are operator actions.
- Token rotation and role provisioning are explicit setup steps.
- Read-only MCP roles are write-denial tested.

## Evidence

`scripts/setup-protocol-roles.ts`, `tests/integration/mcp/authorization.test.ts`,
`tests/integration/a2a/delegated-governance.test.ts`.
