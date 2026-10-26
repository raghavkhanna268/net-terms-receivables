-- S25: Bulk operation exactly-once processing
-- Adds columns for finish-received tracking, processing lease, and next-stage enqueue tracking
-- Adds table for reconcile stage claims to prevent duplicate ops per chain stage

ALTER TABLE s6_bulk_operations
  ADD COLUMN IF NOT EXISTS finish_received_at TIMESTAMPTZ(6),
  ADD COLUMN IF NOT EXISTS processing_lease_until TIMESTAMPTZ(6),
  ADD COLUMN IF NOT EXISTS next_stage_enqueued_at TIMESTAMPTZ(6);

CREATE TABLE IF NOT EXISTS s6_reconcile_stage_claims (
  chain_key TEXT NOT NULL,
  stage TEXT NOT NULL,
  shop TEXT NOT NULL,
  bulk_operation_id TEXT,
  claimed_at TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  PRIMARY KEY (chain_key, stage)
);

CREATE INDEX IF NOT EXISTS s6_reconcile_stage_claims_shop_idx ON s6_reconcile_stage_claims (shop);
