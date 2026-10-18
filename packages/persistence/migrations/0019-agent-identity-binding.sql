-- Phase 12 CR: bind protocol ledger/task identities to the database login.
--
-- The Phase 05 governance functions are SECURITY DEFINER and accept a
-- caller-supplied `p_agent_identity`. Without a login binding, any specialist
-- role could settle another specialist's reserved calls or rewrite its task
-- counters by passing that identity. The triggers below validate the identity
-- column against `session_user` (the original login, even inside a SECURITY
-- DEFINER function) for every INSERT/UPDATE/DELETE.
--
-- The database owner and superusers are allowed so migrations, the worker, the
-- coordinator and direct-SQL integration tests keep working; production agent
-- roles are ordinary LOGIN roles and are constrained by the mapping.

CREATE TABLE IF NOT EXISTS odft_app.protocol_agent_logins (
    role_name      text NOT NULL,
    agent_identity text NOT NULL,
    PRIMARY KEY (role_name, agent_identity)
);

INSERT INTO odft_app.protocol_agent_logins (role_name, agent_identity)
VALUES
    ('odft_flight_agent', 'flight-agent'),
    ('odft_accommodation_agent', 'accommodation-agent'),
    ('odft_accommodation_agent', 'accommodation-agent-alt'),
    ('odft_city_guide_agent', 'city-guide-agent')
ON CONFLICT (role_name, agent_identity) DO NOTHING;

