-- schedule-dueat-utc-time.sql (READ-ONLY)
-- Does Shopify PaymentSchedule.dueAt arrive as midnight UTC? Counts Invoice
-- rows whose due date came from the Shopify payment schedule
-- ("dueSource" = 'schedule') with no "dueBasis", grouped by the UTC
-- time-of-day of "dueAt" (HH24:MI:SS.MS), split by shop_kind and seed_class.
--
-- A  one row per (shop_kind, seed_class, utc_time): n.
-- B  per (shop_kind, seed_class): schedule_rows, midnight_utc_rows
--    (utc_time = '00:00:00.000'), null_due_rows ("dueAt" IS NULL; its
--    utc_time is NULL in A).
-- C  all shops together: schedule_rows, midnight_utc_rows, null_due_rows.
--
-- seed_class (fixtures from scripts/seed.ts SEED_TAG 'ntr-seed' /
-- SEED_PREFIX 'ntr-seed-'). Invoice has no externalId and the schema has no
-- Order table or stored order tags, so the only reachable marker is the
-- stored Shopify customer tags: Invoice."buyerAccountId" -> BuyerAccount
-- ("customerId", same shop) -> s8_tagged_customers.tags (JSONB array of all
-- the customer's tags, written by app/services/sync/customer.server.ts).
--   seed      a stored tag is 'ntr-seed' or starts with 'ntr-seed-'
--             (seed customers carry 'ntr-seed' and 'ntr-seed-net<N>')
--   non_seed  the customer has an s8_tagged_customers row with neither
--   unknown   no s8_tagged_customers row is reachable (e.g. COMPANY buyer
--             accounts with no "customerId", or an untracked customer); seed
--             status cannot be read from the DB for these rows.
--
-- shop_kind: identity label from the canonical shop_labels CTE
-- (scripts/ci/shop-labels.ts). 'main' = the shop whose domain is :'allowed'
-- (ALLOWED_DEV_STORE), 'e2e' = :'e2e' (E2E_SHOP), 'other_N' = the rest ranked by
-- Shop.id within this run only (N is stable within one run but does NOT identify
-- a shop across runs), 'unknown' for every shop if a secret is empty or both are
-- equal. Domains are compared, never printed.
-- One REPEATABLE READ snapshot, so other_N and the counts agree across A-C.
-- Output: counts, enums and UTC time-of-day strings only. No ids, GIDs, tags,
-- money, domains or shop values are printed.
-- Vars: allowed, e2e (masked secrets, passed by prod-readonly-query.yml).
--
-- @col utc_time: timestamp
\set ON_ERROR_STOP 1
BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;

\echo '== A schedule dueAt UTC time-of-day counts by shop_kind, seed_class'
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
sched AS (
  SELECT i."shopId" AS sched_shop,
         to_char(i."dueAt" AT TIME ZONE 'UTC', 'HH24:MI:SS.MS') AS utc_time,
         CASE WHEN tc.customer_id IS NULL THEN 'unknown'
              WHEN EXISTS (
                SELECT 1 FROM jsonb_array_elements_text(tc.tags) AS t(tag)
                WHERE t.tag = 'ntr-seed' OR t.tag LIKE 'ntr-seed-%'
              ) THEN 'seed'
              ELSE 'non_seed'
         END AS seed_class
  FROM "Invoice" i
  INNER JOIN "BuyerAccount" ba ON ba.id = i."buyerAccountId" AND ba."shopId" = i."shopId"
  LEFT JOIN s8_tagged_customers tc ON tc.shop_id = ba."shopId" AND tc.customer_id = ba."customerId"
  WHERE i."dueSource" = 'schedule' AND i."dueBasis" IS NULL
)
SELECT sl.shop_kind,
       s.seed_class,
       s.utc_time,
       COUNT(*) AS n
FROM sched s
LEFT JOIN shop_labels sl ON sl.shop_id = s.sched_shop
GROUP BY sl.shop_kind, s.seed_class, s.utc_time
ORDER BY sl.shop_kind, s.seed_class, COUNT(*) DESC, s.utc_time;

\echo '== B schedule rows and midnight-UTC rows by shop_kind, seed_class'
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
sched AS (
  SELECT i."shopId" AS sched_shop,
         i."dueAt" IS NULL AS no_due,
         to_char(i."dueAt" AT TIME ZONE 'UTC', 'HH24:MI:SS.MS') = '00:00:00.000' AS is_midnight,
         CASE WHEN tc.customer_id IS NULL THEN 'unknown'
              WHEN EXISTS (
                SELECT 1 FROM jsonb_array_elements_text(tc.tags) AS t(tag)
                WHERE t.tag = 'ntr-seed' OR t.tag LIKE 'ntr-seed-%'
              ) THEN 'seed'
              ELSE 'non_seed'
         END AS seed_class
  FROM "Invoice" i
  INNER JOIN "BuyerAccount" ba ON ba.id = i."buyerAccountId" AND ba."shopId" = i."shopId"
  LEFT JOIN s8_tagged_customers tc ON tc.shop_id = ba."shopId" AND tc.customer_id = ba."customerId"
  WHERE i."dueSource" = 'schedule' AND i."dueBasis" IS NULL
)
SELECT sl.shop_kind,
       s.seed_class,
       COUNT(*) AS schedule_rows,
       COUNT(*) FILTER (WHERE s.is_midnight) AS midnight_utc_rows,
       COUNT(*) FILTER (WHERE s.no_due) AS null_due_rows
FROM sched s
LEFT JOIN shop_labels sl ON sl.shop_id = s.sched_shop
GROUP BY sl.shop_kind, s.seed_class
ORDER BY sl.shop_kind, s.seed_class;

\echo '== C totals over all shops'
SELECT COUNT(*) AS schedule_rows,
       COUNT(*) FILTER (
         WHERE to_char(i."dueAt" AT TIME ZONE 'UTC', 'HH24:MI:SS.MS') = '00:00:00.000'
       ) AS midnight_utc_rows,
       COUNT(*) FILTER (WHERE i."dueAt" IS NULL) AS null_due_rows
FROM "Invoice" i
WHERE i."dueSource" = 'schedule' AND i."dueBasis" IS NULL;

ROLLBACK;
