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
-- What's cleared (after retention window):
-- - Payment.narration → '[RETENTION_PURGED]'
-- - Payment.payerText → NULL
--
-- Retention window: 180 days (PROVISIONAL, pending Raghav)
-- This matches UNMATCHED_NARRATION_RETENTION_DAYS in
-- app/services/compliance/compliance.server.ts
--
-- Job runs daily at 04:00 UTC (after other nightly jobs).

-- =============================================================================
-- PG_CRON: PURGE UNMATCHED PAYMENT NARRATION (RETENTION)
-- =============================================================================

DO $do$
BEGIN
  -- Only create the cron job if pg_cron extension is available
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    -- Schedule the retention purge job
    -- 180 days = 6 months (PROVISIONAL, pending product decision)
    PERFORM cron.schedule(
      's22_purge_unmatched_narration',
      '0 4 * * *',  -- Daily at 04:00 UTC
      $$
        UPDATE "Payment"
        SET
          narration = '[RETENTION_PURGED]',
          "payerText" = NULL,
          "updatedAt" = NOW()
        WHERE status = 'unmatched'
          AND "createdAt" < NOW() - INTERVAL '180 days'
          AND narration != '[RETENTION_PURGED]'
          AND narration != '[REDACTED]'
      $$
    );
    RAISE NOTICE 's22_purge_unmatched_narration cron job scheduled (04:00 UTC daily, 180-day window)';
  ELSE
    RAISE NOTICE 'pg_cron not available; skipping s22_purge_unmatched_narration job (OK for CI)';
  END IF;
END$do$;

-- =============================================================================
-- INDEX FOR RETENTION JOB (if not exists)
-- =============================================================================
-- The job filters by status='unmatched' AND createdAt < threshold.
-- Existing index idx_payment_shop_status on (shopId, status) helps,
-- but for the retention query we need (status, createdAt).

CREATE INDEX IF NOT EXISTS idx_payment_status_created
  ON "Payment" (status, "createdAt")
  WHERE status = 'unmatched';

COMMENT ON INDEX idx_payment_status_created IS 'S22: Supports retention purge of unmatched narration (status + createdAt filter)';
