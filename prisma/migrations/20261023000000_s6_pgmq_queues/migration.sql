-- S6: Enable pgmq and create queues for company/order sync
--
-- Extensions:
--   pgmq (required): Message queue for async webhook processing
--   pg_cron (optional): Job scheduling for queue drain (S10)
--   pg_net (optional): HTTP requests for webhook retries (future)
--
-- Queue design:
--   s6_sync: All company, company_location, and order webhook events
--   s6_bulk: Bulk operation completion events (JSONL processing)
--
-- CI compatibility:
--   - pgmq is required and will fail if not available (CI uses ghcr.io/pgmq/pg16-pgmq image)
--   - pg_cron and pg_net are optional; CREATE EXTENSION is wrapped in exception handling
--     so CI can run without them. In production (Supabase), all three are available.

-- Enable pgmq extension (required for queue operations)
-- This will fail if pgmq is not installed, which is intentional:
-- CI must use a Postgres image with pgmq, and Supabase has it available.
CREATE EXTENSION IF NOT EXISTS pgmq;

-- Enable pg_cron (optional - used by S10 drain scheduler)
-- Gracefully skip if not available (CI doesn't have pg_cron)
DO $$
BEGIN
    CREATE EXTENSION IF NOT EXISTS pg_cron;
    RAISE NOTICE 'pg_cron extension enabled';
EXCEPTION
    WHEN OTHERS THEN
        RAISE NOTICE 'pg_cron extension not available (OK for CI): %', SQLERRM;
END;
$$;

-- Enable pg_net (optional - used for HTTP callbacks)
-- Gracefully skip if not available (CI doesn't have pg_net)
-- Note: pg_net requires schema specification on Supabase
DO $$
BEGIN
    -- Try with extensions schema first (Supabase convention)
    CREATE EXTENSION IF NOT EXISTS pg_net WITH SCHEMA extensions;
    RAISE NOTICE 'pg_net extension enabled in extensions schema';
EXCEPTION
    WHEN OTHERS THEN
        BEGIN
            -- Fallback: try without schema specification
            CREATE EXTENSION IF NOT EXISTS pg_net;
            RAISE NOTICE 'pg_net extension enabled in public schema';
        EXCEPTION
            WHEN OTHERS THEN
                RAISE NOTICE 'pg_net extension not available (OK for CI): %', SQLERRM;
        END;
END;
$$;

-- Create s6_sync queue for webhook events
-- Messages contain: {topic, shop, resourceGid, webhookId}
-- The drain (S10) will read from this queue and call sync processors
SELECT pgmq.create('s6_sync');

-- Create s6_bulk queue for bulk operation completion events
-- Messages contain: {shop, bulkOperationId, type, webhookId}
-- The drain will download JSONL and process results
SELECT pgmq.create('s6_bulk');

-- Create index on pgmq queue tables for efficient polling
-- pgmq creates tables named pgmq.q_<queue_name>
-- These indexes help the drain find unprocessed messages quickly
CREATE INDEX IF NOT EXISTS idx_q_s6_sync_vt ON pgmq.q_s6_sync(vt) WHERE vt <= now();
CREATE INDEX IF NOT EXISTS idx_q_s6_bulk_vt ON pgmq.q_s6_bulk(vt) WHERE vt <= now();

-- Add comment documenting queue purposes
COMMENT ON TABLE pgmq.q_s6_sync IS 'S6 webhook events: companies, company_locations, orders with payment terms';
COMMENT ON TABLE pgmq.q_s6_bulk IS 'S6 bulk operation completions: JSONL download/processing triggers';

-- Create webhook dedupe table for idempotent processing
-- Stores processed webhook IDs to prevent duplicate processing when
-- Shopify retries webhooks or the drain reprocesses messages.
CREATE TABLE IF NOT EXISTS s6_processed_webhooks (
    webhook_id TEXT PRIMARY KEY,
    topic TEXT NOT NULL,
    resource_gid TEXT NOT NULL,
    processed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Index for cleanup of old entries (pg_cron job in S10 will purge >7 days)
CREATE INDEX IF NOT EXISTS idx_s6_processed_webhooks_processed_at
    ON s6_processed_webhooks(processed_at);

-- Comment documenting table purpose
COMMENT ON TABLE s6_processed_webhooks IS 'S6 webhook idempotency: tracks processed webhook IDs to prevent duplicate processing';
