-- s12-hold-coverage.sql (READ-ONLY)
-- Why the 00:30 IST credit_status_daily_sweep held only some past-due accounts (S12),
-- plus the #200 orphan-location confirmation. SELECT only, inside a READ ONLY transaction.
-- QA 2 audit: Prints only enums, booleans, timestamps, and counts. Individual buyer, invoice,
-- customer, and company location IDs are aggregated, not printed.
-- Never selects name, holdNote, emails, domains, money amounts (outstanding/total/creditLimit
-- only appear inside comparisons), payloads, or free-text fields.
-- "past_due"  = open invoice, outstanding > 0, dueAt < NOW().
-- "overdue"   = the sweep / hasOverdueInvoices predicate: same, but dueAt < NOW() - 1 day.
-- "is_seed"   = BuyerAccount.id LIKE 'seed-account-%' (same as s12-checkout-fixtures.sql).
-- over_limit mirrors computeExposure(): open invoice outstanding + s8 draft orders with
-- payment terms in ('open','invoice_sent'), compared with creditLimit.
-- Vars:
--   since (ISO-8601 UTC of the sweep run, e.g. 2026-10-24T19:00:00Z). The sweep's dedupe key
--         date is since's UTC date.
--   allowed, e2e (masked secrets, passed by prod-readonly-query.yml) for shop_kind.
-- shop_kind: identity label from the canonical shop_labels CTE
-- (scripts/ci/shop-labels.ts). 'main' = the shop whose domain is :'allowed'
-- (ALLOWED_DEV_STORE), 'e2e' = :'e2e' (E2E_SHOP), 'other_N' = the rest ranked by
-- Shop.id within this run only (N is stable within one run but does NOT identify
-- a shop across runs), 'unknown' for every shop if a secret is empty or both are
-- equal. Domains are compared, never printed.
-- Orphan locations (sections B and C) are derived inside SQL from COMPANY_LOCATIONS_DELETE
-- webhook receipts, not passed as psql variables.
-- @col kind, "holdState", proname, dep_table: enum
-- @col "manualHold", bypass, "syncPending": boolean
-- @col "defaultTermsDays": config_int
-- The following are SUM of COUNT(*) expressions through CTEs - declare as count:
-- @col total_past_due_invoices, total_overdue_invoices: count
-- @col total_delete_webhook_rows, total_any_topic_dedupe_rows: count
-- @col total_invoices, total_matches, total_matched_payments, total_rejected_matches: count
-- @col total_reminder_logs, total_alias_entries, total_draft_orders: count
\set ON_ERROR_STOP 1
BEGIN TRANSACTION READ ONLY;

\echo '== H0 live sweep function: grace interval / gated filter present in prosrc'
SELECT proname,
       position('INTERVAL ''1 day''' in prosrc) > 0 AS uses_1_day_grace,
       position('gated_at' in prosrc) > 0 AS filters_gated,
       position('''OK'', ''NEAR_LIMIT''' in prosrc) > 0 AS part1_ok_near_limit_only
FROM pg_proc WHERE proname = 'enqueue_credit_status_recomputes';

\echo '== H1 shop-level defaultTermsDays (config_int, clamped) per shop'
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
       CASE WHEN s."defaultTermsDays" BETWEEN 0 AND 365 THEN s."defaultTermsDays" END AS "defaultTermsDays"
FROM "Shop" s
JOIN shop_labels sl ON sl.shop_id = s.id
ORDER BY 1;

\echo '== A per BuyerAccount with >= 1 past-due unpaid invoice (aggregated)'
-- QA 2 audit: individual buyer_account_id, company_location_gid, and customer_gid removed.
-- Aggregated by holdState, kind, and other dimension columns.
WITH pd AS (
  SELECT i."buyerAccountId" AS buyer_account_id,
         COUNT(*) AS past_due_invoices,
         COUNT(*) FILTER (WHERE i."dueAt" < NOW() - INTERVAL '1 day') AS overdue_invoices
  FROM "Invoice" i
  WHERE i.status = 'open' AND i.outstanding > 0
    AND i."dueAt" IS NOT NULL AND i."dueAt" < NOW()
  GROUP BY 1
)
SELECT ba.kind, ba."holdState", ba."manualHold", ba.bypass,
       ba.gated_at IS NOT NULL AS gated,
       ba."defaultTermsDays" IS NOT NULL AS has_account_terms,
       ba."creditLimit" IS NOT NULL AS has_credit_limit,
       ba."syncPending",
       ba."metafieldSyncedAt" IS NULL AS metafield_synced_at_is_null,
       ba.id LIKE 'seed-account-%' AS is_seed,
       s."uninstalledAt" IS NULL AS shop_installed,
       COUNT(DISTINCT ba.id) AS account_count,
       SUM(pd.past_due_invoices) AS total_past_due_invoices,
       SUM(pd.overdue_invoices) AS total_overdue_invoices,
       COUNT(*) FILTER (WHERE ba."holdState" IN ('OK', 'NEAR_LIMIT') AND ba.bypass = false AND pd.overdue_invoices > 0) AS sweep_part1_eligible_count
