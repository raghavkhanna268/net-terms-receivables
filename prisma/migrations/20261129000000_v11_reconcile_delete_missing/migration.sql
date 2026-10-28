-- v1.1: Add columns for reconcile delete-missing detection
--
-- This migration adds:
-- 1. last_seen_bulk_op_id to s8_draft_orders and s8_tagged_customers
--    - Set unconditionally during reconcile bulk upserts
--    - NULL for rows created/updated via webhook only
--    - Used to identify rows not seen in the latest reconcile
--
-- 2. lines_processed to s6_bulk_operations
--    - Set once at EOF to the total JSONL line count
--    - Used with objectCount for completeness check before delete-missing

-- Add last_seen_bulk_op_id to s8_draft_orders
ALTER TABLE s8_draft_orders
  ADD COLUMN IF NOT EXISTS last_seen_bulk_op_id TEXT;

CREATE INDEX IF NOT EXISTS idx_s8_draft_orders_last_seen
  ON s8_draft_orders(shop_id, last_seen_bulk_op_id);

COMMENT ON COLUMN s8_draft_orders.last_seen_bulk_op_id IS 
  'Bulk operation ID that last saw this row during reconcile. NULL for webhook-only rows. Used for delete-missing detection.';

-- Add last_seen_bulk_op_id to s8_tagged_customers  
ALTER TABLE s8_tagged_customers
  ADD COLUMN IF NOT EXISTS last_seen_bulk_op_id TEXT;

CREATE INDEX IF NOT EXISTS idx_s8_tagged_customers_last_seen
  ON s8_tagged_customers(shop_id, last_seen_bulk_op_id);

COMMENT ON COLUMN s8_tagged_customers.last_seen_bulk_op_id IS 
  'Bulk operation ID that last saw this row during reconcile. NULL for webhook-only rows. Used for delete-missing detection.';

-- Add lines_processed to s6_bulk_operations for completeness check
ALTER TABLE s6_bulk_operations
  ADD COLUMN IF NOT EXISTS lines_processed BIGINT;

COMMENT ON COLUMN s6_bulk_operations.lines_processed IS 
  'Total JSONL lines processed (set once at EOF). Used with objectCount for completeness check.';

-- Add lines_read to s6_bulk_operations for running line count during processing
ALTER TABLE s6_bulk_operations ADD COLUMN IF NOT EXISTS lines_read BIGINT;
