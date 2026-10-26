-- pgmq-archive-age.sql (READ-ONLY)
-- Dry-run sizing for a proposed 7-day purge of the pgmq archive tables (nothing is
-- purged here). Per archive table: total rows, rows with archived_at older than 7 days,
-- and the oldest archived_at as a UTC date. Plus the s6_dead_letter row count for context.
-- Archive tables: pgmq.a_s6_sync and pgmq.a_s6_bulk, the only queues created by the
-- migrations (prisma/migrations/20261023000000_s6_pgmq_queues: pgmq.create('s6_sync'),
-- pgmq.create('s6_bulk')). The pgmq.meta section confirms no other queue exists in prod.
-- Counts, enums, booleans and dates only. No message bodies, payloads or domains.
-- Vars: none.
-- Output column kinds for passthrough columns (scripts/ci/check-readonly-columns.ts,
-- see scripts/readonly/README.md). Derived counts/booleans/CASE enums need no entry.
-- @col oldest_archived_utc_date: timestamp
\set ON_ERROR_STOP 1
BEGIN TRANSACTION READ ONLY;

\echo '== pgmq.meta queues (archive table present?)'
-- Queue names are mapped to literals; any unexpected queue shows up as 'other'.
SELECT CASE m.queue_name
         WHEN 's6_sync' THEN 's6_sync'
         WHEN 's6_bulk' THEN 's6_bulk'
         ELSE 'other'
       END AS queue,
       COUNT(*) AS queues,
       bool_and(to_regclass('pgmq.a_' || m.queue_name) IS NOT NULL) AS archive_exists
FROM pgmq.meta m
GROUP BY 1
ORDER BY 1;

\echo '== archive tables: total, older than 7 days, oldest archived_at (UTC date)'
SELECT 'a_s6_sync' AS archive_table,
       COUNT(*) AS total_rows,
       COUNT(*) FILTER (WHERE archived_at < NOW() - INTERVAL '7 days') AS older_than_7d,
       MIN((archived_at AT TIME ZONE 'UTC')::date) AS oldest_archived_utc_date
FROM pgmq.a_s6_sync
UNION ALL
SELECT 'a_s6_bulk',
       COUNT(*),
       COUNT(*) FILTER (WHERE archived_at < NOW() - INTERVAL '7 days'),
       MIN((archived_at AT TIME ZONE 'UTC')::date)
FROM pgmq.a_s6_bulk
ORDER BY 1;

\echo '== s6_dead_letter (context)'
SELECT COUNT(*) AS dlq_rows
FROM s6_dead_letter;

ROLLBACK;