FROM pd
JOIN "BuyerAccount" ba ON ba.id = pd.buyer_account_id
JOIN "Shop" s ON s.id = ba."shopId"
GROUP BY 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11
ORDER BY 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11;

\echo '== A2 summary: past-due accounts by holdState / overdue (sweep predicate) / seed'
WITH pd AS (
  SELECT i."buyerAccountId" AS buyer_account_id,
         COUNT(*) AS past_due_invoices,
         COUNT(*) FILTER (WHERE i."dueAt" < NOW() - INTERVAL '1 day') AS overdue_invoices
  FROM "Invoice" i
  WHERE i.status = 'open' AND i.outstanding > 0
    AND i."dueAt" IS NOT NULL AND i."dueAt" < NOW()
  GROUP BY 1
)
SELECT ba."holdState", ba."manualHold", ba.bypass,
       pd.overdue_invoices > 0 AS has_overdue,
       ba.id LIKE 'seed-account-%' AS is_seed,
       COUNT(*) AS accounts,
       COUNT(*) FILTER (WHERE ba."syncPending") AS accounts_sync_pending
FROM pd JOIN "BuyerAccount" ba ON ba.id = pd.buyer_account_id
GROUP BY 1, 2, 3, 4, 5 ORDER BY 1, 2, 3, 4, 5;

\echo '== A3 all open invoices by due bucket and outstanding > 0 (diagnostics past_due counts open + dueAt < NOW() without the outstanding filter)'
SELECT CASE WHEN i."dueAt" IS NULL THEN 'no_due_at'
            WHEN i."dueAt" >= NOW() THEN 'not_yet_due'
            WHEN i."dueAt" >= NOW() - INTERVAL '1 day' THEN 'past_due_within_1_day_grace'
            ELSE 'overdue_beyond_grace' END AS due_bucket,
       i.outstanding > 0 AS outstanding_gt_0,
       COUNT(*) AS invoices,
       COUNT(DISTINCT i."buyerAccountId") AS accounts
FROM "Invoice" i
WHERE i.status = 'open'
GROUP BY 1, 2 ORDER BY 1, 2;

\echo '== A4 sweep dedupe rows (credit_recompute:*) on the since date and daily_sweep messages since :since'
SELECT 'dedupe_rows_on_since_date' AS what, COUNT(*) AS n
FROM s6_processed_webhooks
WHERE webhook_id LIKE 'credit_recompute:%:' || TO_CHAR((:'since')::timestamptz AT TIME ZONE 'UTC', 'YYYY-MM-DD')
UNION ALL
SELECT 'archived_daily_sweep_since', COUNT(*) FROM pgmq.a_s6_sync
WHERE message->>'source' = 'daily_sweep' AND enqueued_at >= (:'since')::timestamptz
UNION ALL
SELECT 'queued_daily_sweep_now', COUNT(*) FROM pgmq.q_s6_sync
WHERE message->>'source' = 'daily_sweep'
UNION ALL
SELECT 'dlq_daily_sweep_since', COUNT(*) FROM s6_dead_letter
WHERE message->>'source' = 'daily_sweep' AND dead_lettered_at >= (:'since')::timestamptz;

