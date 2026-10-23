-- S20: Webhook receipts table for edge-level idempotency
--
-- This migration:
-- 1. Creates webhook_receipts table for edge deduplication (before enqueue)
-- 2. Migrates existing s6_processed_webhooks data to new table
-- 3. Adds 30-day retention purge via pg_cron
-- 4. Adds triggered_at column for ordering guards in processors
--
-- Idempotency design:
--   Webhooks are deduplicated at TWO levels:
--   1. Edge (webhook route): INSERT with ON CONFLICT DO NOTHING, skip enqueue on conflict
--   2. Processor (drain): Check webhook_receipts before processing (handles retries)
--
-- The edge check prevents duplicate enqueues when Shopify retries webhooks.
-- The processor check provides belt-and-suspenders safety for queue retries.
--
-- Ordering guards:
--   Processors compare X-Shopify-Triggered-At (stored as triggered_at) against
--   existing data's updated_at. Older events never overwrite newer data.

-- =============================================================================
-- WEBHOOK RECEIPTS TABLE
-- =============================================================================

CREATE TABLE IF NOT EXISTS webhook_receipts (
    shop TEXT NOT NULL,
    webhook_id TEXT NOT NULL,
    topic TEXT NOT NULL,
    triggered_at TIMESTAMPTZ(6),
    received_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
    PRIMARY KEY (shop, webhook_id)
);

CREATE INDEX IF NOT EXISTS idx_webhook_receipts_received_at
    ON webhook_receipts(received_at);

CREATE INDEX IF NOT EXISTS idx_webhook_receipts_shop
    ON webhook_receipts(shop);

COMMENT ON TABLE webhook_receipts IS 'S20 webhook idempotency: tracks received webhook IDs per shop to prevent duplicate processing';
COMMENT ON COLUMN webhook_receipts.triggered_at IS 'X-Shopify-Triggered-At header value for ordering guards';

-- Enable RLS with no policies (blocks all access via PostgREST)
ALTER TABLE webhook_receipts ENABLE ROW LEVEL SECURITY;

-- =============================================================================
-- MIGRATE EXISTING DATA FROM s6_processed_webhooks
-- =============================================================================

-- Migrate existing processed webhooks to new table
-- Extract shop from the processor context (stored in different column patterns)
-- Since s6_processed_webhooks doesn't have a shop column, we'll migrate what we can
INSERT INTO webhook_receipts (shop, webhook_id, topic, received_at)
SELECT 
    'unknown' as shop,  -- Legacy data lacks shop; marked for eventual cleanup
    webhook_id,
    topic,
    processed_at as received_at
FROM s6_processed_webhooks
ON CONFLICT (shop, webhook_id) DO NOTHING;

-- =============================================================================
-- PG_CRON RETENTION JOBS (guarded)
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
        RAISE NOTICE 'pg_cron not available; skipping webhook_receipts purge job (OK for CI)';
        RETURN;
    END IF;

    -- Unschedule existing job if it exists (idempotent)
    IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 's20_webhook_receipts_cleanup') THEN
        PERFORM cron.unschedule('s20_webhook_receipts_cleanup');
    END IF;

    -- Unschedule old s10 processed webhooks cleanup (being replaced)
    IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 's10_processed_webhooks_cleanup') THEN
        PERFORM cron.unschedule('s10_processed_webhooks_cleanup');
    END IF;

    -- Schedule 30-day retention purge (daily, 04:30 UTC - offset from other jobs)
    PERFORM cron.schedule(
        's20_webhook_receipts_cleanup',
        '30 4 * * *',
        $cmd$DELETE FROM webhook_receipts WHERE received_at < NOW() - INTERVAL '30 days'$cmd$
    );
    RAISE NOTICE 'Scheduled s20_webhook_receipts_cleanup cron job (04:30 UTC daily, 30-day retention)';

END;
$do$;

-- =============================================================================
-- DROP OLD TABLE (after migration)
-- =============================================================================

-- Keep old table for now as processors may still reference it during rollout
-- Will be dropped in a future migration after confirming all processors use new table
-- DROP TABLE IF EXISTS s6_processed_webhooks;

COMMENT ON TABLE s6_processed_webhooks IS 'DEPRECATED: Use webhook_receipts instead. Will be dropped in future migration.';
