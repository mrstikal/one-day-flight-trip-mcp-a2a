-- Phase 09 cancel outbox: bounded remote-cancel retries.
--
-- `cancellation_attempts` counts SDK `cancelTask` tries for a persisted
-- `cancellation_state = 'pending'` intent. The reconciler leaves the intent
-- `pending` until the attempt budget is exhausted and only then settles it as
-- `failed` inspector evidence — a transient transport outage can never
-- terminally fail a cancel on its first try.

ALTER TABLE odft_app.agent_delegations
    ADD COLUMN IF NOT EXISTS cancellation_attempts integer NOT NULL DEFAULT 0
        CHECK (cancellation_attempts >= 0);
