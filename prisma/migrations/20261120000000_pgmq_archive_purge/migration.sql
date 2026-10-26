-- pgmq archive purge: 7-day retention for pgmq.a_s6_sync and pgmq.a_s6_bulk
--
-- This migration ONLY defines the purge function. It does NOT schedule it:
-- there is no cron.schedule call, so applying this migration deletes nothing.
-- Enabling the nightly job needs the owner's (Raghav's) explicit OK; the
-- schedule SQL is kept in the comment at the bottom of this file.
--
-- What it deletes: archived (already processed) queue messages, i.e. rows of
-- pgmq.a_s6_sync / pgmq.a_s6_bulk with archived_at older than 7 days. Live queue
-- tables (pgmq.q_*) and the dead-letter table (s6_dead_letter) are not touched.
--
-- Bounded: deletes by msg_id in batches of p_batch_size (default 5000, clamped
-- to 1..50000), at most p_max_batches batches per table per call (default 20,
-- clamped to 1..1000). Returns the total number of rows deleted. Any rows left
-- over are picked up by the next call. Uses pgmq's archived_at index on each
-- archive table. Tables that do not exist are skipped.
--
-- RETENTION WINDOW: 7 days

CREATE OR REPLACE FUNCTION public.pgmq_purge_archives_7d(
  p_batch_size INTEGER DEFAULT 5000,
  p_max_batches INTEGER DEFAULT 20
)
RETURNS BIGINT
LANGUAGE plpgsql
AS $$
DECLARE
  v_batch_size INTEGER := LEAST(GREATEST(COALESCE(p_batch_size, 5000), 1), 50000);
  v_max_batches INTEGER := LEAST(GREATEST(COALESCE(p_max_batches, 20), 1), 1000);
  v_table TEXT;
  v_batch INTEGER;
  v_deleted INTEGER;
  v_total BIGINT := 0;
BEGIN
  FOREACH v_table IN ARRAY ARRAY['a_s6_sync', 'a_s6_bulk'] LOOP
    IF to_regclass(format('pgmq.%I', v_table)) IS NULL THEN
      CONTINUE;
    END IF;

    v_batch := 0;
    LOOP
      EXIT WHEN v_batch >= v_max_batches;
      v_batch := v_batch + 1;

      EXECUTE format(
        'DELETE FROM pgmq.%1$I
          WHERE msg_id IN (
            SELECT msg_id FROM pgmq.%1$I
             WHERE archived_at < now() - interval ''7 days''
             ORDER BY msg_id
             LIMIT $1
          )',
        v_table
      ) USING v_batch_size;

      GET DIAGNOSTICS v_deleted = ROW_COUNT;
      v_total := v_total + v_deleted;
      EXIT WHEN v_deleted < v_batch_size;
    END LOOP;
  END LOOP;

  RETURN v_total;
END;
$$;

COMMENT ON FUNCTION public.pgmq_purge_archives_7d(INTEGER, INTEGER) IS
  'Deletes pgmq.a_s6_sync / pgmq.a_s6_bulk rows archived more than 7 days ago, in bounded msg_id batches. Returns rows deleted. NOT scheduled; enabling needs owner OK.';

-- =============================================================================
-- PG_CRON JOB: intentionally NOT scheduled
-- =============================================================================
-- To enable later, only with the owner's explicit OK, in a separate reviewed
-- migration (daily 05:30 UTC, after the other retention jobs):
--
--   DO $do$
--   BEGIN
--     IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
--       PERFORM cron.schedule(
--         'pgmq_purge_archives_7d',
--         '30 5 * * *',
--         'SELECT public.pgmq_purge_archives_7d()'
--       );
--     END IF;
--   END$do$;
