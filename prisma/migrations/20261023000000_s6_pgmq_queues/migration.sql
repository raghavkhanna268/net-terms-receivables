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
-- Per Supabase docs: pg_cron must be installed in pg_catalog schema.
-- Gracefully skip if not available (CI doesn't have pg_cron).
-- No cron jobs are scheduled here; that's S10.
DO $$
BEGIN
    CREATE EXTENSION IF NOT EXISTS pg_cron WITH SCHEMA pg_catalog;
    RAISE NOTICE 'pg_cron extension enabled in pg_catalog schema';
EXCEPTION
    WHEN OTHERS THEN
        RAISE NOTICE 'pg_cron extension not available (OK for CI): %', SQLERRM;
END;
$$;

-- Enable pg_net (optional - used for HTTP callbacks)
-- Per Supabase docs: pg_net goes in extensions schema.
-- Gracefully skip if not available (CI doesn't have pg_net).
DO $$
BEGIN
    CREATE EXTENSION IF NOT EXISTS pg_net WITH SCHEMA extensions;
    RAISE NOTICE 'pg_net extension enabled in extensions schema';
EXCEPTION
    WHEN OTHERS THEN
        RAISE NOTICE 'pg_net extension not available (OK for CI): %', SQLERRM;
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

-- Note: pgmq already creates an index on the vt column for each queue table,
-- so no additional indexes are needed for efficient polling.

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

-- Create bulk operations tracking table
-- Records the type of each bulk operation at launch so the finish webhook
-- knows how to process the JSONL result.
CREATE TABLE IF NOT EXISTS s6_bulk_operations (
    bulk_operation_id TEXT PRIMARY KEY,
    shop TEXT NOT NULL,
    bulk_type TEXT NOT NULL CHECK (bulk_type IN ('companies', 'orders')),
    started_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Index for cleanup of old entries (pg_cron job in S10 will purge >7 days)
CREATE INDEX IF NOT EXISTS idx_s6_processed_webhooks_processed_at
    ON s6_processed_webhooks(processed_at);

-- Comment documenting table purpose
COMMENT ON TABLE s6_processed_webhooks IS 'S6 webhook idempotency: tracks processed webhook IDs to prevent duplicate processing';
