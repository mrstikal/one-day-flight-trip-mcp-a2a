-- Phase 03 (ODTF_PLAN.md section 3.6): protocol state, engine identity and the
-- official SDK task storage.
--
-- This migration is additive: every existing trip/operation/decision keeps the
-- `langgraph` engine by default, no user trip is archived and the production
-- default engine does not change. `coordinator-v1` records exist only for
-- explicitly created migration/interoperability test trips until Phase 11.
--
-- The `odft_protocol` task tables are the official `@a2a-js/sdk@1.3.0` schema,
-- generated offline with `a2a-db upgrade --sql --dialect postgres --store tasks
-- --tasks-table-name <name>` and reviewed; the SDK never runs untracked schema
-- upgrades at service startup.

-- ---------------------------------------------------------------------------
-- Engine identity and history/archive metadata
-- ---------------------------------------------------------------------------

ALTER TABLE odft_app.trips
    ADD COLUMN IF NOT EXISTS engine text NOT NULL DEFAULT 'langgraph';
ALTER TABLE odft_app.trips
    ADD COLUMN IF NOT EXISTS archived_at timestamptz;
ALTER TABLE odft_app.trips
    ADD COLUMN IF NOT EXISTS archive_reason text;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'trips_engine_check') THEN
        ALTER TABLE odft_app.trips ADD CONSTRAINT trips_engine_check
            CHECK (engine IN ('langgraph', 'coordinator-v1'));
    END IF;
END $$;

ALTER TABLE odft_app.workflow_operations
    ADD COLUMN IF NOT EXISTS engine text NOT NULL DEFAULT 'langgraph';

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'workflow_operations_engine_check') THEN
        ALTER TABLE odft_app.workflow_operations ADD CONSTRAINT workflow_operations_engine_check
            CHECK (engine IN ('langgraph', 'coordinator-v1'));
    END IF;
END $$;

-- ---------------------------------------------------------------------------
-- Coordinator runs (typed cursor; domain entities stay in their own tables)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS odft_app.coordinator_runs (
    id                  uuid PRIMARY KEY,
    trip_id             uuid NOT NULL REFERENCES odft_app.trips (id),
    operation_id        uuid REFERENCES odft_app.workflow_operations (id),
    coordinator_version text NOT NULL CHECK (coordinator_version = 'coordinator-v1'),
    accepted_revision   integer NOT NULL CHECK (accepted_revision >= 0),
    step                text NOT NULL CHECK (step IN (
        'initializing','interpreting','validating_route','requesting_flights','researching',
        'validating_logistics','planning','awaiting_user','completed','failed','cancelled')),
    wait_reason         text CHECK (wait_reason IN (
        'flight_choice','booking_confirmation','replacement_confirmation','hotel_choice',
        'program_choices','itinerary_approval','route_change_confirmation','clarification',
        'recovery','agent_input')),
    status              text NOT NULL DEFAULT 'running' CHECK (status IN (
        'running','waiting','completed','failed','cancelled')),
    state_version       integer NOT NULL DEFAULT 1 CHECK (state_version >= 1),
    -- Minimal schema-versioned execution data (references only, never a copy of
    -- the trip); validated by `coordinatorRunDataSchema` in contracts.
    run_data            jsonb NOT NULL,
    failure_code        text,
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now(),
    -- Waiting runs must name a typed wait reason; active/finished runs must not.
    CONSTRAINT coordinator_runs_wait_reason CHECK (
        (status = 'waiting') = (wait_reason IS NOT NULL)
    )
);

CREATE INDEX IF NOT EXISTS coordinator_runs_trip_idx
    ON odft_app.coordinator_runs (trip_id, status);
CREATE INDEX IF NOT EXISTS coordinator_runs_operation_idx
    ON odft_app.coordinator_runs (operation_id) WHERE operation_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Engine-aware pending decisions
-- ---------------------------------------------------------------------------

ALTER TABLE odft_app.pending_decisions
    ADD COLUMN IF NOT EXISTS engine text NOT NULL DEFAULT 'langgraph';
ALTER TABLE odft_app.pending_decisions
    ADD COLUMN IF NOT EXISTS coordinator_run_id uuid;

