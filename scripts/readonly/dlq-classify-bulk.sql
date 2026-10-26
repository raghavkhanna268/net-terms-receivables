-- dlq-classify-bulk.sql (READ-ONLY)
-- Classifies the two s6_bulk / BULK_OPERATIONS_FINISH dead-letter rows,
-- original_msg_id 14 and 15 (fixed literals). Codes, enums, booleans, counts
-- and timestamps only: no error text, payload values, shop domains or bulk
-- operation ids. Vars: none.
--
-- error codes print as literals only (post-drain-aggregates.sql convention):
--   '<non_code>'   error is NULL or does not match the mandatory-prefix pattern
--                  ^(permanent|non_retryable):[a-z][a-z0-9_]{0,63}$
--   '<prefix>:<code>'  pattern matched and <code> is on the list below
--   '<other_code>' pattern matched but <code> is not listed
-- Code list, from origin/main a42a3cf:
--   app/services/sync/bulk-jsonl-processor.server.ts BULK_ERROR_CODES (the
--     codes processBulkOperation returns; processor writes permanent:<code>)
--     and AUTH_ERROR_CODES (invalid_grant, no_refresh_token, no_session)
--   app/lib/log.server.ts toErrorCode fixed returns (bulk fallback/catch path)
--   app/services/drain/processor.server.ts processBulkQueue: permanent:no_handler
--   app/services/drain/dead-letter-sanitize.server.ts: permanent:shop_not_found
-- error_len_class maps length(error) to fixed buckets; the length itself is not printed.
-- origin is a closed enum (CHECK in 20261024040000_s10b_bulk_origin_stage);
-- anything else prints as 'other'.
-- Output column kinds (scripts/ci/check-readonly-columns.ts, scripts/readonly/README.md):
-- @col dlq_at_ist, enqueue_to_dlq, day_ist: timestamp
-- @col failure_count: count
\set ON_ERROR_STOP 1
BEGIN TRANSACTION READ ONLY;

