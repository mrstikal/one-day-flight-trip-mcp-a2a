-- Phase 10: immutable itinerary versions (03-langgraph-design.md section 4,
-- 04-domain-model.md section 8). Only the columns the itinerary record requires
-- beyond the Phase 03 table are added here; versions stay append-only.

ALTER TABLE odft_app.itineraries
    ADD COLUMN IF NOT EXISTS costs jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE odft_app.itineraries
    ADD COLUMN IF NOT EXISTS review jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE odft_app.itineraries
    ADD COLUMN IF NOT EXISTS simulated_failure boolean NOT NULL DEFAULT false;
ALTER TABLE odft_app.itineraries
    ADD COLUMN IF NOT EXISTS simulated_failure_note text;
-- Immutable plan inputs re-read by the projection and the approval check. The
-- table had no writer before Phase 10, so the defaults only satisfy the DDL.
ALTER TABLE odft_app.itineraries
    ADD COLUMN IF NOT EXISTS sightseeing_date date NOT NULL DEFAULT '1970-01-01';
ALTER TABLE odft_app.itineraries
    ADD COLUMN IF NOT EXISTS zone text NOT NULL DEFAULT 'UTC';
ALTER TABLE odft_app.itineraries
    ADD COLUMN IF NOT EXISTS adults integer NOT NULL DEFAULT 1;
ALTER TABLE odft_app.itineraries
    ADD COLUMN IF NOT EXISTS pace text NOT NULL DEFAULT 'moderate';
ALTER TABLE odft_app.itineraries
    ADD COLUMN IF NOT EXISTS travel_variant text NOT NULL DEFAULT 'one_night';

CREATE INDEX IF NOT EXISTS itineraries_trip_version_idx
    ON odft_app.itineraries (trip_id, version DESC);