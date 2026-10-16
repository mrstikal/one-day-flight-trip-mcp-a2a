-- 0008-ai.sql
-- AI call governance and conversation evolution (Phase 08).
-- Tables were created in 0003-domain.sql; this migration only evolves them.
-- Idempotent DDL; schema odft_app.

-- Cost precision: USD amounts are fixed-precision numeric(18,9) strings.
ALTER TABLE odft_app.llm_calls
    ALTER COLUMN reserved_cost_usd TYPE numeric(18, 9),
    ALTER COLUMN actual_cost_usd TYPE numeric(18, 9);

ALTER TABLE odft_app.llm_calls
    ADD COLUMN IF NOT EXISTS provider text,
    ADD COLUMN IF NOT EXISTS mode text NOT NULL DEFAULT 'openrouter',
    ADD COLUMN IF NOT EXISTS effect_scope text,
    ADD COLUMN IF NOT EXISTS pricing_version text,
    ADD COLUMN IF NOT EXISTS schema_version text,
    ADD COLUMN IF NOT EXISTS input_tokens integer CHECK (input_tokens IS NULL OR input_tokens >= 0),
    ADD COLUMN IF NOT EXISTS output_tokens integer CHECK (output_tokens IS NULL OR output_tokens >= 0),
    ADD COLUMN IF NOT EXISTS cached_input_tokens integer CHECK (cached_input_tokens IS NULL OR cached_input_tokens >= 0),
    ADD COLUMN IF NOT EXISTS reasoning_output_tokens integer CHECK (reasoning_output_tokens IS NULL OR reasoning_output_tokens >= 0),
    ADD COLUMN IF NOT EXISTS latency_ms integer CHECK (latency_ms IS NULL OR latency_ms >= 0),
    ADD COLUMN IF NOT EXISTS finish_reason text,
    ADD COLUMN IF NOT EXISTS validation_status text CHECK (validation_status IS NULL OR validation_status IN ('valid','invalid','pending')),
    ADD COLUMN IF NOT EXISTS cost_status text CHECK (cost_status IS NULL OR cost_status IN ('actual','estimated','unknown_reserved')),
    ADD COLUMN IF NOT EXISTS error_code text,
    ADD COLUMN IF NOT EXISTS reconciled_at timestamptz;

CREATE INDEX IF NOT EXISTS llm_calls_trip_idx ON odft_app.llm_calls (trip_id, created_at);

-- Conversation messages link to the admitting operation/request so a duplicate
-- requestId reuses the original message instead of appending another entry.
ALTER TABLE odft_app.conversation_messages
    ADD COLUMN IF NOT EXISTS operation_id uuid,
    ADD COLUMN IF NOT EXISTS request_id uuid;

CREATE UNIQUE INDEX IF NOT EXISTS conversation_messages_request_idx
    ON odft_app.conversation_messages (trip_id, request_id)
    WHERE request_id IS NOT NULL;

-- The clarification question/options are server-side bound state; the pending
-- decision row carries the opaque option ids, the payload carries labels.
ALTER TABLE odft_app.pending_decisions
    ADD COLUMN IF NOT EXISTS option_payload jsonb NOT NULL DEFAULT '[]'::jsonb;
