export const PACKAGE_ID = "@odft/protocols" as const;

/**
 * Phase 03: official A2A and MCP SDK plumbing over real HTTP.
 *
 * This package owns transport adaptation only: contracts, auth, the trusted
 * registry, safe telemetry, durable inbound admission and SDK task storage.
 * It never contains business rules (those live in `@odft/domain`), graph
 * orchestration (`@odft/workflow`) or composition services (`@odft/services`).
 */

export * from "./config.js";
export * from "./auth.js";
export * from "./telemetry.js";
export * from "./canonical-json.js";
export * from "./service-lock.js";
export * from "./a2a/registry.js";
export * from "./a2a/client.js";
export * from "./a2a/server.js";
export * from "./a2a/task-store.js";
export * from "./a2a/executor-support.js";
export * from "./a2a/message-admission.js";
export * from "./a2a/task-control.js";
export * from "./mcp/client.js";
export * from "./mcp/server.js";
