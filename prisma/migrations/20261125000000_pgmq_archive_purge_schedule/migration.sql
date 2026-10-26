-- pgmq archive purge: schedule the 30-day purge (daily 05:30 UTC)
--
-- Depends on 20261124000000_pgmq_archive_purge, which defines
-- public.pgmq_purge_archives_30d(INTEGER, INTEGER). Applying this migration
-- ENABLES deletion of pgmq.a_s6_sync / pgmq.a_s6_bulk rows archived more than
-- 30 days ago, nightly, in bounded batches (5000 rows x 20 batches per table per
-- run). Needs the owner's (Raghav's) explicit OK before it is merged/applied.
--
-- Idempotent: an existing job named 'pgmq_purge_archives_30d' is unscheduled
-- first, so re-running leaves exactly one job. Skipped (no-op) where pg_cron is
-- not installed, e.g. CI.

DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_extension WHERE extname = 'pg_cron') THEN
    RAISE NOTICE 'pg_cron not available; skipping pgmq_purge_archives_30d job (OK for CI)';
    RETURN;
  END IF;

  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'pgmq_purge_archives_30d') THEN
    PERFORM cron.unschedule('pgmq_purge_archives_30d');
  END IF;

  PERFORM cron.schedule(
    'pgmq_purge_archives_30d',
    '30 5 * * *',
    'SELECT public.pgmq_purge_archives_30d()'
  );
END
$do$;
