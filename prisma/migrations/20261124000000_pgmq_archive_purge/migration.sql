-- pgmq archive purge: 30-day retention for pgmq.a_s6_sync and pgmq.a_s6_bulk
--
-- This migration ONLY defines the purge function. It does NOT schedule it:
-- there is no cron.schedule call, so applying this migration deletes nothing.
-- Enabling the nightly job needs the owner's (Raghav's) explicit OK; the
-- schedule SQL is kept in the comment at the bottom of this file.
--
-- What it deletes: archived (already processed) queue messages, i.e. rows of
-- pgmq.a_s6_sync / pgmq.a_s6_bulk with archived_at older than 30 days. Live queue
-- tables (pgmq.q_*) and the dead-letter table (s6_dead_letter) are not touched.
--
-- Bounded: deletes by msg_id in batches of p_batch_size (default 5000, clamped
-- to 1..50000), at most p_max_batches batches per table per call (default 20,
-- clamped to 1..1000). Returns the total number of rows deleted. Any rows left
-- over are picked up by the next call. Uses pgmq's archived_at index on each
-- archive table. Tables that do not exist are skipped.
--
-- SECURITY: SET search_path = '' with every reference schema-qualified (pgmq.*,
-- pg_catalog.*), and EXECUTE is revoked from PUBLIC, anon and authenticated.
--
-- RETENTION WINDOW: 30 days

CREATE OR REPLACE FUNCTION public.pgmq_purge_archives_30d(
  p_batch_size INTEGER DEFAULT 5000,
  p_max_batches INTEGER DEFAULT 20
)
RETURNS BIGINT
LANGUAGE plpgsql
SET search_path = ''
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
    IF pg_catalog.to_regclass(pg_catalog.format('pgmq.%I', v_table)) IS NULL THEN
      CONTINUE;
    END IF;

    v_batch := 0;
    LOOP
      EXIT WHEN v_batch >= v_max_batches;
      v_batch := v_batch + 1;

      EXECUTE pg_catalog.format(
        'DELETE FROM pgmq.%1$I
          WHERE msg_id IN (
            SELECT msg_id FROM pgmq.%1$I
             WHERE archived_at < pg_catalog.now() - interval ''30 days''
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

COMMENT ON FUNCTION public.pgmq_purge_archives_30d(INTEGER, INTEGER) IS
  'Deletes pgmq.a_s6_sync / pgmq.a_s6_bulk rows archived more than 30 days ago, in bounded msg_id batches. Returns rows deleted. NOT scheduled; enabling needs owner OK.';

-- Revoke execute: always from PUBLIC; from anon / authenticated only where those
-- (Supabase) roles exist, since CI Postgres does not have them.
REVOKE ALL ON FUNCTION public.pgmq_purge_archives_30d(INTEGER, INTEGER) FROM PUBLIC;

DO $revoke$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE ALL ON FUNCTION public.pgmq_purge_archives_30d(INTEGER, INTEGER) FROM anon';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'REVOKE ALL ON FUNCTION public.pgmq_purge_archives_30d(INTEGER, INTEGER) FROM authenticated';
  END IF;
END
$revoke$;

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
--         'pgmq_purge_archives_30d',
--         '30 5 * * *',
--         'SELECT public.pgmq_purge_archives_30d()'
--       );
--     END IF;
--   END$do$;
