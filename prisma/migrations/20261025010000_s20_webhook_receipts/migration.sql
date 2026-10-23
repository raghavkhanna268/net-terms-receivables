-- S20: Webhook receipts table for edge-level idempotency
--
-- This migration:
-- 1. Creates webhook_receipts table for edge deduplication (before enqueue)
-- 2. Adds 30-day retention purge via pg_cron
--
-- Idempotency design - TWO separate levels:
--   1. Edge (webhook_receipts): Prevents duplicate enqueues from Shopify retries
--      - Receipt + enqueue in ONE transaction; if enqueue fails, receipt rolls back
--   2. Drain (s6_processed_webhooks): Prevents duplicate processing in queue
--      - Checked via isWebhookProcessed() before processing
--
-- No data migration from s6_processed_webhooks - the tables serve different purposes.
-- The s10_processed_webhooks_cleanup cron is kept running since s6_processed_webhooks
-- is still actively used for drain idempotency.

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

COMMENT ON TABLE webhook_receipts IS 'S20 edge idempotency: tracks received webhook IDs per shop to prevent duplicate enqueues';
COMMENT ON COLUMN webhook_receipts.triggered_at IS 'X-Shopify-Triggered-At header value (stored for audit, not used for ordering)';

-- Enable RLS with no policies (blocks all access via PostgREST)
ALTER TABLE webhook_receipts ENABLE ROW LEVEL SECURITY;

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

    -- NOTE: s10_processed_webhooks_cleanup is KEPT RUNNING
    -- s6_processed_webhooks is still used for drain-level idempotency

    -- Schedule 30-day retention purge (daily, 04:30 UTC - offset from other jobs)
    PERFORM cron.schedule(
        's20_webhook_receipts_cleanup',
        '30 4 * * *',
        $cmd$DELETE FROM webhook_receipts WHERE received_at < NOW() - INTERVAL '30 days'$cmd$
    );
    RAISE NOTICE 'Scheduled s20_webhook_receipts_cleanup cron job (04:30 UTC daily, 30-day retention)';

END;
$do$;
