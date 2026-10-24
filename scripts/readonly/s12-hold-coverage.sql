-- s12-hold-coverage.sql (READ-ONLY)
-- Why the 00:30 IST credit_status_daily_sweep held only some past-due accounts (S12),
-- plus the #200 orphan-location confirmation. SELECT only, inside a READ ONLY transaction.
-- Prints only ids, gids, enums, booleans, timestamps, counts, day integers and the
-- config_int defaultTermsDays. Never selects name, holdNote, emails, domains, money
-- amounts (outstanding/total/creditLimit only appear inside comparisons), payloads
-- or free-text fields.
-- "past_due"  = open invoice, outstanding > 0, dueAt < NOW().
-- "overdue"   = the sweep / hasOverdueInvoices predicate: same, but dueAt < NOW() - 1 day.
-- "is_seed"   = BuyerAccount.id LIKE 'seed-account-%' (same as s12-checkout-fixtures.sql).
-- over_limit mirrors computeExposure(): open invoice outstanding + s8 draft orders with
-- payment terms in ('open','invoice_sent'), compared with creditLimit.
-- Var: since (ISO-8601 UTC of the sweep run, e.g. 2026-10-24T19:00:00Z). The sweep's
--      dedupe key date is since's UTC date.
-- @col kind, "holdState", proname: enum
-- @col "manualHold", bypass, "syncPending": boolean
-- @col max_days_past_due, min_days_past_due: timestamp
-- @col "defaultTermsDays": config_int
\set ON_ERROR_STOP 1
BEGIN TRANSACTION READ ONLY;

\echo '== H0 live sweep function: grace interval / gated filter present in prosrc'
SELECT proname,
       position('INTERVAL ''1 day''' in prosrc) > 0 AS uses_1_day_grace,
       position('gated_at' in prosrc) > 0 AS filters_gated,
       position('''OK'', ''NEAR_LIMIT''' in prosrc) > 0 AS part1_ok_near_limit_only
FROM pg_proc WHERE proname = 'enqueue_credit_status_recomputes';

\echo '== H1 shop-level defaultTermsDays (config_int, clamped) per shop'
SELECT DENSE_RANK() OVER (ORDER BY s.id) AS shop_idx,
       s."uninstalledAt" IS NULL AS installed,
       CASE WHEN s."defaultTermsDays" BETWEEN 0 AND 365 THEN s."defaultTermsDays" END AS "defaultTermsDays"
FROM "Shop" s
ORDER BY 1;

\echo '== A per BuyerAccount with >= 1 past-due unpaid invoice'
WITH pd AS (
  SELECT i."buyerAccountId" AS buyer_account_id,
         COUNT(*) AS past_due_invoices,
         COUNT(*) FILTER (WHERE i."dueAt" < NOW() - INTERVAL '1 day') AS overdue_invoices,
         MIN(i."dueAt") AS oldest_due_at,
         MAX(i."dueAt") AS newest_due_at
  FROM "Invoice" i
  WHERE i.status = 'open' AND i.outstanding > 0
    AND i."dueAt" IS NOT NULL AND i."dueAt" < NOW()
  GROUP BY 1
)
SELECT ba.id AS buyer_account_id,
       DENSE_RANK() OVER (ORDER BY ba."shopId") AS shop_idx,
       ba.kind,
       ba."companyLocationId" AS company_location_gid,
       ba."customerId" AS customer_gid,
       ba."holdState", ba."manualHold", ba.bypass,
       ba.gated_at IS NOT NULL AS gated,
       pd.past_due_invoices,
       pd.overdue_invoices,
       EXTRACT(DAY FROM NOW() - pd.oldest_due_at)::int AS max_days_past_due,
       EXTRACT(DAY FROM NOW() - pd.newest_due_at)::int AS min_days_past_due,
       CASE WHEN ba."defaultTermsDays" BETWEEN 0 AND 365 THEN ba."defaultTermsDays" END AS "defaultTermsDays",
       ba."creditLimit" IS NOT NULL AS has_credit_limit,
       (ba."creditLimit" IS NOT NULL AND
        (COALESCE((SELECT SUM(i2.outstanding) FROM "Invoice" i2
                   WHERE i2."buyerAccountId" = ba.id AND i2.status = 'open' AND i2.outstanding > 0), 0)
         + COALESCE((SELECT SUM(d.total) FROM s8_draft_orders d
                     WHERE d.buyer_account_id = ba.id AND d.has_payment_terms
                       AND d.status IN ('open', 'invoice_sent')), 0)) > ba."creditLimit") AS over_limit,
       ba."syncPending",
       ba."metafieldSyncedAt" IS NULL AS metafield_synced_at_is_null,
       ba."metafieldSyncedAt" AS metafield_synced_at,
       ba."updatedAt" AS account_updated_at,
       ba.id LIKE 'seed-account-%' AS is_seed,
       s."uninstalledAt" IS NULL AS shop_installed,
       (ba."holdState" IN ('OK', 'NEAR_LIMIT') AND ba.bypass = false AND pd.overdue_invoices > 0) AS sweep_part1_eligible,
       EXISTS (SELECT 1 FROM s6_processed_webhooks w
               WHERE w.webhook_id = 'credit_recompute:' || ba.id || ':' || TO_CHAR((:'since')::timestamptz AT TIME ZONE 'UTC', 'YYYY-MM-DD')) AS swept_on_since_date,
       (SELECT MAX(w.processed_at) FROM s6_processed_webhooks w
         WHERE w.webhook_id LIKE 'credit_recompute:' || ba.id || ':%') AS last_recompute_processed_at
