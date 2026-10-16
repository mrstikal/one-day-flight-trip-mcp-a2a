-- 0002-reference.sql
-- Offline geographic reference tables (Phase 02). Idempotent DDL.

CREATE TABLE IF NOT EXISTS odft_app.reference_countries (
    country_key  text PRIMARY KEY CHECK (country_key ~ '^[A-Z]{2}$'),
    name         text NOT NULL CHECK (length(name) > 0),
    admitted     boolean NOT NULL DEFAULT true,
    extension    boolean NOT NULL DEFAULT false,
    policy_note  text
);

CREATE TABLE IF NOT EXISTS odft_app.reference_cities (
    id            text PRIMARY KEY CHECK (id ~ '^geonames:[0-9]+$'),
    country_key   text NOT NULL REFERENCES odft_app.reference_countries (country_key),
    name          text NOT NULL CHECK (length(name) > 0),
    ascii_name    text NOT NULL CHECK (length(ascii_name) > 0),
    lat           double precision NOT NULL CHECK (lat BETWEEN -90 AND 90),
    lon           double precision NOT NULL CHECK (lon BETWEEN -180 AND 180),
    zone          text NOT NULL CHECK (length(zone) > 0),
    coverage_flag text NOT NULL CHECK (coverage_flag IN ('curated_landmarks', 'generic_only', 'insufficient_reference')),
    population    integer NOT NULL DEFAULT 0 CHECK (population >= 0),
    search_key    text NOT NULL CHECK (length(search_key) > 0),
    updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS reference_cities_search_key_idx
    ON odft_app.reference_cities (search_key);
CREATE INDEX IF NOT EXISTS reference_cities_country_search_idx
    ON odft_app.reference_cities (country_key, search_key);

CREATE TABLE IF NOT EXISTS odft_app.reference_airports (
    id                    text PRIMARY KEY CHECK (id ~ '^ourairports:[0-9]+$'),
    iata                  text NOT NULL UNIQUE CHECK (iata ~ '^[A-Z]{3}$'),
    icao                  text,
    name                  text NOT NULL CHECK (length(name) > 0),
    country_key           text NOT NULL REFERENCES odft_app.reference_countries (country_key),
    municipality          text,
    lat                   double precision NOT NULL CHECK (lat BETWEEN -90 AND 90),
    lon                   double precision NOT NULL CHECK (lon BETWEEN -180 AND 180),
    zone                  text NOT NULL CHECK (length(zone) > 0),
    zone_source           text NOT NULL CHECK (zone_source IN ('geo-tz', 'override')),
    zone_evidence         text NOT NULL CHECK (length(zone_evidence) > 0),
    zone_override_reason  text,
    eligible_origin       boolean NOT NULL DEFAULT false,
    airport_type          text NOT NULL CHECK (length(airport_type) > 0),
    scheduled_service     boolean NOT NULL DEFAULT false,
    search_key            text NOT NULL CHECK (length(search_key) > 0),
    updated_at            timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS reference_airports_search_key_idx
    ON odft_app.reference_airports (search_key);
CREATE INDEX IF NOT EXISTS reference_airports_eligible_origin_idx
    ON odft_app.reference_airports (eligible_origin, search_key);

CREATE TABLE IF NOT EXISTS odft_app.reference_city_airports (
    city_id               text NOT NULL REFERENCES odft_app.reference_cities (id),
    airport_id            text NOT NULL REFERENCES odft_app.reference_airports (id),
    metro_catchment_id    text NOT NULL CHECK (length(metro_catchment_id) > 0),
    transfer_minutes      integer NOT NULL CHECK (transfer_minutes BETWEEN 0 AND 600),
    transfer_mode         text NOT NULL CHECK (transfer_mode IN ('public_transport', 'taxi')),
    eligible_destination  boolean NOT NULL DEFAULT true,
    reviewed              boolean NOT NULL DEFAULT false,
    evidence_refs         jsonb NOT NULL DEFAULT '[]'::jsonb,
    PRIMARY KEY (city_id, airport_id)
);

CREATE INDEX IF NOT EXISTS reference_city_airports_catchment_idx
    ON odft_app.reference_city_airports (metro_catchment_id);

CREATE TABLE IF NOT EXISTS odft_app.reference_landmarks (
    id          text PRIMARY KEY CHECK (id ~ '^wikidata:Q[0-9]+$'),
    city_id     text NOT NULL REFERENCES odft_app.reference_cities (id),
    name        text NOT NULL CHECK (length(name) > 0),
    lat         double precision NOT NULL CHECK (lat BETWEEN -90 AND 90),
    lon         double precision NOT NULL CHECK (lon BETWEEN -180 AND 180),
    source      text NOT NULL CHECK (source = 'wikidata'),
    source_id   text NOT NULL CHECK (source_id ~ '^Q[0-9]+$'),
    source_url  text NOT NULL CHECK (length(source_url) > 0),
    verified    boolean NOT NULL DEFAULT true,
    updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS reference_landmarks_city_idx
    ON odft_app.reference_landmarks (city_id);

CREATE TABLE IF NOT EXISTS odft_app.reference_route_evidence (
    id              text PRIMARY KEY,
    kind            text NOT NULL CHECK (kind IN ('ground_corridor', 'island_exception', 'curated_direct')),
    origin_ref      text NOT NULL CHECK (length(origin_ref) > 0),
    destination_ref text NOT NULL CHECK (length(destination_ref) > 0),
    minutes         integer CHECK (minutes IS NULL OR minutes >= 0),
    details         text,
    evidence_refs   jsonb NOT NULL DEFAULT '[]'::jsonb
);

CREATE INDEX IF NOT EXISTS reference_route_evidence_kind_idx
    ON odft_app.reference_route_evidence (kind);

CREATE TABLE IF NOT EXISTS odft_app.reference_manifests (
    source            text PRIMARY KEY,
    url               text NOT NULL CHECK (length(url) > 0),
    retrieved_at      text NOT NULL CHECK (length(retrieved_at) > 0),
    revision          text,
    sha256            text NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
    license           text NOT NULL CHECK (length(license) > 0),
    license_url       text,
    transform_version text NOT NULL CHECK (length(transform_version) > 0),
    record_count      integer NOT NULL CHECK (record_count >= 0),
    rejected_count    integer NOT NULL CHECK (rejected_count >= 0),
    rejected_report   jsonb NOT NULL DEFAULT '[]'::jsonb,
    attribution       text,
    loaded_at         timestamptz NOT NULL DEFAULT now()
);