-- Graph decisions keep their checkpoint binding; coordinator decisions bind the
-- exact run and must not invent graph ids.
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'pending_decisions_engine_check') THEN
        ALTER TABLE odft_app.pending_decisions ADD CONSTRAINT pending_decisions_engine_check
            CHECK (engine IN ('langgraph', 'coordinator-v1'));
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'pending_decisions_engine_binding_check') THEN
        ALTER TABLE odft_app.pending_decisions ADD CONSTRAINT pending_decisions_engine_binding_check
            CHECK (
                (engine = 'langgraph' AND thread_id IS NOT NULL AND graph_version IS NOT NULL
                    AND coordinator_run_id IS NULL)
                OR (engine = 'coordinator-v1' AND thread_id IS NULL AND graph_version IS NULL
                    AND coordinator_run_id IS NOT NULL)
            );
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'pending_decisions_coordinator_run_fk') THEN
        ALTER TABLE odft_app.pending_decisions ADD CONSTRAINT pending_decisions_coordinator_run_fk
            FOREIGN KEY (coordinator_run_id) REFERENCES odft_app.coordinator_runs (id);
    END IF;
END $$;

-- Coordinator decisions have no checkpoint identifiers.
ALTER TABLE odft_app.pending_decisions ALTER COLUMN thread_id DROP NOT NULL;
ALTER TABLE odft_app.pending_decisions ALTER COLUMN graph_version DROP NOT NULL;

-- Extend the decision-kind vocabulary with the genuine specialist question.
ALTER TABLE odft_app.pending_decisions DROP CONSTRAINT IF EXISTS pending_decisions_kind_check;
ALTER TABLE odft_app.pending_decisions ADD CONSTRAINT pending_decisions_kind_check
    CHECK (kind IN (
        'flight_choice','hotel_choice','program_choices','booking_confirmation','replacement_confirmation',
        'route_change_confirmation','itinerary_approval','clarification','recovery','agent_input'));

