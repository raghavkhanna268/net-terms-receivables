-- g3-shop-config-currency-counts.sql (READ-ONLY)
-- G3: how many installed shops may lack the #292 $app:shop_config metafield
-- (currency for the INR-only Rust Function guards), and how many of those are
-- not INR. Output: exactly one row, three integer counts a, b, c. No domains,
-- ids, currency values or per-shop timestamps are printed.
-- Vars: none. The cutoff is a constant in this file, not a workflow input.
--
-- Columns (prisma/schema.prisma model Shop): "uninstalledAt" timestamptz(3),
-- "createdAt" timestamptz(3) (first install time), currency text NOT NULL
-- DEFAULT 'INR'.
--
-- Cutoff = PR #337 ("#292 INR-only currency guards: per-order filter +
-- fail-closed shop_config") merge time: mergedAt 2026-10-26T00:16:21Z,
-- merge commit e46c08b15db022e102c275d509bd9a471df85c3e
-- (git log -1 --format=%cI -> 2026-10-26T05:46:21+05:30, same instant).
--
-- a = shops not uninstalled: "uninstalledAt" IS NULL.
-- b = of a, shops that may have no shop_config metafield: "createdAt" < cutoff.
--     The schema has NO column recording a shop_config metafield write
--     (shop-config.server.ts only logs success/failure; Shop has no
--     metafield-synced-at column; BuyerAccount."metafieldSyncedAt" tracks the
--     credit_status metafield, not shop_config). So the "no shop_config synced"
--     arm cannot be read from the DB and b uses the cutoff arm only. b is an
--     upper bound: a pre-cutoff shop that re-authed or loaded /app after the
--     #337 deploy may already have shop_config and is still counted.
-- c = of b, shops whose stored currency is not INR:
--     currency IS DISTINCT FROM 'INR'. NULL counts as not INR (the column is
--     NOT NULL today, so this only matters if that ever changes); the match is
--     exact and case-sensitive, so 'inr' would count as not INR.
\set ON_ERROR_STOP 1
BEGIN TRANSACTION READ ONLY;

\echo '== g3 shop_config currency counts (a installed, b of a created before #337 merge, c of b not INR)'
SELECT
  COUNT(*) FILTER (WHERE s."uninstalledAt" IS NULL) AS a,
  COUNT(*) FILTER (
    WHERE s."uninstalledAt" IS NULL
      AND s."createdAt" < TIMESTAMPTZ '2026-10-26 00:16:21+00'
  ) AS b,
  COUNT(*) FILTER (
    WHERE s."uninstalledAt" IS NULL
      AND s."createdAt" < TIMESTAMPTZ '2026-10-26 00:16:21+00'
      AND s.currency IS DISTINCT FROM 'INR'
  ) AS c
FROM public."Shop" s;

ROLLBACK;
