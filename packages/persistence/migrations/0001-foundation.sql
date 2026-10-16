-- 0001-foundation.sql
-- Foundation schema for the AI Travel Planner demo application.
-- Idempotent: safe to run repeatedly alongside the migration ledger in runMigrations.

CREATE SCHEMA IF NOT EXISTS odft_app;
CREATE SCHEMA IF NOT EXISTS odft_checkpoint;

-- Small operational table used by the worker readiness contract. The worker
-- upserts its own process identity on a fixed interval; readiness must never
-- pretend a worker is alive when no recent heartbeat exists.
CREATE TABLE IF NOT EXISTS odft_app.worker_heartbeat (
    worker_id         text PRIMARY KEY,
    started_at        timestamptz NOT NULL DEFAULT now(),
    last_heartbeat_at timestamptz NOT NULL DEFAULT now(),
    host              text NOT NULL,
    pid               integer NOT NULL
);

CREATE INDEX IF NOT EXISTS worker_heartbeat_last_heartbeat_at_idx
    ON odft_app.worker_heartbeat (last_heartbeat_at);