-- ---------------------------------------------------------------------------
-- Agent delegations and durable outbound messages
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS odft_app.agent_delegations (
    id                       uuid PRIMARY KEY,
    trip_id                  uuid NOT NULL REFERENCES odft_app.trips (id),
    originating_operation_id uuid NOT NULL REFERENCES odft_app.workflow_operations (id),
    current_operation_id     uuid REFERENCES odft_app.workflow_operations (id),
    accepted_revision        integer NOT NULL CHECK (accepted_revision >= 0),
    skill_id                 text NOT NULL,
    agent_identity           text NOT NULL,
    endpoint_url             text NOT NULL,
    card_version             text,
    snapshot_id              uuid NOT NULL,
    input_fingerprint        text NOT NULL CHECK (input_fingerprint ~ '^[a-f0-9]{64}$'),
    scope                    jsonb NOT NULL,
    task_id                  text,
    context_id               text,
    status                   text NOT NULL DEFAULT 'pending' CHECK (status IN (
        'pending','dispatched','working','input_required','completed','failed','cancelled','revoked')),
    deadline_at              timestamptz,
    attempt                  integer NOT NULL DEFAULT 1 CHECK (attempt >= 1),
    revoked_at               timestamptz,
    revoke_reason            text,
    accepted_artifact_hash   text CHECK (accepted_artifact_hash ~ '^[a-f0-9]{64}$'),
    cancellation_requested_at timestamptz,
    cancellation_state       text CHECK (cancellation_state IN ('pending','acknowledged','failed')),
    created_at               timestamptz NOT NULL DEFAULT now(),
    updated_at               timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS agent_delegations_outstanding_idx
    ON odft_app.agent_delegations (trip_id, status)
    WHERE status IN ('pending','dispatched','working','input_required');
CREATE INDEX IF NOT EXISTS agent_delegations_cancel_pending_idx
    ON odft_app.agent_delegations (cancellation_state)
    WHERE cancellation_state = 'pending';
CREATE INDEX IF NOT EXISTS agent_delegations_task_idx
    ON odft_app.agent_delegations (agent_identity, task_id) WHERE task_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS odft_app.protocol_outbound_messages (
    id                     uuid PRIMARY KEY,
    delegation_id          uuid NOT NULL REFERENCES odft_app.agent_delegations (id),
    message_id             text NOT NULL,
    -- Canonical hash of the immutable serialized application payload below.
    payload_hash           text NOT NULL CHECK (payload_hash ~ '^[a-f0-9]{64}$'),
    payload                jsonb NOT NULL,
    delivery_state         text NOT NULL DEFAULT 'pending' CHECK (delivery_state IN (
        'pending','delivered','acknowledged','failed')),
    continuation_generation integer NOT NULL DEFAULT 1 CHECK (continuation_generation >= 1),
    attempt                integer NOT NULL DEFAULT 1 CHECK (attempt >= 1),
    last_error_code        text,
    created_at             timestamptz NOT NULL DEFAULT now(),
    delivered_at           timestamptz,
    UNIQUE (delegation_id, message_id)
);

CREATE INDEX IF NOT EXISTS protocol_outbound_pending_idx
    ON odft_app.protocol_outbound_messages (delivery_state)
    WHERE delivery_state IN ('pending','delivered');

-- ---------------------------------------------------------------------------
-- Durable inbound admission: per-agent message dedupe, task mapping, controls
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS odft_app.protocol_inbound_messages (
    id               uuid PRIMARY KEY,
    agent_identity   text NOT NULL,
    message_id       text NOT NULL,
    payload_hash     text NOT NULL CHECK (payload_hash ~ '^[a-f0-9]{64}$'),
    task_id          text,
    context_id       text,
    state            text NOT NULL DEFAULT 'admitted' CHECK (state IN (
        'admitted','mapped','completed','failed','conflicted')),
    admitted_at      timestamptz NOT NULL DEFAULT now(),
    mapped_at        timestamptz,
    last_error_code  text,
    -- One canonical admission per authenticated agent identity and message id;
    -- a conflicting payload hash for the same key is rejected, never re-run.
    UNIQUE (agent_identity, message_id)
);

CREATE INDEX IF NOT EXISTS protocol_inbound_unmapped_idx
    ON odft_app.protocol_inbound_messages (agent_identity)
    WHERE state = 'admitted';

CREATE TABLE IF NOT EXISTS odft_app.protocol_task_control (
    agent_identity      text NOT NULL,
    task_id             text NOT NULL,
    context_id          text NOT NULL,
    -- SDK store scope tenant of the task (the SDK keys rows by tenant+owner+id).
    tenant              text NOT NULL DEFAULT '',
    delegation_id       uuid REFERENCES odft_app.agent_delegations (id),
    -- Active execution owner (one service process, guarded by a service lock).
    active_owner        text,
    state               text NOT NULL DEFAULT 'submitted' CHECK (state IN (
        'submitted','working','input_required','completed','failed','cancelled')),
    active_time_ms      bigint NOT NULL DEFAULT 0 CHECK (active_time_ms >= 0),
    mcp_invocations     integer NOT NULL DEFAULT 0 CHECK (mcp_invocations >= 0),
    llm_attempts        integer NOT NULL DEFAULT 0 CHECK (llm_attempts >= 0),
    input_count         integer NOT NULL DEFAULT 0 CHECK (input_count >= 0),
    reserved_cost_usd   numeric(18,9) NOT NULL DEFAULT 0 CHECK (reserved_cost_usd >= 0),
    actual_cost_usd     numeric(18,9) NOT NULL DEFAULT 0 CHECK (actual_cost_usd >= 0),
    input_generation    integer NOT NULL DEFAULT 1 CHECK (input_generation >= 1),
    cancel_requested_at timestamptz,
    restart_failed_at   timestamptz,
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (agent_identity, task_id)
);

CREATE INDEX IF NOT EXISTS protocol_task_control_state_idx
    ON odft_app.protocol_task_control (agent_identity, state);
CREATE INDEX IF NOT EXISTS protocol_task_control_restart_idx
    ON odft_app.protocol_task_control (agent_identity)
    WHERE state IN ('submitted','working') AND restart_failed_at IS NULL;

-- Cache of validated agent outputs (accepted artifacts keyed by payload hash).
CREATE TABLE IF NOT EXISTS odft_app.protocol_validated_outputs (
    id             uuid PRIMARY KEY,
    agent_identity text NOT NULL,
    task_id        text NOT NULL,
    artifact_kind  text NOT NULL,
    payload_hash   text NOT NULL CHECK (payload_hash ~ '^[a-f0-9]{64}$'),
    payload        jsonb NOT NULL,
    accepted       boolean NOT NULL DEFAULT true,
    validated_at   timestamptz NOT NULL DEFAULT now(),
    UNIQUE (agent_identity, task_id, artifact_kind, payload_hash)
);

-- ---------------------------------------------------------------------------
-- Safe protocol observations (+ idempotent application-event link)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS odft_app.protocol_observations (
    id                   uuid PRIMARY KEY,
    source               text NOT NULL,
    kind                 text NOT NULL,
    trip_id              uuid REFERENCES odft_app.trips (id),
    operation_id         uuid REFERENCES odft_app.workflow_operations (id),
    delegation_id        uuid REFERENCES odft_app.agent_delegations (id),
    task_id              text,
    context_id           text,
    trace_id             text,
    -- Sanitized safe payload only (never prompts, tokens or raw bodies).
    payload              jsonb NOT NULL,
    payload_hash         text NOT NULL CHECK (payload_hash ~ '^[a-f0-9]{64}$'),
    occurred_at          timestamptz NOT NULL,
    created_at           timestamptz NOT NULL DEFAULT now(),
    -- Set once when the observation was bridged to an execution event; the
    -- unique link makes SSE ingestion idempotent.
    application_event_id bigint UNIQUE REFERENCES odft_app.execution_events (id)
);

CREATE INDEX IF NOT EXISTS protocol_observations_uningested_idx
    ON odft_app.protocol_observations (created_at) WHERE application_event_id IS NULL;
CREATE INDEX IF NOT EXISTS protocol_observations_trip_idx
    ON odft_app.protocol_observations (trip_id, occurred_at);
CREATE INDEX IF NOT EXISTS protocol_observations_operation_idx
    ON odft_app.protocol_observations (operation_id, occurred_at) WHERE operation_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Official SDK task storage (generated by a2a-db 1.3.0, reviewed)
-- ---------------------------------------------------------------------------

CREATE SCHEMA IF NOT EXISTS odft_protocol;

DO $$
DECLARE
    task_table   text;
    ledger_table text;
BEGIN
    FOREACH task_table IN ARRAY ARRAY[
        'agent_tasks_flight',
        'agent_tasks_accommodation',
        'agent_tasks_city_guide',
        'agent_tasks_accommodation_alt'
    ]
    LOOP
        ledger_table := 'a2a_' || task_table || '_migrations';
        -- SDK migration ledger, kept in step so `a2a-db status` stays accurate
        -- while the schema itself is owned by this checksummed migration.
        EXECUTE format(
            'CREATE TABLE IF NOT EXISTS odft_protocol.%I (' ||
            '"name" varchar(255) not null primary key, "timestamp" varchar(255) not null)',
            ledger_table);
        -- Official `a2a-db upgrade --sql --dialect postgres --store tasks` DDL.
        EXECUTE format(
            'CREATE TABLE IF NOT EXISTS odft_protocol.%I (' ||
            '"tenant" varchar(255) collate "C" not null, ' ||
            '"owner" varchar(255) collate "C" not null, ' ||
            '"id" varchar(36) collate "C" not null, ' ||
            '"context_id" varchar(36) collate "C" not null, ' ||
            '"status_last_updated" bigint not null, ' ||
            '"status_state" varchar(255) collate "C", ' ||
            '"status" text, "artifacts" text, "history" text, "metadata" text, ' ||
            '"protocol_version" varchar(255), ' ||
            'constraint %I primary key ("tenant", "owner", "id"))',
            task_table, task_table || '_pkey');
        EXECUTE format(
            'CREATE INDEX IF NOT EXISTS %I ON odft_protocol.%I ("tenant", "owner", "status_last_updated", "id")',
            task_table || '_scope_updated_idx', task_table);
        EXECUTE format(
            'CREATE INDEX IF NOT EXISTS %I ON odft_protocol.%I ("tenant", "owner", "context_id", "status_last_updated", "id")',
            task_table || '_scope_context_updated_idx', task_table);
        EXECUTE format(
            'INSERT INTO odft_protocol.%I ("name", "timestamp") VALUES (%L, %L) ON CONFLICT ("name") DO NOTHING',
            ledger_table, '0001_create_tasks', '2026-10-16T21:57:29.196Z');
    END LOOP;
END $$;
