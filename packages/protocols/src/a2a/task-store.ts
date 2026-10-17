import { Kysely, type Transaction } from "kysely";
import { DatabaseTaskStore } from "@a2a-js/sdk/server/database";
import type { TaskStore } from "@a2a-js/sdk/server";

/**
 * Phase 03 official SDK task storage (plan §3.7).
 *
 * The task tables were generated offline by `a2a-db@1.3.0` and folded into the
 * checksummed application migration `0013-protocol-state.sql`; the SDK never
 * runs untracked schema upgrades at service startup. This module only wires
 * the official `DatabaseTaskStore` to a schema-qualified Kysely instance and
 * an owner resolver pinned to the agent identity, so tasks of different agents
 * can never read each other's rows.
 */

export const PROTOCOL_SCHEMA = "odft_protocol";

/** Table names created by migration 0013 (official a2a-db DDL). */
export const AGENT_TASK_TABLES = {
  flight: "agent_tasks_flight",
  accommodation: "agent_tasks_accommodation",
  cityGuide: "agent_tasks_city_guide",
  accommodationAlt: "agent_tasks_accommodation_alt",
} as const;
export type AgentTaskTable = (typeof AGENT_TASK_TABLES)[keyof typeof AGENT_TASK_TABLES];

export function createTaskStore(
  db: Kysely<unknown>,
  options: { readonly tableName: AgentTaskTable; readonly owner: string },
): TaskStore {
  return new DatabaseTaskStore(db.withSchema(PROTOCOL_SCHEMA), {
    tableName: options.tableName,
    ownerResolver: () => options.owner,
  });
}

/**
 * The official store constructed on a transaction handle.
 *
 * `DatabaseTaskStore` expects the `Kysely` class type, while a transaction
 * handle is the structurally-compatible `Transaction<DB>` interface; the store
 * only uses query-builder methods, so this narrow, documented cast is safe and
 * is what lets admission commit the canonical task and the dedupe mapping in
 * ONE transaction.
 */
export function createTransactionalTaskStore(
  transaction: Transaction<unknown>,
  options: { readonly tableName: AgentTaskTable; readonly owner: string },
): TaskStore {
  const scoped = transaction.withSchema(PROTOCOL_SCHEMA);
  return new DatabaseTaskStore(scoped as unknown as Kysely<unknown>, {
    tableName: options.tableName,
    ownerResolver: () => options.owner,
  });
}