\echo '== B #200 orphan gids: COMPANY_LOCATIONS_DELETE dedupe rows + account sync state (aggregated)'
-- QA 2 audit: orphan CompanyLocations derived from COMPANY_LOCATIONS_DELETE webhook receipts.
-- No psql variables or workflow dispatch inputs. Locations are identified by the presence of
-- a delete webhook in s6_processed_webhooks (7-day retention) or a webhook_receipts row
-- (30-day) joined to its s6_sync message (archive, live queue or DLQ) for the resource gid.
-- Output is aggregated by holdState; individual IDs are not printed.
WITH deleted_locations AS (
  SELECT DISTINCT
    CASE
      WHEN w.resource_gid LIKE 'gid://shopify/CompanyLocation/%' THEN w.resource_gid
      ELSE 'gid://shopify/CompanyLocation/' || w.resource_gid
    END AS company_location_gid
  FROM s6_processed_webhooks w
  WHERE w.topic = 'COMPANY_LOCATIONS_DELETE'
  UNION
  -- webhook_receipts has no resource column (PK shop, webhook_id; see
  -- prisma/migrations/20261025010000_s20_webhook_receipts). The resource gid travels in the
  -- s6_sync message (SyncMessage.resourceGid, app/lib/pgmq.server.ts), so join the edge
  -- receipt to its message on (shop, webhookId), as redriven-webhook-receipts.sql does.
  SELECT DISTINCT
    CASE
      WHEN m.message->>'resourceGid' LIKE 'gid://shopify/CompanyLocation/%' THEN m.message->>'resourceGid'
      ELSE 'gid://shopify/CompanyLocation/' || (m.message->>'resourceGid')
    END AS company_location_gid
  FROM webhook_receipts wr
  JOIN (
    SELECT message FROM pgmq.a_s6_sync
    UNION ALL
    SELECT message FROM pgmq.q_s6_sync
    UNION ALL
    SELECT message FROM s6_dead_letter
  ) m ON m.message->>'shop' = wr.shop AND m.message->>'webhookId' = wr.webhook_id
  WHERE wr.topic = 'COMPANY_LOCATIONS_DELETE'
    AND COALESCE(m.message->>'resourceGid', '') <> ''
),
delete_counts AS (
  SELECT w.resource_gid, COUNT(*) AS delete_ct
  FROM s6_processed_webhooks w
  WHERE w.topic = 'COMPANY_LOCATIONS_DELETE'
  GROUP BY w.resource_gid
),
any_topic_counts AS (
  SELECT w.resource_gid, COUNT(*) AS topic_ct
  FROM s6_processed_webhooks w
  GROUP BY w.resource_gid
)
SELECT ba."holdState", ba."syncPending",
       ba."metafieldSyncedAt" IS NULL AS metafield_synced_at_is_null,
       ba.id LIKE 'seed-account-%' AS is_seed,
       COUNT(DISTINCT dl.company_location_gid) AS location_count,
       COUNT(DISTINCT ba.id) AS account_count,
       COALESCE(SUM(dc.delete_ct), 0) + COALESCE(SUM(dc2.delete_ct), 0) AS total_delete_webhook_rows,
       COALESCE(SUM(atc.topic_ct), 0) AS total_any_topic_dedupe_rows
FROM deleted_locations dl
LEFT JOIN "BuyerAccount" ba ON ba."companyLocationId" = dl.company_location_gid
LEFT JOIN delete_counts dc ON dc.resource_gid = dl.company_location_gid
LEFT JOIN delete_counts dc2 ON dc2.resource_gid = replace(dl.company_location_gid, 'gid://shopify/CompanyLocation/', '')
LEFT JOIN any_topic_counts atc ON atc.resource_gid = dl.company_location_gid
GROUP BY 1, 2, 3, 4
ORDER BY 1, 2, 3, 4;

\echo '== B2 COMPANY_LOCATIONS_DELETE totals (dedupe table / edge receipts)'
SELECT 'processed_webhooks' AS src, COUNT(*) AS n, MIN(processed_at) AS min_at, MAX(processed_at) AS max_at
FROM s6_processed_webhooks WHERE topic = 'COMPANY_LOCATIONS_DELETE'
UNION ALL
SELECT 'webhook_receipts', COUNT(*), MIN(received_at), MAX(received_at)
FROM webhook_receipts WHERE topic = 'COMPANY_LOCATIONS_DELETE';

