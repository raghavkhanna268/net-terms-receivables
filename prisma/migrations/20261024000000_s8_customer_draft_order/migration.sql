-- S8: Tagged customer tracking and draft order pending exposure
--
-- Features:
--   1. Tag rules: Track customers with configurable tags (e.g., "net-terms")
--      to create BuyerAccount (kind=TAGGED_CUSTOMER) when tags match AccountSource rules
--   2. Draft order tracking: Track draft orders with payment terms for pending
--      credit exposure calculation
--
-- DPDP compliance:
--   - s8_tagged_customers stores only customer GID and tags array
--   - s8_draft_orders stores only order GID, amount, and buyer reference
--   - No PII fields (names, emails, phones, addresses) are stored
--
-- Precedence rule (documented in S8):
--   When a customer is both a B2B company contact AND has a buyer tag,
--   the COMPANY BuyerAccount takes precedence for order mapping.
--   This is handled in the sync processor, not at the database level.

-- Create s8_tagged_customers table
-- Tracks customers with minimal data for tag rule matching
CREATE TABLE IF NOT EXISTS s8_tagged_customers (
    id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
    shop_id TEXT NOT NULL,
    customer_id TEXT NOT NULL,
    tags JSONB NOT NULL DEFAULT '[]'::jsonb,
    has_tag BOOLEAN NOT NULL DEFAULT false,
    -- Reserved PII fields: gated on Shopify Protected Customer Data approval (Level 2)
    -- These columns are always NULL until the approval is granted and CUSTOMER_PII_FIELDS=1 is set.
    -- Phone and address are never stored regardless of approval level.
    email TEXT,
    display_name TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    
    CONSTRAINT s8_tagged_customers_shop_customer_unique UNIQUE (shop_id, customer_id)
);

-- Indexes for efficient queries
CREATE INDEX IF NOT EXISTS idx_s8_tagged_customers_shop_has_tag 
    ON s8_tagged_customers(shop_id, has_tag);

-- Comment documenting table purpose and DPDP compliance
COMMENT ON TABLE s8_tagged_customers IS 'S8 tagged customer tracking: minimal customer data (GID + tags only) for tag-based buyer accounts. email/display_name reserved for future Protected Customer Data approval.';
COMMENT ON COLUMN s8_tagged_customers.email IS 'Reserved: requires Protected Customer Data Level 2 approval and CUSTOMER_PII_FIELDS=1. Always NULL until approved.';
COMMENT ON COLUMN s8_tagged_customers.display_name IS 'Reserved: requires Protected Customer Data Level 2 approval and CUSTOMER_PII_FIELDS=1. Always NULL until approved.';

-- Create s8_draft_orders table
-- Tracks draft orders with payment terms for pending credit exposure
CREATE TABLE IF NOT EXISTS s8_draft_orders (
    id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
    shop_id TEXT NOT NULL,
    draft_order_id TEXT NOT NULL,
    buyer_account_id TEXT,
    name TEXT NOT NULL,
    total NUMERIC(14, 2) NOT NULL,
    has_payment_terms BOOLEAN NOT NULL DEFAULT false,
    status TEXT NOT NULL DEFAULT 'open',
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    
    CONSTRAINT s8_draft_orders_shop_draft_unique UNIQUE (shop_id, draft_order_id)
);

-- Indexes for efficient credit exposure queries
CREATE INDEX IF NOT EXISTS idx_s8_draft_orders_shop_buyer 
    ON s8_draft_orders(shop_id, buyer_account_id);
CREATE INDEX IF NOT EXISTS idx_s8_draft_orders_shop_has_terms 
    ON s8_draft_orders(shop_id, has_payment_terms);

-- Comment documenting table purpose
COMMENT ON TABLE s8_draft_orders IS 'S8 draft order tracking: draft orders with payment terms for pending credit exposure calculation';

-- Update s6_bulk_operations to allow 'customers' bulk type
-- This is needed for the customer backfill bulk operation
ALTER TABLE s6_bulk_operations 
    DROP CONSTRAINT IF EXISTS s6_bulk_operations_bulk_type_check;

ALTER TABLE s6_bulk_operations 
    ADD CONSTRAINT s6_bulk_operations_bulk_type_check 
    CHECK (bulk_type IN ('companies', 'orders', 'customers'));

-- Update comment on bulk_type constraint
COMMENT ON COLUMN s6_bulk_operations.bulk_type IS 'Type of bulk operation: companies, orders, or customers';

-- Create updated_at trigger function if it doesn't exist
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Add updated_at triggers for S8 tables
DROP TRIGGER IF EXISTS trigger_s8_tagged_customers_updated_at ON s8_tagged_customers;
CREATE TRIGGER trigger_s8_tagged_customers_updated_at
    BEFORE UPDATE ON s8_tagged_customers
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS trigger_s8_draft_orders_updated_at ON s8_draft_orders;
CREATE TRIGGER trigger_s8_draft_orders_updated_at
    BEFORE UPDATE ON s8_draft_orders
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();
