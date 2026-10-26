-- s18-reminders-due-7d.sql (READ-ONLY)
-- Sizing for turning on reminder email: how many reminders s18_enqueue_reminders()
-- Part 3 would pick up over the next 7 shop-local days (today through today + 6),
-- per shop_idx and recipient domain class. Nothing is enqueued or sent here.
--
-- Selection mirrors Part 3 of public.s18_enqueue_reminders()
-- (prisma/migrations/20261122000000_s18_catchup_amount_ordering/migration.sql):
-- enabled email ReminderRule, shop reminders enabled (s18_shop_reminder_settings),
-- shop installed, invoice open with dueAt, BuyerAccount in the same shop, no
-- ReminderLog row for (rule, invoice), and dueAt (shop tz) + offsetDays = the day.
-- The 09-18 local-hour check is per run, so it is not applied to future days.
--
-- Recipient mirrors getInvoiceForReminder() (app/services/reminders.server.ts):
-- COMPANY accounts use BuyerAccount.mainContactEmail, others the tagged customer's
-- s8_tagged_customers.email. recipient_class: example_com (seed fixtures, address
-- ends in @example.com), other, none (no address). No addresses are printed.
--
-- send_gates_ok_7d also applies the send-time data gates the Worker checks before
-- the recipient allowlist: outstanding > 0, shop currency INR (isShopCurrencySupported),
-- address present, buyer not opted out (reminderOptOutAt IS NULL). Plan gating is
-- off (PLAN_GATING_ENFORCED=false), so gated_at is not applied. It cannot apply
-- RESEND_TEST_RECIPIENTS (a Worker secret), so 'other' is an upper bound on
-- allowlisted sends.
--
-- shop_idx = DENSE_RANK over all Shop ids, as in s12-hold-coverage.sql. The first
-- section maps shop_idx to installed / currency class / reminders enabled so the
-- reader can tell the INR throwaway store from the USD main dev store.
-- Counts, enums, booleans and ids only. Vars: none.
\set ON_ERROR_STOP 1
BEGIN TRANSACTION READ ONLY;

\echo '== shops: shop_idx, installed, currency class, reminders enabled'
WITH shops AS (
  SELECT s.id AS shop_id,
         DENSE_RANK() OVER (ORDER BY s.id) AS shop_idx
  FROM "Shop" s
)
SELECT sh.shop_idx,
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
JOIN shops sh ON sh.shop_id = s.id
ORDER BY 1;

\echo '== reminders due in the next 7 shop-local days (Part 3 selection), per shop_idx and recipient class'
WITH shops AS (
  SELECT s.id AS shop_id,
         DENSE_RANK() OVER (ORDER BY s.id) AS shop_idx
  FROM "Shop" s
),
due AS (
  SELECT sh.shop_idx,
         (i."dueAt" AT TIME ZONE public.s18_safe_timezone(s.timezone))::DATE + r."offsetDays"
           - (NOW() AT TIME ZONE public.s18_safe_timezone(s.timezone))::DATE AS day_offset,
         lower(btrim(CASE WHEN ba.kind::TEXT = 'COMPANY' THEN ba."mainContactEmail"
                          WHEN ba."customerId" IS NOT NULL THEN tc.email
                     END)) AS rcpt,
         i.outstanding > 0 AS has_balance,
         s.currency = 'INR' AS currency_ok,
         ba."reminderOptOutAt" IS NULL AS not_opted_out
  FROM "ReminderRule" r
  INNER JOIN s18_shop_reminder_settings srs
      ON srs.shop_id = r."shopId" AND srs.enabled = true
  INNER JOIN "Shop" s
      ON s.id = r."shopId" AND s."uninstalledAt" IS NULL
  INNER JOIN shops sh ON sh.shop_id = s.id
  INNER JOIN "Invoice" i
      ON i."shopId" = r."shopId"
      AND i.status = 'open'
      AND i."dueAt" IS NOT NULL
  INNER JOIN "BuyerAccount" ba
      ON ba.id = i."buyerAccountId"
      AND ba."shopId" = i."shopId"
  LEFT JOIN s8_tagged_customers tc
      ON tc.shop_id = i."shopId" AND tc.customer_id = ba."customerId"
  WHERE r.enabled = true
    AND r.channel = 'email'::"ReminderChannel"
    AND (i."dueAt" AT TIME ZONE public.s18_safe_timezone(s.timezone))::DATE + r."offsetDays"
        BETWEEN (NOW() AT TIME ZONE public.s18_safe_timezone(s.timezone))::DATE
            AND (NOW() AT TIME ZONE public.s18_safe_timezone(s.timezone))::DATE + 6
    AND NOT EXISTS (
        SELECT 1 FROM "ReminderLog" rl
        WHERE rl."ruleId" = r.id AND rl."invoiceId" = i.id
    )
),
classed AS (
  SELECT d.shop_idx,
         d.day_offset,
         d.rcpt,
         CASE WHEN d.rcpt IS NULL OR d.rcpt = '' THEN 'none'
              WHEN d.rcpt LIKE '%@example.com' THEN 'example_com'
              ELSE 'other'
         END AS recipient_class,
         d.has_balance AND d.currency_ok AND d.not_opted_out
           AND d.rcpt IS NOT NULL AND d.rcpt <> '' AS gates_ok
  FROM due d
)
SELECT c.shop_idx,
       c.recipient_class,
       COUNT(*) AS due_7d,
       COUNT(*) FILTER (WHERE c.day_offset = 0) AS due_today,
       COUNT(*) FILTER (WHERE c.gates_ok) AS send_gates_ok_7d,
       COUNT(DISTINCT c.rcpt) AS distinct_recipients_7d,
       COUNT(DISTINCT c.rcpt) FILTER (WHERE c.gates_ok) AS distinct_recipients_gates_ok_7d
FROM classed c
GROUP BY 1, 2
ORDER BY 1, 2;

ROLLBACK;
