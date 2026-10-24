-- post-drain-aggregates.sql (READ-ONLY)
-- Aggregates and ids only. No names, emails, addresses or payloads.
-- Vars: since (ISO timestamp, redrive start), location_id (CompanyLocation numeric id
--       of one held account for the overdue drill-down).
-- Usage: psql -v since='2026-10-24T08:29:23Z' -v location_id='24544084133' -f ...
\set ON_ERROR_STOP 1
BEGIN TRANSACTION READ ONLY;

\echo '== s6_sync live queue (pending by topic, read_ct>0 count)'
SELECT message->>'topic' AS topic, COUNT(*) AS pending,
       COUNT(*) FILTER (WHERE read_ct > 0) AS read_ct_gt0,
       MIN(msg_id) AS min_msg_id, MAX(msg_id) AS max_msg_id
FROM pgmq.q_s6_sync GROUP BY 1 ORDER BY 1;

\echo '== s6_sync archive since redrive start (by topic)'
SELECT message->>'topic' AS topic, COUNT(*) AS archived
FROM pgmq.a_s6_sync WHERE archived_at >= (:'since')::timestamptz
GROUP BY 1 ORDER BY 1;

\echo '== DLQ counts by queue/topic (all-time / since redrive start)'
SELECT original_queue, message->>'topic' AS topic, COUNT(*) AS total,
       COUNT(*) FILTER (WHERE dead_lettered_at >= (:'since')::timestamptz) AS since_start
FROM s6_dead_letter GROUP BY 1, 2 ORDER BY 1, 2;

\echo '== DLQ entries since redrive start (ids + error class before first colon, redacted, max 80 chars; same as prod-diagnostics)'
SELECT original_msg_id, message->>'topic' AS topic, dead_lettered_at,
       LEFT(REGEXP_REPLACE(REGEXP_REPLACE(REGEXP_REPLACE(REGEXP_REPLACE(REGEXP_REPLACE(error, ':.*$', ''),
         '[^[:space:]@]+@[^[:space:]]+', '<email>', 'g'),
         '[A-Za-z0-9_.-]+\.(local|com|net|org|io|co|dev|in|app)\M', '<host>', 'g'),
         '\m[0-9a-fA-F]{12,}\M', '<hex>', 'g'), '[0-9]{4,}', '<n>', 'g'), 80) AS error_class_truncated
FROM s6_dead_letter WHERE dead_lettered_at >= (:'since')::timestamptz
ORDER BY dead_lettered_at LIMIT 50;

\echo '== Invoice totals by status / past-due bucket / dueBasis (dueAt; overdue_rule = backstop rule dueAt < now()-1d)'
SELECT i."shopId" AS shop_id, i.status,
       CASE WHEN i.status <> 'open' THEN '-'
            WHEN i."dueAt" IS NULL THEN 'open_no_due'
            WHEN i."dueAt" < NOW() THEN 'past_due'
            ELSE 'open_not_due' END AS bucket,
       COALESCE(i."dueBasis", '(null)') AS due_basis,
       COUNT(*) AS invoices,
       SUM(i.total) AS total_amount,
       SUM(i.outstanding) AS outstanding_amount,
       COUNT(*) FILTER (WHERE i.status = 'open' AND i.outstanding > 0
                        AND i."dueAt" < NOW() - INTERVAL '1 day') AS overdue_rule_count
FROM "Invoice" i
GROUP BY 1, 2, 3, 4 ORDER BY 1, 2, 3, 4;

\echo '== backstop_processed_orders by action/reason (all-time / since redrive start)'
SELECT action, COALESCE(reason, '(null)') AS reason, COUNT(*) AS total,
       COUNT(*) FILTER (WHERE processed_at >= (:'since')::timestamptz) AS since_start
FROM backstop_processed_orders GROUP BY 1, 2 ORDER BY 1, 2;

\echo '== held orders with an invoice (since redrive start)'
SELECT COUNT(*) AS held_orders,
       COUNT(i.id) AS held_orders_with_invoice
FROM backstop_processed_orders b
LEFT JOIN "Invoice" i ON i."orderId" = b.order_gid AND i."shopId" = b.shop_id
WHERE b.action = 'held' AND b.processed_at >= (:'since')::timestamptz;

\echo '== backstop.hold_applied AuditEvents since redrive start (order gid, account, reason fields from data)'
SELECT e.at, e.data->>'orderGid' AS order_gid, e.data->>'buyerAccountId' AS buyer_account_id,
       e.data->>'holdReasonCode' AS data_hold_reason_code, e.data->>'reason' AS data_reason,
       e.data->>'fulfillmentOrdersHeld' AS fo_held, e.data->>'nonMerchantManagedSkipped' AS non_mm_skipped,
       a."holdReasonCode" AS account_hold_reason_code, a."holdState" AS account_hold_state
FROM "AuditEvent" e
LEFT JOIN "BuyerAccount" a ON a.id = e.data->>'buyerAccountId'
WHERE e.type = 'backstop.hold_applied' AND e.at >= (:'since')::timestamptz
ORDER BY e.at;

\echo '== held account drill-down: account hold fields (no name)'
SELECT a.id, a.kind, a."holdState", a."holdReasonCode", a."manualHold", a.bypass,
       a."syncPending", a."syncVersion", (a."creditLimit" IS NOT NULL) AS has_credit_limit, a."defaultTermsDays",
       a."defaultTermsSource", a.gated_at, a."updatedAt"
FROM "BuyerAccount" a
WHERE a."companyLocationId" = 'gid://shopify/CompanyLocation/' || :'location_id';

\echo '== held account drill-down: its open invoices vs overdue rule'
SELECT i.id, i.status, i."dueAt", i."dueOverrideAt", i."dueSource", i."dueBasis",
       i.issued_at_days_ago, i.outstanding > 0 AS has_outstanding,
       (i.status = 'open' AND i.outstanding > 0 AND i."dueAt" < NOW() - INTERVAL '1 day') AS overdue_rule
FROM (
  SELECT inv.*, EXTRACT(DAY FROM NOW() - inv."issuedAt")::int AS issued_at_days_ago
  FROM "Invoice" inv JOIN "BuyerAccount" a ON a.id = inv."buyerAccountId"
  WHERE a."companyLocationId" = 'gid://shopify/CompanyLocation/' || :'location_id'
) i
ORDER BY i."dueAt" NULLS LAST;

ROLLBACK;
