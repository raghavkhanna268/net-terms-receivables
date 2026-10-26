-- post-drain-aggregates.sql (READ-ONLY)
-- Enums, booleans, timestamps and counts only. No money amounts, shop domains,
-- names, emails, addresses, payloads, free text (reasons/errors mapped to enums),
-- or individual buyer/invoice/order IDs (QA 2 audit: aggregates only).
-- Vars: since (ISO timestamp, redrive start), location_id (CompanyLocation numeric id
--       of one held account for the overdue drill-down, passed as workflow input).
-- Usage: psql -v since='2026-10-24T08:29:23Z' -v location_id='...' -f ...
-- Output column kinds for passthrough columns (scripts/ci/check-readonly-columns.ts,
-- see scripts/readonly/README.md). Derived counts/booleans/CASE enums need no entry.
-- @col topic, original_queue, error_format, error_disposition, error_code, status, due_basis, action, account_hold_state, kind, holdState, defaultTermsSource, dueSource, dueBasis: enum
-- dueBasis / due_basis and dueSource are TEXT columns holding app-written fixed codes (not free text), so enum.
-- @col total_fo_held, total_non_mm_skipped: count
-- @col defaultTermsDays: config_int
-- @col manualHold, bypass, syncPending: boolean
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
         WHEN m.m[1] = 'non_retryable' THEN 'non_retryable'
         WHEN m.m[1] = 'permanent' THEN 'permanent'
         WHEN m.m IS NOT NULL THEN 'none'
         WHEN d.error LIKE 'Non-retryable error:%' THEN 'non_retryable'
         ELSE 'none' END AS error_disposition,
    CASE WHEN d.error IS NULL THEN NULL
         -- the code is a regex capture of the error column, so only literal
         -- codes print (toErrorCode's fixed set in app/lib/log.server.ts); other
         -- codes bucket. Per-code counts: the backstop.failed errorCode section.
         WHEN m.m[2] = 'no_handler' THEN 'no_handler'
         WHEN m.m[2] = 'unknown' THEN 'unknown'
         WHEN m.m[2] = 'error' THEN 'error'
         WHEN m.m[2] = 'connection_refused' THEN 'connection_refused'
         WHEN m.m[2] = 'timeout' THEN 'timeout'
         WHEN m.m[2] = 'dns_error' THEN 'dns_error'
         WHEN m.m[2] = 'fetch_error' THEN 'fetch_error'
         WHEN m.m[2] = 'invalid_grant' THEN 'invalid_grant'
         WHEN m.m[2] = 'access_denied' THEN 'access_denied'
         WHEN m.m[2] = 'throttled' THEN 'throttled'
         WHEN m.m[2] = 'rate_limited' THEN 'rate_limited'
         WHEN m.m[2] = 'pg_unique_violation' THEN 'pg_unique_violation'
         WHEN m.m[2] = 'pg_foreign_key_violation' THEN 'pg_foreign_key_violation'
         WHEN m.m[2] = 'pg_connection_error' THEN 'pg_connection_error'
         WHEN m.m[2] = 'queue_error' THEN 'queue_error'
         WHEN m.m[2] LIKE 'graphql_error:%' THEN 'graphql_error:<code>'
         WHEN m.m IS NOT NULL THEN '<other_code>'
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
         WHEN m.m[1] = 'non_retryable' THEN 'non_retryable'
         WHEN m.m[1] = 'permanent' THEN 'permanent'
         WHEN m.m IS NOT NULL THEN 'none'
         WHEN d.error LIKE 'Non-retryable error:%' THEN 'non_retryable'
         ELSE 'none' END AS error_disposition,
    CASE WHEN d.error IS NULL THEN NULL
         -- the code is a regex capture of the error column, so only literal
         -- codes print (toErrorCode's fixed set in app/lib/log.server.ts); other
         -- codes bucket. Per-code counts: the backstop.failed errorCode section.
         WHEN m.m[2] = 'no_handler' THEN 'no_handler'
         WHEN m.m[2] = 'unknown' THEN 'unknown'
         WHEN m.m[2] = 'error' THEN 'error'
         WHEN m.m[2] = 'connection_refused' THEN 'connection_refused'
         WHEN m.m[2] = 'timeout' THEN 'timeout'
         WHEN m.m[2] = 'dns_error' THEN 'dns_error'
         WHEN m.m[2] = 'fetch_error' THEN 'fetch_error'
         WHEN m.m[2] = 'invalid_grant' THEN 'invalid_grant'
         WHEN m.m[2] = 'access_denied' THEN 'access_denied'
         WHEN m.m[2] = 'throttled' THEN 'throttled'
         WHEN m.m[2] = 'rate_limited' THEN 'rate_limited'
         WHEN m.m[2] = 'pg_unique_violation' THEN 'pg_unique_violation'
         WHEN m.m[2] = 'pg_foreign_key_violation' THEN 'pg_foreign_key_violation'
         WHEN m.m[2] = 'pg_connection_error' THEN 'pg_connection_error'
         WHEN m.m[2] = 'queue_error' THEN 'queue_error'
         WHEN m.m[2] LIKE 'graphql_error:%' THEN 'graphql_error:<code>'
         WHEN m.m IS NOT NULL THEN '<other_code>'
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

\echo '== backstop.hold_applied AuditEvents since redrive start (aggregated by reason code)'
-- QA 2 audit: individual order_gid and buyer_account_id removed; aggregated by reason code.
SELECT CASE WHEN e.data->>'holdReasonCode' ~ '^[A-Z0-9_]{1,40}$' THEN e.data->>'holdReasonCode' WHEN e.data->>'holdReasonCode' IS NULL THEN NULL ELSE '<other>' END AS data_hold_reason_code,
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
       CASE WHEN a."holdReasonCode" ~ '^[A-Z0-9_]{1,40}$' THEN a."holdReasonCode" WHEN a."holdReasonCode" IS NULL THEN NULL ELSE '<other>' END AS account_hold_reason_code,
       a."holdState" AS account_hold_state,
       COUNT(*) AS event_count,
       COUNT(DISTINCT e.data->>'orderGid') AS distinct_orders,
       COUNT(DISTINCT e.data->>'buyerAccountId') AS distinct_accounts,
       SUM((e.data->>'fulfillmentOrdersHeld')::int) AS total_fo_held,
       SUM((e.data->>'nonMerchantManagedSkipped')::int) AS total_non_mm_skipped
FROM "AuditEvent" e
LEFT JOIN "BuyerAccount" a ON a.id = e.data->>'buyerAccountId'
WHERE e.type = 'backstop.hold_applied' AND e.at >= (:'since')::timestamptz
GROUP BY 1, 2, 3, 4
ORDER BY 1, 2, 3, 4;

\echo '== backstop.failed AuditEvents by error code (all-time / since redrive start; data.errorCode since #176, legacy data.error text never printed)'
SELECT CASE WHEN e.data ? 'errorCode' THEN
              CASE WHEN e.data->>'errorCode' ~ '^(?:(non_retryable|permanent):)?[A-Za-z][A-Za-z0-9_]{0,63}$' THEN e.data->>'errorCode'
                   WHEN e.data->>'errorCode' ~ '^graphql_error:[A-Za-z0-9_]{1,64}$' THEN e.data->>'errorCode'
                   WHEN e.data->>'errorCode' LIKE 'graphql_error:%' THEN 'graphql_error:<multiple>'
                   ELSE '<other>' END
            WHEN e.data ? 'error' THEN 'legacy_unclassified'
            ELSE '(none)' END AS error_code,
       COUNT(*) AS total,
       COUNT(*) FILTER (WHERE e.at >= (:'since')::timestamptz) AS since_start
FROM "AuditEvent" e
WHERE e.type = 'backstop.failed'
GROUP BY 1 ORDER BY 1;

\echo '== held account drill-down: aggregated account hold fields'
-- QA 2 audit: individual account IDs removed; aggregated by holdState.
-- The location_id variable is passed as a numeric workflow input.
SELECT a.kind, a."holdState",
       CASE WHEN a."holdReasonCode" ~ '^[A-Z0-9_]{1,40}$' THEN a."holdReasonCode" WHEN a."holdReasonCode" IS NULL THEN NULL ELSE '<other>' END AS hold_reason_code,
       a."manualHold", a.bypass, a."syncPending",
       (a."creditLimit" IS NOT NULL) AS has_credit_limit,
       CASE WHEN a."defaultTermsDays" BETWEEN 0 AND 365 THEN a."defaultTermsDays" END AS "defaultTermsDays",
       a."defaultTermsSource",
       (a.gated_at IS NOT NULL) AS gated,
       COUNT(*) AS account_count
FROM "BuyerAccount" a
WHERE a."companyLocationId" = 'gid://shopify/CompanyLocation/' || :'location_id'
GROUP BY 1, 2, 3, 4, 5, 6, 7, 8, 9, 10
ORDER BY 1, 2, 3, 4, 5, 6, 7, 8, 9, 10;

\echo '== held account drill-down: its open invoices vs overdue rule (aggregated)'
-- QA 2 audit: individual invoice IDs removed; aggregated by status and overdue state.
SELECT i.status, i."dueSource", i."dueBasis",
       (i.outstanding > 0) AS has_outstanding,
       (i.status = 'open' AND i.outstanding > 0 AND i."dueAt" < NOW() - INTERVAL '1 day') AS overdue_rule,
       COUNT(*) AS invoice_count
FROM "Invoice" i
JOIN "BuyerAccount" a ON a.id = i."buyerAccountId"
WHERE a."companyLocationId" = 'gid://shopify/CompanyLocation/' || :'location_id'
GROUP BY 1, 2, 3, 4, 5
ORDER BY 1, 2, 3, 4, 5;

ROLLBACK;
