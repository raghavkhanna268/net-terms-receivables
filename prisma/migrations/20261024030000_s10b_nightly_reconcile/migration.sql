-- S10b: Nightly reconcile cron + bulk ingestion
--
-- This migration:
-- 1. Creates s10b_order_refetch_null aggregate table (shop, day, count)
-- 2. Creates s10b_call_reconcile function to call drain endpoint
-- 3. Schedules pg_cron nightly reconcile job (02:00 UTC daily)
--
-- The heavy processing happens in the Worker:
-- 1. pg_cron calls s10b_call_reconcile() at 02:00 UTC daily
-- 2. Worker's /jobs/drain?reconcile=true enqueues RECONCILE_COMPANIES per shop
-- 3. Drain processes messages, starts bulk operations
-- 4. BULK_OPERATIONS_FINISH webhook triggers JSONL download
-- 5. After companies complete, orders reconcile starts

-- =============================================================================
-- ORDER REFETCH NULL AGGREGATE TABLE
-- =============================================================================

-- Aggregate counter for orders that returned null on re-fetch (>60 days without
-- read_all_orders). No PII - just (shop, day, count) for monitoring.
CREATE TABLE IF NOT EXISTS s10b_order_refetch_null (
    shop TEXT NOT NULL,
    day DATE NOT NULL,
    count INT NOT NULL DEFAULT 1,
    PRIMARY KEY (shop, day)
);

COMMENT ON TABLE s10b_order_refetch_null IS 'S10b: Aggregate count of orders that returned null on re-fetch per shop per day. No PII.';

-- Enable RLS with no policies (blocks all access via PostgREST)
ALTER TABLE s10b_order_refetch_null ENABLE ROW LEVEL SECURITY;

-- =============================================================================
-- RECONCILE HTTP CALL FUNCTION
-- =============================================================================

-- Function to call the drain endpoint with ?reconcile=true via pg_net
-- Reads URL and secret from Supabase Vault at runtime
CREATE OR REPLACE FUNCTION public.s10b_call_reconcile()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $cron$
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
        RAISE NOTICE 's10b_call_reconcile: jobs_drain_url not found in Vault, skipping';
        RETURN;
    END IF;

    IF drain_secret IS NULL THEN
        RAISE NOTICE 's10b_call_reconcile: jobs_drain_secret not found in Vault, skipping';
        RETURN;
    END IF;

    -- Call the drain endpoint with ?reconcile=true via pg_net with 60s timeout
    SELECT net.http_post(
        url := drain_url || '?reconcile=true',
        headers := jsonb_build_object(
            'Authorization', 'Bearer ' || drain_secret,
            'Content-Type', 'application/json'
        ),
        body := '{}'::jsonb,
        timeout_milliseconds := 60000
    ) INTO req_id;

    RAISE LOG 's10b_call_reconcile: initiated request %', req_id;
END;
$cron$;

-- Revoke public access
DO $revoke$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
        EXECUTE 'REVOKE EXECUTE ON FUNCTION public.s10b_call_reconcile() FROM anon';
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
        EXECUTE 'REVOKE EXECUTE ON FUNCTION public.s10b_call_reconcile() FROM authenticated';
    END IF;
    REVOKE EXECUTE ON FUNCTION public.s10b_call_reconcile() FROM PUBLIC;
END;
$revoke$;

-- =============================================================================
-- PG_CRON NIGHTLY RECONCILE JOB (guarded)
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
        RAISE NOTICE 'pg_cron not available; skipping nightly reconcile cron job (OK for CI)';
        RETURN;
    END IF;

    IF NOT net_enabled THEN
        RAISE NOTICE 'pg_net not available; skipping nightly reconcile cron job (OK for CI)';
        RETURN;
    END IF;

    -- Unschedule existing job if it exists (idempotent)
    IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 's10b_nightly_reconcile') THEN
        PERFORM cron.unschedule('s10b_nightly_reconcile');
        RAISE NOTICE 'Unscheduled existing s10b_nightly_reconcile job';
    END IF;

    -- Schedule nightly reconcile at 02:00 UTC daily
    -- This calls the HTTP endpoint which enqueues messages and runs drain
    PERFORM cron.schedule(
        's10b_nightly_reconcile',
        '0 2 * * *',
        $cmd$SELECT public.s10b_call_reconcile()$cmd$
    );
    RAISE NOTICE 'Scheduled s10b_nightly_reconcile cron job (02:00 UTC daily)';

    -- Add comment
    COMMENT ON FUNCTION public.s10b_call_reconcile IS 'S10b: Calls drain endpoint with ?reconcile=true via pg_net';

END;
$do$;

-- =============================================================================
-- 90-DAY RETENTION PURGE FOR ORDER REFETCH NULL (guarded)
-- =============================================================================

DO $do$
DECLARE
    cron_enabled BOOLEAN := FALSE;
BEGIN
    -- Check if pg_cron is available
    SELECT EXISTS(
        SELECT 1 FROM pg_extension WHERE extname = 'pg_cron'
    ) INTO cron_enabled;

    IF NOT cron_enabled THEN
        RAISE NOTICE 'pg_cron not available; skipping 90-day retention purge job (OK for CI)';
        RETURN;
    END IF;

    -- Unschedule existing job if it exists (idempotent)
    IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 's10b_purge_old_refetch_null') THEN
        PERFORM cron.unschedule('s10b_purge_old_refetch_null');
    END IF;

    -- Schedule daily purge of records older than 90 days (04:00 UTC)
    PERFORM cron.schedule(
        's10b_purge_old_refetch_null',
        '0 4 * * *',
        $cmd$DELETE FROM s10b_order_refetch_null WHERE day < CURRENT_DATE - INTERVAL '90 days'$cmd$
    );
    RAISE NOTICE 'Scheduled s10b_purge_old_refetch_null cron job (04:00 UTC daily, 90-day retention)';

END;
$do$;
