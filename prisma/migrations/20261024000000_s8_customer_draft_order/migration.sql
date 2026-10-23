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
-- Tag activation design:
--   Tag activation state (tag_active/tag_deactivated_at) is separate from credit
--   hold state (BuyerAccount.holdState). Tag sync never touches holdState - that
--   belongs to the credit logic alone. When a tag is removed, we set tag_active=false
--   and record tag_deactivated_at; when re-added, we set tag_active=true.
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
    -- Tag activation state (separate from BuyerAccount.holdState)
    -- tag_active=true means customer currently has a matching tag
    -- tag_active=false means tag was removed; tag_deactivated_at records when
    tag_active BOOLEAN NOT NULL DEFAULT false,
    tag_deactivated_at TIMESTAMPTZ,
    -- Reserved PII fields: gated on Protected Customer Data approval
    -- (Level 1 plus Email and Name fields when approved and CUSTOMER_PII_FIELDS=1)
    -- These columns are always NULL until approval is granted.
    -- Phone and address are never stored regardless of approval level.
    email TEXT,
    display_name TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    
    CONSTRAINT s8_tagged_customers_shop_customer_unique UNIQUE (shop_id, customer_id)
);

-- Indexes for efficient queries
CREATE INDEX IF NOT EXISTS idx_s8_tagged_customers_shop_tag_active 
    ON s8_tagged_customers(shop_id, tag_active);

-- Comment documenting table purpose and DPDP compliance
COMMENT ON TABLE s8_tagged_customers IS 'S8 tagged customer tracking: minimal customer data (GID + tags only) for tag-based buyer accounts. tag_active is separate from holdState. email/display_name reserved for future Protected Customer Data approval.';
COMMENT ON COLUMN s8_tagged_customers.tag_active IS 'Whether customer currently has a matching buyer tag. Separate from BuyerAccount.holdState - tag sync never touches credit hold state.';
COMMENT ON COLUMN s8_tagged_customers.tag_deactivated_at IS 'When the customer lost the matching tag. NULL if tag_active=true.';
COMMENT ON COLUMN s8_tagged_customers.email IS 'Reserved: requires Protected Customer Data approval (Level 1 + Email) and CUSTOMER_PII_FIELDS=1. Always NULL until approved.';
COMMENT ON COLUMN s8_tagged_customers.display_name IS 'Reserved: requires Protected Customer Data approval (Level 1 + Name) and CUSTOMER_PII_FIELDS=1. Always NULL until approved.';

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
