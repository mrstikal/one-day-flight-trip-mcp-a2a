-- 0003-domain.sql
-- Domain, session, proposal, reservation, operation, effect, event tables (Phase 03).
-- Idempotent DDL; schema odft_app.

CREATE TABLE IF NOT EXISTS odft_app.anonymous_sessions (
    id              uuid PRIMARY KEY,
    token_hash      text NOT NULL UNIQUE CHECK (length(token_hash) > 0),
    csrf_token_hash text NOT NULL CHECK (length(csrf_token_hash) > 0),
    created_at      timestamptz NOT NULL DEFAULT now(),
    expires_at      timestamptz NOT NULL,
    last_seen_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS odft_app.trips (
    id                        uuid PRIMARY KEY,
    session_id                uuid NOT NULL REFERENCES odft_app.anonymous_sessions (id),
    revision                  integer NOT NULL DEFAULT 1 CHECK (revision >= 0),
    user_name                 text NOT NULL CHECK (length(user_name) BETWEEN 1 AND 60),
    adults                    integer NOT NULL CHECK (adults BETWEEN 1 AND 6),
    origin_airport_id         text NOT NULL CHECK (length(origin_airport_id) > 0),
    destination_country_key   text NOT NULL CHECK (destination_country_key ~ '^[A-Z]{2}$'),
    destination_city_id       text NOT NULL CHECK (length(destination_city_id) > 0),
    sightseeing_date          date NOT NULL,
    travel_variant            text NOT NULL CHECK (travel_variant IN ('one_night', 'two_nights')),
    preferences               jsonb NOT NULL,
    active_scenario_snapshot_id uuid,
    current_route_validation_id uuid,
    current_schedule_validation_id uuid,
    current_itinerary_id      uuid,
    approved_itinerary_id     uuid,
    workflow_status           text NOT NULL DEFAULT 'idle'
        CHECK (workflow_status IN ('idle','queued','running','waiting_user','blocked','ready','failed')),
    recovery_required         boolean NOT NULL DEFAULT false,
    last_unfinished_operation_id uuid,
    graph_version             text NOT NULL,
    creation_request_id       uuid NOT NULL,
    creation_payload_hash     text NOT NULL CHECK (creation_payload_hash ~ '^[a-f0-9]{64}$'),
    created_at                timestamptz NOT NULL DEFAULT now(),
    updated_at                timestamptz NOT NULL DEFAULT now(),
    UNIQUE (session_id, creation_request_id)
);

CREATE TABLE IF NOT EXISTS odft_app.scenario_snapshots (
    id              uuid PRIMARY KEY,
    trip_id         uuid NOT NULL REFERENCES odft_app.trips (id),
    scenario_key    text NOT NULL,
    snapshot_version integer NOT NULL CHECK (snapshot_version >= 1),
    manifest        jsonb NOT NULL,
    inventory       jsonb NOT NULL,
    content_hashes  jsonb NOT NULL,
    generated_at    timestamptz NOT NULL,
    created_at      timestamptz NOT NULL DEFAULT now(),
    UNIQUE (trip_id, snapshot_version)
);

CREATE TABLE IF NOT EXISTS odft_app.route_validations (
    id              uuid PRIMARY KEY,
    trip_id         uuid NOT NULL REFERENCES odft_app.trips (id),
    fingerprint     text NOT NULL CHECK (fingerprint ~ '^[a-f0-9]{64}$'),
    policy_version  text NOT NULL,
    status          text NOT NULL CHECK (status IN ('FEASIBLE','INFEASIBLE','UNDETERMINED')),
    result          jsonb NOT NULL,
    created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS route_validations_trip_idx ON odft_app.route_validations (trip_id, created_at DESC);

CREATE TABLE IF NOT EXISTS odft_app.schedule_validations (
    id                  uuid PRIMARY KEY,
    route_validation_id uuid NOT NULL REFERENCES odft_app.route_validations (id),
    snapshot_id         uuid NOT NULL REFERENCES odft_app.scenario_snapshots (id),
    fingerprint         text NOT NULL CHECK (fingerprint ~ '^[a-f0-9]{64}$'),
    status              text NOT NULL CHECK (status IN ('VALID','NO_VALID_OFFERS')),
    result              jsonb NOT NULL,
    created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS odft_app.trip_selections (
    id                 uuid PRIMARY KEY,
    trip_id            uuid NOT NULL REFERENCES odft_app.trips (id),
    service_key        text NOT NULL CHECK (service_key IN ('flights','hotel','breakfast','lunch','dinner')),
    offer_id           text NOT NULL,
    snapshot_id        uuid NOT NULL REFERENCES odft_app.scenario_snapshots (id),
    selected_by        text NOT NULL CHECK (selected_by IN ('user','default')),
    source_fingerprint text NOT NULL CHECK (source_fingerprint ~ '^[a-f0-9]{64}$'),
    active_proposal_id uuid,
    active_reservation_id uuid,
    updated_at         timestamptz NOT NULL DEFAULT now(),
    UNIQUE (trip_id, service_key)
);

CREATE TABLE IF NOT EXISTS odft_app.selection_proposals (
    id                 uuid PRIMARY KEY,
    trip_id            uuid NOT NULL REFERENCES odft_app.trips (id),
    service_key        text NOT NULL CHECK (service_key IN ('flights','hotel','breakfast','lunch','dinner')),
    offer_id           text NOT NULL,
    snapshot_id        uuid NOT NULL REFERENCES odft_app.scenario_snapshots (id),
    status             text NOT NULL DEFAULT 'proposed'
        CHECK (status IN ('proposed','accepted','rejected','expired','superseded')),
    party_total_minor  integer NOT NULL CHECK (party_total_minor >= 0),
    price_delta_minor  integer,
    expires_at         timestamptz NOT NULL,
    created_revision   integer NOT NULL CHECK (created_revision >= 0),
    source_fingerprint text NOT NULL CHECK (source_fingerprint ~ '^[a-f0-9]{64}$'),
    impact             jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at         timestamptz NOT NULL DEFAULT now(),
    resolved_at        timestamptz
);

CREATE INDEX IF NOT EXISTS selection_proposals_trip_idx ON odft_app.selection_proposals (trip_id, status);

CREATE TABLE IF NOT EXISTS odft_app.reservations (
    id               uuid PRIMARY KEY,
    trip_id          uuid NOT NULL REFERENCES odft_app.trips (id),
    service_key      text NOT NULL CHECK (service_key IN ('flights','hotel','breakfast','lunch','dinner')),
    offer_id         text NOT NULL,
    snapshot_id      uuid NOT NULL REFERENCES odft_app.scenario_snapshots (id),
    status           text NOT NULL CHECK (status IN ('confirmed','superseded','cancelled')),
    terms_hash       text NOT NULL CHECK (terms_hash ~ '^[a-f0-9]{64}$'),
    terms            jsonb NOT NULL DEFAULT '{}'::jsonb,
    disclaimer_acknowledged boolean NOT NULL DEFAULT true,
    demo_reference   text NOT NULL UNIQUE CHECK (demo_reference ~ '^DEMO-(FLT|HTL|RST)-[0-9A-F]{20}$'),
    confirmation_key text NOT NULL CHECK (length(confirmation_key) > 0),
    proposal_id      uuid NOT NULL REFERENCES odft_app.selection_proposals (id),
    decision_id      uuid NOT NULL,
    party_total_minor integer NOT NULL CHECK (party_total_minor >= 0),
    superseded_by    uuid,
    cancel_reason    text,
    created_at       timestamptz NOT NULL DEFAULT now(),
    updated_at       timestamptz NOT NULL DEFAULT now()
);

-- At most one confirmed reservation per trip/service; checked immediately, so a
-- replacement must supersede the old row before inserting the new one.
CREATE UNIQUE INDEX IF NOT EXISTS reservations_one_confirmed_per_service
    ON odft_app.reservations (trip_id, service_key) WHERE status = 'confirmed';
CREATE UNIQUE INDEX IF NOT EXISTS reservations_trip_confirmation_key
    ON odft_app.reservations (trip_id, confirmation_key);
CREATE INDEX IF NOT EXISTS reservations_history_idx ON odft_app.reservations (trip_id, service_key, created_at DESC);

CREATE TABLE IF NOT EXISTS odft_app.pending_decisions (
    id                 uuid PRIMARY KEY,
    trip_id            uuid NOT NULL REFERENCES odft_app.trips (id),
    kind               text NOT NULL CHECK (kind IN (
        'flight_choice','hotel_choice','program_choices','booking_confirmation','replacement_confirmation',
        'route_change_confirmation','itinerary_approval','clarification','recovery')),
    thread_id          text NOT NULL,
    interrupt_id       text,
    checkpoint_id      text,
    graph_version      text NOT NULL,
    created_revision   integer NOT NULL CHECK (created_revision >= 0),
    source_fingerprint text NOT NULL CHECK (source_fingerprint ~ '^[a-f0-9]{64}$'),
    proposal_id        uuid,
    allowed_offer_ids  jsonb NOT NULL DEFAULT '[]'::jsonb,
    allowed_option_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
    payload_hash       text NOT NULL CHECK (payload_hash ~ '^[a-f0-9]{64}$'),
    status             text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','resolved','cancelled')),
    created_at         timestamptz NOT NULL DEFAULT now(),
    resolved_at        timestamptz
);

CREATE UNIQUE INDEX IF NOT EXISTS pending_decisions_one_pending_per_trip
    ON odft_app.pending_decisions (trip_id) WHERE status = 'pending';

CREATE TABLE IF NOT EXISTS odft_app.workflow_operations (
    id               uuid PRIMARY KEY,
    trip_id          uuid NOT NULL REFERENCES odft_app.trips (id),
    request_id       uuid NOT NULL,
    payload_hash     text NOT NULL CHECK (payload_hash ~ '^[a-f0-9]{64}$'),
    accepted_revision integer NOT NULL CHECK (accepted_revision >= 0),
    status           text NOT NULL DEFAULT 'queued'
        CHECK (status IN ('queued','running','waiting','succeeded','failed','cancelled')),
    kind             text NOT NULL DEFAULT 'command' CHECK (kind IN ('command','creation','decision')),
    node_name        text,
    payload          jsonb NOT NULL,
    result           jsonb,
    attempts         integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    fencing_token    bigint NOT NULL DEFAULT 0,
    lease_expires_at timestamptz,
    created_at       timestamptz NOT NULL DEFAULT now(),
    updated_at       timestamptz NOT NULL DEFAULT now(),
    UNIQUE (trip_id, request_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS workflow_operations_one_active_per_trip
    ON odft_app.workflow_operations (trip_id) WHERE status IN ('queued', 'running');

CREATE TABLE IF NOT EXISTS odft_app.workflow_effects (
    operation_id uuid NOT NULL REFERENCES odft_app.workflow_operations (id),
    node_name    text NOT NULL,
    effect_scope text NOT NULL,
    result       jsonb NOT NULL,
    created_at   timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (operation_id, node_name, effect_scope)
);

CREATE TABLE IF NOT EXISTS odft_app.execution_events (
    id           bigserial PRIMARY KEY,
    trip_id      uuid NOT NULL REFERENCES odft_app.trips (id),
    operation_id uuid,
    type         text NOT NULL,
    payload      jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS execution_events_trip_idx ON odft_app.execution_events (trip_id, id);

CREATE TABLE IF NOT EXISTS odft_app.conversation_messages (
    id             uuid PRIMARY KEY,
    trip_id        uuid NOT NULL REFERENCES odft_app.trips (id),
    sequence       integer NOT NULL CHECK (sequence >= 1),
    role           text NOT NULL CHECK (role IN ('user','assistant','system')),
    content        text NOT NULL CHECK (length(content) BETWEEN 1 AND 2000),
    interpretation jsonb,
    result         jsonb,
    created_at     timestamptz NOT NULL DEFAULT now(),
    UNIQUE (trip_id, sequence)
);

CREATE TABLE IF NOT EXISTS odft_app.conversation_summaries (
    id         uuid PRIMARY KEY,
    trip_id    uuid NOT NULL REFERENCES odft_app.trips (id),
    version    integer NOT NULL CHECK (version >= 1),
    summary    jsonb NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (trip_id, version)
);

CREATE TABLE IF NOT EXISTS odft_app.workflow_control_requests (
    id                    uuid PRIMARY KEY,
    trip_id               uuid NOT NULL REFERENCES odft_app.trips (id),
    control_request_id    uuid NOT NULL,
    payload_hash          text NOT NULL CHECK (payload_hash ~ '^[a-f0-9]{64}$'),
    original_operation_id uuid NOT NULL REFERENCES odft_app.workflow_operations (id),
    result                jsonb,
    created_at            timestamptz NOT NULL DEFAULT now(),
    UNIQUE (trip_id, control_request_id)
);

CREATE TABLE IF NOT EXISTS odft_app.recommendation_artifacts (
    id                uuid PRIMARY KEY,
    trip_id           uuid NOT NULL REFERENCES odft_app.trips (id),
    service_key       text NOT NULL,
    input_fingerprint text NOT NULL CHECK (input_fingerprint ~ '^[a-f0-9]{64}$'),
    snapshot_refs     jsonb NOT NULL DEFAULT '[]'::jsonb,
    ranked_offers     jsonb NOT NULL DEFAULT '[]'::jsonb,
    explanation       text,
    created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS odft_app.itineraries (
    id         uuid PRIMARY KEY,
    trip_id    uuid NOT NULL REFERENCES odft_app.trips (id),
    version    integer NOT NULL CHECK (version >= 1),
    events     jsonb NOT NULL,
    validation jsonb NOT NULL DEFAULT '{}'::jsonb,
    status     text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','approved','superseded')),
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (trip_id, version)
);

CREATE TABLE IF NOT EXISTS odft_app.simulation_faults (
    id           uuid PRIMARY KEY,
    trip_id      uuid NOT NULL REFERENCES odft_app.trips (id),
    operation_id uuid,
    domain       text NOT NULL,
    fault        text NOT NULL,
    state        jsonb NOT NULL DEFAULT '{}'::jsonb,
    counters     jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at   timestamptz NOT NULL DEFAULT now(),
    UNIQUE (trip_id, operation_id, domain, fault)
);

CREATE TABLE IF NOT EXISTS odft_app.rate_limit_buckets (
    scope_hash   text NOT NULL,
    endpoint     text NOT NULL,
    window_start timestamptz NOT NULL,
    count        integer NOT NULL DEFAULT 0 CHECK (count >= 0),
    PRIMARY KEY (scope_hash, endpoint, window_start)
);

CREATE TABLE IF NOT EXISTS odft_app.llm_calls (
    id                uuid PRIMARY KEY,
    trip_id           uuid,
    operation_id      uuid,
    role              text NOT NULL,
    model             text NOT NULL,
    prompt_version    text NOT NULL,
    reserved_tokens   integer NOT NULL DEFAULT 0 CHECK (reserved_tokens >= 0),
    actual_tokens     integer CHECK (actual_tokens IS NULL OR actual_tokens >= 0),
    reserved_cost_usd numeric(12, 6) NOT NULL DEFAULT 0,
    actual_cost_usd   numeric(12, 6),
    attempts          integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    status            text NOT NULL,
    created_at        timestamptz NOT NULL DEFAULT now()
);

-- Deferred foreign keys (added after all tables exist; nullable so ordering stays flexible).
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'trips_active_snapshot_fk') THEN
        ALTER TABLE odft_app.trips ADD CONSTRAINT trips_active_snapshot_fk
            FOREIGN KEY (active_scenario_snapshot_id) REFERENCES odft_app.scenario_snapshots (id);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'trips_current_route_fk') THEN
        ALTER TABLE odft_app.trips ADD CONSTRAINT trips_current_route_fk
            FOREIGN KEY (current_route_validation_id) REFERENCES odft_app.route_validations (id);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'trips_current_schedule_fk') THEN
        ALTER TABLE odft_app.trips ADD CONSTRAINT trips_current_schedule_fk
            FOREIGN KEY (current_schedule_validation_id) REFERENCES odft_app.schedule_validations (id);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'pending_decisions_proposal_fk') THEN
        ALTER TABLE odft_app.pending_decisions ADD CONSTRAINT pending_decisions_proposal_fk
            FOREIGN KEY (proposal_id) REFERENCES odft_app.selection_proposals (id);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'execution_events_operation_fk') THEN
        ALTER TABLE odft_app.execution_events ADD CONSTRAINT execution_events_operation_fk
            FOREIGN KEY (operation_id) REFERENCES odft_app.workflow_operations (id);
    END IF;
END $$;
