-- s18-reminders-due-7d.sql (READ-ONLY)
-- Sizing for turning on reminder email. Nothing is enqueued or sent here.
--
-- would_fire_7d is the Team Lead definition, exactly: invoices that are open
-- (status = 'open') and unpaid (outstanding > 0), on BuyerAccounts that are not
-- opted out (reminderOptOutAt IS NULL), that match an enabled ReminderRule offset
-- (dueAt in shop tz + offsetDays) that falls in the next 7 shop-local days
-- (today through today + 6), MINUS any (invoice, rule) pair that already has a
-- ReminderLog row. Counted per (invoice, rule) pair, per shop_kind.
--
-- Narrower columns:
--   would_fire_email_7d: the same rows restricted to email rules (the only ones
--     Resend / RESEND_FROM sends; native rules do not email).
--   enqueue_gated_email_7d: also applies the remaining gates of Part 3 of
--     public.s18_enqueue_reminders()
--     (prisma/migrations/20261122000000_s18_catchup_amount_ordering/migration.sql):
--     shop reminders enabled (s18_shop_reminder_settings), shop installed, plus
--     the Worker's data-side send gates: shop currency INR (isShopCurrencySupported)
--     and a recipient address present. Plan gating is off (PLAN_GATING_ENFORCED=false).
--   The 09-18 local-hour check is per run, so it is not applied to future days.
--
-- Recipient mirrors getInvoiceForReminder() (app/services/reminders.server.ts):
-- COMPANY accounts use BuyerAccount.mainContactEmail, others the tagged customer's
-- s8_tagged_customers.email. recipient_class: example_com (seed fixtures, address
-- ends in @example.com), other, none (no address). No addresses are printed.
-- RESEND_TEST_RECIPIENTS is a Worker secret and is not applied, so 'other' is an
-- UPPER BOUND on what the recipient allowlist would let through.
--
-- Caps: there is no per-run or per-shop cap on reminder sends; enqueue has no
-- LIMIT and each pg_cron drain run takes a batch of 5 (Worker fallback 10) and
-- re-runs every minute. The binding cap is global: DAILY_SEND_CAP = 100 per UTC
-- day and MONTHLY_SEND_CAP = 3000 (reminders.server.ts), across all shops. The
-- last section compares email would-fire per day (summed over shops, bucketed by
-- each shop's local day) against the daily cap.
--
-- shop_kind: identity label from the canonical shop_labels CTE
-- (scripts/ci/shop-labels.ts). 'main' = the shop whose domain is :'allowed'
-- (ALLOWED_DEV_STORE), 'e2e' = :'e2e' (E2E_SHOP), 'other_N' = the rest ranked by
-- Shop.id within this run only (N is stable within one run but does NOT identify
-- a shop across runs), 'unknown' for every shop if a secret is empty or both are
-- equal. Domains are compared, never printed.
-- The first section maps shop_kind to installed / currency class / reminders enabled.
-- Counts, enums and booleans only.
-- Vars: allowed, e2e (masked secrets, passed by prod-readonly-query.yml).
\set ON_ERROR_STOP 1
-- REPEATABLE READ: both sections read one snapshot, so the two
-- shop_labels copies number other_N identically within this run.
BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;

\echo '== shops: shop_kind, installed, currency class, reminders enabled'
WITH shop_labels AS (
  SELECT s.id AS shop_id,
         CASE WHEN :'allowed' = '' OR :'e2e' = '' OR :'allowed' = :'e2e' THEN 'unknown'
              WHEN s.domain = :'allowed' THEN 'main'
              WHEN s.domain = :'e2e' THEN 'e2e'
              ELSE 'other_' || (ROW_NUMBER() OVER (
                     PARTITION BY s.domain IN (:'allowed', :'e2e')
                     ORDER BY s.id))::text
         END AS shop_kind
  FROM "Shop" s
)
SELECT sl.shop_kind,
       s."uninstalledAt" IS NULL AS installed,
       CASE WHEN s.currency = 'INR' THEN 'INR'
            WHEN s.currency = 'USD' THEN 'USD'
            ELSE 'other'
       END AS currency_class,
       EXISTS (
         SELECT 1 FROM s18_shop_reminder_settings srs
         WHERE srs.shop_id = s.id AND srs.enabled = true
       ) AS reminders_enabled,
       (SELECT COUNT(*) FROM "ReminderRule" r
        WHERE r."shopId" = s.id AND r.enabled = true
          AND r.channel = 'email'::"ReminderChannel") AS enabled_email_rules
FROM "Shop" s
JOIN shop_labels sl ON sl.shop_id = s.id
ORDER BY 1;

\echo '== would fire in the next 7 shop-local days, per shop_kind and recipient class'
WITH shop_labels AS (
  SELECT s.id AS shop_id,
         CASE WHEN :'allowed' = '' OR :'e2e' = '' OR :'allowed' = :'e2e' THEN 'unknown'
              WHEN s.domain = :'allowed' THEN 'main'
              WHEN s.domain = :'e2e' THEN 'e2e'
              ELSE 'other_' || (ROW_NUMBER() OVER (
                     PARTITION BY s.domain IN (:'allowed', :'e2e')
                     ORDER BY s.id))::text
         END AS shop_kind
  FROM "Shop" s
),
due AS (
  SELECT sl.shop_kind,
         (i."dueAt" AT TIME ZONE public.s18_safe_timezone(s.timezone))::DATE + r."offsetDays"
           - (NOW() AT TIME ZONE public.s18_safe_timezone(s.timezone))::DATE AS day_offset,
         lower(btrim(CASE WHEN ba.kind::TEXT = 'COMPANY' THEN ba."mainContactEmail"
                          WHEN ba."customerId" IS NOT NULL THEN tc.email
                     END)) AS rcpt,
         r.channel = 'email'::"ReminderChannel" AS is_email,
         COALESCE(srs.enabled, false) AND s."uninstalledAt" IS NULL
           AND s.currency = 'INR' AS enqueue_gates_ok
  FROM "ReminderRule" r
  INNER JOIN "Shop" s ON s.id = r."shopId"
  INNER JOIN shop_labels sl ON sl.shop_id = s.id
  LEFT JOIN s18_shop_reminder_settings srs ON srs.shop_id = r."shopId"
  INNER JOIN "Invoice" i
      ON i."shopId" = r."shopId"
      AND i.status = 'open'
      AND i.outstanding > 0
      AND i."dueAt" IS NOT NULL
  INNER JOIN "BuyerAccount" ba
      ON ba.id = i."buyerAccountId"
      AND ba."shopId" = i."shopId"
      AND ba."reminderOptOutAt" IS NULL
  LEFT JOIN s8_tagged_customers tc
      ON tc.shop_id = i."shopId" AND tc.customer_id = ba."customerId"
  WHERE r.enabled = true
    AND (i."dueAt" AT TIME ZONE public.s18_safe_timezone(s.timezone))::DATE + r."offsetDays"
        BETWEEN (NOW() AT TIME ZONE public.s18_safe_timezone(s.timezone))::DATE
            AND (NOW() AT TIME ZONE public.s18_safe_timezone(s.timezone))::DATE + 6
    AND NOT EXISTS (
        SELECT 1 FROM "ReminderLog" rl
        WHERE rl."ruleId" = r.id AND rl."invoiceId" = i.id
    )
),
classed AS (
  SELECT d.shop_kind,
         d.day_offset,
         d.rcpt,
         d.is_email,
         CASE WHEN d.rcpt IS NULL OR d.rcpt = '' THEN 'none'
              WHEN d.rcpt LIKE '%@example.com' THEN 'example_com'
              ELSE 'other'
         END AS recipient_class,
         d.is_email AND d.enqueue_gates_ok
           AND d.rcpt IS NOT NULL AND d.rcpt <> '' AS gated_email
  FROM due d
)
SELECT c.shop_kind,
       c.recipient_class,
       COUNT(*) AS would_fire_7d,
       COUNT(*) FILTER (WHERE c.is_email) AS would_fire_email_7d,
       COUNT(*) FILTER (WHERE c.is_email AND c.day_offset = 0) AS would_fire_email_today,
       COUNT(*) FILTER (WHERE c.gated_email) AS enqueue_gated_email_7d,
       COUNT(DISTINCT c.rcpt) FILTER (WHERE c.is_email) AS distinct_recipients_email_7d,
       COUNT(DISTINCT c.rcpt) FILTER (WHERE c.gated_email) AS distinct_recipients_gated_7d
FROM classed c
GROUP BY 1, 2
ORDER BY 1, 2;

\echo '== email would-fire per shop-local day offset, all shops, vs global DAILY_SEND_CAP (100)'
WITH due AS (
  SELECT (i."dueAt" AT TIME ZONE public.s18_safe_timezone(s.timezone))::DATE + r."offsetDays"
           - (NOW() AT TIME ZONE public.s18_safe_timezone(s.timezone))::DATE AS day_offset
  FROM "ReminderRule" r
  INNER JOIN "Shop" s ON s.id = r."shopId"
  INNER JOIN "Invoice" i
      ON i."shopId" = r."shopId"
      AND i.status = 'open'
      AND i.outstanding > 0
      AND i."dueAt" IS NOT NULL
  INNER JOIN "BuyerAccount" ba
      ON ba.id = i."buyerAccountId"
      AND ba."shopId" = i."shopId"
      AND ba."reminderOptOutAt" IS NULL
  WHERE r.enabled = true
    AND r.channel = 'email'::"ReminderChannel"
    AND (i."dueAt" AT TIME ZONE public.s18_safe_timezone(s.timezone))::DATE + r."offsetDays"
        BETWEEN (NOW() AT TIME ZONE public.s18_safe_timezone(s.timezone))::DATE
            AND (NOW() AT TIME ZONE public.s18_safe_timezone(s.timezone))::DATE + 6
    AND NOT EXISTS (
        SELECT 1 FROM "ReminderLog" rl
        WHERE rl."ruleId" = r.id AND rl."invoiceId" = i.id
    )
)
SELECT CASE d.day_offset
         WHEN 0 THEN 'd0'
         WHEN 1 THEN 'd1'
         WHEN 2 THEN 'd2'
         WHEN 3 THEN 'd3'
         WHEN 4 THEN 'd4'
         WHEN 5 THEN 'd5'
         WHEN 6 THEN 'd6'
       END AS local_day,
       COUNT(*) AS would_fire_email,
       COUNT(*) > 100 AS over_daily_cap
FROM due d
GROUP BY 1
ORDER BY 1;

ROLLBACK;
