-- Phase 05 (ODTF_PLAN.md section 3.6): delegated AI governance.
--
-- Extends the existing LLM ledger with agent/delegation/task/trace correlation
-- and adds narrowly scoped SECURITY DEFINER functions so an agent process can
-- reserve and settle delegated paid calls (and mirror its task counters)
-- WITHOUT holding the coordinator's database authority. Lock order inside the
-- functions follows Section 3.8: trip -> delegation -> task counters/ledger.
--
-- Administrative creation of the agent login role and its password belongs to
-- documented local setup (scripts/setup-protocol-roles.ts), never to this file.

-- ---------------------------------------------------------------------------
-- Ledger correlation
-- ---------------------------------------------------------------------------

ALTER TABLE odft_app.llm_calls
    ADD COLUMN IF NOT EXISTS agent_identity text;
ALTER TABLE odft_app.llm_calls
    ADD COLUMN IF NOT EXISTS delegation_id uuid;
ALTER TABLE odft_app.llm_calls
    ADD COLUMN IF NOT EXISTS task_id text;
ALTER TABLE odft_app.llm_calls
    ADD COLUMN IF NOT EXISTS trace_id text;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'llm_calls_delegation_fk') THEN
        ALTER TABLE odft_app.llm_calls ADD CONSTRAINT llm_calls_delegation_fk
            FOREIGN KEY (delegation_id) REFERENCES odft_app.agent_delegations (id);
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS llm_calls_delegation_idx
    ON odft_app.llm_calls (delegation_id) WHERE delegation_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS llm_calls_task_idx
    ON odft_app.llm_calls (agent_identity, task_id) WHERE task_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Delegated reserve/settle (restricted, validated, fixed search path)
-- ---------------------------------------------------------------------------

