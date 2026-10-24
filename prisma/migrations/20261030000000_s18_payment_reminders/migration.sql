-- S18: Payment Reminders - Cap tracking, per-shop settings, pg_cron enqueue job
--
-- This migration:
-- 1. Creates s18_global_sends table for GLOBAL daily/monthly cap tracking (Resend limits are per account)
-- 2. Creates s18_shop_reminder_settings table for per-shop reminder toggle (defaults OFF)
-- 3. Creates helper function s18_enqueue_reminders() using shop timezone and send window
-- 4. Schedules hourly pg_cron job to call the enqueue function
-- 5. Creates default reminder rules for existing shops (3 days before, on due, 7 days overdue)
--
-- Resend Free Tier Limits (https://resend.com/pricing):
--   - 100 emails/day per account (GLOBAL, not per-shop)
--   - 3,000 emails/month per account (GLOBAL, not per-shop)
--
-- Cap behavior:
--   - Caps are enforced GLOBALLY across all shops sharing the same Resend API key
--   - Daily cap (100) resets at midnight UTC
--   - Monthly cap (3,000) resets on the 1st of each month UTC
--   - Atomic increment with cap check prevents race conditions

-- =============================================================================
-- GLOBAL SENDS TRACKING TABLE (account-wide, not per-shop)
-- =============================================================================

CREATE TABLE IF NOT EXISTS s18_global_sends (
    -- Using a fixed key 'global' since Resend limits are per API key/account
    send_key TEXT NOT NULL,
    send_date DATE NOT NULL,
    send_month TEXT NOT NULL, -- YYYY-MM format for monthly tracking
    daily_count INT NOT NULL DEFAULT 0,
    monthly_count INT NOT NULL DEFAULT 0,
    updated_at TIMESTAMPTZ(3) NOT NULL DEFAULT NOW(),
    PRIMARY KEY (send_key, send_date)
);

COMMENT ON TABLE s18_global_sends IS 'S18: Tracks GLOBAL reminder email counts for Resend free tier caps (100/day, 3000/month). Caps are per Resend account, not per shop.';

-- Index for monthly rollup queries
CREATE INDEX IF NOT EXISTS idx_s18_global_sends_month ON s18_global_sends(send_key, send_month);

-- Index for cleanup of old entries
CREATE INDEX IF NOT EXISTS idx_s18_global_sends_date ON s18_global_sends(send_date);

-- Enable RLS with no policies (blocks all access via PostgREST)
ALTER TABLE s18_global_sends ENABLE ROW LEVEL SECURITY;

-- =============================================================================
-- SHOP REMINDER SETTINGS TABLE
-- =============================================================================

CREATE TABLE IF NOT EXISTS s18_shop_reminder_settings (
    shop_id TEXT PRIMARY KEY,
    enabled BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMPTZ(3) NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ(3) NOT NULL DEFAULT NOW(),
    CONSTRAINT s18_shop_reminder_settings_shop_fkey
      FOREIGN KEY (shop_id) REFERENCES "Shop"(id) ON DELETE CASCADE ON UPDATE CASCADE
);

COMMENT ON TABLE s18_shop_reminder_settings IS 'S18: Per-shop reminder settings. enabled defaults to FALSE - merchants must explicitly enable.';

-- Create trigger for updated_at (reuse existing set_updated_at function)
CREATE TRIGGER s18_shop_reminder_settings_updated_at
  BEFORE UPDATE ON s18_shop_reminder_settings
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Enable RLS with no policies (blocks all access via PostgREST)
ALTER TABLE s18_shop_reminder_settings ENABLE ROW LEVEL SECURITY;

-- =============================================================================
-- SAFE TIMEZONE HELPER FUNCTION
-- =============================================================================

-- Returns a valid IANA timezone or the fallback 'Asia/Kolkata'.
-- Prevents invalid Shop.timezone from aborting the entire enqueue run.
CREATE OR REPLACE FUNCTION public.s18_safe_timezone(tz TEXT)
RETURNS TEXT
LANGUAGE sql
STABLE
SECURITY INVOKER
AS $$
  SELECT CASE 
    WHEN tz IS NULL THEN 'Asia/Kolkata'
    WHEN EXISTS (SELECT 1 FROM pg_catalog.pg_timezone_names WHERE name = tz) THEN tz
    ELSE 'Asia/Kolkata'
  END;
$$;

COMMENT ON FUNCTION public.s18_safe_timezone(TEXT) IS 'S18: Returns valid timezone or fallback. Used by s18_enqueue_reminders to skip bad timezones safely.';

-- =============================================================================
-- ENQUEUE REMINDERS FUNCTION
-- =============================================================================

-- Function to enqueue reminder work for eligible invoices
-- Uses EACH shop's timezone for day math (from Shop.timezone, S7)
-- Only enqueues during the shop's local 09:00-19:00 window
--
-- SECURITY: Uses SECURITY DEFINER with search_path='' to prevent
-- search_path injection. All table, function, and type names are
-- schema-qualified (public.*, pgmq.*) per s10_call_drain convention.
--
-- ROBUSTNESS: Invalid Shop.timezone values are handled gracefully via
-- s18_safe_timezone() - bad shops get skipped with fallback to Asia/Kolkata.
CREATE OR REPLACE FUNCTION public.s18_enqueue_reminders()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $func$
DECLARE
    reminder_row RECORD;
    enqueued_count INT := 0;
    shop_local_hour INT;
    shop_local_date DATE;
BEGIN
    -- Find all eligible (invoiceId, ruleId) pairs:
    -- 1. Shop has reminders enabled (srs.enabled = true)
    -- 2. Shop is installed (uninstalledAt IS NULL)
    -- 3. Invoice is open with a due date
    -- 4. Rule is enabled and channel is email
    -- 5. Due date + offset = today IN THE SHOP'S TIMEZONE
    -- 6. Current time is within shop's local 09:00-19:00 window
    -- 7. No existing ReminderLog entry for (invoiceId, ruleId)
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
            s.domain AS shop_domain,
            s.timezone AS shop_timezone
        FROM public."ReminderRule" r
        INNER JOIN public.s18_shop_reminder_settings srs 
            ON srs.shop_id = r."shopId" AND srs.enabled = true
        INNER JOIN public."Shop" s 
            ON s.id = r."shopId" AND s."uninstalledAt" IS NULL
        INNER JOIN public."Invoice" i 
            ON i."shopId" = r."shopId"
            AND i.status = 'open'
            AND i."dueAt" IS NOT NULL
        WHERE r.enabled = true
          AND r.channel = 'email'::public."ReminderChannel"
          -- Check send window: shop's local hour must be 09-18 (19:00 = last send at 18:xx)
          -- Uses s18_safe_timezone to gracefully handle invalid Shop.timezone values
          AND EXTRACT(HOUR FROM (NOW() AT TIME ZONE public.s18_safe_timezone(s.timezone))) BETWEEN 9 AND 18
          -- Due date + offset = today in shop's timezone
          AND (i."dueAt" AT TIME ZONE public.s18_safe_timezone(s.timezone))::DATE + r."offsetDays" 
              = (NOW() AT TIME ZONE public.s18_safe_timezone(s.timezone))::DATE
          -- Exclude already-sent reminders (unique index ensures idempotency)
          AND NOT EXISTS (
              SELECT 1 FROM public."ReminderLog" rl
              WHERE rl."ruleId" = r.id AND rl."invoiceId" = i.id
          )
    LOOP
        -- Enqueue a REMINDER_SEND message to the s6_sync queue
        -- The drain handler will check caps and send the email
        PERFORM pgmq.send(
            's6_sync'::TEXT,
            pg_catalog.jsonb_build_object(
                'topic', 'REMINDER_SEND',
                'shop', reminder_row.shop_domain,
                'shopId', reminder_row.shop_id,
                'invoiceId', reminder_row.invoice_id,
                'ruleId', reminder_row.rule_id,
                'offsetDays', reminder_row.offset_days,
                'timezone', public.s18_safe_timezone(reminder_row.shop_timezone),
                'webhookId', 's18_' || reminder_row.invoice_id || '_' || reminder_row.rule_id || '_' || 
                    ((NOW() AT TIME ZONE public.s18_safe_timezone(reminder_row.shop_timezone))::DATE)::TEXT,
                'enqueuedAt', NOW()::TEXT
            )
        );
        
        enqueued_count := enqueued_count + 1;
    END LOOP;
    
    IF enqueued_count > 0 THEN
        RAISE LOG 's18_enqueue_reminders: enqueued % reminder(s)', enqueued_count;
    END IF;
END;
$func$;

COMMENT ON FUNCTION public.s18_enqueue_reminders() IS 'S18: Enqueues REMINDER_SEND messages for eligible invoices. Uses shop timezone for day math, only enqueues during 09:00-19:00 local time. Called by pg_cron hourly.';

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

    -- Unschedule existing jobs if they exist (idempotent)
    IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 's18_enqueue_reminders_hourly') THEN
        PERFORM cron.unschedule('s18_enqueue_reminders_hourly');
    END IF;
    
    IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 's18_global_sends_cleanup') THEN
        PERFORM cron.unschedule('s18_global_sends_cleanup');
    END IF;

    -- Schedule hourly reminder enqueue job (at minute 15 of each hour)
    -- Offset from minute 0 to avoid collision with drain cron
    PERFORM cron.schedule(
        's18_enqueue_reminders_hourly',
        '15 * * * *',
        $cmd$SELECT public.s18_enqueue_reminders()$cmd$
    );
    RAISE NOTICE 'Scheduled s18_enqueue_reminders_hourly cron job';
    
    -- Schedule cleanup of global sends older than 35 days (daily at 05:00 UTC)
    -- Keep slightly more than a month for monthly rollup accuracy
    PERFORM cron.schedule(
        's18_global_sends_cleanup',
        '0 5 * * *',
        $cmd$DELETE FROM public.s18_global_sends WHERE send_date < NOW() - INTERVAL '35 days'$cmd$
    );
    RAISE NOTICE 'Scheduled s18_global_sends_cleanup cron job';

