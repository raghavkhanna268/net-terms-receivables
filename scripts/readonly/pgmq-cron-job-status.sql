-- pgmq-cron-job-status.sql (READ-ONLY)
-- Confirm the pgmq_purge_archives_30d pg_cron job (created by
-- prisma/migrations/20261126000000_pgmq_archive_purge_30d) is scheduled and succeeding.
-- This job runs daily at 05:30 UTC and deletes rows from pgmq.a_s6_sync and
-- pgmq.a_s6_bulk older than 30 days.
--
-- Output:
-- 1. Job definition from cron.job (jobid, jobname, schedule, active, job_exists)
-- 2. Last run from cron.job_run_details (runid, status, start_time_utc, duration_sec)
-- 3. Run counts by status over the last 7 days (succeeded, failed, other, total)
--
-- Scoped ONLY to jobs whose jobname = 'pgmq_purge_archives_30d'.
-- Never prints cron.job.command or job_run_details.return_message.
-- Counts, enums, booleans, ids and timestamps only. No free text.
-- Vars: none.
-- @col jobid: id
-- @col runid: id
-- @col active: boolean
-- @col start_time_utc: timestamp
-- @col duration_sec: count
\set ON_ERROR_STOP 1
BEGIN TRANSACTION READ ONLY;

\echo '== cron.job_run_details exists?'
SELECT to_regclass('cron.job_run_details') IS NOT NULL AS job_run_details_exists;

\echo '== pgmq_purge_archives_30d job definition (from cron.job)'
SELECT
  j.jobid,
  CASE WHEN j.jobname = 'pgmq_purge_archives_30d' THEN 'pgmq_purge_archives_30d' END AS jobname,
  CASE WHEN j.schedule IN ('30 5 * * *') THEN j.schedule
       ELSE 'other' END AS schedule,
  j.active,
  TRUE AS job_exists
FROM cron.job j
WHERE j.jobname = 'pgmq_purge_archives_30d'
UNION ALL
SELECT
  0::bigint AS jobid,
  'missing' AS jobname,
  'missing' AS schedule,
  FALSE AS active,
  FALSE AS job_exists
WHERE NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'pgmq_purge_archives_30d');

\echo '== pgmq_purge_archives_30d last run (from cron.job_run_details)'
SELECT
  d.runid,
  CASE WHEN d.status IN ('succeeded', 'failed', 'running', 'starting') THEN d.status
       ELSE 'other' END AS status,
  (d.start_time AT TIME ZONE 'UTC') AS start_time_utc,
  EXTRACT(EPOCH FROM (d.end_time - d.start_time))::int AS duration_sec
FROM cron.job_run_details d
JOIN cron.job j ON j.jobid = d.jobid
WHERE j.jobname = 'pgmq_purge_archives_30d'
ORDER BY d.start_time DESC
LIMIT 1;

\echo '== pgmq_purge_archives_30d run counts (last 7 days)'
SELECT
  COUNT(*) FILTER (WHERE d.status = 'succeeded') AS succeeded_7d,
  COUNT(*) FILTER (WHERE d.status = 'failed') AS failed_7d,
  COUNT(*) FILTER (WHERE d.status NOT IN ('succeeded', 'failed')) AS other_7d,
  COUNT(*) AS total_7d
FROM cron.job_run_details d
JOIN cron.job j ON j.jobid = d.jobid
WHERE j.jobname = 'pgmq_purge_archives_30d'
  AND d.start_time > NOW() - INTERVAL '7 days';

ROLLBACK;
