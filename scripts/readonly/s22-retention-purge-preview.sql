-- s22-retention-purge-preview.sql (READ-ONLY)
-- Counts the rows s22_purge_unmatched_narration() (migration 20261101000000_s22_followups)
-- WOULD touch, using the exact same table, columns and predicate (180-day window,
-- hard-coded here because the migration's config function may not exist yet).
-- Counts, booleans and timestamps only. No narration, payerText or other PII.
-- Vars: none.
-- Output column kinds for passthrough columns (scripts/ci/check-readonly-columns.ts,
-- see scripts/readonly/README.md). Derived counts/booleans/CASE enums need no entry.
-- @col transaction_read_only: boolean
-- @col status: enum
\set ON_ERROR_STOP 1
BEGIN TRANSACTION READ ONLY;

\echo '== session read-only'
SHOW transaction_read_only;

\echo '== S22 migration objects present (should be false/false before the migration)'
SELECT to_regprocedure('public.s22_purge_unmatched_narration()') IS NOT NULL AS purge_fn_exists,
       to_regclass('public.idx_payment_status_valuedate') IS NOT NULL AS index_exists;

\echo '== rows the purge would touch (status=unmatched, valueDate older than 180 days, narration not already purged/redacted/empty)'
SELECT COUNT(*) AS would_purge
FROM public."Payment"
WHERE status = 'unmatched'
  AND "valueDate" < NOW() - INTERVAL '180 days'
  AND narration != '[RETENTION_PURGED]'
  AND narration != '[REDACTED]'
  AND narration != '';

\echo '== context counts (Payment rows by status; unmatched age buckets)'
SELECT status::text AS status, COUNT(*) AS total,
       COUNT(*) FILTER (WHERE "valueDate" < NOW() - INTERVAL '180 days') AS older_than_180d,
       COUNT(*) FILTER (WHERE "valueDate" < NOW() - INTERVAL '150 days') AS older_than_150d
FROM public."Payment" GROUP BY 1 ORDER BY 1;

\echo '== oldest unmatched valueDate (timestamp only)'
SELECT MIN("valueDate") AS oldest_unmatched_value_date
FROM public."Payment" WHERE status = 'unmatched';

ROLLBACK;
