-- S11: Add columns for credit status management
--
-- manualHold: Explicit manual hold flag (separate from computed holdState)
-- syncPending: Whether metafield sync is pending (set on failure, cleared on success)
-- holdReasonCode: Machine-readable reason for the hold
-- holdNote: Optional internal note about the hold

ALTER TABLE "BuyerAccount"
ADD COLUMN IF NOT EXISTS "manualHold" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "BuyerAccount"
ADD COLUMN IF NOT EXISTS "syncPending" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "BuyerAccount"
ADD COLUMN IF NOT EXISTS "holdReasonCode" TEXT;

ALTER TABLE "BuyerAccount"
ADD COLUMN IF NOT EXISTS "holdNote" TEXT;

-- Index for finding accounts with pending sync
CREATE INDEX IF NOT EXISTS idx_buyer_account_sync_pending
  ON "BuyerAccount"("shopId", "syncPending")
  WHERE "syncPending" = true;

COMMENT ON COLUMN "BuyerAccount"."manualHold" IS 'S11: Explicit manual hold flag set by merchant';
COMMENT ON COLUMN "BuyerAccount"."syncPending" IS 'S11: Whether metafield sync to Shopify is pending';
COMMENT ON COLUMN "BuyerAccount"."holdReasonCode" IS 'S11: Machine-readable reason code for hold (e.g., MANUAL_HOLD, PAYMENT_OVERDUE)';
COMMENT ON COLUMN "BuyerAccount"."holdNote" IS 'S11: Optional internal note about the hold';
