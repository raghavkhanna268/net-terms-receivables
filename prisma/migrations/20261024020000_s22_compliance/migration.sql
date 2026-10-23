-- S22: GDPR/CCPA Compliance - Cascade FKs, Data Requests
--
-- This migration:
-- 1. Adds ON DELETE CASCADE FKs from s8 tables to Shop (enables shop/redact)
-- 2. Creates s22_data_requests table for customers/data_request
-- 3. Adds uninstalled_at column to Shop (for app/uninstalled webhook)
--
-- Idempotent: All operations are guarded with IF NOT EXISTS/IF EXISTS.
--
-- Orphan cleanup: Before adding FKs, we delete any orphaned rows that reference
-- non-existent Shop records. This ensures the migration succeeds on databases
-- with pre-existing data inconsistencies.

-- =============================================================================
-- 1. SHOP UNINSTALLED_AT COLUMN
-- =============================================================================

ALTER TABLE "Shop"
  ADD COLUMN IF NOT EXISTS "uninstalledAt" TIMESTAMPTZ(3);

COMMENT ON COLUMN "Shop"."uninstalledAt" IS 'When the shop uninstalled the app. Full data deletion happens on shop/redact (48h later per Shopify docs). NULL means still installed.';

-- =============================================================================
-- 2. S8 TABLES - ADD CASCADE FKs TO SHOP
-- =============================================================================

-- Clean up orphaned s8_tagged_customers rows (if any) before adding FK
DELETE FROM s8_tagged_customers tc
WHERE NOT EXISTS (
  SELECT 1 FROM "Shop" s WHERE s.id = tc.shop_id
);

-- Add FK from s8_tagged_customers to Shop with CASCADE
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 's8_tagged_customers_shop_fkey'
    AND table_name = 's8_tagged_customers'
  ) THEN
    ALTER TABLE s8_tagged_customers
      ADD CONSTRAINT s8_tagged_customers_shop_fkey
      FOREIGN KEY (shop_id) REFERENCES "Shop"(id) ON DELETE CASCADE;
  END IF;
END$$;

-- Clean up orphaned s8_draft_orders rows (if any) before adding FK
DELETE FROM s8_draft_orders do_
WHERE NOT EXISTS (
  SELECT 1 FROM "Shop" s WHERE s.id = do_.shop_id
);

-- Add FK from s8_draft_orders to Shop with CASCADE
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 's8_draft_orders_shop_fkey'
    AND table_name = 's8_draft_orders'
  ) THEN
    ALTER TABLE s8_draft_orders
      ADD CONSTRAINT s8_draft_orders_shop_fkey
      FOREIGN KEY (shop_id) REFERENCES "Shop"(id) ON DELETE CASCADE;
  END IF;
END$$;

-- =============================================================================
-- 3. S22_DATA_REQUESTS TABLE
-- =============================================================================
-- Stores GDPR/CCPA data export requests for customers/data_request webhook.
-- Merchant downloads pending exports via admin route.
-- Exports are retained for 30 days (DPDP minimisation) then auto-purged.

CREATE TABLE IF NOT EXISTS s22_data_requests (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  shop_id TEXT NOT NULL,
  customer_gid TEXT NOT NULL,
  request_id TEXT NOT NULL,
  received_at TIMESTAMPTZ(3) NOT NULL DEFAULT NOW(),
  status TEXT NOT NULL DEFAULT 'pending',
  export_data JSONB,
  completed_at TIMESTAMPTZ(3),
  downloaded_at TIMESTAMPTZ(3),
  expires_at TIMESTAMPTZ(3),
  created_at TIMESTAMPTZ(3) NOT NULL DEFAULT NOW()
);

-- FK to Shop with CASCADE (data requests are purged with shop)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 's22_data_requests_shop_fkey'
    AND table_name = 's22_data_requests'
  ) THEN
    ALTER TABLE s22_data_requests
      ADD CONSTRAINT s22_data_requests_shop_fkey
      FOREIGN KEY (shop_id) REFERENCES "Shop"(id) ON DELETE CASCADE;
  END IF;
END$$;

-- Unique constraint on request_id (Shopify sends unique request IDs)
CREATE UNIQUE INDEX IF NOT EXISTS idx_s22_data_requests_request_id
  ON s22_data_requests(request_id);

-- Index for finding pending requests by shop
CREATE INDEX IF NOT EXISTS idx_s22_data_requests_shop_status
  ON s22_data_requests(shop_id, status);

-- Index for finding requests by customer within a shop
CREATE INDEX IF NOT EXISTS idx_s22_data_requests_shop_customer
  ON s22_data_requests(shop_id, customer_gid);

-- Index for pg_cron purge of expired exports
CREATE INDEX IF NOT EXISTS idx_s22_data_requests_expires_at
  ON s22_data_requests(expires_at) WHERE expires_at IS NOT NULL;

COMMENT ON TABLE s22_data_requests IS 'S22 GDPR/CCPA data requests: stores customer data exports from customers/data_request webhook. Merchant downloads via admin route. Exports expire after 30 days per DPDP minimisation.';
COMMENT ON COLUMN s22_data_requests.status IS 'Request status: pending (export created), completed (ready for download), downloaded (merchant has retrieved), expired (past retention)';
COMMENT ON COLUMN s22_data_requests.export_data IS 'JSON export of all customer data across tables. NULL before export is generated.';
COMMENT ON COLUMN s22_data_requests.expires_at IS 'Expiration timestamp (30 days from creation). Expired exports are purged by pg_cron.';

-- Enable RLS (no policies = blocked via PostgREST)
ALTER TABLE s22_data_requests ENABLE ROW LEVEL SECURITY;

-- =============================================================================
-- 4. PG_CRON: PURGE EXPIRED DATA REQUESTS
-- =============================================================================
-- Scheduled job to delete expired data request exports (DPDP minimisation).
-- Runs daily at 03:00 UTC (off-peak for most regions).
--
-- Note: pg_cron must be enabled on the Supabase database for this to work.
-- If pg_cron is not available, manual purge via drain or admin route is fallback.
--
-- The cron.schedule call is idempotent: it uses a named job that gets replaced
-- if it already exists.

DO $do$
BEGIN
  -- Only create the cron job if pg_cron extension is available
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    PERFORM cron.schedule(
      's22_purge_expired_data_requests',
      '0 3 * * *',
      'DELETE FROM s22_data_requests WHERE expires_at IS NOT NULL AND expires_at < NOW()'
    );
  END IF;
END$do$;

-- =============================================================================
-- 5. UPDATE PRISMA SCHEMA SYNC COMMENTS
-- =============================================================================

COMMENT ON COLUMN s8_tagged_customers.shop_id IS 'Shop ID (FK to Shop with CASCADE). Enables automatic deletion on shop/redact.';
COMMENT ON COLUMN s8_draft_orders.shop_id IS 'Shop ID (FK to Shop with CASCADE). Enables automatic deletion on shop/redact.';
