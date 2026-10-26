-- g3-noninr-is-dev-store.sql (READ-ONLY)
-- G3 follow-up to g3-shop-config-currency-counts.sql: is every installed,
-- pre-#337 shop whose stored currency is not INR (the "c" set) the main dev
-- store (ALLOWED_DEV_STORE secret)? The comparison runs here in SQL against
-- the psql variable :allowed, which prod-readonly-query.yml sets from the
-- ALLOWED_DEV_STORE secret (validated and masked; never a workflow input).
-- Output: exactly one row, a count and a boolean. No domains, ids, currency
-- values or per-shop timestamps are printed.
-- Vars: allowed (from the secret, not an input). The cutoff is a constant,
-- the same as g3-shop-config-currency-counts.sql: PR #337 mergedAt
-- 2026-10-26T00:16:21Z, merge commit e46c08b15db022e102c275d509bd9a471df85c3e.
--
-- noninr_count = c: "uninstalledAt" IS NULL AND "createdAt" < cutoff AND
--   currency IS DISTINCT FROM 'INR' (NULL counts as not INR).
-- noninr_is_dev_store = true iff noninr_count > 0 and every shop in that set
--   has domain = :'allowed'. false when the set is empty or any shop in it is
--   not the allowed dev store.
\set ON_ERROR_STOP 1
BEGIN TRANSACTION READ ONLY;

\echo '== g3 non-INR pre-#337 installed shops vs allowed dev store (count + boolean)'
SELECT
  COUNT(*) AS noninr_count,
  COALESCE(bool_and(s.domain = :'allowed'), false) AS noninr_is_dev_store
FROM public."Shop" s
WHERE s."uninstalledAt" IS NULL
  AND s."createdAt" < TIMESTAMPTZ '2026-10-26 00:16:21+00'
  AND s.currency IS DISTINCT FROM 'INR';

ROLLBACK;
