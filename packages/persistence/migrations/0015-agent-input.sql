-- Phase 06: persistent specialist input requests (plan §3.9/§3.10).
--
-- The agent persists the exact pending question binding on the canonical task
-- control row so a continuation can be validated (input generation, request id,
-- 24-hour expiry) without trusting the inbound message. The request hash is
-- stored as correlation evidence. Human waiting on `input_required` is excluded
-- from active execution time.
--
-- The columns are deliberately plain nullable fields: admission moves the row
-- back to `working` (with a fresh generation) BEFORE the executor validates the
-- answer, and the executor's compare-and-swap UPDATE then consumes the pending
-- binding exactly once. A row-level CHECK here would fight that ordering.

ALTER TABLE odft_app.protocol_task_control
    ADD COLUMN IF NOT EXISTS input_request_id text,
    ADD COLUMN IF NOT EXISTS input_request_hash text CHECK (
        input_request_hash IS NULL OR input_request_hash ~ '^[a-f0-9]{64}$'
    ),
    ADD COLUMN IF NOT EXISTS input_expires_at timestamptz;
