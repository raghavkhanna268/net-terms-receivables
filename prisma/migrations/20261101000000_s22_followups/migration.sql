-- S22 Follow-ups: Retention job for unmatched payment narration
--
-- This migration adds:
-- 1. s22_unmatched_narration_retention_days() - config function (180 days)
-- 2. s22_purge_unmatched_narration() - purge function called by pg_cron and tests
-- 3. pg_cron job scheduling the purge daily at 04:00 UTC (09:30 IST)
-- 4. idx_payment_status_valuedate index for the purge query
--
-- What's retained: amount, UTR, rail, valueDate, status, importId, match history
-- What's cleared: narration → '[RETENTION_PURGED]', payerText → NULL
--
-- Age measured from valueDate (bank statement date), not createdAt (import date).
-- RETENTION WINDOW: 180 days

-- =============================================================================
-- RETENTION WINDOW CONFIG FUNCTION
-- =============================================================================
-- 180 days - single source of truth for the retention window.

CREATE OR REPLACE FUNCTION public.s22_unmatched_narration_retention_days()
RETURNS INTEGER
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT 180
$$;

COMMENT ON FUNCTION public.s22_unmatched_narration_retention_days() IS
  'S22: Retention window (days) for unmatched payment narration. Single source of truth.';

-- =============================================================================
-- PURGE FUNCTION
-- =============================================================================
-- Called by pg_cron job and integration tests. Returns number of rows purged.

CREATE OR REPLACE FUNCTION public.s22_purge_unmatched_narration()
RETURNS INTEGER
LANGUAGE plpgsql
AS $$
DECLARE
  purged_count INTEGER;
BEGIN
  UPDATE public."Payment"
  SET
    narration = '[RETENTION_PURGED]',
    "payerText" = NULL,
    "updatedAt" = NOW()
  WHERE status = 'unmatched'
    AND "valueDate" < NOW() - (public.s22_unmatched_narration_retention_days() || ' days')::INTERVAL
    AND narration != '[RETENTION_PURGED]'
    AND narration != '[REDACTED]'
    AND narration != '';

  GET DIAGNOSTICS purged_count = ROW_COUNT;
  RETURN purged_count;
END;
$$;

COMMENT ON FUNCTION public.s22_purge_unmatched_narration() IS
  'S22: Purge narration/payerText on old unmatched payments. Called by pg_cron daily. Returns rows purged.';

-- =============================================================================
-- PG_CRON JOB
-- =============================================================================

DO $do$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    PERFORM cron.schedule(
      's22_purge_unmatched_narration',
      '0 4 * * *',
      'SELECT public.s22_purge_unmatched_narration()'
    );
    RAISE NOTICE 's22_purge_unmatched_narration cron job scheduled (04:00 UTC daily)';
  ELSE
    RAISE NOTICE 'pg_cron not available; skipping s22_purge_unmatched_narration job (OK for CI)';
  END IF;
END$do$;

-- =============================================================================
-- INDEX
-- =============================================================================
-- Supports the purge query (status + valueDate filter).
-- Declared in schema.prisma as @@index([status, valueDate], map: "idx_payment_status_valuedate")

CREATE INDEX IF NOT EXISTS idx_payment_status_valuedate
  ON public."Payment" (status, "valueDate");

COMMENT ON INDEX idx_payment_status_valuedate IS 'S22: Supports retention purge of unmatched narration.';
