-- Credit Status Metafield Synced At
-- Adds a nullable metafieldSyncedAt column to BuyerAccount to track when the
-- credit_status metafield was last successfully synced to Shopify.
--
-- This column enables detection of accounts that have never had a metafield write,
-- which is needed to backfill seed CompanyLocations where $app:credit_status is null.
-- Without this metafield, the S12 checkout Validation Function has nothing to enforce.
--
-- Migration: ADD COLUMN only, no data backfill.

ALTER TABLE "BuyerAccount"
  ADD COLUMN "metafieldSyncedAt" TIMESTAMPTZ(3);

-- No index needed: the backfill script queries metafieldSyncedAt IS NULL, which
-- is a one-time operation. Daily operations use existing indexes on shopId, holdState.
