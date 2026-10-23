-- S10b: Nightly reconcile cron + drift report
--
-- This migration:
-- 1. Creates the s10b_reconcile_drift table for drift reports
-- 2. Creates s10b_enqueue_reconcile function to queue reconcile messages
-- 3. Creates s10b_call_reconcile function to call drain endpoint with ?reconcile=true
-- 4. Schedules pg_cron nightly reconcile job (02:00 UTC daily)
--
-- The heavy processing happens in the Worker:
-- 1. pg_cron calls s10b_call_reconcile() at 02:00 UTC daily
-- 2. Worker's /jobs/drain?reconcile=true enqueues RECONCILE_* messages per shop
-- 3. Drain processes messages, starts bulk operations
-- 4. BULK_OPERATIONS_FINISH webhook triggers JSONL download
-- 5. After processing, drift report is generated and saved

-- =============================================================================
-- DRIFT REPORT TABLE
-- =============================================================================

CREATE TABLE IF NOT EXISTS s10b_reconcile_drift (
    id BIGSERIAL PRIMARY KEY,
    shop TEXT NOT NULL,
    reconcile_date DATE NOT NULL,
    kind TEXT NOT NULL, -- 'companies' or 'orders'
    -- Drift counts by category
    missing_local INT NOT NULL DEFAULT 0,   -- In Shopify, not in local ledger
    missing_shopify INT NOT NULL DEFAULT 0, -- In local ledger, not in Shopify
    status_mismatch INT NOT NULL DEFAULT 0, -- Status differs
    amount_mismatch INT NOT NULL DEFAULT 0, -- Amount differs
    total_shopify INT NOT NULL DEFAULT 0,   -- Total count from Shopify
    total_local INT NOT NULL DEFAULT 0,     -- Total count in local ledger
    -- Timing
    started_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
    completed_at TIMESTAMPTZ(6),
    -- Metadata (no PII - just GIDs for investigation)
    sample_missing_local JSONB,  -- Up to 10 GIDs
    sample_missing_shopify JSONB, -- Up to 10 GIDs
    UNIQUE(shop, reconcile_date, kind)
);

CREATE INDEX IF NOT EXISTS idx_s10b_reconcile_drift_shop_date
    ON s10b_reconcile_drift(shop, reconcile_date DESC);

COMMENT ON TABLE s10b_reconcile_drift IS 'S10b drift report: Nightly comparison of Shopify vs local ledger';

-- Enable RLS with no policies (blocks all access via PostgREST)
ALTER TABLE s10b_reconcile_drift ENABLE ROW LEVEL SECURITY;

-- =============================================================================
-- BULK OPERATION PROGRESS TABLE (chunked JSONL download tracking)
-- =============================================================================

-- Add partial_line column to s6_bulk_operations for line-split handling
ALTER TABLE s6_bulk_operations
  ADD COLUMN IF NOT EXISTS partial_line TEXT DEFAULT '';

-- =============================================================================
-- RECONCILE ENQUEUE FUNCTION
-- =============================================================================

-- Function to enqueue reconcile messages for all installed (non-uninstalled) shops
-- Called by the Worker's /jobs/drain?reconcile=true endpoint
-- This is NOT called by pg_cron directly - pg_cron calls the HTTP endpoint
CREATE OR REPLACE FUNCTION public.s10b_enqueue_reconcile()
RETURNS TABLE(shop TEXT, messages_enqueued INT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $func$
DECLARE
    shop_record RECORD;
    today_str TEXT;
    webhook_id_companies TEXT;
    webhook_id_orders TEXT;
    msg_companies JSONB;
    msg_orders JSONB;
BEGIN
    today_str := to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD');
    
    FOR shop_record IN 
        SELECT domain FROM "Shop" WHERE "uninstalledAt" IS NULL
    LOOP
        -- Generate idempotent webhookIds
        webhook_id_companies := 'reconcile:' || shop_record.domain || ':' || today_str || ':companies';
        webhook_id_orders := 'reconcile:' || shop_record.domain || ':' || today_str || ':orders';
        
        -- Build messages
        msg_companies := jsonb_build_object(
            'topic', 'RECONCILE_COMPANIES',
            'shop', shop_record.domain,
            'webhookId', webhook_id_companies,
            'enqueuedAt', NOW()::text
        );
        
        msg_orders := jsonb_build_object(
            'topic', 'RECONCILE_ORDERS',
            'shop', shop_record.domain,
            'webhookId', webhook_id_orders,
            'enqueuedAt', NOW()::text
        );
        
        -- Enqueue to s6_sync
        PERFORM pgmq.send('s6_sync', msg_companies);
        PERFORM pgmq.send('s6_sync', msg_orders);
        
        shop := shop_record.domain;
        messages_enqueued := 2;
        RETURN NEXT;
    END LOOP;
END;
$func$;

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
        EXECUTE 'REVOKE EXECUTE ON FUNCTION public.s10b_enqueue_reconcile() FROM anon';
        EXECUTE 'REVOKE EXECUTE ON FUNCTION public.s10b_call_reconcile() FROM anon';
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
        EXECUTE 'REVOKE EXECUTE ON FUNCTION public.s10b_enqueue_reconcile() FROM authenticated';
        EXECUTE 'REVOKE EXECUTE ON FUNCTION public.s10b_call_reconcile() FROM authenticated';
    END IF;
    REVOKE EXECUTE ON FUNCTION public.s10b_enqueue_reconcile() FROM PUBLIC;
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

    -- Add comments
    COMMENT ON FUNCTION public.s10b_enqueue_reconcile IS 'S10b: Enqueues RECONCILE_* messages per installed shop';
    COMMENT ON FUNCTION public.s10b_call_reconcile IS 'S10b: Calls drain endpoint with ?reconcile=true via pg_net';

END;
$do$;

-- =============================================================================
-- ORDER REFETCH NULL COUNTER TABLE
-- =============================================================================

CREATE TABLE IF NOT EXISTS s10b_order_refetch_null (
    id BIGSERIAL PRIMARY KEY,
    shop TEXT NOT NULL,
    order_gid TEXT NOT NULL,
    topic TEXT NOT NULL,
    recorded_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_s10b_order_refetch_null_shop_date
    ON s10b_order_refetch_null(shop, recorded_at DESC);

COMMENT ON TABLE s10b_order_refetch_null IS 'S10b: Tracks orders that returned null on re-fetch (>60 days without read_all_orders)';

-- Enable RLS
ALTER TABLE s10b_order_refetch_null ENABLE ROW LEVEL SECURITY;
