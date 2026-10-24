-- Order outstanding missing aggregate (diagnostic counter)
--
-- Counts orders where totalOutstandingSet is missing per shop per day.
-- Used to monitor data quality for S10b/S20 invoice sync.
-- No PII - just (shop, day, count) for diagnostics.
-- 90-day retention via pg_cron purge job.
--
-- Follows the same pattern as s10b_order_refetch_null.

-- =============================================================================
-- ORDER OUTSTANDING MISSING AGGREGATE TABLE
-- =============================================================================

CREATE TABLE IF NOT EXISTS order_outstanding_missing (
    shop TEXT NOT NULL,
    day DATE NOT NULL,
    count INT NOT NULL DEFAULT 1,
    PRIMARY KEY (shop, day)
);

COMMENT ON TABLE order_outstanding_missing IS 'Diagnostic counter: orders where totalOutstandingSet was missing per shop per day. No PII.';

-- Enable RLS with no policies (blocks all access via PostgREST)
ALTER TABLE order_outstanding_missing ENABLE ROW LEVEL SECURITY;

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
    IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'purge_old_order_outstanding_missing') THEN
        PERFORM cron.unschedule('purge_old_order_outstanding_missing');
    END IF;

    -- Schedule daily purge of records older than 90 days (04:30 UTC)
    PERFORM cron.schedule(
        'purge_old_order_outstanding_missing',
        '30 4 * * *',
        $cmd$DELETE FROM order_outstanding_missing WHERE day < CURRENT_DATE - INTERVAL '90 days'$cmd$
    );
    RAISE NOTICE 'Scheduled purge_old_order_outstanding_missing cron job (04:30 UTC daily, 90-day retention)';

END;
$do$;
