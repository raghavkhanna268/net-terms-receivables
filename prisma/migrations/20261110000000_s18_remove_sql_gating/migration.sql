-- S18: Remove gated-account filter from s18_enqueue_reminders()
--
-- Design change: SQL no longer filters gated accounts. The TS send and catch-up
-- paths (sendPaymentReminder, sendCatchupReminder) are the sole gating point,
-- checking PLAN_GATING_ENFORCED env var via isAccountActive().
--
-- This prevents SQL and TS from disagreeing on gating policy. Trade-off:
-- a gated invoice may be re-enqueued on its due day (Part 3) or within D+1..D+3
-- (Part 4), but TS drops it before any Resend call, claim, or cap reservation.
-- The re-enqueue is bounded by the catch-up window.

-- Drop the s18_app_settings table (no longer needed)
DROP TABLE IF EXISTS public.s18_app_settings;

-- Replace s18_enqueue_reminders() to remove gating filter
CREATE OR REPLACE FUNCTION public.s18_enqueue_reminders()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $func$
DECLARE
    reminder_row RECORD;
    catchup_row RECORD;
    enqueued_count INT := 0;
    catchup_count INT := 0;
    expired_count INT := 0;
    skipped_older_stages INT := 0;
    skipped_newer_due_today INT := 0;