\echo '== Q1 s6_bulk DLQ msg 14,15 (code, length bucket, times, payload kinds)'
SELECT d.original_msg_id,
  CASE WHEN d.error IS NULL OR NOT (d.error ~ '^(permanent|non_retryable):[a-z][a-z0-9_]{0,63}$') THEN '<non_code>'
       WHEN d.error = 'permanent:bulk_no_result_url' THEN 'permanent:bulk_no_result_url'
       WHEN d.error = 'permanent:bulk_max_failures' THEN 'permanent:bulk_max_failures'
       WHEN d.error = 'permanent:bulk_chunk_http_4xx' THEN 'permanent:bulk_chunk_http_4xx'
       WHEN d.error = 'permanent:bulk_processing_error' THEN 'permanent:bulk_processing_error'
       WHEN d.error = 'permanent:bulk_lease_contention' THEN 'permanent:bulk_lease_contention'
       WHEN d.error = 'permanent:bulk_stale_recovery' THEN 'permanent:bulk_stale_recovery'
       WHEN d.error = 'permanent:bulk_auth_needs_reauth' THEN 'permanent:bulk_auth_needs_reauth'
       WHEN d.error = 'permanent:bulk_status_fetch_failed' THEN 'permanent:bulk_status_fetch_failed'
       WHEN d.error = 'permanent:bulk_op_disappeared' THEN 'permanent:bulk_op_disappeared'
       WHEN d.error = 'permanent:bulk_op_not_found' THEN 'permanent:bulk_op_not_found'
       WHEN d.error = 'permanent:unknown' THEN 'permanent:unknown'
       WHEN d.error = 'permanent:connection_refused' THEN 'permanent:connection_refused'
       WHEN d.error = 'permanent:timeout' THEN 'permanent:timeout'
       WHEN d.error = 'permanent:dns_error' THEN 'permanent:dns_error'
       WHEN d.error = 'permanent:fetch_error' THEN 'permanent:fetch_error'
       WHEN d.error = 'permanent:invalid_grant' THEN 'permanent:invalid_grant'
       WHEN d.error = 'permanent:access_denied' THEN 'permanent:access_denied'
       WHEN d.error = 'permanent:throttled' THEN 'permanent:throttled'
       WHEN d.error = 'permanent:rate_limited' THEN 'permanent:rate_limited'
       WHEN d.error = 'permanent:pg_unique_violation' THEN 'permanent:pg_unique_violation'
       WHEN d.error = 'permanent:pg_foreign_key_violation' THEN 'permanent:pg_foreign_key_violation'
       WHEN d.error = 'permanent:pg_connection_error' THEN 'permanent:pg_connection_error'
       WHEN d.error = 'permanent:queue_error' THEN 'permanent:queue_error'
       WHEN d.error = 'permanent:error' THEN 'permanent:error'
       WHEN d.error = 'permanent:string_error' THEN 'permanent:string_error'
       WHEN d.error = 'permanent:no_handler' THEN 'permanent:no_handler'
       WHEN d.error = 'permanent:shop_not_found' THEN 'permanent:shop_not_found'
       WHEN d.error = 'permanent:no_refresh_token' THEN 'permanent:no_refresh_token'
       WHEN d.error = 'permanent:no_session' THEN 'permanent:no_session'
       WHEN d.error = 'non_retryable:bulk_no_result_url' THEN 'non_retryable:bulk_no_result_url'
       WHEN d.error = 'non_retryable:bulk_max_failures' THEN 'non_retryable:bulk_max_failures'
       WHEN d.error = 'non_retryable:bulk_chunk_http_4xx' THEN 'non_retryable:bulk_chunk_http_4xx'
       WHEN d.error = 'non_retryable:bulk_processing_error' THEN 'non_retryable:bulk_processing_error'
       WHEN d.error = 'non_retryable:bulk_lease_contention' THEN 'non_retryable:bulk_lease_contention'
       WHEN d.error = 'non_retryable:bulk_stale_recovery' THEN 'non_retryable:bulk_stale_recovery'
       WHEN d.error = 'non_retryable:bulk_auth_needs_reauth' THEN 'non_retryable:bulk_auth_needs_reauth'
       WHEN d.error = 'non_retryable:bulk_status_fetch_failed' THEN 'non_retryable:bulk_status_fetch_failed'
       WHEN d.error = 'non_retryable:bulk_op_disappeared' THEN 'non_retryable:bulk_op_disappeared'
       WHEN d.error = 'non_retryable:bulk_op_not_found' THEN 'non_retryable:bulk_op_not_found'
       WHEN d.error = 'non_retryable:unknown' THEN 'non_retryable:unknown'
       WHEN d.error = 'non_retryable:connection_refused' THEN 'non_retryable:connection_refused'
       WHEN d.error = 'non_retryable:timeout' THEN 'non_retryable:timeout'
       WHEN d.error = 'non_retryable:dns_error' THEN 'non_retryable:dns_error'
       WHEN d.error = 'non_retryable:fetch_error' THEN 'non_retryable:fetch_error'
       WHEN d.error = 'non_retryable:invalid_grant' THEN 'non_retryable:invalid_grant'
       WHEN d.error = 'non_retryable:access_denied' THEN 'non_retryable:access_denied'
       WHEN d.error = 'non_retryable:throttled' THEN 'non_retryable:throttled'
       WHEN d.error = 'non_retryable:rate_limited' THEN 'non_retryable:rate_limited'
       WHEN d.error = 'non_retryable:pg_unique_violation' THEN 'non_retryable:pg_unique_violation'
       WHEN d.error = 'non_retryable:pg_foreign_key_violation' THEN 'non_retryable:pg_foreign_key_violation'
       WHEN d.error = 'non_retryable:pg_connection_error' THEN 'non_retryable:pg_connection_error'
       WHEN d.error = 'non_retryable:queue_error' THEN 'non_retryable:queue_error'
       WHEN d.error = 'non_retryable:error' THEN 'non_retryable:error'
       WHEN d.error = 'non_retryable:string_error' THEN 'non_retryable:string_error'
       WHEN d.error = 'non_retryable:no_handler' THEN 'non_retryable:no_handler'
       WHEN d.error = 'non_retryable:shop_not_found' THEN 'non_retryable:shop_not_found'
       WHEN d.error = 'non_retryable:no_refresh_token' THEN 'non_retryable:no_refresh_token'
       WHEN d.error = 'non_retryable:no_session' THEN 'non_retryable:no_session'
       ELSE '<other_code>' END AS error_code,
  CASE WHEN d.error IS NULL THEN NULL
       WHEN length(d.error) = 0 THEN '0'
       WHEN length(d.error) <= 32 THEN '1-32'
       WHEN length(d.error) <= 64 THEN '33-64'
       WHEN length(d.error) <= 128 THEN '65-128'
       ELSE '>128' END AS error_len_class,
  d.dead_lettered_at AT TIME ZONE 'Asia/Kolkata' AS dlq_at_ist,
  CASE WHEN d.message->>'bulkType' IN ('companies','customers','orders') THEN d.message->>'bulkType' ELSE 'other' END AS bulk_type,
  COALESCE(d.message->>'sanitized' = 'true', false) AS sanitized,
  CASE WHEN d.message->>'webhookId' LIKE 'recovery:%' THEN 'recovery'
       WHEN d.message->>'webhookId' ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-' THEN 'shopify_uuid'
       WHEN d.message->>'webhookId' IS NULL THEN 'missing' ELSE 'other' END AS webhook_id_kind,
  CASE WHEN d.message->>'enqueuedAt' ~ '^\d{4}-\d\d-\d\dT'
       THEN d.dead_lettered_at - (d.message->>'enqueuedAt')::timestamptz END AS enqueue_to_dlq
