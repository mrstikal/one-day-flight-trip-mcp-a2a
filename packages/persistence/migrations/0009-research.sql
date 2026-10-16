-- Phase 09: research fan-out indexes and the overlay freshness column.
--
-- The tables themselves were created by 0003-domain.sql; this migration adds no
-- duplicate CREATE. `simulation_faults.updated_at` makes overlay resolution
-- deterministic when both a trip-level control row and an operation-scoped
-- outcome row exist: the most recently written overlay wins.

ALTER TABLE odft_app.simulation_faults
    ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

CREATE INDEX IF NOT EXISTS recommendation_artifacts_trip_service_idx
    ON odft_app.recommendation_artifacts (trip_id, service_key, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS simulation_faults_trip_domain_idx
    ON odft_app.simulation_faults (trip_id, domain, updated_at DESC);