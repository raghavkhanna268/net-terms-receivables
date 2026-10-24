-- redriven-webhook-receipts.sql (READ-ONLY)
-- (CTEs only: read-only transactions forbid CREATE, even TEMP views.)
-- For the given s6_sync msg_ids (archive or live queue), takes message->>'webhookId'
-- (BaseMessage.webhookId in app/lib/pgmq.server.ts) and message->>'shop', and counts
-- webhook_receipts rows (PK shop, webhook_id) relative to the baseline :'since'.
-- Counts only: no ids, no payloads, no domains.
-- Usage: psql -v ON_ERROR_STOP=1 -v msg_ids='240,241' -v since='2026-10-24T08:29:23Z' \
--        -f scripts/readonly/redriven-webhook-receipts.sql
\set ON_ERROR_STOP 1
BEGIN TRANSACTION READ ONLY;

\echo '== messages found for msg_ids (by source/topic)'
WITH _msgs AS (
  SELECT msg_id, 'archive' AS src, message FROM pgmq.a_s6_sync
  WHERE msg_id = ANY (string_to_array(:'msg_ids', ',')::bigint[])
  UNION ALL
  SELECT msg_id, 'queue' AS src, message FROM pgmq.q_s6_sync
  WHERE msg_id = ANY (string_to_array(:'msg_ids', ',')::bigint[])
)
SELECT src, message->>'topic' AS topic,
       COUNT(*)                                            AS messages,
       COUNT(DISTINCT (message->>'shop', message->>'webhookId')) AS distinct_webhook_ids,
       COUNT(*) FILTER (WHERE COALESCE(message->>'webhookId', '') = '') AS missing_webhook_id
FROM _msgs
GROUP BY 1, 2
ORDER BY 1, 2;

\echo '== webhook_receipts for those webhookIds (ORDERS_UPDATED messages, distinct shop+webhookId)'
WITH _msgs AS (
  SELECT message FROM pgmq.a_s6_sync
  WHERE msg_id = ANY (string_to_array(:'msg_ids', ',')::bigint[])
  UNION ALL
  SELECT message FROM pgmq.q_s6_sync
  WHERE msg_id = ANY (string_to_array(:'msg_ids', ',')::bigint[])
),
_ids AS (
  SELECT DISTINCT message->>'shop' AS shop, message->>'webhookId' AS webhook_id
  FROM _msgs
  WHERE message->>'topic' = 'ORDERS_UPDATED'
    AND COALESCE(message->>'webhookId', '') <> ''
),
_j AS (
  SELECT i.shop, i.webhook_id, r.topic, r.received_at
  FROM _ids i
  LEFT JOIN webhook_receipts r ON r.shop = i.shop AND r.webhook_id = i.webhook_id
)
SELECT
  COUNT(*)                                                                  AS distinct_webhook_ids,
  COUNT(*) FILTER (WHERE topic = 'ORDERS_UPDATED' AND received_at <  :'since'::timestamptz) AS receipts_before_baseline,
  COUNT(*) FILTER (WHERE topic = 'ORDERS_UPDATED' AND received_at >= :'since'::timestamptz) AS receipts_on_or_after_baseline,
  COUNT(*) FILTER (WHERE topic IS NOT NULL AND topic <> 'ORDERS_UPDATED')   AS receipts_other_topic,
  COUNT(*) FILTER (WHERE topic IS NULL)                                     AS missing_receipt,
  (SELECT COUNT(*) FROM webhook_receipts WHERE topic = 'ORDERS_UPDATED')    AS orders_updated_receipts_total,
  (SELECT MIN(received_at) FROM webhook_receipts)                           AS oldest_receipt_at
FROM _j;

\echo '== ORDERS_UPDATED messages: receipts vs drain idempotency (s6_processed_webhooks, PK webhook_id)'
WITH _msgs AS (
  SELECT message FROM pgmq.a_s6_sync
  WHERE msg_id = ANY (string_to_array(:'msg_ids', ',')::bigint[])
  UNION ALL
  SELECT message FROM pgmq.q_s6_sync
  WHERE msg_id = ANY (string_to_array(:'msg_ids', ',')::bigint[])
),
_ou AS (
  SELECT message->>'shop' AS shop, message->>'webhookId' AS webhook_id
  FROM _msgs WHERE message->>'topic' = 'ORDERS_UPDATED'
)
SELECT
  (SELECT COUNT(*) FROM _ou)                                   AS messages,
  (SELECT COUNT(DISTINCT webhook_id) FROM _ou)                 AS distinct_webhook_ids,
  (SELECT COUNT(DISTINCT o.webhook_id) FROM _ou o
     WHERE EXISTS (SELECT 1 FROM webhook_receipts r
                   WHERE r.shop = o.shop AND r.webhook_id = o.webhook_id)) AS with_webhook_receipt,
  (SELECT COUNT(DISTINCT o.webhook_id) FROM _ou o
     WHERE EXISTS (SELECT 1 FROM s6_processed_webhooks p
                   WHERE p.webhook_id = o.webhook_id))         AS with_s6_processed_row;

ROLLBACK;
