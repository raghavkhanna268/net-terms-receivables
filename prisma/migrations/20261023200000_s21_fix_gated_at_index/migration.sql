-- Fix S21 gated_at index to match Prisma schema expectations.
-- The original migration (20261025000000_s21_plan_cache) created a partial index
-- with snake_case naming that doesn't match Prisma's expected index name.
--
-- Changes:
-- 1. Drop the partial index (BuyerAccount_gated_at_idx)
-- 2. Create a regular index with the name Prisma expects (BuyerAccount_gatedAt_idx)
--
-- Note: A regular index is slightly less efficient than a partial index for
-- finding gated accounts, but it ensures Prisma schema drift checks pass.
-- For a boolean-like nullable column, the overhead is minimal.

-- Drop the old partial index
DROP INDEX IF EXISTS "BuyerAccount_gated_at_idx";

-- Create a regular index with the name Prisma expects
CREATE INDEX IF NOT EXISTS "BuyerAccount_gatedAt_idx" ON "BuyerAccount" (gated_at);
