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
SELECT m.msg_id, b.order_gid, b.action, b.reason, b.processed_at
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
       ba."holdReasonCode"             AS hold_reason_code
FROM _msgs m
LEFT JOIN "Invoice" i ON i."orderId" = m.order_gid
LEFT JOIN "BuyerAccount" ba ON ba.id = i."buyerAccountId"
ORDER BY m.msg_id;

ROLLBACK;
