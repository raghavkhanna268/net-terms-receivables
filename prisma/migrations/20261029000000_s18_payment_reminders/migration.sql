-- S18: Payment Reminders - Daily cap tracking and pg_cron enqueue job
--
-- This migration:
-- 1. Creates s18_daily_sends table to track daily send counts per shop (for Resend free tier cap)
-- 2. Creates s18_shop_reminder_settings table for per-shop reminder toggle
-- 3. Creates helper function s18_enqueue_reminders() to enqueue reminder jobs
-- 4. Schedules hourly pg_cron job to call the enqueue function
-- 5. Creates default reminder rules for existing shops (3 days before, on due, 7 days overdue)
--
-- Resend Free Tier Limits (https://resend.com/pricing):
--   - 100 emails/day per account
--   - 3,000 emails/month per account
--
-- Daily cap is enforced per-shop at 100 emails/day to stay under free tier.

-- =============================================================================
-- DAILY SENDS TRACKING TABLE
-- =============================================================================

CREATE TABLE IF NOT EXISTS s18_daily_sends (
    shop_id TEXT NOT NULL,
    send_date DATE NOT NULL,
    count INT NOT NULL DEFAULT 0,
    PRIMARY KEY (shop_id, send_date)
);

COMMENT ON TABLE s18_daily_sends IS 'S18: Tracks daily reminder email count per shop for Resend free tier cap (100/day)';

-- Add FK to Shop with CASCADE delete
ALTER TABLE s18_daily_sends
  ADD CONSTRAINT s18_daily_sends_shop_fkey
  FOREIGN KEY (shop_id) REFERENCES "Shop"(id) ON DELETE CASCADE;

-- Index for cleanup of old entries (7 day retention via pg_cron purge job)
CREATE INDEX IF NOT EXISTS idx_s18_daily_sends_date ON s18_daily_sends(send_date);

-- =============================================================================
-- SHOP REMINDER SETTINGS TABLE
-- =============================================================================

CREATE TABLE IF NOT EXISTS s18_shop_reminder_settings (
    shop_id TEXT PRIMARY KEY REFERENCES "Shop"(id) ON DELETE CASCADE,
    enabled BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE s18_shop_reminder_settings IS 'S18: Per-shop reminder settings (enabled toggle)';

-- Create trigger for updated_at (reuse existing set_updated_at function)
CREATE TRIGGER s18_shop_reminder_settings_updated_at
  BEFORE UPDATE ON s18_shop_reminder_settings
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- =============================================================================
-- ENQUEUE REMINDERS FUNCTION
-- =============================================================================

-- Function to enqueue reminder work for eligible invoices
-- This ONLY enqueues to the queue; the drain sends the actual emails
CREATE OR REPLACE FUNCTION public.s18_enqueue_reminders()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $func$
DECLARE
    reminder_row RECORD;
    invoice_row RECORD;
    enqueued_count INT := 0;
    current_date_ist DATE;
BEGIN
    -- Get current date in Asia/Kolkata timezone (consistent with S7 aging-dates)
    current_date_ist := (NOW() AT TIME ZONE 'Asia/Kolkata')::DATE;
    
    -- Find all eligible (invoiceId, ruleId) pairs:
    -- 1. Invoice is open
    -- 2. Invoice has a due date
    -- 3. Rule is enabled
    -- 4. Shop has reminders enabled
    -- 5. Invoice due date + rule offset = today
    -- 6. No existing ReminderLog entry for (invoiceId, ruleId) - prevents duplicates
    FOR reminder_row IN
        SELECT
            r.id AS rule_id,
            r."shopId" AS shop_id,
            r."offsetDays" AS offset_days,
            r.channel,
            i.id AS invoice_id,
            i.name AS invoice_name,
            i."buyerAccountId" AS buyer_account_id,
            i.total,
            i."dueAt" AS due_at,
            s.domain AS shop_domain
        FROM "ReminderRule" r
        INNER JOIN s18_shop_reminder_settings srs ON srs.shop_id = r."shopId" AND srs.enabled = true
        INNER JOIN "Shop" s ON s.id = r."shopId" AND s."uninstalledAt" IS NULL
        INNER JOIN "Invoice" i ON i."shopId" = r."shopId"
            AND i.status = 'open'
            AND i."dueAt" IS NOT NULL
            -- Due date + offset = today (negative offset = before due, positive = after)
            AND (i."dueAt" AT TIME ZONE 'Asia/Kolkata')::DATE + r."offsetDays" = current_date_ist
        WHERE r.enabled = true
          AND r.channel = 'email'
          -- Exclude already-sent reminders (unique index ensures idempotency)
          AND NOT EXISTS (
              SELECT 1 FROM "ReminderLog" rl
              WHERE rl."ruleId" = r.id AND rl."invoiceId" = i.id
          )
    LOOP
        -- Enqueue a REMINDER_SEND message to the s6_sync queue
        -- The drain will pick this up and send the email
        PERFORM pgmq.send(
            's6_sync',
            jsonb_build_object(
                'topic', 'REMINDER_SEND',
                'shop', reminder_row.shop_domain,
                'shopId', reminder_row.shop_id,
                'invoiceId', reminder_row.invoice_id,
                'ruleId', reminder_row.rule_id,
                'webhookId', 's18_enqueue_' || reminder_row.invoice_id || '_' || reminder_row.rule_id || '_' || current_date_ist::TEXT,
                'enqueuedAt', NOW()::TEXT
            )
        );
        
        enqueued_count := enqueued_count + 1;
    END LOOP;
    
    IF enqueued_count > 0 THEN
        RAISE LOG 's18_enqueue_reminders: enqueued % reminder(s) for date %', enqueued_count, current_date_ist;
    END IF;
END;
$func$;

COMMENT ON FUNCTION public.s18_enqueue_reminders() IS 'S18: Enqueues REMINDER_SEND messages for eligible invoices. Called by pg_cron hourly.';

-- Revoke public access (Supabase-specific roles, guarded for CI compatibility)
DO $revoke$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
        EXECUTE 'REVOKE EXECUTE ON FUNCTION public.s18_enqueue_reminders() FROM anon';
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
        EXECUTE 'REVOKE EXECUTE ON FUNCTION public.s18_enqueue_reminders() FROM authenticated';
    END IF;
    REVOKE EXECUTE ON FUNCTION public.s18_enqueue_reminders() FROM PUBLIC;
END;
$revoke$;

-- =============================================================================
-- PG_CRON JOBS (guarded)
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
        RAISE NOTICE 'pg_cron not available; skipping S18 cron job creation (OK for CI)';
        RETURN;
    END IF;

    -- Unschedule existing job if it exists (idempotent)
    IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 's18_enqueue_reminders_hourly') THEN
        PERFORM cron.unschedule('s18_enqueue_reminders_hourly');
    END IF;
    
    IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 's18_daily_sends_cleanup') THEN
        PERFORM cron.unschedule('s18_daily_sends_cleanup');
    END IF;

    -- Schedule hourly reminder enqueue job (at minute 15 of each hour)
    -- Offset from minute 0 to avoid collision with drain cron
    PERFORM cron.schedule(
        's18_enqueue_reminders_hourly',
        '15 * * * *',
        $cmd$SELECT public.s18_enqueue_reminders()$cmd$
    );
    RAISE NOTICE 'Scheduled s18_enqueue_reminders_hourly cron job';
    
    -- Schedule cleanup of daily sends older than 7 days (daily, 05:00 UTC)
    PERFORM cron.schedule(
        's18_daily_sends_cleanup',
        '0 5 * * *',
        $cmd$DELETE FROM s18_daily_sends WHERE send_date < NOW() - INTERVAL '7 days'$cmd$
    );
    RAISE NOTICE 'Scheduled s18_daily_sends_cleanup cron job';

END;
$do$;

-- =============================================================================
-- DEFAULT REMINDER RULES FOR EXISTING SHOPS
-- =============================================================================

-- Insert default reminder rules for shops that don't have any yet
-- Default offsets: -3 (3 days before), 0 (on due date), 7 (7 days overdue)
INSERT INTO "ReminderRule" (id, "shopId", "offsetDays", channel, enabled, "createdAt", "updatedAt")
SELECT 
    gen_random_uuid()::TEXT,
    s.id,
    offset_days.val,
    'email'::"ReminderChannel",
    true,
    NOW(),
    NOW()
FROM "Shop" s
CROSS JOIN (VALUES (-3), (0), (7)) AS offset_days(val)
WHERE s."uninstalledAt" IS NULL
  AND NOT EXISTS (
      SELECT 1 FROM "ReminderRule" r WHERE r."shopId" = s.id
  )
ON CONFLICT DO NOTHING;

-- Note: Shops start with reminders DISABLED by default (no row in s18_shop_reminder_settings).
-- Merchants must explicitly enable reminders via the settings UI.