-- Reserve one delegated paid transport attempt. Validates the service/delegation
-- binding, enforces the per-task allowance (USD mirror on the task-control row)
-- and the shared per-trip caps, then writes the ledger row with correlation and
-- mirrors the reservation on the task-control row. Mirrors the semantics of
-- `reserveCall` (worst-case ceiling, per-scope attempt bound, no recovery
-- multiplier for agents: their authority is per task, not per operation round).
CREATE OR REPLACE FUNCTION odft_app.reserve_delegated_call(
    p_agent_identity text,
    p_delegation_id uuid,
    p_task_id text,
    p_trace_id text,
    p_attempt_scope text,
    p_role text,
    p_model text,
    p_provider text,
    p_prompt_version text,
    p_mode text,
    p_pricing_version text,
    p_reserved_tokens integer,
    p_reserved_cost_usd numeric,
    p_max_call_cost_usd numeric,
    p_max_calls_per_trip integer,
    p_max_cost_usd_per_trip numeric,
    p_max_attempts_per_scope integer,
    p_task_max_cost_usd numeric
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = odft_app, pg_temp
AS $$
DECLARE
    v_delegation odft_app.agent_delegations%ROWTYPE;
    v_scope_attempts integer;
    v_trip_calls integer;
    v_trip_spent numeric;
    v_task_spent numeric;
    v_call_id uuid;
BEGIN
    SELECT * INTO v_delegation FROM odft_app.agent_delegations WHERE id = p_delegation_id;
    IF NOT FOUND THEN
        RETURN jsonb_build_object('ok', false, 'code', 'DELEGATION_REVOKED', 'message', 'delegation not found');
    END IF;
    IF v_delegation.agent_identity <> p_agent_identity THEN
        RETURN jsonb_build_object('ok', false, 'code', 'DELEGATION_REVOKED', 'message', 'delegation belongs to another agent');
    END IF;
    IF v_delegation.status NOT IN ('pending', 'dispatched', 'working', 'input_required') THEN
        RETURN jsonb_build_object('ok', false, 'code', 'DELEGATION_REVOKED', 'message', 'delegation is ' || v_delegation.status);
    END IF;
    IF v_delegation.deadline_at IS NOT NULL AND v_delegation.deadline_at < now() THEN
        RETURN jsonb_build_object('ok', false, 'code', 'INPUT_EXPIRED', 'message', 'delegation deadline passed');
    END IF;
    IF v_delegation.task_id IS DISTINCT FROM p_task_id THEN
        RETURN jsonb_build_object('ok', false, 'code', 'STALE_AGENT_RESULT', 'message', 'task is not the delegated task');
    END IF;

    -- Section 3.8 order: trip -> delegation -> task counters/ledger. The
    -- delegation is re-read UNDER its row lock and re-checked, so a concurrent
    -- revoke/expiry between the unlocked validation above and the lock cannot
    -- still admit a paid reservation.
    PERFORM 1 FROM odft_app.trips WHERE id = v_delegation.trip_id FOR UPDATE;
    SELECT * INTO v_delegation FROM odft_app.agent_delegations WHERE id = p_delegation_id FOR UPDATE;
    IF NOT FOUND
       OR v_delegation.agent_identity <> p_agent_identity
       OR v_delegation.status NOT IN ('pending', 'dispatched', 'working', 'input_required') THEN
        RETURN jsonb_build_object('ok', false, 'code', 'DELEGATION_REVOKED', 'message', 'the delegation is no longer valid for this task');
    END IF;
    IF v_delegation.deadline_at IS NOT NULL AND v_delegation.deadline_at < now() THEN
        RETURN jsonb_build_object('ok', false, 'code', 'INPUT_EXPIRED', 'message', 'delegation deadline passed');
    END IF;
    IF v_delegation.task_id IS DISTINCT FROM p_task_id THEN
        RETURN jsonb_build_object('ok', false, 'code', 'STALE_AGENT_RESULT', 'message', 'task is not the delegated task');
    END IF;

    IF p_max_call_cost_usd > 0 AND p_reserved_cost_usd > p_max_call_cost_usd THEN
        RETURN jsonb_build_object('ok', false, 'code', 'AI_BUDGET_EXCEEDED', 'message', 'worst-case call cost exceeds the profile ceiling');
    END IF;

    -- Shared trip caps use the SAME formula as the coordinator ledger
    -- (`sumTripLlmCostUsd`): a settled row counts its actual cost, a reserved
    -- row its reservation — never both.
    SELECT count(*), coalesce(sum(coalesce(actual_cost_usd, reserved_cost_usd)), 0)
      INTO v_trip_calls, v_trip_spent
      FROM odft_app.llm_calls WHERE trip_id = v_delegation.trip_id;
    IF v_trip_calls + 1 > p_max_calls_per_trip THEN
        RETURN jsonb_build_object('ok', false, 'code', 'AI_BUDGET_EXCEEDED', 'message', 'the per-trip AI call budget is exhausted');
    END IF;
    IF v_trip_spent + p_reserved_cost_usd > p_max_cost_usd_per_trip THEN
        RETURN jsonb_build_object('ok', false, 'code', 'AI_BUDGET_EXCEEDED', 'message', 'the per-trip AI cost budget is exhausted');
    END IF;

    SELECT count(*) INTO v_scope_attempts
      FROM odft_app.llm_calls
     WHERE delegation_id = p_delegation_id AND effect_scope = p_attempt_scope;
    IF v_scope_attempts + 1 > p_max_attempts_per_scope THEN
        RETURN jsonb_build_object('ok', false, 'code', 'AI_BUDGET_EXCEEDED', 'message', 'the per-scope AI attempt limit is exhausted');
    END IF;

    SELECT reserved_cost_usd + actual_cost_usd INTO v_task_spent
      FROM odft_app.protocol_task_control
     WHERE agent_identity = p_agent_identity AND task_id = p_task_id;
    IF NOT FOUND THEN
        RETURN jsonb_build_object('ok', false, 'code', 'STALE_AGENT_RESULT', 'message', 'task-control row missing');
    END IF;
    IF coalesce(v_task_spent, 0) + p_reserved_cost_usd > p_task_max_cost_usd THEN
        RETURN jsonb_build_object('ok', false, 'code', 'TASK_BUDGET_EXCEEDED', 'message', 'the task cost allowance is exhausted');
    END IF;

    INSERT INTO odft_app.llm_calls (
        id, trip_id, operation_id, role, model, provider, prompt_version, mode, effect_scope,
        pricing_version, reserved_tokens, reserved_cost_usd, attempts, status, validation_status,
        agent_identity, delegation_id, task_id, trace_id
    ) VALUES (
        gen_random_uuid(), v_delegation.trip_id, v_delegation.originating_operation_id, p_role, p_model, p_provider,
        p_prompt_version, p_mode, p_attempt_scope, p_pricing_version, p_reserved_tokens,
        p_reserved_cost_usd, 0, 'reserved', 'pending',
        p_agent_identity, p_delegation_id, p_task_id, p_trace_id
    ) RETURNING id INTO v_call_id;

    UPDATE odft_app.protocol_task_control
       SET reserved_cost_usd = reserved_cost_usd + p_reserved_cost_usd,
           llm_attempts = llm_attempts + 1,
           updated_at = now()
     WHERE agent_identity = p_agent_identity AND task_id = p_task_id;

    RETURN jsonb_build_object('ok', true, 'callId', v_call_id);
END;
$$;

-- Settle one delegated call with actual usage (mirrors `recordCallResult`); the
-- task-control mirror moves the reservation into the settled counters.
CREATE OR REPLACE FUNCTION odft_app.settle_delegated_call(
    p_agent_identity text,
    p_call_id uuid,
    p_input_tokens integer,
    p_output_tokens integer,
    p_cached_input_tokens integer,
    p_reasoning_output_tokens integer,
    p_cost_usd numeric,
    p_cost_status text,
    p_latency_ms integer,
    p_finish_reason text,
    p_attempts integer,
    p_validation_status text,
    p_error_code text
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = odft_app, pg_temp
AS $$
DECLARE
    v_call odft_app.llm_calls%ROWTYPE;
    v_status text;
BEGIN
    SELECT * INTO v_call FROM odft_app.llm_calls WHERE id = p_call_id FOR UPDATE;
    IF NOT FOUND OR v_call.agent_identity IS DISTINCT FROM p_agent_identity THEN
        RETURN false;
    END IF;
    IF v_call.status <> 'reserved' THEN
        RETURN false;
    END IF;
    v_status := CASE
        WHEN p_cost_status = 'unknown_reserved' THEN 'unknown_reserved'
        WHEN p_validation_status = 'valid' THEN 'succeeded'
        ELSE 'failed'
    END;
    UPDATE odft_app.llm_calls
       SET input_tokens = p_input_tokens,
           output_tokens = p_output_tokens,
           cached_input_tokens = p_cached_input_tokens,
           reasoning_output_tokens = p_reasoning_output_tokens,
           actual_cost_usd = CASE WHEN p_cost_usd IS NULL THEN NULL ELSE p_cost_usd END,
           cost_status = p_cost_status,
           latency_ms = p_latency_ms,
           finish_reason = p_finish_reason,
           attempts = p_attempts,
           validation_status = p_validation_status,
           error_code = p_error_code,
           status = v_status
     WHERE id = p_call_id;
    UPDATE odft_app.protocol_task_control
       SET reserved_cost_usd = greatest(reserved_cost_usd - coalesce(v_call.reserved_cost_usd, 0), 0),
           -- A null actual cost keeps the reservation charged, matching the
           -- trip-cap formula's `coalesce(actual_cost_usd, reserved_cost_usd)`.
           actual_cost_usd = actual_cost_usd + coalesce(p_cost_usd, coalesce(v_call.reserved_cost_usd, 0)),
           updated_at = now()
     WHERE agent_identity = p_agent_identity AND task_id = v_call.task_id;
    RETURN true;
END;
$$;

-- Uncertain paid outcome: keep the reservation counted (never release as free).
CREATE OR REPLACE FUNCTION odft_app.mark_delegated_call_unknown(
    p_agent_identity text,
    p_call_id uuid,
    p_reason text,
    p_latency_ms integer
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = odft_app, pg_temp
AS $$
DECLARE
    v_call odft_app.llm_calls%ROWTYPE;
BEGIN
    SELECT * INTO v_call FROM odft_app.llm_calls WHERE id = p_call_id FOR UPDATE;
    IF NOT FOUND OR v_call.agent_identity IS DISTINCT FROM p_agent_identity THEN
        RETURN false;
    END IF;
    IF v_call.status <> 'reserved' THEN
        RETURN false;
    END IF;
    UPDATE odft_app.llm_calls
       SET status = 'unknown_reserved',
           cost_status = 'unknown_reserved',
           error_code = p_reason,
           latency_ms = p_latency_ms
     WHERE id = p_call_id;
    -- The reservation stays on the task-control mirror and in the trip caps.
    RETURN true;
END;
$$;

-- Claim the canonical task binding on first use. Agents have no UPDATE grant
-- on agent_delegations: this validated function is the only mutation they can
-- perform there, and it refuses a different existing binding.
CREATE OR REPLACE FUNCTION odft_app.claim_delegated_task(
    p_agent_identity text,
    p_delegation_id uuid,
    p_task_id text
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = odft_app, pg_temp
AS $$
DECLARE
    v_rows integer;
BEGIN
    UPDATE odft_app.agent_delegations
       SET task_id = p_task_id, updated_at = now()
     WHERE id = p_delegation_id
       AND agent_identity = p_agent_identity
       AND (task_id IS NULL OR task_id = p_task_id)
       AND status IN ('pending', 'dispatched', 'working', 'input_required');
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    RETURN v_rows = 1;
END;
$$;

REVOKE ALL ON FUNCTION odft_app.claim_delegated_task(text, uuid, text) FROM PUBLIC;

REVOKE ALL ON FUNCTION odft_app.reserve_delegated_call(
    text, uuid, text, text, text, text, text, text, text, text, text,
    integer, numeric, numeric, integer, numeric, integer, numeric) FROM PUBLIC;
REVOKE ALL ON FUNCTION odft_app.settle_delegated_call(
    text, uuid, integer, integer, integer, integer, numeric, text, integer, text, integer, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION odft_app.mark_delegated_call_unknown(text, uuid, text, integer) FROM PUBLIC;