FROM pd
JOIN "BuyerAccount" ba ON ba.id = pd.buyer_account_id
JOIN "Shop" s ON s.id = ba."shopId"
ORDER BY ba.id
LIMIT 200;

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
       COUNT(*) FILTER (WHERE pd.past_due_invoices > 0) AS accounts_past_due
FROM pd JOIN "BuyerAccount" ba ON ba.id = pd.buyer_account_id
GROUP BY 1, 2, 3, 4, 5 ORDER BY 1, 2, 3, 4, 5;

\echo '== A3 open invoices outstanding > 0 by due bucket (context for the past-due total)'
SELECT CASE WHEN i."dueAt" IS NULL THEN 'no_due_at'
            WHEN i."dueAt" >= NOW() THEN 'not_yet_due'
            WHEN i."dueAt" >= NOW() - INTERVAL '1 day' THEN 'past_due_within_1_day_grace'
            ELSE 'overdue_beyond_grace' END AS due_bucket,
       COUNT(*) AS invoices,
       COUNT(DISTINCT i."buyerAccountId") AS accounts
FROM "Invoice" i
WHERE i.status = 'open' AND i.outstanding > 0
GROUP BY 1 ORDER BY 1;

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

\echo '== B #200 orphan gids: COMPANY_LOCATIONS_DELETE dedupe rows + account sync state'
WITH g(company_location_gid) AS (
  SELECT 'gid://shopify/CompanyLocation/24539463845' UNION ALL
  SELECT 'gid://shopify/CompanyLocation/24539529381' UNION ALL
  SELECT 'gid://shopify/CompanyLocation/24539594917'
)
SELECT g.company_location_gid,
       (SELECT COUNT(*) FROM s6_processed_webhooks w
         WHERE w.topic = 'COMPANY_LOCATIONS_DELETE'
           AND (w.resource_gid = g.company_location_gid
                OR w.resource_gid = replace(g.company_location_gid, 'gid://shopify/CompanyLocation/', ''))) AS delete_webhook_rows,
       (SELECT COUNT(*) FROM s6_processed_webhooks w
         WHERE w.resource_gid = g.company_location_gid) AS any_topic_dedupe_rows,
       ba.id AS buyer_account_id,
       ba.id LIKE 'seed-account-%' AS is_seed,
       ba."holdState",
       ba."syncPending",
       ba."metafieldSyncedAt" IS NULL AS metafield_synced_at_is_null,
       ba."updatedAt" AS account_updated_at
FROM g
LEFT JOIN "BuyerAccount" ba ON ba."companyLocationId" = g.company_location_gid
ORDER BY 1;

\echo '== B2 COMPANY_LOCATIONS_DELETE totals (dedupe table / edge receipts)'
SELECT 'processed_webhooks' AS src, COUNT(*) AS n, MIN(processed_at) AS min_at, MAX(processed_at) AS max_at
FROM s6_processed_webhooks WHERE topic = 'COMPANY_LOCATIONS_DELETE'
UNION ALL
SELECT 'webhook_receipts', COUNT(*), MIN(received_at), MAX(received_at)
FROM webhook_receipts WHERE topic = 'COMPANY_LOCATIONS_DELETE';

\echo '== C dependent rows per seed BuyerAccount (pair with checkout_fixtures owner_found for node-null)'
SELECT ba.id AS buyer_account_id,
       ba."companyLocationId" AS company_location_gid,
       ba."companyLocationId" IN ('gid://shopify/CompanyLocation/24539463845',
                                  'gid://shopify/CompanyLocation/24539529381',
                                  'gid://shopify/CompanyLocation/24539594917') AS known_orphan,
       (SELECT COUNT(*) FROM "Invoice" i WHERE i."buyerAccountId" = ba.id) AS invoices,
       (SELECT COUNT(*) FROM "Match" m JOIN "Invoice" i ON i.id = m."invoiceId" WHERE i."buyerAccountId" = ba.id) AS matches,
       (SELECT COUNT(DISTINCT m."paymentId") FROM "Match" m JOIN "Invoice" i ON i.id = m."invoiceId" WHERE i."buyerAccountId" = ba.id) AS matched_payments,
       (SELECT COUNT(*) FROM "RejectedMatch" r JOIN "Invoice" i ON i.id = r."invoiceId" WHERE i."buyerAccountId" = ba.id) AS rejected_matches,
       (SELECT COUNT(*) FROM "ReminderLog" rl JOIN "Invoice" i ON i.id = rl."invoiceId" WHERE i."buyerAccountId" = ba.id) AS reminder_logs,
       (SELECT COUNT(*) FROM "PayerAlias" pa WHERE pa."buyerAccountId" = ba.id) AS payer_aliases,
       (SELECT COUNT(*) FROM s8_draft_orders d WHERE d.buyer_account_id = ba.id) AS draft_orders,
       (SELECT COUNT(*) FROM "AuditEvent" e WHERE e."shopId" = ba."shopId" AND e.data->>'buyerAccountId' = ba.id) AS audit_events,
       (SELECT COUNT(*) FROM s6_processed_webhooks w WHERE w.webhook_id LIKE 'credit_recompute:' || ba.id || ':%') AS recompute_dedupe_rows
FROM "BuyerAccount" ba
WHERE ba.id LIKE 'seed-account-%'
ORDER BY ba.id
LIMIT 200;

\echo '== C2 BuyerAccount totals by seed / kind (non-seed node-null needs the Admin API; not checked here)'
SELECT ba.id LIKE 'seed-account-%' AS is_seed, ba.kind, COUNT(*) AS accounts
FROM "BuyerAccount" ba GROUP BY 1, 2 ORDER BY 1, 2;

ROLLBACK;
