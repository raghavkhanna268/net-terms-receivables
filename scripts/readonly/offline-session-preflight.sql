-- offline-session-preflight.sql (READ-ONLY)
-- Preflight for the nightly sweep: is each installed shop's OFFLINE Session row
-- refreshable without merchant re-auth? Columns from prisma/schema.prisma model
-- Session: isOnline, expires, refreshToken, refreshTokenExpires, needsReauth.
-- Counts and booleans only. No token values, no shop domain (shops are indexed).
-- Vars: none.
\set ON_ERROR_STOP 1
BEGIN TRANSACTION READ ONLY;

\echo '== session read-only'
SHOW transaction_read_only;

\echo '== offline sessions (all rows, isOnline=false)'
SELECT COUNT(*) AS offline_sessions
FROM public."Session"
WHERE "isOnline" = false;

\echo '== offline session preflight per installed shop (Shop.uninstalledAt IS NULL; domain not printed)'
SELECT
  ROW_NUMBER() OVER (ORDER BY s.id) AS shop_idx,
  COUNT(se.id) AS offline_sessions,
  COALESCE(bool_and(se."refreshToken" IS NOT NULL AND se."refreshToken" <> ''), false) AS refresh_token_present,
  COALESCE(bool_or(se."needsReauth"), false) AS needs_reauth,
  COALESCE(bool_and(se."refreshTokenExpires" > NOW()), false) AS refresh_token_expires_in_future,
  COALESCE(bool_or(se."refreshTokenExpires" IS NULL), false) AS refresh_token_expires_null,
  COALESCE(bool_or(se.expires < NOW()), false) AS access_token_expired
FROM public."Shop" s
LEFT JOIN public."Session" se
  ON se.shop = s.domain AND se."isOnline" = false
WHERE s."uninstalledAt" IS NULL
GROUP BY s.id
ORDER BY s.id;

ROLLBACK;
