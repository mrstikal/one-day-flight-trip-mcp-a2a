-- 0004-graph-lease.sql
-- Durable worker claim/lease/fencing and driver-recovery columns (Phase 05).
-- Idempotent DDL; schema odft_app.

-- Who currently holds the operation lease (worker identity); never a secret.
ALTER TABLE odft_app.workflow_operations
    ADD COLUMN IF NOT EXISTS claimed_by text;

-- Completed-at timestamp for terminal operations (audit; not a cursor).
ALTER TABLE odft_app.workflow_operations
    ADD COLUMN IF NOT EXISTS completed_at timestamptz;

-- Explicit recovery rounds granted by owner technical retry. Total automatic
-- claims (attempts) stay monotonic; automatic claims per round are bounded.
ALTER TABLE odft_app.workflow_operations
    ADD COLUMN IF NOT EXISTS recovery_rounds integer NOT NULL DEFAULT 0
        CHECK (recovery_rounds >= 0);

-- Automatic claims already consumed in the current recovery round.
ALTER TABLE odft_app.workflow_operations
    ADD COLUMN IF NOT EXISTS auto_claims integer NOT NULL DEFAULT 0
        CHECK (auto_claims >= 0);

-- Claim scans look for queued work or expired running leases in creation order.
CREATE INDEX IF NOT EXISTS workflow_operations_claim_idx
    ON odft_app.workflow_operations (status, lease_expires_at, created_at);
