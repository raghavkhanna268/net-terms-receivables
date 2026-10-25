-- S8: Widen reconcile_stage and bulk_type CHECKs for customers and draft_orders
--
-- This migration covers both PR-A (customers) and PR-B (draft_orders) to avoid
-- migration conflicts. PR-B will add code only, no additional migration needed.
--
-- Changes:
-- 1. reconcile_stage: add 'customers' and 'draft_orders' to allowed values
-- 2. bulk_type: add 'draft_orders' (customers already allowed since 20261024000000)

-- Widen reconcile_stage CHECK to include customers and draft_orders
-- The existing constraint only allows ('companies', 'orders')
DO $do$
BEGIN
  ALTER TABLE s6_bulk_operations DROP CONSTRAINT IF EXISTS s6_bulk_operations_reconcile_stage_check;
  ALTER TABLE s6_bulk_operations
    ADD CONSTRAINT s6_bulk_operations_reconcile_stage_check
    CHECK (reconcile_stage IS NULL OR reconcile_stage IN ('companies', 'orders', 'customers', 'draft_orders'));
EXCEPTION
  WHEN undefined_object THEN
    ALTER TABLE s6_bulk_operations
      ADD CONSTRAINT s6_bulk_operations_reconcile_stage_check
      CHECK (reconcile_stage IS NULL OR reconcile_stage IN ('companies', 'orders', 'customers', 'draft_orders'));
  WHEN duplicate_object THEN
    NULL;
END;
$do$;

-- Widen bulk_type CHECK to include draft_orders
-- The existing constraint allows ('companies', 'orders', 'customers')
DO $do$
BEGIN
  ALTER TABLE s6_bulk_operations DROP CONSTRAINT IF EXISTS s6_bulk_operations_bulk_type_check;
  ALTER TABLE s6_bulk_operations
    ADD CONSTRAINT s6_bulk_operations_bulk_type_check
    CHECK (bulk_type IN ('companies', 'orders', 'customers', 'draft_orders'));
EXCEPTION
  WHEN undefined_object THEN
    ALTER TABLE s6_bulk_operations
      ADD CONSTRAINT s6_bulk_operations_bulk_type_check
      CHECK (bulk_type IN ('companies', 'orders', 'customers', 'draft_orders'));
  WHEN duplicate_object THEN
    NULL;
END;
$do$;

COMMENT ON COLUMN s6_bulk_operations.reconcile_stage IS 'For reconcile origin: companies, customers, orders, or draft_orders stage';
