-- S21: Add plan_pending_handle column for Shopify App Pricing welcome-link redirect
-- Stores the unverified plan_handle from the welcome redirect when activeSubscriptions
-- cannot confirm the plan. Never used for gating or confirmed plan storage.
--
-- Flow:
-- 1. Welcome redirect receives plan_handle query param
-- 2. Verify against Admin API currentAppInstallation.activeSubscriptions
-- 3. If confirmed → store in plan_key/subscription_* columns, clear pending_handle
-- 4. If not confirmed → store in plan_pending_handle only, keep existing plan

ALTER TABLE "Shop" ADD COLUMN IF NOT EXISTS plan_pending_handle TEXT;

COMMENT ON COLUMN "Shop".plan_pending_handle IS 'Unverified plan_handle from App Pricing welcome redirect. Cleared on verification.';