END;
$do$;

-- =============================================================================
-- DEFAULT REMINDER RULES FOR EXISTING SHOPS
-- =============================================================================

-- Insert default reminder rules for shops that don't have any yet
-- Default offsets: -3 (3 days before), 0 (on due date), 7 (7 days overdue)
-- Rules are enabled by default, but shop-level reminders start DISABLED
INSERT INTO public."ReminderRule" (id, "shopId", "offsetDays", channel, enabled, "createdAt", "updatedAt")
SELECT 
    pg_catalog.gen_random_uuid()::TEXT,
    s.id,
    offset_days.val,
    'email'::public."ReminderChannel",
    true,
    NOW(),
    NOW()
FROM public."Shop" s
CROSS JOIN (VALUES (-3), (0), (7)) AS offset_days(val)
WHERE s."uninstalledAt" IS NULL
  AND NOT EXISTS (
      SELECT 1 FROM public."ReminderRule" r WHERE r."shopId" = s.id
  )
ON CONFLICT DO NOTHING;

-- NOTE: Shops start with reminders DISABLED by default (no row in s18_shop_reminder_settings
-- or enabled = false). Merchants must explicitly enable reminders via the settings UI.
-- This is intentional: we don't want to send emails until the merchant opts in AND
-- the RESEND_API_KEY is configured.
