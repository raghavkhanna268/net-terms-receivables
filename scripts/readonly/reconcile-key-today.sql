-- reconcile-key-today.sql (READ-ONLY)
-- Does the nightly reconcile dedupe key for a UTC day already exist, per
-- installed shop? Answers "was a later invoke_reconcile acked as idempotent
-- because the 07:30 IST (02:00 UTC) nightly already used the day's key?".
--
-- Key formats (app code on main):
--   s6_processed_webhooks.webhook_id = 'reconcile:<shop>:<YYYY-MM-DD UTC>:<stage>'
--     (app/services/drain/reconcile.server.ts makeReconcileWebhookId,
--      app/services/drain/reconcile-handlers.server.ts enqueueReconcileStage)
--   s6_reconcile_stage_claims PK (chain_key, stage), chain_key = '<shop>:<YYYY-MM-DD UTC>'
--     (reconcile-handlers.server.ts extractChainKey / claimReconcileStage)
--   stage in ('companies', 'customers', 'orders'). Manual keys
--   ('<shop>:manual:<ts>') are not checked here.
-- Columns: s6_processed_webhooks (webhook_id PK, topic, resource_gid,
--   processed_at timestamptz) from 20261023000000_s6_pgmq_queues;
--   s6_reconcile_stage_claims (chain_key, stage, shop, bulk_operation_id,
--   claimed_at timestamptz) from 20261119000000_s25_bulk_op_exactly_once.
--
-- shop_idx: installed shops ("uninstalledAt" IS NULL) numbered by Shop.id, the
-- same ordering as offline-session-preflight.sql (ROW_NUMBER OVER s.id) and
-- post-drain-aggregates.sql (DENSE_RANK OVER Invoice."shopId"). invoices is the
-- shop's Invoice count so the index can be matched to a known shop.
--
-- Day checked: the UTC date of the `since` input when it is after 2000-01-01,
-- otherwise the current UTC date (the workflow default since is 1970).
--
-- Output: shop_idx, invoices (count), stage (literal enum), booleans and
-- timestamptz values only. Shop domains are used in join keys, never printed.
-- Vars: since (ISO timestamp, optional day selector).
-- Output column kinds for passthrough columns (scripts/ci/check-readonly-columns.ts,
-- see scripts/readonly/README.md). Derived counts/booleans/CASE enums need no entry.
-- @col checked_utc_date: timestamp
\set ON_ERROR_STOP 1
BEGIN TRANSACTION READ ONLY;

\echo '== reconcile dedupe key existence per installed shop and stage (domain not printed)'
WITH day AS (
  SELECT to_char(
           CASE WHEN (:'since')::timestamptz > TIMESTAMPTZ '2000-01-01 00:00:00+00'
                THEN ((:'since')::timestamptz AT TIME ZONE 'UTC')::date
                ELSE (NOW() AT TIME ZONE 'UTC')::date END,
           'YYYY-MM-DD') AS d
),
sh AS (
  SELECT ROW_NUMBER() OVER (ORDER BY s.id) AS shop_idx, s.id AS shop_id, s.domain AS dom
  FROM public."Shop" s
  WHERE s."uninstalledAt" IS NULL
),
inv AS (
  SELECT i."shopId" AS shop_id, COUNT(*) AS invoices
  FROM public."Invoice" i
  GROUP BY i."shopId"
),
st AS (
  SELECT 'companies' AS stage
  UNION ALL SELECT 'customers' AS stage
  UNION ALL SELECT 'orders' AS stage
)
SELECT sh.shop_idx,
       COALESCE(inv.invoices, 0) AS invoices,
       day.d AS checked_utc_date,
       st.stage,
       p.webhook_id IS NOT NULL AS processed_key_exists,
       p.processed_at,
       c.chain_key IS NOT NULL AS stage_claim_exists,
       c.bulk_operation_id IS NOT NULL AS claim_has_bulk_op,
       c.claimed_at
FROM sh
CROSS JOIN day
CROSS JOIN st
LEFT JOIN inv ON inv.shop_id = sh.shop_id
LEFT JOIN s6_processed_webhooks p
  ON p.webhook_id = 'reconcile:' || sh.dom || ':' || day.d || ':' || st.stage
LEFT JOIN s6_reconcile_stage_claims c
  ON c.chain_key = sh.dom || ':' || day.d AND c.stage = st.stage
ORDER BY sh.shop_idx, st.stage;

ROLLBACK;
