-- Phase 11 maintenance cutover (ODTF_PLAN.md Phase 11).
--
-- The coordinator is the only active runtime. Legacy LangGraph trips are
-- retained as read-only history: their domain rows, scenario snapshots and
-- inert checkpoint rows are never deleted or rewritten, but no legacy operation
-- may resume, no pending legacy decision may be answered, and no new work may be
-- admitted for them. New trips, operations and decisions default to the
-- coordinator engine.

UPDATE odft_app.trips
   SET archived_at = COALESCE(archived_at, now()),
       archive_reason = COALESCE(
           archive_reason,
           'Legacy LangGraph trip archived at the Phase 11 coordinator cutover'
       ),
       workflow_status = CASE
           WHEN workflow_status IN ('queued', 'running', 'waiting_user') THEN 'failed'
           ELSE workflow_status
       END,
       recovery_required = false,
       last_unfinished_operation_id = NULL,
       updated_at = now()
 WHERE engine = 'langgraph';

-- Cancel unfinished legacy work and rotate the fencing token so a stale worker
-- holding an old lease can never write through it again.
UPDATE odft_app.workflow_operations
   SET status = 'cancelled',
       completed_at = COALESCE(completed_at, now()),
       lease_expires_at = NULL,
       claimed_by = NULL,
       fencing_token = fencing_token + 1,
       updated_at = now()
 WHERE status IN ('queued', 'running', 'waiting')
   AND trip_id IN (SELECT id FROM odft_app.trips WHERE engine = 'langgraph');

UPDATE odft_app.pending_decisions
   SET status = 'cancelled',
       resolved_at = COALESCE(resolved_at, now())
 WHERE status = 'pending'
   AND trip_id IN (SELECT id FROM odft_app.trips WHERE engine = 'langgraph');

-- Revoke outstanding legacy specialist delegations. Revocation is local and
-- best-effort: no coordinator consumes these rows anymore, but leaving them
-- active would let paid remote work continue and would append new protocol
-- observations to archived trips.
UPDATE odft_app.agent_delegations
   SET status = 'revoked',
       revoked_at = COALESCE(revoked_at, now()),
       revoke_reason = COALESCE(revoke_reason, 'Phase 11 legacy trip archival'),
       updated_at = now()
 WHERE status IN ('pending', 'dispatched', 'working', 'input_required')
   AND trip_id IN (SELECT id FROM odft_app.trips WHERE engine = 'langgraph');

ALTER TABLE odft_app.trips ALTER COLUMN engine SET DEFAULT 'coordinator-v1';
ALTER TABLE odft_app.workflow_operations ALTER COLUMN engine SET DEFAULT 'coordinator-v1';
ALTER TABLE odft_app.pending_decisions ALTER COLUMN engine SET DEFAULT 'coordinator-v1';
