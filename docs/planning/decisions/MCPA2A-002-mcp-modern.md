# MCPA2A-002: MCP stable v2 with pinned modern Streamable HTTP

- Status: Accepted
- Date: 2026-10-18
- Source: `ODTF_PLAN.md` §3.18
- Supersedes: none

## Context

Specialist agents need networked, read-only capability services with explicit
protocol negotiation. Accidental legacy handshakes would hide compatibility
problems.

## Decision

Use the pinned MCP server/client packages (`@modelcontextprotocol/server`,
`client@2.3.1`, `node@2.1.1`) with modern Streamable HTTP negotiation pinned to
`2026-07-28`. The server rejects 2025-era clients with the SDK's
unsupported-protocol-version error.

## Consequences

- The Express body is forwarded as `parsedBody`; the adapter never re-reads a
  consumed stream.
- Every endpoint has explicit deadlines and bounded retries for read-only reads.
- A client upgrade is a deliberate, tested change.

## Evidence

`tests/integration/mcp/*`, `docs/protocols/mcp.md`.
