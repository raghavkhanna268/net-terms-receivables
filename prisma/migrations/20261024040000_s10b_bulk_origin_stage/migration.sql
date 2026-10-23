-- S10b: Add origin, reconcile_stage, and failure_count to s6_bulk_operations
--
-- Fix #1: Track origin ('reconcile' | 'webhook' | 'manual') and reconcile_stage
--         to enable sequential reconcile chaining (companies → orders)
-- Fix #4: Track failure_count separately from pgmq read_ct so progress iterations
--         don't count toward DLQ threshold

-- Add origin column: where the bulk operation came from
ALTER TABLE s6_bulk_operations
  ADD COLUMN IF NOT EXISTS origin TEXT NOT NULL DEFAULT 'webhook'
    CHECK (origin IN ('reconcile', 'webhook', 'manual'));

-- Add reconcile_stage column: for reconcile operations, which stage
-- NULL for webhook/manual, 'companies' or 'orders' for reconcile
ALTER TABLE s6_bulk_operations
  ADD COLUMN IF NOT EXISTS reconcile_stage TEXT
    CHECK (reconcile_stage IS NULL OR reconcile_stage IN ('companies', 'orders'));

-- Add failure_count column: real failures (not progress iterations)
-- Only incremented on actual errors, used for DLQ threshold
ALTER TABLE s6_bulk_operations
  ADD COLUMN IF NOT EXISTS failure_count INT NOT NULL DEFAULT 0;

-- Add max_chunk_size column: for growing range window on no-newline chunks
-- Starts at default (512KB), doubles up to cap (8MB) per retry
ALTER TABLE s6_bulk_operations
  ADD COLUMN IF NOT EXISTS chunk_size INT NOT NULL DEFAULT 524288;

-- Update constraint on bulk_type to include customers (S8)
-- Need to drop and recreate the constraint
DO $do$
BEGIN
  ALTER TABLE s6_bulk_operations DROP CONSTRAINT IF EXISTS s6_bulk_operations_bulk_type_check;
  ALTER TABLE s6_bulk_operations 
    ADD CONSTRAINT s6_bulk_operations_bulk_type_check 
    CHECK (bulk_type IN ('companies', 'orders', 'customers'));
EXCEPTION WHEN OTHERS THEN
  -- Constraint may not exist in CI, ignore errors
  NULL;
END;
$do$;

COMMENT ON COLUMN s6_bulk_operations.origin IS 'Source of bulk operation: reconcile (nightly), webhook (backfill), or manual';
COMMENT ON COLUMN s6_bulk_operations.reconcile_stage IS 'For reconcile origin: companies or orders stage';
COMMENT ON COLUMN s6_bulk_operations.failure_count IS 'Count of real failures (not progress iterations). DLQ after 5.';
COMMENT ON COLUMN s6_bulk_operations.chunk_size IS 'Current Range chunk size in bytes. Grows on no-newline chunks up to 8MB cap.';
