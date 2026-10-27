-- pgmq archive retention: delete processed queue messages after 30 days.
--
-- Schedules one daily pg_cron job, 'pgmq_purge_archives_30d', at 05:30 UTC
-- (11:00 IST), after the other retention jobs. It deletes only rows of
-- pgmq.a_s6_sync and pgmq.a_s6_bulk (created by 20261023000000_s6_pgmq_queues)
-- whose archived_at is older than 30 days. Live queues (pgmq.q_*) and
-- s6_dead_letter are not touched. Applying this migration deletes nothing by
-- itself; the job does, on its schedule.
--
-- Idempotent: an existing job with the same name is unscheduled first, so
-- re-running leaves exactly one job. No-op where cron.job does not exist
-- (pg_cron not installed, e.g. CI).
-- The guard checks cron.job directly (not pg_extension) so the real migration can be exercised in CI against a test cron schema.

DO $do$
BEGIN
  IF pg_catalog.to_regclass('cron.job') IS NULL THEN
    RAISE NOTICE 'pg_cron not available; skipping pgmq_purge_archives_30d job (OK for CI)';
    RETURN;
  END IF;

  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'pgmq_purge_archives_30d') THEN
    PERFORM cron.unschedule('pgmq_purge_archives_30d');
  END IF;

  PERFORM cron.schedule(
    'pgmq_purge_archives_30d',
    '30 5 * * *',
    $cmd$DELETE FROM pgmq.a_s6_sync WHERE archived_at < NOW() - INTERVAL '30 days'; DELETE FROM pgmq.a_s6_bulk WHERE archived_at < NOW() - INTERVAL '30 days'$cmd$
  );
END
$do$;