BEGIN
    -- Part 1: Expire reminders older than D+3 catch-up window
    -- These delayed reminders are past the point where catch-up can send them
    UPDATE public."ReminderLog" rl
    SET status = 'skipped_daily_limit'::public."ReminderLogStatus"
    FROM public."Invoice" i, public."Shop" s, public."ReminderRule" r
    WHERE rl."invoiceId" = i.id
      AND s.id = i."shopId"
      AND r.id = rl."ruleId"
      AND rl.status = 'delayed'::public."ReminderLogStatus"
      AND i."dueAt" IS NOT NULL
      AND (NOW() AT TIME ZONE public.s18_safe_timezone(s.timezone))::DATE 
          > ((i."dueAt" AT TIME ZONE public.s18_safe_timezone(s.timezone))::DATE + r."offsetDays" + 3);
    
    GET DIAGNOSTICS expired_count = ROW_COUNT;

    -- Part 2: Collapse older stages to skipped_daily_limit when a later stage exists
    -- Only one reminder per invoice should be in 'delayed' state: the latest stage
    -- This query groups by (shopId, invoiceId) and marks all but the max-offsetDays row as skipped
    WITH older_stages AS (
        SELECT rl.id
        FROM public."ReminderLog" rl
        INNER JOIN public."ReminderRule" r ON r.id = rl."ruleId"
        WHERE rl.status = 'delayed'::public."ReminderLogStatus"
          AND EXISTS (
              SELECT 1 
              FROM public."ReminderLog" rl2
              INNER JOIN public."ReminderRule" r2 ON r2.id = rl2."ruleId"
              WHERE rl2."shopId" = rl."shopId"
                AND rl2."invoiceId" = rl."invoiceId"
                AND rl2.status = 'delayed'::public."ReminderLogStatus"
                AND r2."offsetDays" > r."offsetDays"
          )
    )
    UPDATE public."ReminderLog"
    SET status = 'skipped_daily_limit'::public."ReminderLogStatus"
    WHERE id IN (SELECT id FROM older_stages);

    GET DIAGNOSTICS skipped_older_stages = ROW_COUNT;

    -- Part 2.5: Skip delayed reminders when a newer stage is due TODAY
    -- (Part 3 will enqueue the newer stage; we don't want both)
    WITH delayed_with_newer_today AS (
        SELECT rl.id
        FROM public."ReminderLog" rl
        INNER JOIN public."ReminderRule" r ON r.id = rl."ruleId"
        INNER JOIN public."Invoice" i ON i.id = rl."invoiceId" AND i."shopId" = rl."shopId"
        INNER JOIN public."Shop" s ON s.id = rl."shopId"
        WHERE rl.status = 'delayed'::public."ReminderLogStatus"
          AND i.status = 'open'
          AND i."dueAt" IS NOT NULL
          AND EXISTS (
              SELECT 1 
              FROM public."ReminderRule" r_today
              WHERE r_today."shopId" = rl."shopId"
                AND r_today.enabled = true
                AND r_today.channel = 'email'::public."ReminderChannel"
                AND r_today."offsetDays" > r."offsetDays"
                AND (i."dueAt" AT TIME ZONE public.s18_safe_timezone(s.timezone))::DATE + r_today."offsetDays"
                    = (NOW() AT TIME ZONE public.s18_safe_timezone(s.timezone))::DATE
          )
    )
    UPDATE public."ReminderLog"
    SET status = 'skipped_daily_limit'::public."ReminderLogStatus"
    WHERE id IN (SELECT id FROM delayed_with_newer_today);

    GET DIAGNOSTICS skipped_newer_due_today = ROW_COUNT;

    -- Part 3: Enqueue new reminders (REMINDER_SEND) for due invoices
    -- NOTE: No gating filter here. TS send path handles PLAN_GATING_ENFORCED.
    FOR reminder_row IN
        SELECT
            r.id AS rule_id,
            r."shopId" AS shop_id,
            r."offsetDays" AS offset_days,
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
        INNER JOIN public."BuyerAccount" ba
            ON ba.id = i."buyerAccountId"
            AND ba."shopId" = i."shopId"
        WHERE r.enabled = true
          AND r.channel = 'email'::public."ReminderChannel"
          AND EXTRACT(HOUR FROM (NOW() AT TIME ZONE public.s18_safe_timezone(s.timezone))) BETWEEN 9 AND 18
          AND (i."dueAt" AT TIME ZONE public.s18_safe_timezone(s.timezone))::DATE + r."offsetDays" 
              = (NOW() AT TIME ZONE public.s18_safe_timezone(s.timezone))::DATE
          AND NOT EXISTS (
              SELECT 1 FROM public."ReminderLog" rl
              WHERE rl."ruleId" = r.id AND rl."invoiceId" = i.id
          )
    LOOP
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

    -- Part 4: Enqueue catch-up reminders (REMINDER_CATCHUP) for delayed reminders
    -- NOTE: No gating filter here. TS catch-up path handles PLAN_GATING_ENFORCED.
    FOR catchup_row IN
        SELECT
            rl.id AS log_id,
            rl."ruleId" AS rule_id,
            rl."shopId" AS shop_id,
            rl."invoiceId" AS invoice_id,
            r."offsetDays" AS offset_days,
            s.domain AS shop_domain,
            s.timezone AS shop_timezone,
            (i."dueAt" AT TIME ZONE public.s18_safe_timezone(s.timezone))::DATE + r."offsetDays" AS reminder_date
        FROM public."ReminderLog" rl
        INNER JOIN public."ReminderRule" r ON r.id = rl."ruleId" AND r.enabled = true
        INNER JOIN public.s18_shop_reminder_settings srs 
            ON srs.shop_id = rl."shopId" AND srs.enabled = true
        INNER JOIN public."Shop" s 
            ON s.id = rl."shopId" AND s."uninstalledAt" IS NULL
        INNER JOIN public."Invoice" i 
            ON i.id = rl."invoiceId" 
            AND i."shopId" = rl."shopId"
            AND i.status = 'open'
            AND i."dueAt" IS NOT NULL
        INNER JOIN public."BuyerAccount" ba
            ON ba.id = i."buyerAccountId"
            AND ba."shopId" = i."shopId"
        WHERE rl.status = 'delayed'::public."ReminderLogStatus"
          AND r.channel = 'email'::public."ReminderChannel"
          AND EXTRACT(HOUR FROM (NOW() AT TIME ZONE public.s18_safe_timezone(s.timezone))) BETWEEN 9 AND 18
          AND (NOW() AT TIME ZONE public.s18_safe_timezone(s.timezone))::DATE 
              BETWEEN ((i."dueAt" AT TIME ZONE public.s18_safe_timezone(s.timezone))::DATE + r."offsetDays" + 1)
              AND ((i."dueAt" AT TIME ZONE public.s18_safe_timezone(s.timezone))::DATE + r."offsetDays" + 3)
          AND NOT EXISTS (
              SELECT 1 FROM public."ReminderRule" r_today
              WHERE r_today."shopId" = rl."shopId"
                AND r_today.enabled = true
                AND r_today.channel = 'email'::public."ReminderChannel"
                AND (i."dueAt" AT TIME ZONE public.s18_safe_timezone(s.timezone))::DATE + r_today."offsetDays"
                    = (NOW() AT TIME ZONE public.s18_safe_timezone(s.timezone))::DATE
          )
        ORDER BY reminder_date ASC, rl."invoiceId" ASC
    LOOP
        PERFORM pgmq.send(
            's6_sync'::TEXT,
            pg_catalog.jsonb_build_object(
                'topic', 'REMINDER_CATCHUP',
                'shop', catchup_row.shop_domain,
                'shopId', catchup_row.shop_id,
                'invoiceId', catchup_row.invoice_id,
                'ruleId', catchup_row.rule_id,
                'logId', catchup_row.log_id,
                'offsetDays', catchup_row.offset_days,
                'timezone', public.s18_safe_timezone(catchup_row.shop_timezone),
                'reminderDate', catchup_row.reminder_date::TEXT,
                'enqueuedAt', NOW()::TEXT
            )
        );
        
        catchup_count := catchup_count + 1;
    END LOOP;

    RAISE LOG 's18_enqueue_reminders: enqueued=%, catchup=%, expired=%, skipped_older=%, skipped_newer_due_today=%',
        enqueued_count, catchup_count, expired_count, skipped_older_stages, skipped_newer_due_today;
END;
$func$;
