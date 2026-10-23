-- Fix S21 gated_at index: convert partial index to regular index.
-- The original migration (20261025000000_s21_plan_cache) created a partial index
-- with WHERE gated_at IS NOT NULL, which Prisma doesn't support natively.
--
-- This migration:
-- 1. Drops the partial index
-- 2. Creates a regular index with the same name (BuyerAccount_gated_at_idx)
--
-- The Prisma schema uses @@index([gatedAt], map: "BuyerAccount_gated_at_idx")
-- to reference this index, avoiding drift.

-- Drop the old partial index
DROP INDEX IF EXISTS "BuyerAccount_gated_at_idx";

-- Create a regular index with the same name
CREATE INDEX IF NOT EXISTS "BuyerAccount_gated_at_idx" ON "BuyerAccount" (gated_at);
