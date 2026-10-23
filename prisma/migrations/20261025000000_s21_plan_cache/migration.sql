-- S21: Plan cache columns for Shop table
-- Caches the resolved plan from Shopify Admin API with ~6h TTL.
-- Refreshed via APP_SUBSCRIPTIONS_UPDATE webhook.

-- Add plan cache columns to Shop table
ALTER TABLE "Shop" ADD COLUMN IF NOT EXISTS plan_key TEXT NOT NULL DEFAULT 'free';
ALTER TABLE "Shop" ADD COLUMN IF NOT EXISTS subscription_id TEXT;
ALTER TABLE "Shop" ADD COLUMN IF NOT EXISTS subscription_name TEXT;
ALTER TABLE "Shop" ADD COLUMN IF NOT EXISTS is_test BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Shop" ADD COLUMN IF NOT EXISTS plan_cached_at TIMESTAMPTZ;

-- Index for finding shops by plan (analytics, batch operations)
CREATE INDEX IF NOT EXISTS "Shop_plan_key_idx" ON "Shop" (plan_key);

-- Comment on columns for documentation
COMMENT ON COLUMN "Shop".plan_key IS 'Cached plan key (free, starter, growth, scale). Defaults to free.';
COMMENT ON COLUMN "Shop".subscription_id IS 'Shopify subscription GID from activeSubscriptions query.';
COMMENT ON COLUMN "Shop".subscription_name IS 'Subscription name from Shopify (maps to plan_key).';
COMMENT ON COLUMN "Shop".is_test IS 'Whether this is a test/development subscription.';
COMMENT ON COLUMN "Shop".plan_cached_at IS 'When the plan cache was last refreshed. TTL ~6h.';

-- S21: Add gated_at column to BuyerAccount for over-limit gating
-- Gated accounts are excluded from limit count and enforcement until reactivated.
ALTER TABLE "BuyerAccount" ADD COLUMN IF NOT EXISTS gated_at TIMESTAMPTZ;

-- Index for finding gated accounts (reactivation on upgrade)
CREATE INDEX IF NOT EXISTS "BuyerAccount_gated_at_idx" ON "BuyerAccount" (gated_at) WHERE gated_at IS NOT NULL;

-- Comment on column
COMMENT ON COLUMN "BuyerAccount".gated_at IS 'When this account was gated due to plan limits. NULL means active.';
