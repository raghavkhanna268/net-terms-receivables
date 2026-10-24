-- S13: Backstop processed orders table
-- Tracks orders that have been checked by the backstop service
-- Ensures idempotency on webhook redelivery

CREATE TABLE backstop_processed_orders (
  shop_id TEXT NOT NULL,
  order_gid TEXT NOT NULL,
  action TEXT NOT NULL,  -- 'held' or 'skipped'
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
