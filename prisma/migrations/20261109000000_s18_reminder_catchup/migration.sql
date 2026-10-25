-- S18: Catch-up for capped payment reminders (#230)
--
-- This migration adds support for deferring capped reminders up to 3 days
-- instead of silently dropping them. Implements the behavior from GitHub
-- issue #230 as approved by Team Lead.
--
-- PURELY ADDITIVE: No drops, no destructive UPDATE/DELETE.
-- Existing rows are backfilled to status='sent' which preserves their meaning.
--
-- New columns and constraints:
-- - ReminderLogStatus enum: sent, delayed, skipped_daily_limit
-- - ReminderLog.status: tracks reminder state
-- - ReminderLog.firstCappedAt: when the reminder was first capped
-- - ReminderLog.sentAt becomes nullable (delayed rows have no sentAt)
-- - CHECK constraints enforce consistency between status and timestamps
-- - Partial index on delayed rows for efficient catch-up queries
--
-- The s18_enqueue_reminders() function is updated to:
-- 1. Keep the gated-account skip from 20261106
-- 2. Add catch-up logic for delayed reminders (D+1..D+3)
-- 3. Enforce latest-stage-wins and one-per-invoice-per-day

-- Step 1: Create the status enum
CREATE TYPE "ReminderLogStatus" AS ENUM ('sent', 'delayed', 'skipped_daily_limit');

-- Step 2: Add status column with default 'sent' (backfills existing rows)
ALTER TABLE "ReminderLog" ADD COLUMN "status" "ReminderLogStatus" NOT NULL DEFAULT 'sent';

-- Step 3: Add firstCappedAt column (nullable timestamp)
ALTER TABLE "ReminderLog" ADD COLUMN "firstCappedAt" TIMESTAMPTZ(3);

-- Step 4: Make sentAt nullable (existing rows already have values, so this is safe)
ALTER TABLE "ReminderLog" ALTER COLUMN "sentAt" DROP NOT NULL;

-- Step 5: Add CHECK constraints that tie timestamps to status
-- These constraints MUST hold on existing data:
-- - Existing rows have sentAt NOT NULL and firstCappedAt will be NULL
-- - After adding status='sent' default, existing rows satisfy the 'sent' constraint
--
-- Constraint rules:
-- - 'sent': sentAt IS NOT NULL, firstCappedAt IS NULL
-- - 'delayed': sentAt IS NULL (firstCappedAt can be set when first capped)
-- - 'skipped_daily_limit': sentAt IS NULL (firstCappedAt preserved from delayed state)
ALTER TABLE "ReminderLog" ADD CONSTRAINT "ReminderLog_status_sent_check"
    CHECK (status != 'sent' OR (status = 'sent' AND "sentAt" IS NOT NULL AND "firstCappedAt" IS NULL));

ALTER TABLE "ReminderLog" ADD CONSTRAINT "ReminderLog_status_delayed_check"
    CHECK (status != 'delayed' OR (status = 'delayed' AND "sentAt" IS NULL));

ALTER TABLE "ReminderLog" ADD CONSTRAINT "ReminderLog_status_skipped_check"
    CHECK (status != 'skipped_daily_limit' OR (status = 'skipped_daily_limit' AND "sentAt" IS NULL));

-- Step 6: Partial index on delayed rows for efficient catch-up queries
-- Only indexes rows that need catch-up processing
-- Note: Cannot use CONCURRENTLY inside Prisma's migration transaction
CREATE INDEX IF NOT EXISTS "idx_reminder_log_delayed"
    ON "ReminderLog" ("shopId", "invoiceId", "ruleId")
    WHERE status = 'delayed';

-- Step 7: Replace s18_enqueue_reminders() with catch-up logic
-- Keeps the gated-account skip from 20261106 migration
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
BEGIN
    -- ==========================================================================
    -- PART 1: Expire delayed reminders past the catch-up window (D+3)
    -- Mark them as skipped_daily_limit
    -- ==========================================================================
    UPDATE public."ReminderLog" rl
    SET status = 'skipped_daily_limit'::"ReminderLogStatus"
    FROM public."Invoice" i,
         public."Shop" s,
         public."ReminderRule" r
    WHERE rl.status = 'delayed'::"ReminderLogStatus"
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
    SET status = 'skipped_daily_limit'::"ReminderLogStatus"
    FROM public."ReminderRule" r,
         latest_stage_per_invoice lsp
    WHERE rl.status = 'delayed'::"ReminderLogStatus"
      AND rl."invoiceId" = lsp."invoiceId"
      AND rl."ruleId" = r.id
      AND r."offsetDays" < lsp.max_offset;
    
    GET DIAGNOSTICS skipped_older_stages = ROW_COUNT;

    -- ==========================================================================
    -- PART 3: Enqueue NEW reminders (due today, no existing log entry)
    -- Keeps the gated-account skip from 20261106 migration
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
        WHERE rl.status = 'delayed'::"ReminderLogStatus"
          AND r.channel = 'email'::public."ReminderChannel"
          -- Check send window
          AND EXTRACT(HOUR FROM (NOW() AT TIME ZONE public.s18_safe_timezone(s.timezone))) BETWEEN 9 AND 18
          -- Within catch-up window: reminder date + 1 to reminder date + 3
          AND (NOW() AT TIME ZONE public.s18_safe_timezone(s.timezone))::DATE 
              BETWEEN ((i."dueAt" AT TIME ZONE public.s18_safe_timezone(s.timezone))::DATE + r."offsetDays" + 1)
              AND ((i."dueAt" AT TIME ZONE public.s18_safe_timezone(s.timezone))::DATE + r."offsetDays" + 3)
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
    
    IF enqueued_count > 0 OR catchup_count > 0 OR expired_count > 0 OR skipped_older_stages > 0 THEN
        RAISE LOG 's18_enqueue_reminders: enqueued=%, catchup=%, expired=%, skipped_older=%', 
            enqueued_count, catchup_count, expired_count, skipped_older_stages;
    END IF;
END;
$func$;

COMMENT ON FUNCTION public.s18_enqueue_reminders() IS 'S18: Enqueues REMINDER_SEND for new reminders and REMINDER_CATCHUP for delayed ones. Handles D+1..D+3 catch-up window, oldest-first ordering, latest-stage-wins. Skips gated accounts. Called by pg_cron hourly.';
