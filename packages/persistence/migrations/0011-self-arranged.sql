-- Phase 12: explicit "I'll arrange it myself" program state. One row per service
-- the traveler handles themselves; these meals/activities are never planned,
-- offered, or costed. Kept separate from `trip_selections` so a self-arranged
-- service is a first-class state instead of a missing (null) selection.

CREATE TABLE IF NOT EXISTS odft_app.self_arranged_services (
    trip_id     uuid NOT NULL REFERENCES odft_app.trips (id),
    service_key text NOT NULL CHECK (service_key IN ('breakfast','lunch','dinner','activities')),
    updated_at  timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (trip_id, service_key)
);