FROM s6_dead_letter d
WHERE d.original_queue = 's6_bulk' AND d.original_msg_id IN ('14','15') ORDER BY 1;

\echo '== Q2 shop/op state for msg 14,15 (booleans and counts only)'
WITH dl AS (SELECT original_msg_id, message->>'shop' AS shop, message->>'bulkOperationId' AS op_id
  FROM s6_dead_letter WHERE original_queue = 's6_bulk' AND original_msg_id IN ('14','15'))
SELECT dl.original_msg_id, s.id IS NOT NULL AS shop_row_exists,
  bo.bulk_operation_id IS NOT NULL AS op_row_exists, CASE WHEN bo.origin IN ('reconcile','webhook','manual') THEN bo.origin WHEN bo.origin IS NULL THEN NULL ELSE 'other' END AS origin, bo.completed_at IS NOT NULL AS op_completed,
  bo.closed_at IS NOT NULL AS op_closed, bo.failure_count,
  (SELECT count(*) FROM s6_dead_letter x WHERE x.message->>'bulkOperationId' = dl.op_id) AS dlq_rows_same_op
FROM dl LEFT JOIN "Shop" s ON s.domain = dl.shop
LEFT JOIN s6_bulk_operations bo ON bo.bulk_operation_id = dl.op_id ORDER BY 1;

\echo '== Q3 msg 14,15: distinct shops / bulk ops (counts)'
SELECT count(DISTINCT message->>'shop') AS distinct_shops, count(DISTINCT message->>'bulkOperationId') AS distinct_ops
FROM s6_dead_letter WHERE original_queue = 's6_bulk' AND original_msg_id IN ('14','15');