\echo '== C dependent rows per seed BuyerAccount (aggregated totals)'
-- QA 2 audit: individual buyer_account_id and company_location_gid removed.
-- Orphan locations derived from COMPANY_LOCATIONS_DELETE webhooks (same as section B).
-- Output aggregated by known_orphan status, using pre-aggregated CTEs to avoid whole-row refs.
WITH deleted_locations AS (
  SELECT DISTINCT
    CASE
      WHEN w.resource_gid LIKE 'gid://shopify/CompanyLocation/%' THEN w.resource_gid
      ELSE 'gid://shopify/CompanyLocation/' || w.resource_gid
    END AS company_location_gid
  FROM s6_processed_webhooks w
  WHERE w.topic = 'COMPANY_LOCATIONS_DELETE'
  UNION
  -- webhook_receipts has no resource column (PK shop, webhook_id; see
  -- prisma/migrations/20261025010000_s20_webhook_receipts). The resource gid travels in the
  -- s6_sync message (SyncMessage.resourceGid, app/lib/pgmq.server.ts), so join the edge
  -- receipt to its message on (shop, webhookId), as redriven-webhook-receipts.sql does.
  SELECT DISTINCT
    CASE
      WHEN m.message->>'resourceGid' LIKE 'gid://shopify/CompanyLocation/%' THEN m.message->>'resourceGid'
      ELSE 'gid://shopify/CompanyLocation/' || (m.message->>'resourceGid')
    END AS company_location_gid
  FROM webhook_receipts wr
  JOIN (
    SELECT message FROM pgmq.a_s6_sync
    UNION ALL
    SELECT message FROM pgmq.q_s6_sync
    UNION ALL
    SELECT message FROM s6_dead_letter
  ) m ON m.message->>'shop' = wr.shop AND m.message->>'webhookId' = wr.webhook_id
  WHERE wr.topic = 'COMPANY_LOCATIONS_DELETE'
    AND COALESCE(m.message->>'resourceGid', '') <> ''
),
invoice_counts AS (
  SELECT i."buyerAccountId" AS ba_id, COUNT(*) AS ct FROM "Invoice" i GROUP BY 1
),
match_counts AS (
  SELECT i."buyerAccountId" AS ba_id, COUNT(*) AS ct, COUNT(DISTINCT m."paymentId") AS pmt_ct
  FROM "Match" m JOIN "Invoice" i ON i.id = m."invoiceId" GROUP BY 1
),
rejected_counts AS (
  SELECT i."buyerAccountId" AS ba_id, COUNT(*) AS ct
  FROM rejected_matches r JOIN "Invoice" i ON i.id = r."invoiceId" GROUP BY 1
),
reminder_counts AS (
  SELECT i."buyerAccountId" AS ba_id, COUNT(*) AS ct
  FROM "ReminderLog" rl JOIN "Invoice" i ON i.id = rl."invoiceId" GROUP BY 1
),
payer_counts AS (
  SELECT pa."buyerAccountId" AS ba_id, COUNT(*) AS ct FROM "PayerAlias" pa GROUP BY 1
),
draft_counts AS (
  SELECT d.buyer_account_id AS ba_id, COUNT(*) AS ct FROM s8_draft_orders d GROUP BY 1
)
SELECT EXISTS (SELECT 1 FROM deleted_locations dl WHERE dl.company_location_gid = ba."companyLocationId") AS known_orphan,
       COUNT(DISTINCT ba.id) AS seed_account_count,
       COALESCE(SUM(ic.ct), 0) AS total_invoices,
       COALESCE(SUM(mc.ct), 0) AS total_matches,
       COALESCE(SUM(mc.pmt_ct), 0) AS total_matched_payments,
       COALESCE(SUM(rc.ct), 0) AS total_rejected_matches,
       COALESCE(SUM(rmc.ct), 0) AS total_reminder_logs,
       COALESCE(SUM(pc.ct), 0) AS total_alias_entries,
       COALESCE(SUM(dc.ct), 0) AS total_draft_orders
FROM "BuyerAccount" ba
LEFT JOIN invoice_counts ic ON ic.ba_id = ba.id
LEFT JOIN match_counts mc ON mc.ba_id = ba.id
LEFT JOIN rejected_counts rc ON rc.ba_id = ba.id
LEFT JOIN reminder_counts rmc ON rmc.ba_id = ba.id
LEFT JOIN payer_counts pc ON pc.ba_id = ba.id
LEFT JOIN draft_counts dc ON dc.ba_id = ba.id
WHERE ba.id LIKE 'seed-account-%'
GROUP BY 1
ORDER BY 1;

