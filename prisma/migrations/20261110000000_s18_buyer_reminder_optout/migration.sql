-- S18: Buyer opt-out / unsubscribe for payment reminders (#232)
--
-- This migration adds per-buyer opt-out for payment reminder emails.
-- Implements:
-- - One-click unsubscribe per RFC 8058 (https://datatracker.ietf.org/doc/html/rfc8058)
-- - Opt-out toggle on buyer account page (merchant can re-enable)
-- - Eligibility gate: opted-out buyers skip reminders at enqueue time
--
-- PURELY ADDITIVE: No drops, no destructive UPDATE/DELETE.
-- Existing rows remain opted-in (NULL = not opted out).
--
-- New columns:
-- - BuyerAccount.reminder_opt_out_at: when the buyer opted out (NULL = opted in)
-- - BuyerAccount.reminder_opt_out_source: who triggered opt-out (merchant|link)
--
-- New enum value:
-- - ReminderLogStatus.skipped_opted_out: buyer was opted out at eligibility check
--
-- The s18_enqueue_reminders() function is updated to skip opted-out buyers
-- in both new reminder enqueue (PART 3) and catch-up enqueue (PART 4).

-- Step 1: Create the opt-out source enum
CREATE TYPE "ReminderOptOutSource" AS ENUM ('merchant', 'link');

-- Step 2: Add opt-out columns to BuyerAccount
-- Both are nullable: NULL means buyer is opted in (receives reminders)
ALTER TABLE "BuyerAccount" ADD COLUMN "reminder_opt_out_at" TIMESTAMPTZ(3);
ALTER TABLE "BuyerAccount" ADD COLUMN "reminder_opt_out_source" "ReminderOptOutSource";

-- Step 3: Add CHECK constraint ensuring both columns are set together
-- Either both are NULL (opted in) or both are NOT NULL (opted out)
ALTER TABLE "BuyerAccount" ADD CONSTRAINT "BuyerAccount_reminder_opt_out_consistency"
    CHECK (
        ("reminder_opt_out_at" IS NULL AND "reminder_opt_out_source" IS NULL) OR
        ("reminder_opt_out_at" IS NOT NULL AND "reminder_opt_out_source" IS NOT NULL)
    );

-- Step 4: Add index on opt-out status for efficient eligibility checks
-- Partial index on opted-out accounts (small subset)
CREATE INDEX "idx_buyer_account_reminder_opt_out"
    ON "BuyerAccount" ("shopId", "reminder_opt_out_at")
    WHERE "reminder_opt_out_at" IS NOT NULL;

-- Step 5: Add new enum value for skipped_opted_out status
-- This tracks when a delayed reminder was skipped because buyer opted out
ALTER TYPE "ReminderLogStatus" ADD VALUE 'skipped_opted_out';

-- Step 6: Replace s18_enqueue_reminders() with opt-out check
-- Keeps all existing logic from 20261109000000_s18_reminder_catchup:
-- - gated-account skip
-- - catch-up D+1..D+3 window
-- - latest-stage-wins
-- - one-per-invoice-per-day
-- Adds: AND ba.reminder_opt_out_at IS NULL to skip opted-out buyers
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
    skipped_opted_out INT := 0;
BEGIN
    -- ==========================================================================
    -- PART 1: Expire delayed reminders past the catch-up window (D+3)
    -- Mark them as skipped_daily_limit
    -- ==========================================================================
    UPDATE public."ReminderLog" rl
    SET status = 'skipped_daily_limit'::public."ReminderLogStatus"
    FROM public."Invoice" i,
         public."Shop" s,
         public."ReminderRule" r
    WHERE rl.status = 'delayed'::public."ReminderLogStatus"
      AND rl."invoiceId" = i.id
      AND rl."shopId" = i."shopId"
      AND rl."ruleId" = r.id
      AND i."shopId" = s.id
      AND i."dueAt" IS NOT NULL
      -- Reminder date = dueAt::date + offsetDays in shop timezone
      -- Window is D+1 to D+3, so past D+3 means > 3 days after reminder date
      AND (NOW() AT TIME ZONE public.s18_safe_timezone(s.timezone))::DATE >
          ((i."dueAt" AT TIME ZONE public.s18_safe_timezone(s.timezone))::DATE + r."offsetDays" + 3);
    
    GET DIAGNOSTICS expired_count = ROW_COUNT;

    -- ==========================================================================
    -- PART 1.5: Mark delayed reminders as skipped if buyer opted out
    -- Opted-out buyers should not receive catch-up reminders
    -- ==========================================================================
    UPDATE public."ReminderLog" rl
    SET status = 'skipped_opted_out'::public."ReminderLogStatus"
    FROM public."Invoice" i,
         public."BuyerAccount" ba
    WHERE rl.status = 'delayed'::public."ReminderLogStatus"
      AND rl."invoiceId" = i.id
      AND rl."shopId" = i."shopId"
      AND i."buyerAccountId" = ba.id
      AND ba.reminder_opt_out_at IS NOT NULL;
    
    GET DIAGNOSTICS skipped_opted_out = ROW_COUNT;
    
    -- ==========================================================================
    -- PART 2: Mark older delayed stages as skipped when a NEWER stage exists
    -- For each invoice, only the LATEST stage should be sent.
    -- A "newer" stage is one with higher offsetDays that has ANY status
    -- (sent, delayed, or skipped_daily_limit).
    -- ==========================================================================
    WITH latest_stage_per_invoice AS (
        -- Find the highest offsetDays for each invoice that has ANY ReminderLog row
        SELECT rl."invoiceId", MAX(r."offsetDays") AS max_offset
        FROM public."ReminderLog" rl
        INNER JOIN public."ReminderRule" r ON r.id = rl."ruleId"
        GROUP BY rl."invoiceId"
    )
    UPDATE public."ReminderLog" rl
    SET status = 'skipped_daily_limit'::public."ReminderLogStatus"
    FROM public."ReminderRule" r,
         latest_stage_per_invoice lsp
    WHERE rl.status = 'delayed'::public."ReminderLogStatus"
      AND rl."invoiceId" = lsp."invoiceId"
      AND rl."ruleId" = r.id
      AND r."offsetDays" < lsp.max_offset;
    
    GET DIAGNOSTICS skipped_older_stages = ROW_COUNT;

    -- ==========================================================================
    -- PART 2.5: Mark delayed stages as skipped when a NEWER stage is DUE TODAY
    -- This prevents Part 4 from enqueuing a delayed stage when Part 3 will
    -- enqueue a newer stage for the same invoice on the same day.
    -- One reminder per invoice per day: newer stage wins.
    -- ==========================================================================
    UPDATE public."ReminderLog" rl
    SET status = 'skipped_daily_limit'::public."ReminderLogStatus"
    FROM public."ReminderRule" r_delayed,
         public."Invoice" i,
         public."Shop" s
    WHERE rl.status = 'delayed'::public."ReminderLogStatus"
      AND rl."ruleId" = r_delayed.id
      AND rl."invoiceId" = i.id
      AND i."shopId" = s.id
      AND i."dueAt" IS NOT NULL
      -- A newer enabled email rule for the same invoice exists AND is due today
      AND EXISTS (
          SELECT 1 FROM public."ReminderRule" r_newer
          INNER JOIN public.s18_shop_reminder_settings srs ON srs.shop_id = r_newer."shopId" AND srs.enabled = true
          WHERE r_newer."shopId" = rl."shopId"
            AND r_newer.enabled = true
            AND r_newer.channel = 'email'::public."ReminderChannel"
            AND r_newer."offsetDays" > r_delayed."offsetDays"
            -- r_newer is due today in shop's timezone
            AND (i."dueAt" AT TIME ZONE public.s18_safe_timezone(s.timezone))::DATE + r_newer."offsetDays"
                = (NOW() AT TIME ZONE public.s18_safe_timezone(s.timezone))::DATE
      );

    -- ==========================================================================
    -- PART 3: Enqueue NEW reminders (due today, no existing log entry)
    -- Keeps the gated-account skip from 20261106 migration
    -- ADDED: Skip buyers who have opted out of reminders
    -- ==========================================================================
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
            AND ba."shopId" = i."shopId"
            AND ba.gated_at IS NULL
            AND ba.reminder_opt_out_at IS NULL  -- Skip opted-out buyers
        WHERE r.enabled = true
          AND r.channel = 'email'::public."ReminderChannel"
          -- Check send window: shop's local hour must be 09-18
          AND EXTRACT(HOUR FROM (NOW() AT TIME ZONE public.s18_safe_timezone(s.timezone))) BETWEEN 9 AND 18
          -- Due date + offset = today in shop's timezone
          AND (i."dueAt" AT TIME ZONE public.s18_safe_timezone(s.timezone))::DATE + r."offsetDays" 
              = (NOW() AT TIME ZONE public.s18_safe_timezone(s.timezone))::DATE
          -- Exclude already-existing reminders (any status)
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

    -- ==========================================================================
    -- PART 4: Enqueue CATCH-UP reminders (delayed, within D+1..D+3 window)
    -- Only the latest stage per invoice (older stages already marked skipped above)
    -- Re-checks eligibility: invoice open, shop enabled, rule enabled, not gated
    -- Excludes invoices that have ANY stage due today (Part 3 handles those)
    -- ADDED: Skip buyers who have opted out of reminders
    -- ==========================================================================
    FOR catchup_row IN
        SELECT
            rl.id AS log_id,
            rl."ruleId" AS rule_id,
            rl."shopId" AS shop_id,
            rl."invoiceId" AS invoice_id,
            r."offsetDays" AS offset_days,
            s.domain AS shop_domain,
            s.timezone AS shop_timezone,
            -- Compute reminder date for ordering (oldest first)
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
            AND ba.gated_at IS NULL
            AND ba.reminder_opt_out_at IS NULL  -- Skip opted-out buyers
        WHERE rl.status = 'delayed'::public."ReminderLogStatus"
          AND r.channel = 'email'::public."ReminderChannel"
          -- Check send window
          AND EXTRACT(HOUR FROM (NOW() AT TIME ZONE public.s18_safe_timezone(s.timezone))) BETWEEN 9 AND 18
          -- Within catch-up window: reminder date + 1 to reminder date + 3
          AND (NOW() AT TIME ZONE public.s18_safe_timezone(s.timezone))::DATE 
              BETWEEN ((i."dueAt" AT TIME ZONE public.s18_safe_timezone(s.timezone))::DATE + r."offsetDays" + 1)
              AND ((i."dueAt" AT TIME ZONE public.s18_safe_timezone(s.timezone))::DATE + r."offsetDays" + 3)
          -- Exclude invoices that have any enabled email rule due today
          -- (Part 3 will handle those; one reminder per invoice per day)
          AND NOT EXISTS (
              SELECT 1 FROM public."ReminderRule" r_today
              WHERE r_today."shopId" = rl."shopId"
                AND r_today.enabled = true
                AND r_today.channel = 'email'::public."ReminderChannel"
                AND (i."dueAt" AT TIME ZONE public.s18_safe_timezone(s.timezone))::DATE + r_today."offsetDays"
                    = (NOW() AT TIME ZONE public.s18_safe_timezone(s.timezone))::DATE
          )
        -- Order by oldest reminder date first within each batch
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
                'webhookId', 's18_catchup_' || catchup_row.invoice_id || '_' || catchup_row.rule_id || '_' || 
                    ((NOW() AT TIME ZONE public.s18_safe_timezone(catchup_row.shop_timezone))::DATE)::TEXT,
                'enqueuedAt', NOW()::TEXT
            )
        );
        
        catchup_count := catchup_count + 1;
    END LOOP;
    
    IF enqueued_count > 0 OR catchup_count > 0 OR expired_count > 0 OR skipped_older_stages > 0 OR skipped_opted_out > 0 THEN
        RAISE LOG 's18_enqueue_reminders: enqueued=%, catchup=%, expired=%, skipped_older=%, skipped_opted_out=%', 
            enqueued_count, catchup_count, expired_count, skipped_older_stages, skipped_opted_out;
    END IF;
END;
$func$;

COMMENT ON FUNCTION public.s18_enqueue_reminders() IS 'S18: Enqueues REMINDER_SEND for new reminders and REMINDER_CATCHUP for delayed ones. Handles D+1..D+3 catch-up window, oldest-first ordering, latest-stage-wins. Skips gated accounts and opted-out buyers. Called by pg_cron hourly.';