\echo '== Q4 s6_bulk DLQ recurrence, last 14 days (IST day, code, count)'
SELECT (dead_lettered_at AT TIME ZONE 'Asia/Kolkata')::date AS day_ist,
  CASE WHEN error IS NULL OR NOT (error ~ '^(permanent|non_retryable):[a-z][a-z0-9_]{0,63}$') THEN '<non_code>'
       WHEN error = 'permanent:bulk_no_result_url' THEN 'permanent:bulk_no_result_url'
       WHEN error = 'permanent:bulk_max_failures' THEN 'permanent:bulk_max_failures'
       WHEN error = 'permanent:bulk_chunk_http_4xx' THEN 'permanent:bulk_chunk_http_4xx'
       WHEN error = 'permanent:bulk_processing_error' THEN 'permanent:bulk_processing_error'
       WHEN error = 'permanent:bulk_lease_contention' THEN 'permanent:bulk_lease_contention'
       WHEN error = 'permanent:bulk_stale_recovery' THEN 'permanent:bulk_stale_recovery'
       WHEN error = 'permanent:bulk_auth_needs_reauth' THEN 'permanent:bulk_auth_needs_reauth'
       WHEN error = 'permanent:bulk_status_fetch_failed' THEN 'permanent:bulk_status_fetch_failed'
       WHEN error = 'permanent:bulk_op_disappeared' THEN 'permanent:bulk_op_disappeared'
       WHEN error = 'permanent:bulk_op_not_found' THEN 'permanent:bulk_op_not_found'
       WHEN error = 'permanent:unknown' THEN 'permanent:unknown'
       WHEN error = 'permanent:connection_refused' THEN 'permanent:connection_refused'
       WHEN error = 'permanent:timeout' THEN 'permanent:timeout'
       WHEN error = 'permanent:dns_error' THEN 'permanent:dns_error'
       WHEN error = 'permanent:fetch_error' THEN 'permanent:fetch_error'
       WHEN error = 'permanent:invalid_grant' THEN 'permanent:invalid_grant'
       WHEN error = 'permanent:access_denied' THEN 'permanent:access_denied'
       WHEN error = 'permanent:throttled' THEN 'permanent:throttled'
       WHEN error = 'permanent:rate_limited' THEN 'permanent:rate_limited'
       WHEN error = 'permanent:pg_unique_violation' THEN 'permanent:pg_unique_violation'
       WHEN error = 'permanent:pg_foreign_key_violation' THEN 'permanent:pg_foreign_key_violation'
       WHEN error = 'permanent:pg_connection_error' THEN 'permanent:pg_connection_error'
       WHEN error = 'permanent:queue_error' THEN 'permanent:queue_error'
       WHEN error = 'permanent:error' THEN 'permanent:error'
       WHEN error = 'permanent:string_error' THEN 'permanent:string_error'
       WHEN error = 'permanent:no_handler' THEN 'permanent:no_handler'
       WHEN error = 'permanent:shop_not_found' THEN 'permanent:shop_not_found'
       WHEN error = 'permanent:no_refresh_token' THEN 'permanent:no_refresh_token'
       WHEN error = 'permanent:no_session' THEN 'permanent:no_session'
       WHEN error = 'non_retryable:bulk_no_result_url' THEN 'non_retryable:bulk_no_result_url'
       WHEN error = 'non_retryable:bulk_max_failures' THEN 'non_retryable:bulk_max_failures'
       WHEN error = 'non_retryable:bulk_chunk_http_4xx' THEN 'non_retryable:bulk_chunk_http_4xx'
       WHEN error = 'non_retryable:bulk_processing_error' THEN 'non_retryable:bulk_processing_error'
       WHEN error = 'non_retryable:bulk_lease_contention' THEN 'non_retryable:bulk_lease_contention'
       WHEN error = 'non_retryable:bulk_stale_recovery' THEN 'non_retryable:bulk_stale_recovery'
       WHEN error = 'non_retryable:bulk_auth_needs_reauth' THEN 'non_retryable:bulk_auth_needs_reauth'
       WHEN error = 'non_retryable:bulk_status_fetch_failed' THEN 'non_retryable:bulk_status_fetch_failed'
       WHEN error = 'non_retryable:bulk_op_disappeared' THEN 'non_retryable:bulk_op_disappeared'
       WHEN error = 'non_retryable:bulk_op_not_found' THEN 'non_retryable:bulk_op_not_found'
       WHEN error = 'non_retryable:unknown' THEN 'non_retryable:unknown'
       WHEN error = 'non_retryable:connection_refused' THEN 'non_retryable:connection_refused'
       WHEN error = 'non_retryable:timeout' THEN 'non_retryable:timeout'
       WHEN error = 'non_retryable:dns_error' THEN 'non_retryable:dns_error'
       WHEN error = 'non_retryable:fetch_error' THEN 'non_retryable:fetch_error'
       WHEN error = 'non_retryable:invalid_grant' THEN 'non_retryable:invalid_grant'
       WHEN error = 'non_retryable:access_denied' THEN 'non_retryable:access_denied'
       WHEN error = 'non_retryable:throttled' THEN 'non_retryable:throttled'
       WHEN error = 'non_retryable:rate_limited' THEN 'non_retryable:rate_limited'
       WHEN error = 'non_retryable:pg_unique_violation' THEN 'non_retryable:pg_unique_violation'
       WHEN error = 'non_retryable:pg_foreign_key_violation' THEN 'non_retryable:pg_foreign_key_violation'
       WHEN error = 'non_retryable:pg_connection_error' THEN 'non_retryable:pg_connection_error'
       WHEN error = 'non_retryable:queue_error' THEN 'non_retryable:queue_error'
       WHEN error = 'non_retryable:error' THEN 'non_retryable:error'
       WHEN error = 'non_retryable:string_error' THEN 'non_retryable:string_error'
       WHEN error = 'non_retryable:no_handler' THEN 'non_retryable:no_handler'
       WHEN error = 'non_retryable:shop_not_found' THEN 'non_retryable:shop_not_found'
       WHEN error = 'non_retryable:no_refresh_token' THEN 'non_retryable:no_refresh_token'
       WHEN error = 'non_retryable:no_session' THEN 'non_retryable:no_session'
       ELSE '<other_code>' END AS code, count(*)
FROM s6_dead_letter WHERE original_queue = 's6_bulk' AND dead_lettered_at > now() - interval '14 days'
GROUP BY 1,2 ORDER BY 1,2;

ROLLBACK;
