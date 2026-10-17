import type { Pool, PoolClient } from "pg";
import { delegationScopeSchema, type DelegationDomain, type DelegationScope } from "@odft/contracts";

type Queryable = Pick<Pool | PoolClient, "query">;

/**
 * Phase 05 delegated execution authority (plan §3.15).
 *
 * An agent's authority is a tagged, revalidated binding to a persisted
 * delegation — never a coordinator fencing token and never a bearer secret.
 * Every read/LLM step revalidates it so a revoked, expired, superseded or
 * cross-identity delegation cannot be used.
 */

export class DelegatedAuthorityError extends Error {
  readonly code: "DELEGATION_REVOKED" | "INPUT_EXPIRED" | "STALE_AGENT_RESULT";
  constructor(code: DelegatedAuthorityError["code"], message: string) {
    super(message);
    this.name = "DelegatedAuthorityError";
    this.code = code;
  }
}

export interface DelegatedAuthority {
  readonly delegationId: string;
  readonly agentIdentity: string;
  readonly skillId: string;
  readonly tripId: string;
  readonly snapshotId: string;
  readonly acceptedRevision: number;
  readonly domains: readonly DelegationDomain[];
  readonly scope: DelegationScope;
  readonly taskId: string | null;
  readonly originatingOperationId: string;
}

interface DelegationAuthorityRow {
  id: string;
  trip_id: string;
  agent_identity: string;
  skill_id: string;
  snapshot_id: string;
  accepted_revision: number;
  scope: unknown;
  task_id: string | null;
  status: string;
  deadline_at: Date | null;
  originating_operation_id: string;
}

/** Load and validate the current authority of a delegation (read-only). */
export async function loadDelegatedAuthority(
  client: Queryable,
  input: { agentIdentity: string; delegationId: string },
): Promise<DelegatedAuthority> {
  const result = await client.query<DelegationAuthorityRow>(
    `SELECT id, trip_id, agent_identity, skill_id, snapshot_id, accepted_revision, scope, task_id,
            status, deadline_at, originating_operation_id
       FROM odft_app.agent_delegations WHERE id = $1`,
    [input.delegationId],
  );
  const row = result.rows[0];
  if (!row) {
    throw new DelegatedAuthorityError("DELEGATION_REVOKED", "delegation not found");
  }
  if (row.agent_identity !== input.agentIdentity) {
    throw new DelegatedAuthorityError(
      "DELEGATION_REVOKED",
      "the delegation belongs to a different agent identity",
    );
  }
  if (row.status === "revoked" || row.status === "cancelled" || row.status === "failed") {
    throw new DelegatedAuthorityError("DELEGATION_REVOKED", `delegation is ${row.status}`);
  }
  if (row.deadline_at && row.deadline_at.getTime() < Date.now()) {
    throw new DelegatedAuthorityError("INPUT_EXPIRED", "the delegation deadline has passed");
  }
  const scope = delegationScopeSchema.parse(row.scope);
  return {
    delegationId: row.id,
    agentIdentity: row.agent_identity,
    skillId: row.skill_id,
    tripId: row.trip_id,
    snapshotId: row.snapshot_id,
    acceptedRevision: row.accepted_revision,
    domains: scope.domains,
    scope,
    taskId: row.task_id,
    originatingOperationId: row.originating_operation_id,
  };
}

/** Assert the authority covers the exact domain/snapshot/task it is used for. */
export function assertAuthorityCovers(
  authority: DelegatedAuthority,
  required: { domain?: DelegationDomain; snapshotId?: string; taskId?: string },
): void {
  if (required.domain && !authority.domains.includes(required.domain)) {
    throw new DelegatedAuthorityError(
      "DELEGATION_REVOKED",
      `domain ${required.domain} is outside the delegated scope`,
    );
  }
  if (required.snapshotId && authority.snapshotId !== required.snapshotId) {
    throw new DelegatedAuthorityError(
      "STALE_AGENT_RESULT",
      "the requested snapshot is not the delegated frozen snapshot",
    );
  }
  if (required.taskId && authority.taskId !== required.taskId) {
    throw new DelegatedAuthorityError(
      "STALE_AGENT_RESULT",
      "the task is not the delegation's canonical task",
    );
  }
}

/**
 * Bind the delegation to the agent's canonical task on first use (idempotent).
 * The coordinator persists its own binding at dispatch; an agent that receives
 * a delegation before that binding exists claims it here, and a delegation
 * already bound to a DIFFERENT task is refused (never rebound).
 */
export async function claimDelegationTask(
  client: Queryable,
  input: { delegationId: string; agentIdentity: string; taskId: string },
): Promise<void> {
  // Validated SECURITY DEFINER function: agents hold no UPDATE grant on
  // agent_delegations, and a different existing binding is refused.
  const result = await client.query<{ claimed: boolean }>(
    `SELECT odft_app.claim_delegated_task($1::text, $2::uuid, $3::text) AS claimed`,
    [input.agentIdentity, input.delegationId, input.taskId],
  );
  if (result.rows[0]?.claimed !== true) {
    throw new DelegatedAuthorityError(
      "STALE_AGENT_RESULT",
      "the delegation is already bound to a different task",
    );
  }
}