-- True when the current login may act as `p_identity`. NULL identities are
-- allowed for the nullable coordinator ledger columns; owner/superuser sessions
-- bypass the mapping.
CREATE OR REPLACE FUNCTION odft_app.agent_identity_allowed(p_identity text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = odft_app, pg_temp
AS $$
    SELECT
        p_identity IS NULL
        OR EXISTS (
            SELECT 1
              FROM pg_database d
              JOIN pg_roles r ON r.oid = d.datdba
             WHERE d.datname = current_database()
               AND r.rolname = session_user
        )
        OR EXISTS (
            SELECT 1 FROM pg_roles
             WHERE rolname = session_user AND rolsuper
        )
        OR EXISTS (
            SELECT 1
              FROM odft_app.protocol_agent_logins
             WHERE role_name = session_user
               AND agent_identity = p_identity
        );
$$;

REVOKE ALL ON FUNCTION odft_app.agent_identity_allowed(text) FROM PUBLIC;

CREATE OR REPLACE FUNCTION odft_app.assert_agent_identity_column()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = odft_app, pg_temp
AS $$
BEGIN
    IF NOT odft_app.agent_identity_allowed(NEW.agent_identity) THEN
        RAISE EXCEPTION 'agent identity % is not bound to login %',
            NEW.agent_identity, session_user
            USING ERRCODE = '42501';
    END IF;
    -- On UPDATE, an agent must not re-parent another agent's row to itself
    -- (which would remove the victim's dedupe/counter key).
    IF TG_OP = 'UPDATE'
       AND OLD.agent_identity IS DISTINCT FROM NEW.agent_identity
       AND NOT odft_app.agent_identity_allowed(OLD.agent_identity) THEN
        RAISE EXCEPTION 'agent identity % is not bound to login %',
            OLD.agent_identity, session_user
            USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION odft_app.assert_agent_identity_delete()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = odft_app, pg_temp
AS $$
BEGIN
    IF NOT odft_app.agent_identity_allowed(OLD.agent_identity) THEN
        RAISE EXCEPTION 'agent identity % is not bound to login %',
            OLD.agent_identity, session_user
            USING ERRCODE = '42501';
    END IF;
    RETURN OLD;
END;
$$;

CREATE OR REPLACE FUNCTION odft_app.assert_task_owner_column()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = odft_app, pg_temp
AS $$
BEGIN
    IF NOT odft_app.agent_identity_allowed(NEW."owner") THEN
        RAISE EXCEPTION 'task owner % is not bound to login %',
            NEW."owner", session_user
            USING ERRCODE = '42501';
    END IF;
    IF TG_OP = 'UPDATE'
       AND OLD."owner" IS DISTINCT FROM NEW."owner"
       AND NOT odft_app.agent_identity_allowed(OLD."owner") THEN
        RAISE EXCEPTION 'task owner % is not bound to login %',
            OLD."owner", session_user
            USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION odft_app.assert_task_owner_delete()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = odft_app, pg_temp
AS $$
BEGIN
    IF NOT odft_app.agent_identity_allowed(OLD."owner") THEN
        RAISE EXCEPTION 'task owner % is not bound to login %',
            OLD."owner", session_user
            USING ERRCODE = '42501';
    END IF;
    RETURN OLD;
END;
$$;

DO $$
DECLARE
    table_name text;
BEGIN
    FOREACH table_name IN ARRAY ARRAY[
        'protocol_task_control',
        'protocol_inbound_messages',
        'protocol_validated_outputs',
        'agent_delegations'
    ]
    LOOP
        EXECUTE format(
            'DROP TRIGGER IF EXISTS %I ON odft_app.%I',
            table_name || '_identity_guard', table_name);
        EXECUTE format(
            'CREATE TRIGGER %I BEFORE INSERT OR UPDATE ON odft_app.%I ' ||
            'FOR EACH ROW EXECUTE FUNCTION odft_app.assert_agent_identity_column()',
            table_name || '_identity_guard', table_name);
        EXECUTE format(
            'DROP TRIGGER IF EXISTS %I ON odft_app.%I',
            table_name || '_identity_delete_guard', table_name);
        EXECUTE format(
            'CREATE TRIGGER %I BEFORE DELETE ON odft_app.%I ' ||
            'FOR EACH ROW EXECUTE FUNCTION odft_app.assert_agent_identity_delete()',
            table_name || '_identity_delete_guard', table_name);
    END LOOP;

    -- Delegated ledger rows: the coordinator may write NULL identities, agents
    -- may only write their own.
    DROP TRIGGER IF EXISTS llm_calls_identity_guard ON odft_app.llm_calls;
    CREATE TRIGGER llm_calls_identity_guard
        BEFORE INSERT OR UPDATE ON odft_app.llm_calls
        FOR EACH ROW EXECUTE FUNCTION odft_app.assert_agent_identity_column();
    DROP TRIGGER IF EXISTS llm_calls_identity_delete_guard ON odft_app.llm_calls;
    CREATE TRIGGER llm_calls_identity_delete_guard
        BEFORE DELETE ON odft_app.llm_calls
        FOR EACH ROW EXECUTE FUNCTION odft_app.assert_agent_identity_delete();

    -- SDK task tables use `owner`, not `agent_identity`.
    FOREACH table_name IN ARRAY ARRAY[
        'agent_tasks_flight',
        'agent_tasks_accommodation',
        'agent_tasks_city_guide',
        'agent_tasks_accommodation_alt'
    ]
    LOOP
        EXECUTE format(
            'DROP TRIGGER IF EXISTS %I ON odft_protocol.%I',
            table_name || '_owner_guard', table_name);
        EXECUTE format(
            'CREATE TRIGGER %I BEFORE INSERT OR UPDATE ON odft_protocol.%I ' ||
            'FOR EACH ROW EXECUTE FUNCTION odft_app.assert_task_owner_column()',
            table_name || '_owner_guard', table_name);
        EXECUTE format(
            'DROP TRIGGER IF EXISTS %I ON odft_protocol.%I',
            table_name || '_owner_delete_guard', table_name);
        EXECUTE format(
            'CREATE TRIGGER %I BEFORE DELETE ON odft_protocol.%I ' ||
            'FOR EACH ROW EXECUTE FUNCTION odft_app.assert_task_owner_delete()',
            table_name || '_owner_delete_guard', table_name);
    END LOOP;
END $$;
