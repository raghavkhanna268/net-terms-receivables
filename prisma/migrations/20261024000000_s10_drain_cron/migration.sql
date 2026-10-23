-- S10: Dead-letter queue table and pg_cron/pg_net jobs for drain and reconcile
--
-- This migration:
-- 1. Creates the s6_dead_letter table for failed messages
-- 2. Schedules a pg_cron job to call the drain endpoint every minute
-- 3. Schedules a nightly reconcile job at 20:30 UTC (02:00 IST)
--
-- Vault secrets (must be created by DevOps, NOT this migration):
--   jobs_drain_url: The full URL to POST to (e.g., https://app.example.workers.dev/jobs/drain)
--   jobs_drain_secret: The Bearer token secret (matches env.JOBS_DRAIN_SECRET)
--
-- These secrets are read at runtime via vault.decrypted_secrets.
-- The migration safely no-ops if they're missing (jobs log a notice and skip).

-- =============================================================================
-- DEAD-LETTER QUEUE TABLE
-- =============================================================================

-- Table for messages that exceeded max retry attempts
CREATE TABLE IF NOT EXISTS s6_dead_letter (
    id BIGSERIAL PRIMARY KEY,
    original_queue TEXT NOT NULL,
    original_msg_id TEXT NOT NULL,
    message JSONB NOT NULL,
    error TEXT NOT NULL,
    dead_lettered_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Index for reviewing/reprocessing dead-lettered messages by queue
CREATE INDEX IF NOT EXISTS idx_s6_dead_letter_queue_time
    ON s6_dead_letter(original_queue, dead_lettered_at DESC);

COMMENT ON TABLE s6_dead_letter IS 'S10 dead-letter queue: Messages that failed after max retries';

-- =============================================================================
-- PG_CRON + PG_NET JOBS
-- =============================================================================

-- Helper function to call the drain endpoint via pg_net
-- Reads URL and secret from Supabase Vault at runtime
-- No-ops gracefully if Vault secrets are missing
DO $$
DECLARE
    cron_enabled BOOLEAN := FALSE;
    net_enabled BOOLEAN := FALSE;
BEGIN
    -- Check if pg_cron is available
    SELECT EXISTS(
        SELECT 1 FROM pg_extension WHERE extname = 'pg_cron'
    ) INTO cron_enabled;

    -- Check if pg_net is available
    SELECT EXISTS(
        SELECT 1 FROM pg_extension WHERE extname = 'pg_net'
    ) INTO net_enabled;

    IF NOT cron_enabled THEN
        RAISE NOTICE 'pg_cron not available; skipping cron job creation (OK for CI)';
        RETURN;
    END IF;

    IF NOT net_enabled THEN
        RAISE NOTICE 'pg_net not available; skipping cron job creation (OK for CI)';
        RETURN;
    END IF;

    -- Create or replace the drain caller function
    -- This function reads secrets from Vault at runtime
    EXECUTE $func$
    CREATE OR REPLACE FUNCTION s10_call_drain()
    RETURNS void
    LANGUAGE plpgsql
    SECURITY DEFINER
    AS $body$
    DECLARE
        drain_url TEXT;
        drain_secret TEXT;
        req_id BIGINT;
    BEGIN
        -- Read URL from Vault (returns NULL if not found)
        SELECT decrypted_secret INTO drain_url
        FROM vault.decrypted_secrets
        WHERE name = 'jobs_drain_url'
        LIMIT 1;

        -- Read secret from Vault (returns NULL if not found)
        SELECT decrypted_secret INTO drain_secret
        FROM vault.decrypted_secrets
        WHERE name = 'jobs_drain_secret'
        LIMIT 1;

        -- If either is missing, log and skip
        IF drain_url IS NULL THEN
            RAISE NOTICE 's10_call_drain: jobs_drain_url not found in Vault, skipping';
            RETURN;
        END IF;

        IF drain_secret IS NULL THEN
            RAISE NOTICE 's10_call_drain: jobs_drain_secret not found in Vault, skipping';
            RETURN;
        END IF;

        -- Call the drain endpoint via pg_net
        SELECT net.http_post(
            url := drain_url,
            headers := jsonb_build_object(
                'Authorization', 'Bearer ' || drain_secret,
                'Content-Type', 'application/json'
            ),
            body := '{}'::jsonb
        ) INTO req_id;

        RAISE LOG 's10_call_drain: initiated request %', req_id;
    END;
    $body$;
    $func$;

    -- Create or replace the reconcile caller function
    -- Enqueues reconcile messages for all installed shops
    EXECUTE $func$
    CREATE OR REPLACE FUNCTION s10_call_reconcile()
    RETURNS void
    LANGUAGE plpgsql
    SECURITY DEFINER
    AS $body$
    DECLARE
        drain_url TEXT;
        drain_secret TEXT;
        req_id BIGINT;
    BEGIN
        -- Read URL from Vault
        SELECT decrypted_secret INTO drain_url
        FROM vault.decrypted_secrets
        WHERE name = 'jobs_drain_url'
        LIMIT 1;

        -- Read secret from Vault
        SELECT decrypted_secret INTO drain_secret
        FROM vault.decrypted_secrets
        WHERE name = 'jobs_drain_secret'
        LIMIT 1;

        IF drain_url IS NULL OR drain_secret IS NULL THEN
            RAISE NOTICE 's10_call_reconcile: Vault secrets missing, skipping';
            RETURN;
        END IF;

        -- Call the reconcile endpoint (drain with reconcile=true)
        SELECT net.http_post(
            url := drain_url || '?reconcile=true',
            headers := jsonb_build_object(
                'Authorization', 'Bearer ' || drain_secret,
                'Content-Type', 'application/json'
            ),
            body := '{}'::jsonb
        ) INTO req_id;

        RAISE LOG 's10_call_reconcile: initiated request %', req_id;
    END;
    $body$;
    $func$;

    -- Schedule the drain job to run every minute
    -- Using cron.schedule with a unique job name so re-running is idempotent
    PERFORM cron.unschedule('s10_drain_every_minute');
    PERFORM cron.schedule(
        's10_drain_every_minute',
        '* * * * *',  -- Every minute
        $$SELECT s10_call_drain()$$
    );
    RAISE NOTICE 'Scheduled s10_drain_every_minute cron job';

    -- Schedule the nightly reconcile at 20:30 UTC (02:00 IST)
    PERFORM cron.unschedule('s10_nightly_reconcile');
    PERFORM cron.schedule(
        's10_nightly_reconcile',
        '30 20 * * *',  -- 20:30 UTC daily = 02:00 IST
        $$SELECT s10_call_reconcile()$$
    );
    RAISE NOTICE 'Scheduled s10_nightly_reconcile cron job (20:30 UTC / 02:00 IST)';

END;
$$;

-- =============================================================================
-- COMMENTS
-- =============================================================================

COMMENT ON FUNCTION s10_call_drain IS 'S10: Calls drain endpoint via pg_net using Vault secrets';
COMMENT ON FUNCTION s10_call_reconcile IS 'S10: Calls reconcile endpoint via pg_net using Vault secrets';

-- =============================================================================
-- CLEANUP OLD DEAD-LETTER ENTRIES (optional maintenance)
-- =============================================================================

-- Schedule cleanup of dead-letter entries older than 30 days
-- This runs weekly at 03:00 UTC on Sundays
DO $$
DECLARE
    cron_enabled BOOLEAN := FALSE;
BEGIN
    SELECT EXISTS(
        SELECT 1 FROM pg_extension WHERE extname = 'pg_cron'
    ) INTO cron_enabled;

    IF NOT cron_enabled THEN
        RETURN;
    END IF;

    PERFORM cron.unschedule('s10_dlq_cleanup_weekly');
    PERFORM cron.schedule(
        's10_dlq_cleanup_weekly',
        '0 3 * * 0',  -- 03:00 UTC every Sunday
        $$DELETE FROM s6_dead_letter WHERE dead_lettered_at < NOW() - INTERVAL '30 days'$$
    );
    RAISE NOTICE 'Scheduled s10_dlq_cleanup_weekly cron job';
END;
$$;
