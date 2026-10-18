-- Phase 09 bridge starvation guard.
--
-- Rows that fail contract parsing stay `application_event_id IS NULL` forever
-- and sort first by (occurred_at, id), so beyond the LIMIT window they would
-- permanently block valid observations. `bridge_skipped_at` marks a row the
-- reconciler gave up on; skipped rows leave the bridge window but stay
-- queryable for operators (never silently deleted).

ALTER TABLE odft_app.protocol_observations
    ADD COLUMN IF NOT EXISTS bridge_skipped_at timestamptz;
