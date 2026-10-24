-- S13: Backstop processed orders table
-- Tracks orders that have been checked by the backstop service
-- Ensures idempotency on webhook redelivery
--
-- Retention: Records older than 30 days are purged by pg_cron job.
-- This is sufficient because webhook redelivery happens within minutes/hours,
-- not weeks. The pg_cron job runs daily at 03:00 UTC.

CREATE TABLE backstop_processed_orders (
  shop_id TEXT NOT NULL,
  order_gid TEXT NOT NULL,
  -- Action values:
  -- 'pending': Processing claimed, not yet complete (concurrent redelivery protection)
  -- 'held': Fulfillment holds were applied
  -- 'skipped': Order was checked but not held (OK account, bypass, etc.)
  action TEXT NOT NULL CHECK (action IN ('pending', 'held', 'skipped')),
  reason TEXT,
  processed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  
  PRIMARY KEY (shop_id, order_gid)
);

-- Index for cleanup queries (30 day retention)
CREATE INDEX idx_backstop_processed_orders_processed_at ON backstop_processed_orders (processed_at);

-- Index for shop-scoped queries
CREATE INDEX idx_backstop_processed_orders_shop ON backstop_processed_orders (shop_id);

-- FK to Shop with CASCADE for cleanup on shop/redact
ALTER TABLE backstop_processed_orders
  ADD CONSTRAINT backstop_processed_orders_shop_fkey
  FOREIGN KEY (shop_id) REFERENCES "Shop" (id)
  ON DELETE CASCADE;

-- pg_cron job to purge old records (30 day retention)
-- Runs daily at 03:00 UTC. Job is idempotent.
-- If pg_cron extension is not available, this will fail silently (DO block handles it).
DO $$
BEGIN
  -- Check if pg_cron extension exists
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    -- Schedule the purge job
    PERFORM cron.schedule(
      'backstop-purge-30d',
      '0 3 * * *',  -- Daily at 03:00 UTC
      $$DELETE FROM backstop_processed_orders WHERE processed_at < NOW() - INTERVAL '30 days'$$
    );
  ELSE
    RAISE NOTICE 'pg_cron extension not available, skipping backstop purge job setup';
  END IF;
EXCEPTION
  WHEN OTHERS THEN
    RAISE NOTICE 'Failed to schedule pg_cron job: %. Manual cleanup may be required.', SQLERRM;
END;
$$;
