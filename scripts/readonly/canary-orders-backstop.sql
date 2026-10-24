-- canary-orders-backstop.sql (READ-ONLY)
-- (CTEs only: read-only transactions forbid CREATE, even TEMP views.)
-- Inspects s6_sync messages by msg_id (archive or live queue) and the
-- S13 backstop state for each referenced order.
-- Prints only ids, enums, booleans and timestamps. No PII, no payloads.
-- Usage: psql -v ON_ERROR_STOP=1 -v msg_ids='162,163' -f scripts/readonly/canary-orders-backstop.sql
\set ON_ERROR_STOP 1
BEGIN TRANSACTION READ ONLY;

\echo '== (0+e) messages: source, topic, order gid, shop match'
WITH _msgs AS (
  SELECT m.msg_id, m.src, m.read_ct, m.message->>'topic' AS topic,
         m.message->>'resourceGid' AS order_gid, m.message->>'shop' AS shop_raw
  FROM (
    SELECT msg_id, 'archive' AS src, read_ct, message FROM pgmq.a_s6_sync
    UNION ALL
    SELECT msg_id, 'queue' AS src, read_ct, message FROM pgmq.q_s6_sync
  ) m
  WHERE m.msg_id = ANY (string_to_array(:'msg_ids', ',')::bigint[])
)
SELECT m.msg_id, m.src, m.read_ct, m.topic, m.order_gid,
       (s.id IS NOT NULL)                                   AS shop_domain_exact_match,
       EXISTS (SELECT 1 FROM "Shop" s2
               WHERE lower(btrim(s2.domain)) = lower(btrim(m.shop_raw))) AS shop_domain_normalized_match
FROM _msgs m
LEFT JOIN "Shop" s ON s.domain = m.shop_raw
ORDER BY m.msg_id, m.src;

\echo '== (a) backstop_processed_orders rows'
WITH _msgs AS (
  SELECT m.msg_id, m.src, m.read_ct, m.message->>'topic' AS topic,
         m.message->>'resourceGid' AS order_gid, m.message->>'shop' AS shop_raw
  FROM (
    SELECT msg_id, 'archive' AS src, read_ct, message FROM pgmq.a_s6_sync
    UNION ALL
    SELECT msg_id, 'queue' AS src, read_ct, message FROM pgmq.q_s6_sync
  ) m
  WHERE m.msg_id = ANY (string_to_array(:'msg_ids', ',')::bigint[])
)
SELECT m.msg_id, b.order_gid, b.action,
       CASE b.reason
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
         ELSE CASE WHEN b.reason IS NULL THEN NULL ELSE '<other>' END
       END AS reason_code, b.processed_at
FROM _msgs m
JOIN backstop_processed_orders b ON b.order_gid = m.order_gid
ORDER BY m.msg_id, b.processed_at;

\echo '== (b) AuditEvent backstop.* rows'
WITH _msgs AS (
  SELECT m.msg_id, m.src, m.read_ct, m.message->>'topic' AS topic,
         m.message->>'resourceGid' AS order_gid, m.message->>'shop' AS shop_raw
  FROM (
    SELECT msg_id, 'archive' AS src, read_ct, message FROM pgmq.a_s6_sync
    UNION ALL
    SELECT msg_id, 'queue' AS src, read_ct, message FROM pgmq.q_s6_sync
  ) m
  WHERE m.msg_id = ANY (string_to_array(:'msg_ids', ',')::bigint[])
)
SELECT m.msg_id, a.type, a.at
FROM _msgs m
JOIN "AuditEvent" a ON a.type LIKE 'backstop.%' AND a.data->>'orderGid' = m.order_gid
ORDER BY m.msg_id, a.at;

\echo '== (c+d) invoice and buyer account hold state'
WITH _msgs AS (
  SELECT m.msg_id, m.src, m.read_ct, m.message->>'topic' AS topic,
         m.message->>'resourceGid' AS order_gid, m.message->>'shop' AS shop_raw
  FROM (
    SELECT msg_id, 'archive' AS src, read_ct, message FROM pgmq.a_s6_sync
    UNION ALL
    SELECT msg_id, 'queue' AS src, read_ct, message FROM pgmq.q_s6_sync
  ) m
  WHERE m.msg_id = ANY (string_to_array(:'msg_ids', ',')::bigint[])
)
SELECT m.msg_id,
       (i.id IS NOT NULL)              AS invoice_exists,
       i.id                            AS invoice_id,
       (i."buyerAccountId" IS NOT NULL) AS has_buyer_account,
       i."buyerAccountId"              AS buyer_account_id,
       ba."holdState"::text            AS hold_state,
       ba."manualHold"                 AS manual_hold,
       ba.bypass                       AS bypass,
       CASE WHEN ba."holdReasonCode" ~ '^[A-Z0-9_]{1,40}$' THEN ba."holdReasonCode" WHEN ba."holdReasonCode" IS NULL THEN NULL ELSE '<other>' END AS hold_reason_code
FROM _msgs m
LEFT JOIN "Invoice" i ON i."orderId" = m.order_gid
LEFT JOIN "BuyerAccount" ba ON ba.id = i."buyerAccountId"
ORDER BY m.msg_id;

ROLLBACK;