\echo '== C3 dependent-row totals per table, seed vs non-seed (all BuyerAccounts; tables with 0 rows for a split are omitted)'
SELECT 'buyer_accounts' AS dep_table, ba.id LIKE 'seed-account-%' AS is_seed, COUNT(*) AS n FROM "BuyerAccount" ba GROUP BY 2
UNION ALL
SELECT 'invoices' AS dep_table, ba.id LIKE 'seed-account-%' AS is_seed, COUNT(*) AS n FROM "Invoice" i JOIN "BuyerAccount" ba ON ba.id = i."buyerAccountId" GROUP BY 2
UNION ALL
SELECT 'matches' AS dep_table, ba.id LIKE 'seed-account-%' AS is_seed, COUNT(*) AS n FROM "Match" m JOIN "Invoice" i ON i.id = m."invoiceId" JOIN "BuyerAccount" ba ON ba.id = i."buyerAccountId" GROUP BY 2
UNION ALL
SELECT 'rejected_matches' AS dep_table, ba.id LIKE 'seed-account-%' AS is_seed, COUNT(*) AS n FROM rejected_matches r JOIN "Invoice" i ON i.id = r."invoiceId" JOIN "BuyerAccount" ba ON ba.id = i."buyerAccountId" GROUP BY 2
UNION ALL
SELECT 'reminder_logs' AS dep_table, ba.id LIKE 'seed-account-%' AS is_seed, COUNT(*) AS n FROM "ReminderLog" rl JOIN "Invoice" i ON i.id = rl."invoiceId" JOIN "BuyerAccount" ba ON ba.id = i."buyerAccountId" GROUP BY 2
UNION ALL
SELECT 'payer_aliases' AS dep_table, ba.id LIKE 'seed-account-%' AS is_seed, COUNT(*) AS n FROM "PayerAlias" pa JOIN "BuyerAccount" ba ON ba.id = pa."buyerAccountId" GROUP BY 2
UNION ALL
SELECT 'draft_orders' AS dep_table, ba.id LIKE 'seed-account-%' AS is_seed, COUNT(*) AS n FROM s8_draft_orders d JOIN "BuyerAccount" ba ON ba.id = d.buyer_account_id GROUP BY 2
UNION ALL
SELECT 'audit_events' AS dep_table, ba.id LIKE 'seed-account-%' AS is_seed, COUNT(*) AS n FROM "AuditEvent" ae JOIN "BuyerAccount" ba ON ba."shopId" = ae."shopId" AND ba.id = ae.data->>'buyerAccountId' GROUP BY 2
UNION ALL
SELECT 'recompute_dedupe_rows' AS dep_table, ba.id LIKE 'seed-account-%' AS is_seed, COUNT(*) AS n FROM s6_processed_webhooks pw JOIN "BuyerAccount" ba ON pw.webhook_id LIKE 'credit_recompute:' || ba.id || ':%' GROUP BY 2
ORDER BY 1, 2;

\echo '== C2 BuyerAccount totals by seed / kind (non-seed node-null needs the Admin API; not checked here)'
SELECT ba.id LIKE 'seed-account-%' AS is_seed, ba.kind, COUNT(*) AS accounts
FROM "BuyerAccount" ba GROUP BY 1, 2 ORDER BY 1, 2;

\echo '== D syncPending accounts bucketed by last modified (updatedAt may change for reasons other than syncPending)'
-- Buckets: <1h, 1-24h, >24h based on updatedAt (account's last modification timestamp, not necessarily when syncPending was set)
SELECT
  CASE
    WHEN ba."updatedAt" > NOW() - INTERVAL '1 hour' THEN '<1h'
    WHEN ba."updatedAt" > NOW() - INTERVAL '24 hours' THEN '1-24h'
    ELSE '>24h'
  END AS pending_age_bucket,
  COUNT(*) AS accounts,
  COUNT(*) FILTER (WHERE ba."metafieldSyncErrorCode" IS NOT NULL) AS with_error_marker,
  COUNT(*) FILTER (WHERE EXISTS (
    SELECT 1 FROM s6_dead_letter d
    WHERE d.message->>'topic' = 'CREDIT_STATUS_RECOMPUTE'
      AND d.message->>'buyerAccountId' = ba.id
      AND d.original_queue = 's6_sync'
      AND d.dead_lettered_at > COALESCE(ba."metafieldSyncedAt", '-infinity')
  )) AS dead_lettered
FROM "BuyerAccount" ba
WHERE ba."syncPending" = true
GROUP BY 1
ORDER BY 1;

ROLLBACK;
