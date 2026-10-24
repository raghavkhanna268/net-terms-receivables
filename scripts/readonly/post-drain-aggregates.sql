-- post-drain-aggregates.sql (READ-ONLY)
-- Ids, enums, booleans, timestamps and counts only. No money amounts, shop domains,
-- names, emails, addresses, payloads or free text (reasons/errors mapped to enums).
-- Vars: since (ISO timestamp, redrive start), location_id (CompanyLocation numeric id
--       of one held account for the overdue drill-down).
-- Usage: psql -v since='2026-10-24T08:29:23Z' -v location_id='24544084133' -f ...
-- Output column kinds for passthrough columns (scripts/ci/check-readonly-columns.ts,
-- see scripts/readonly/README.md). Derived counts/booleans/CASE enums need no entry.
-- @col topic, original_queue, error_format, error_disposition, error_code, status, due_basis, action, account_hold_state, kind, holdState, defaultTermsSource, dueSource, dueBasis: enum
-- dueBasis (and due_basis) is a TEXT column holding app-written fixed codes, not free text, so enum.
-- @col fo_held, non_mm_skipped, syncVersion: count
-- @col manualHold, bypass, syncPending: boolean
-- @col issued_at_days_ago: timestamp
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

\echo '== DLQ entries since redrive start (ids + error code; error text never printed). error is "[non_retryable:|permanent:]<code>" since #176; older raw-text rows map to legacy_* buckets'
SELECT original_msg_id, message->>'topic' AS topic, dead_lettered_at,
       error_format, error_disposition, error_code
FROM
  (SELECT d.*,
    CASE WHEN d.error IS NULL THEN NULL
         WHEN m.m IS NOT NULL THEN 'code'
         WHEN d.error LIKE 'No handler registered for topic after %' THEN 'no_handler_text'
         ELSE 'legacy_text' END AS error_format,
    CASE WHEN d.error IS NULL THEN NULL
         WHEN m.m IS NOT NULL THEN COALESCE(m.m[1], 'none')
         WHEN d.error LIKE 'Non-retryable error:%' THEN 'non_retryable'
         ELSE 'none' END AS error_disposition,
    CASE WHEN d.error IS NULL THEN NULL
         WHEN m.m IS NOT NULL THEN m.m[2]
         WHEN d.error LIKE 'No handler registered for topic after %' THEN 'no_handler'
         WHEN d.error LIKE 'Order has payment terms but no matching BuyerAccount found%' THEN 'legacy_nba_payment_terms'
         WHEN d.error LIKE 'Customer matches tag rule % but no BuyerAccount found%' THEN 'legacy_nba_tag_rule'
         WHEN d.error LIKE 'CompanyLocation exists but no BuyerAccount synced yet%' THEN 'legacy_nba_company_location'
         ELSE 'legacy_unclassified' END AS error_code
  FROM s6_dead_letter d
  CROSS JOIN LATERAL (SELECT regexp_match(d.error, '^(?:(non_retryable|permanent):)?([A-Za-z][A-Za-z0-9_]{0,63}|graphql_error:[A-Za-z0-9_,]{1,200})$') AS m) m) dlq
WHERE dead_lettered_at >= (:'since')::timestamptz
ORDER BY dead_lettered_at LIMIT 50;

\echo '== DLQ by error code (all-time / since redrive start)'
SELECT error_format, error_disposition, error_code, COUNT(*) AS total,
       COUNT(*) FILTER (WHERE dead_lettered_at >= (:'since')::timestamptz) AS since_start
FROM
  (SELECT d.*,
    CASE WHEN d.error IS NULL THEN NULL
         WHEN m.m IS NOT NULL THEN 'code'
         WHEN d.error LIKE 'No handler registered for topic after %' THEN 'no_handler_text'
         ELSE 'legacy_text' END AS error_format,
    CASE WHEN d.error IS NULL THEN NULL
         WHEN m.m IS NOT NULL THEN COALESCE(m.m[1], 'none')
         WHEN d.error LIKE 'Non-retryable error:%' THEN 'non_retryable'
         ELSE 'none' END AS error_disposition,
    CASE WHEN d.error IS NULL THEN NULL
         WHEN m.m IS NOT NULL THEN m.m[2]
         WHEN d.error LIKE 'No handler registered for topic after %' THEN 'no_handler'
         WHEN d.error LIKE 'Order has payment terms but no matching BuyerAccount found%' THEN 'legacy_nba_payment_terms'
         WHEN d.error LIKE 'Customer matches tag rule % but no BuyerAccount found%' THEN 'legacy_nba_tag_rule'
         WHEN d.error LIKE 'CompanyLocation exists but no BuyerAccount synced yet%' THEN 'legacy_nba_company_location'
         ELSE 'legacy_unclassified' END AS error_code
  FROM s6_dead_letter d
  CROSS JOIN LATERAL (SELECT regexp_match(d.error, '^(?:(non_retryable|permanent):)?([A-Za-z][A-Za-z0-9_]{0,63}|graphql_error:[A-Za-z0-9_,]{1,200})$') AS m) m) dlq
GROUP BY 1, 2, 3 ORDER BY 1, 2, 3;

