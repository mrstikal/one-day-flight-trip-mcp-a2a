# ADR-001: Next.js BFF and Dedicated Node.js Worker

Status: accepted for implementation planning; not yet implemented. Date: 2026-10-10.

## Context

The demo needs a responsive graphical/chat UI and graph work that can pause, outlive an HTTP request, and survive process/browser restarts. The repository currently has no application stack. Adding several services would obscure the LangGraph demonstration.

## Decision

Use one npm-workspace repository, Next.js App Router/React frontend and BFF, one Node.js graph worker without a public HTTP API, and PostgreSQL. Self-host both processes; PostgreSQL is the only infrastructure dependency. Use the pinned [stack baseline](../00-project-overview.md#3-final-technology-stack).

The web tier validates ownership, schemas, and command admission; the worker exclusively drives graph threads. Persist jobs/events in PostgreSQL. Browser progress uses same-origin SSE and authorized read projections.

## Alternatives

| Alternative | Reason not chosen |
| --- | --- |
| Next.js request-inline graph | Request cancellation/host lifecycle cannot provide durable ownership |
| Untracked background promise in web process | Lost on restart/deploy; no reliable queue/recovery |
| Separate Fastify/Nest API plus frontend | Adds routing/authentication/deployment duplication without need |
| Redis queue plus worker | Useful at scale, unnecessary infrastructure for a small PostgreSQL-backed demo |
| Python graph service | Violates the primary TypeScript design and adds another runtime/API boundary |

## Consequences

- Two managed application processes need health/startup/shutdown instructions and bounded database pools.
- No serverless deployment claim is made. An explicit worker is a durability choice, not a microservice platform.
- Work admission returns `202`, never a booking-completion response.
- Module boundaries prevent browser imports of graph/database clients and secrets.

## Verification and References

[Architecture](../02-architecture.md), [Phase01](../phases/phase-01.md), and [worker phase](../phases/phase-05.md). Verify production package imports/build, no public worker port, worker heartbeat, restart recovery, and client-bundle secret/server-module exclusion.
