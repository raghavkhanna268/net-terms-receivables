-- S22 Follow-ups: Retention job for unmatched payment narration
--
-- This migration adds a pg_cron job that clears raw narration/payerText
-- on UNMATCHED payments older than the retention window.
--
-- What's retained:
-- - Payment.amount, Payment.utr, Payment.rail, Payment.valueDate
-- - Payment.status, Payment.importId (match history)
-- - All matched payments retain narration until customers/redact
--
-- What's cleared (after retention window, measured from valueDate):
-- - Payment.narration → '[RETENTION_PURGED]'
-- - Payment.payerText → NULL
--
-- Age measurement: valueDate (when the payment occurred per bank statement),
-- NOT createdAt (when it was imported). This aligns with docs/privacy.md.
--
-- RETENTION WINDOW: 180 days (PROVISIONAL, pending Raghav)
-- *** SINGLE SOURCE OF TRUTH: s22_unmatched_narration_retention_days() function ***
-- To change: update the function below. The TS constant in
-- app/services/compliance/compliance.server.ts documents the same value.
--
-- Job runs daily at 04:00 UTC (after other nightly jobs).
--
-- HARDENING NOTES:
-- - All table/column references are schema-qualified (public."Payment")
-- - NULL-safe comparison using IS DISTINCT FROM for narration checks
-- - Explicit NOT NULL check ensures rows with NULL narration aren't touched
-- - status uses the PaymentStatus enum value 'unmatched' (not partial/matched)
-- - No partial index (Prisma drift issue per S21 precedent)

-- =============================================================================
-- RETENTION WINDOW CONFIG FUNCTION
-- =============================================================================
-- PROVISIONAL: 180 days, pending Raghav
-- This is the SINGLE source of truth for the retention window.
-- The cron job calls this function rather than hardcoding the interval.

CREATE OR REPLACE FUNCTION public.s22_unmatched_narration_retention_days()
RETURNS INTEGER
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT 180  -- PROVISIONAL, pending Raghav
$$;

COMMENT ON FUNCTION public.s22_unmatched_narration_retention_days() IS
  'S22: Retention window (days) for unmatched payment narration. PROVISIONAL: 180 days, pending Raghav. This is the single source of truth; change here to update the retention policy.';

-- =============================================================================
-- PG_CRON: PURGE UNMATCHED PAYMENT NARRATION (RETENTION)
-- =============================================================================

DO $do$
BEGIN
  -- Only create the cron job if pg_cron extension is available
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    -- Schedule the retention purge job
    -- Age measured from valueDate (bank statement date), not createdAt (import date)
    -- Retention window read from s22_unmatched_narration_retention_days() function
    PERFORM cron.schedule(
      's22_purge_unmatched_narration',
      '0 4 * * *',  -- Daily at 04:00 UTC
      $$
        UPDATE public."Payment"
        SET
          narration = '[RETENTION_PURGED]',
          "payerText" = NULL,
          "updatedAt" = NOW()
        WHERE status = 'unmatched'
          AND "valueDate" < NOW() - (public.s22_unmatched_narration_retention_days() || ' days')::INTERVAL
          AND narration IS NOT NULL
          AND narration IS DISTINCT FROM '[RETENTION_PURGED]'
          AND narration IS DISTINCT FROM '[REDACTED]'
      $$
    );
    RAISE NOTICE 's22_purge_unmatched_narration cron job scheduled (04:00 UTC daily, retention from s22_unmatched_narration_retention_days())';
  ELSE
    RAISE NOTICE 'pg_cron not available; skipping s22_purge_unmatched_narration job (OK for CI)';
  END IF;
END$do$;

-- =============================================================================
-- INDEX FOR RETENTION JOB
-- =============================================================================
-- The job filters by status='unmatched' AND valueDate < threshold.
-- Using a regular index (not partial) to avoid Prisma drift issues.
-- See 20261025000001_s21_fix_gated_at_index for precedent.

CREATE INDEX IF NOT EXISTS idx_payment_status_valuedate
  ON public."Payment" (status, "valueDate");

COMMENT ON INDEX idx_payment_status_valuedate IS 'S22: Supports retention purge of unmatched narration (status + valueDate filter). Regular index (not partial) to avoid Prisma drift.';
