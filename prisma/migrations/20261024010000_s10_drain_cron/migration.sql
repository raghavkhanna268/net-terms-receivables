-- S10: Dead-letter queue, bulk operation cursor, pg_cron/pg_net jobs for drain and reconcile
--
-- This migration:
-- 1. Creates the s6_dead_letter table for failed messages
-- 2. Creates helper functions for calling drain/reconcile endpoints
-- 3. Schedules pg_cron jobs (guarded, no-op if extensions unavailable)
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

CREATE TABLE IF NOT EXISTS s6_dead_letter (
    id BIGSERIAL PRIMARY KEY,
    original_queue TEXT NOT NULL,
    original_msg_id TEXT NOT NULL,
    message JSONB NOT NULL,
    error TEXT NOT NULL,
    dead_lettered_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_s6_dead_letter_queue_time
    ON s6_dead_letter(original_queue, dead_lettered_at DESC);

COMMENT ON TABLE s6_dead_letter IS 'S10 dead-letter queue: Messages that failed after max retries';

-- Enable RLS with no policies (blocks all access via PostgREST)
ALTER TABLE s6_dead_letter ENABLE ROW LEVEL SECURITY;

-- =============================================================================
-- BULK OPERATIONS CURSOR SUPPORT
-- =============================================================================

-- Add columns to s6_bulk_operations for chunked JSONL processing
-- byte_offset: resume position for Range requests
-- completed_at: when processing finished
ALTER TABLE s6_bulk_operations
  ADD COLUMN IF NOT EXISTS byte_offset BIGINT DEFAULT 0,
  ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ(6);

-- =============================================================================
-- HELPER FUNCTIONS (top-level, no extension dependency)
-- =============================================================================

-- Function to call the drain endpoint via pg_net
-- Reads URL and secret from Supabase Vault at runtime
-- No-ops gracefully if Vault secrets are missing
CREATE OR REPLACE FUNCTION public.s10_call_drain()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $func$
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

    -- Call the drain endpoint via pg_net with 30s timeout
    SELECT net.http_post(
        url := drain_url,
        headers := jsonb_build_object(
            'Authorization', 'Bearer ' || drain_secret,
            'Content-Type', 'application/json'
        ),
        body := '{}'::jsonb,
        timeout_milliseconds := 30000
    ) INTO req_id;

    RAISE LOG 's10_call_drain: initiated request %', req_id;
END;
$func$;

-- Function to call the reconcile endpoint
-- Enqueues reconcile messages for all installed shops
CREATE OR REPLACE FUNCTION public.s10_call_reconcile()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $func$
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

    -- Call the reconcile endpoint (drain with reconcile=true) with 30s timeout
    SELECT net.http_post(
        url := drain_url || '?reconcile=true',
        headers := jsonb_build_object(
            'Authorization', 'Bearer ' || drain_secret,
            'Content-Type', 'application/json'
        ),
        body := '{}'::jsonb,
        timeout_milliseconds := 30000
    ) INTO req_id;

    RAISE LOG 's10_call_reconcile: initiated request %', req_id;
END;
$func$;

-- Revoke public access to these functions (they should only be called by pg_cron)
REVOKE EXECUTE ON FUNCTION public.s10_call_drain() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.s10_call_reconcile() FROM PUBLIC, anon, authenticated;

-- =============================================================================
-- PG_CRON JOBS (guarded)
-- =============================================================================

DO $do$
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

    -- Unschedule existing jobs if they exist (idempotent)
    IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 's10_drain_every_minute') THEN
        PERFORM cron.unschedule('s10_drain_every_minute');
    END IF;

    IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 's10_nightly_reconcile') THEN
        PERFORM cron.unschedule('s10_nightly_reconcile');
    END IF;

    IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 's10_dlq_cleanup_weekly') THEN
        PERFORM cron.unschedule('s10_dlq_cleanup_weekly');
    END IF;

    IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 's10_processed_webhooks_cleanup') THEN
        PERFORM cron.unschedule('s10_processed_webhooks_cleanup');
    END IF;

    -- Schedule the drain job to run every minute
    PERFORM cron.schedule(
        's10_drain_every_minute',
        '* * * * *',
        $cmd$SELECT public.s10_call_drain()$cmd$
    );
    RAISE NOTICE 'Scheduled s10_drain_every_minute cron job';

    -- Schedule the nightly reconcile at 20:30 UTC (02:00 IST)
    PERFORM cron.schedule(
        's10_nightly_reconcile',
        '30 20 * * *',
        $cmd$SELECT public.s10_call_reconcile()$cmd$
    );
    RAISE NOTICE 'Scheduled s10_nightly_reconcile cron job (20:30 UTC / 02:00 IST)';

    -- Schedule cleanup of dead-letter entries older than 30 days (weekly, Sunday 03:00 UTC)
    PERFORM cron.schedule(
        's10_dlq_cleanup_weekly',
        '0 3 * * 0',
        $cmd$DELETE FROM s6_dead_letter WHERE dead_lettered_at < NOW() - INTERVAL '30 days'$cmd$
    );
    RAISE NOTICE 'Scheduled s10_dlq_cleanup_weekly cron job';

    -- Schedule cleanup of processed webhooks older than 7 days (daily, 04:00 UTC)
    -- This fulfills the promise in the S6 migration comment
    PERFORM cron.schedule(
        's10_processed_webhooks_cleanup',
        '0 4 * * *',
        $cmd$DELETE FROM s6_processed_webhooks WHERE processed_at < NOW() - INTERVAL '7 days'$cmd$
    );
    RAISE NOTICE 'Scheduled s10_processed_webhooks_cleanup cron job';

    -- Add comments inside the guard since they reference the functions
    COMMENT ON FUNCTION public.s10_call_drain IS 'S10: Calls drain endpoint via pg_net using Vault secrets';
    COMMENT ON FUNCTION public.s10_call_reconcile IS 'S10: Calls reconcile endpoint via pg_net using Vault secrets';

END;
$do$;
