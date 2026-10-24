-- S18: Skip gated accounts when enqueuing reminders
--
-- When plan gating is enforced (PLAN_GATING_ENFORCED=1), accounts over the
-- plan limit have gated_at set. These accounts should not receive reminders.
--
-- The app-side sendPaymentReminder already skips gated accounts via
-- isAccountActive(buyerAccountGatedAt). This migration adds the same filter
-- at enqueue time to avoid wasteful queue messages.
--
-- Gating condition: Filter out accounts where gated_at IS NOT NULL.
-- This is safe because gated_at is only ever set when gating is enforced.
-- When gating is OFF (current production state), all accounts have gated_at = NULL,
-- so this filter is a no-op and behavior is byte-for-byte equivalent.

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
    -- 8. Buyer account is not gated (gated_at IS NULL)
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
        INNER JOIN public."BuyerAccount" ba
            ON ba.id = i."buyerAccountId"
            AND ba.gated_at IS NULL
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

COMMENT ON FUNCTION public.s18_enqueue_reminders() IS 'S18: Enqueues REMINDER_SEND messages for eligible invoices. Uses shop timezone for day math, only enqueues during 09:00-19:00 local time. Skips gated accounts. Called by pg_cron hourly.';
