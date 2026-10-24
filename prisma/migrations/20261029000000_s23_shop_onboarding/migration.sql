-- S23: Shop onboarding state tracking table
-- Minimal table for tracking onboarding dismissal and completion per shop.
-- Required because: (1) Shop table has no settings field, (2) no write_metafields scope for shop metafields.
-- Matches S23 test plan: "A ShopOnboarding row stores dismissed and completed flags only."

CREATE TABLE shop_onboarding (
  shop_id TEXT PRIMARY KEY REFERENCES "Shop"(id) ON DELETE CASCADE,
  dismissed_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Index for efficient lookup by dismissed state (for analytics/reporting)
CREATE INDEX idx_shop_onboarding_dismissed ON shop_onboarding(dismissed_at) WHERE dismissed_at IS NOT NULL;
