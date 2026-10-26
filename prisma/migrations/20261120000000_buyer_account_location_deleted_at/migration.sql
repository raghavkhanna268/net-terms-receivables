-- T5: Add locationDeletedAt column to BuyerAccount
-- Tracks when a company location was deleted in Shopify.
-- Deleted company locations are excluded from the active account count.
-- A restore clears this only when the event/bulk timestamp is newer.

ALTER TABLE "BuyerAccount" ADD COLUMN "locationDeletedAt" TIMESTAMPTZ(3);
