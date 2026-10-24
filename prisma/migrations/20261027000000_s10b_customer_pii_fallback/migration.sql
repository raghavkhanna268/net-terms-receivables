-- S10b: Customer PII ACCESS_DENIED fallback counter
--
-- Tracks when customer fetches fall back to non-PII queries due to ACCESS_DENIED.
-- This happens when CUSTOMER_PII_FIELDS=1 but PCD approval is pending/revoked.
-- Aggregate table (shop, day, count) - no PII.

-- =============================================================================
-- CUSTOMER PII FALLBACK AGGREGATE TABLE
-- =============================================================================

CREATE TABLE IF NOT EXISTS s10b_customer_pii_fallback (
    shop TEXT NOT NULL,
    day DATE NOT NULL,
    count INT NOT NULL DEFAULT 1,
    PRIMARY KEY (shop, day)
);

COMMENT ON TABLE s10b_customer_pii_fallback IS 'S10b: Aggregate count of customer fetches that fell back to non-PII query due to ACCESS_DENIED per shop per day. No PII.';

-- Enable RLS with no policies (blocks all access via PostgREST)
ALTER TABLE s10b_customer_pii_fallback ENABLE ROW LEVEL SECURITY;

-- =============================================================================
-- 90-DAY RETENTION PURGE (guarded)
-- =============================================================================

DO $do$
DECLARE
    cron_enabled BOOLEAN := FALSE;
BEGIN
    -- Check if pg_cron is available
    SELECT EXISTS(
        SELECT 1 FROM pg_extension WHERE extname = 'pg_cron'
    ) INTO cron_enabled;

    IF NOT cron_enabled THEN
        RAISE NOTICE 'pg_cron not available; skipping 90-day retention purge job (OK for CI)';
        RETURN;
    END IF;

    -- Unschedule existing job if it exists (idempotent)
    IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 's10b_purge_old_pii_fallback') THEN
        PERFORM cron.unschedule('s10b_purge_old_pii_fallback');
    END IF;

    -- Schedule daily purge of records older than 90 days (04:15 UTC)
    PERFORM cron.schedule(
        's10b_purge_old_pii_fallback',
        '15 4 * * *',
        $cmd$DELETE FROM s10b_customer_pii_fallback WHERE day < CURRENT_DATE - INTERVAL '90 days'$cmd$
    );
    RAISE NOTICE 'Scheduled s10b_purge_old_pii_fallback cron job (04:15 UTC daily, 90-day retention)';

END;
$do$;