\echo '== Invoice totals by status / past-due bucket / dueBasis (dueAt; overdue_rule = backstop rule dueAt < now()-1d)'
SELECT DENSE_RANK() OVER (ORDER BY i."shopId") AS shop_idx, i.status,
       CASE WHEN i.status <> 'open' THEN '-'
            WHEN i."dueAt" IS NULL THEN 'open_no_due'
            WHEN i."dueAt" < NOW() THEN 'past_due'
            ELSE 'open_not_due' END AS bucket,
       COALESCE(i."dueBasis", '(null)') AS due_basis,
       COUNT(*) AS invoices,
       COUNT(*) FILTER (WHERE i.outstanding > 0) AS outstanding_gt_0_count,
       COUNT(*) FILTER (WHERE i.status = 'open' AND i.outstanding > 0
                        AND i."dueAt" < NOW() - INTERVAL '1 day') AS overdue_rule_count
FROM "Invoice" i
GROUP BY i."shopId", 2, 3, 4 ORDER BY 1, 2, 3, 4;

\echo '== backstop_processed_orders by action/reason (all-time / since redrive start)'
SELECT action, COALESCE(CASE reason
         WHEN 'Order placed from held account - backstop applied'                   THEN 'hold_applied'
         WHEN 'Backstop failed after all retries - manual intervention required'     THEN 'failed_after_retries'
         WHEN 'backstop_max_retries'                                                THEN 'failed_after_retries'
         WHEN 'Skipped non-merchant-managed fulfillment orders (outside our scope)'  THEN 'non_merchant_managed_skipped'
         WHEN 'Account not found'                                                   THEN 'account_not_found'
         WHEN 'Bypass active'                                                       THEN 'bypass_active'
         WHEN 'Manual hold'                                                         THEN 'manual_hold'
         WHEN 'Payment overdue'                                                     THEN 'payment_overdue'
         WHEN 'Over credit limit'                                                   THEN 'over_credit_limit'
         WHEN 'Not held'                                                            THEN 'not_held'
         WHEN 'No credit limit'                                                     THEN 'no_credit_limit'
         WHEN 'Already over limit before this order'                                THEN 'already_over_limit'
         WHEN 'This order pushed account over limit (not held)'                     THEN 'order_pushed_over_limit'
         ELSE CASE WHEN reason IS NULL THEN NULL ELSE '<other>' END
       END, '(null)') AS reason_code, COUNT(*) AS total,
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
       CASE WHEN e.data->>'holdReasonCode' ~ '^[A-Z0-9_]{1,40}$' THEN e.data->>'holdReasonCode' WHEN e.data->>'holdReasonCode' IS NULL THEN NULL ELSE '<other>' END AS data_hold_reason_code,
       CASE e.data->>'reason'
         WHEN 'Order placed from held account - backstop applied'                   THEN 'hold_applied'
         WHEN 'Backstop failed after all retries - manual intervention required'     THEN 'failed_after_retries'
         WHEN 'backstop_max_retries'                                                THEN 'failed_after_retries'
         WHEN 'Skipped non-merchant-managed fulfillment orders (outside our scope)'  THEN 'non_merchant_managed_skipped'
         WHEN 'Account not found'                                                   THEN 'account_not_found'
         WHEN 'Bypass active'                                                       THEN 'bypass_active'
         WHEN 'Manual hold'                                                         THEN 'manual_hold'
         WHEN 'Payment overdue'                                                     THEN 'payment_overdue'
         WHEN 'Over credit limit'                                                   THEN 'over_credit_limit'
         WHEN 'Not held'                                                            THEN 'not_held'
         WHEN 'No credit limit'                                                     THEN 'no_credit_limit'
         WHEN 'Already over limit before this order'                                THEN 'already_over_limit'
         WHEN 'This order pushed account over limit (not held)'                     THEN 'order_pushed_over_limit'
         ELSE CASE WHEN e.data->>'reason' IS NULL THEN NULL ELSE '<other>' END
       END AS data_reason_code,
       e.data->>'fulfillmentOrdersHeld' AS fo_held, e.data->>'nonMerchantManagedSkipped' AS non_mm_skipped,
       CASE WHEN a."holdReasonCode" ~ '^[A-Z0-9_]{1,40}$' THEN a."holdReasonCode" WHEN a."holdReasonCode" IS NULL THEN NULL ELSE '<other>' END AS account_hold_reason_code, a."holdState" AS account_hold_state
FROM "AuditEvent" e
LEFT JOIN "BuyerAccount" a ON a.id = e.data->>'buyerAccountId'
WHERE e.type = 'backstop.hold_applied' AND e.at >= (:'since')::timestamptz
ORDER BY e.at;

\echo '== backstop.failed AuditEvents by error code (all-time / since redrive start; data.errorCode since #176, legacy data.error text never printed)'
SELECT CASE WHEN e.data ? 'errorCode' THEN
              CASE WHEN e.data->>'errorCode' ~ '^(?:(non_retryable|permanent):)?([A-Za-z][A-Za-z0-9_]{0,63}|graphql_error:[A-Za-z0-9_,]{1,200})$' THEN e.data->>'errorCode' ELSE '<other>' END
            WHEN e.data ? 'error' THEN 'legacy_unclassified'
            ELSE '(none)' END AS error_code,
       COUNT(*) AS total,
       COUNT(*) FILTER (WHERE e.at >= (:'since')::timestamptz) AS since_start
FROM "AuditEvent" e
WHERE e.type = 'backstop.failed'
GROUP BY 1 ORDER BY 1;

\echo '== held account drill-down: account hold fields (no name)'
SELECT a.id, a.kind, a."holdState", CASE WHEN a."holdReasonCode" ~ '^[A-Z0-9_]{1,40}$' THEN a."holdReasonCode" WHEN a."holdReasonCode" IS NULL THEN NULL ELSE '<other>' END AS hold_reason_code, a."manualHold", a.bypass,
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
