-- offline-session-preflight.sql (READ-ONLY)
-- Preflight for the nightly sweep: is each installed shop's OFFLINE Session row
-- refreshable without merchant re-auth? Columns from prisma/schema.prisma model
-- Session: isOnline, expires, refreshToken, refreshTokenExpires, needsReauth.
-- Session.expires and Session.refreshTokenExpires are TIMESTAMP(3) WITHOUT TIME
-- ZONE holding UTC wall-clock values, so every comparison uses
-- (NOW() AT TIME ZONE 'UTC') and the result does not depend on the DB session TimeZone.
-- Counts and booleans only. No token values, no shop domain (shops are labelled).
-- shop_kind: identity label from the canonical shop_labels CTE
-- (scripts/ci/shop-labels.ts). 'main' = the shop whose domain is :'allowed'
-- (ALLOWED_DEV_STORE), 'e2e' = :'e2e' (E2E_SHOP), 'other_N' = the rest ranked by
-- Shop.id within this run only (N is stable within one run but does NOT identify
-- a shop across runs), 'unknown' for every shop if a secret is empty or both are
-- equal. Domains are compared, never printed.
-- Vars: allowed, e2e (masked secrets, passed by prod-readonly-query.yml).
-- Output column kinds for passthrough columns (scripts/ci/check-readonly-columns.ts,
-- see scripts/readonly/README.md). Derived counts/booleans/CASE enums need no entry.
-- @col transaction_read_only: boolean
-- @col db_session_timezone: enum
\set ON_ERROR_STOP 1
BEGIN TRANSACTION READ ONLY;

\echo '== session read-only'
SHOW transaction_read_only;

\echo '== db session timezone (comparisons below are UTC-normalised regardless)'
SELECT current_setting('TimeZone') AS db_session_timezone;

\echo '== offline sessions (all rows, isOnline=false)'
SELECT COUNT(*) AS offline_sessions
FROM public."Session"
WHERE "isOnline" = false;

\echo '== offline session preflight per installed shop (Shop.uninstalledAt IS NULL; domain not printed)'
WITH shop_labels AS (
  SELECT s.id AS shop_id,
         CASE WHEN :'allowed' = '' OR :'e2e' = '' OR :'allowed' = :'e2e' THEN 'unknown'
              WHEN s.domain = :'allowed' THEN 'main'
              WHEN s.domain = :'e2e' THEN 'e2e'
              ELSE 'other_' || (ROW_NUMBER() OVER (
                     PARTITION BY s.domain IN (:'allowed', :'e2e')
                     ORDER BY s.id))::text
         END AS shop_kind
  FROM "Shop" s
)
SELECT
  sl.shop_kind,
  COUNT(se.id) AS offline_sessions,
  COUNT(se.id) > 0 AS has_offline_session,
  COALESCE(bool_and(se."refreshToken" IS NOT NULL AND se."refreshToken" <> ''), false) AS refresh_token_present,
  -- A shop with no offline session needs re-auth; don't let it read as false.
  COALESCE(bool_or(se."needsReauth"), COUNT(se.id) = 0) AS needs_reauth,
  COALESCE(bool_and(se."refreshTokenExpires" > (NOW() AT TIME ZONE 'UTC')), false) AS refresh_token_expires_in_future,
  COALESCE(bool_and(se."refreshTokenExpires" > (NOW() AT TIME ZONE 'UTC') + INTERVAL '2 hours'), false) AS refresh_token_valid_in_2h,
  COALESCE(bool_or(se.id IS NOT NULL AND se."refreshTokenExpires" IS NULL), false) AS refresh_token_expires_null,
  COALESCE(bool_or(se.expires < (NOW() AT TIME ZONE 'UTC')), false) AS access_token_expired
FROM public."Shop" s
JOIN shop_labels sl ON sl.shop_id = s.id
LEFT JOIN public."Session" se
  ON se.shop = s.domain AND se."isOnline" = false
WHERE s."uninstalledAt" IS NULL
GROUP BY s.id, sl.shop_kind
ORDER BY sl.shop_kind;

ROLLBACK;
