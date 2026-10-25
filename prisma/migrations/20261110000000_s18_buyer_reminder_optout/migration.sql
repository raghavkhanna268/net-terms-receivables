-- S18: Buyer opt-out / unsubscribe for payment reminders (#232)
--
-- This migration adds per-buyer opt-out for payment reminder emails.
-- Implements:
-- - One-click unsubscribe per RFC 8058 (https://datatracker.ietf.org/doc/html/rfc8058)
-- - Opt-out toggle on buyer account page (merchant can re-enable)
-- - Eligibility gate: opted-out buyers skip reminders (enforced in TypeScript handlers)
--
-- PURELY ADDITIVE: No drops, no destructive UPDATE/DELETE.
-- Existing rows remain opted-in (NULL = not opted out).
--
-- New columns (quoted camelCase, matching BuyerAccount convention):
-- - BuyerAccount."reminderOptOutAt": when the buyer opted out (NULL = opted in)
-- - BuyerAccount."reminderOptOutSource": who triggered opt-out (merchant|link)
--
-- New enum value:
-- - ReminderLogStatus.skipped_opted_out: buyer was opted out at eligibility check
--
-- The opt-out eligibility check is enforced in TypeScript handlers (REMINDER_SEND,
-- REMINDER_CATCHUP) via isBuyerOptedOut(), NOT in s18_enqueue_reminders().
-- This allows the function to be updated independently by PR #244.

-- Step 1: Create the opt-out source enum
CREATE TYPE "ReminderOptOutSource" AS ENUM ('merchant', 'link');

-- Step 2: Add opt-out columns to BuyerAccount (quoted camelCase, no @map)
-- Both are nullable: NULL means buyer is opted in (receives reminders)
ALTER TABLE "BuyerAccount" ADD COLUMN "reminderOptOutAt" TIMESTAMPTZ(3);
ALTER TABLE "BuyerAccount" ADD COLUMN "reminderOptOutSource" "ReminderOptOutSource";

-- Step 3: Add CHECK constraint ensuring both columns are set together
-- Either both are NULL (opted in) or both are NOT NULL (opted out)
ALTER TABLE "BuyerAccount" ADD CONSTRAINT "BuyerAccount_reminder_opt_out_consistency"
    CHECK (
        ("reminderOptOutAt" IS NULL AND "reminderOptOutSource" IS NULL) OR
        ("reminderOptOutAt" IS NOT NULL AND "reminderOptOutSource" IS NOT NULL)
    );

-- Step 4: Add index on opt-out status for efficient eligibility checks
-- Partial index on opted-out accounts (small subset)
CREATE INDEX "idx_buyer_account_reminder_opt_out"
    ON "BuyerAccount" ("shopId", "reminderOptOutAt")
    WHERE "reminderOptOutAt" IS NOT NULL;

-- Step 5: Add new enum value for skipped_opted_out status
-- This tracks when a reminder was skipped because buyer opted out
ALTER TYPE "ReminderLogStatus" ADD VALUE 'skipped_opted_out';

-- Step 6: Add CHECK constraint for skipped_opted_out status
-- skipped_opted_out rows must have sentAt NULL (they were never sent)
-- Note: New enum values cannot be used in the same transaction they're added,
-- so we compare as text instead of using the enum type directly.
ALTER TABLE "ReminderLog" ADD CONSTRAINT "ReminderLog_status_skipped_opted_out_check"
    CHECK (status::text <> 'skipped_opted_out' OR "sentAt" IS NULL);
