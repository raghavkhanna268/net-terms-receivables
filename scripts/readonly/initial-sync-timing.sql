-- initial-sync-timing.sql (READ-ONLY)
-- Where does Initial Sync wall time go? Per-stage timings for one shop's latest
-- initial-sync run, pgmq queue wait (enqueued_at -> archived_at) by topic, the
-- s10_drain_every_minute pg_cron cadence and pg_net response counts.
-- Timestamps are printed as UTC ISO-8601 strings (to_char ... AT TIME ZONE 'UTC'),
-- intervals as whole seconds (*_sec) or milliseconds (*_ms). Counts, enums and
-- booleans otherwise. No domains, GIDs, ids, message bodies, command or
-- return/error text are printed.
--
-- Shop selection (never a workflow input domain): psql vars set by
-- prod-readonly-query.yml.
--   shop_idx : choice input, one of 1 | 2 | reviewer
--   e2e      : secrets.E2E_SHOP (validated, masked; never printed)
--   allowed  : secrets.ALLOWED_DEV_STORE (validated, masked; never printed)
-- 1 = the E2E_SHOP store, 2 = the ALLOWED_DEV_STORE store, reviewer = the single
-- installed shop ("uninstalledAt" IS NULL) that is neither of those two. Fails
-- closed: reviewer resolves only when exactly one such shop exists; otherwise
-- shop_resolved = false and the shop-scoped sections print no rows.
--
-- "Latest initial-sync run" = the shop's newest origin='reconcile',
-- reconcile_stage='companies', closed_at IS NULL op (same anchor as
-- getInitialSyncState in app/lib/initial-sync.server.ts) plus every reconcile op
-- started at or after it.
--
-- Columns (prisma/schema.prisma S6BulkOperation; migrations s6_pgmq_queues,
-- s10_drain_cron, s10b_bulk_origin_stage, s24_bulk_op_closed,
-- s25_bulk_op_exactly_once): started_at, finish_received_at, completed_at,
-- next_stage_enqueued_at, failure_count, reconcile_stage, origin, closed_at.
-- pgmq archive tables: enqueued_at, archived_at, read_ct. pg_cron:
-- cron.job_run_details(jobid, status, start_time, end_time), cron.job(jobname).
-- pg_net: net._http_response(status_code, timed_out, error_msg, created).
--
-- Output column kinds for passthrough columns (scripts/ci/check-readonly-columns.ts,
-- see scripts/readonly/README.md). Derived counts/booleans/CASE enums need no entry.
-- @col started_utc, finish_received_utc, completed_utc, next_stage_enqueued_utc, next_started_utc: timestamp
-- @col start_to_finish_webhook_sec, finish_webhook_to_completed_sec, completed_to_next_enqueued_sec, next_enqueued_to_next_start_sec, op_wall_sec: timestamp
-- @col failure_count: count
-- @col sync_enqueued_utc, run_started_utc, last_completed_utc, enqueue_to_first_start_sec, enqueue_to_last_completed_sec: timestamp
-- @col wait_p50_sec, wait_p95_sec, wait_max_sec: timestamp
-- @col first_start_utc, last_start_utc, gap_p50_sec, gap_max_sec, dur_p50_ms, dur_max_ms: timestamp
-- @col status_code: enum
-- @col timed_out: boolean
\set ON_ERROR_STOP 1
BEGIN TRANSACTION READ ONLY;

\echo '== shop selection (fails closed unless exactly one shop resolves)'
WITH cand AS (
  SELECT s.domain AS k
  FROM public."Shop" s
  WHERE s."uninstalledAt" IS NULL
    AND s.domain <> :'e2e'
    AND s.domain <> :'allowed'
),
target AS (
  SELECT s.domain AS k
  FROM public."Shop" s
  WHERE (:'shop_idx' = '1' AND s.domain = :'e2e')
     OR (:'shop_idx' = '2' AND s.domain = :'allowed')
     OR (:'shop_idx' = 'reviewer' AND s.domain IN (SELECT c.k FROM cand c)
         AND (SELECT COUNT(*) FROM cand) = 1)
)
SELECT CASE WHEN :'shop_idx' = '1' THEN '1'
            WHEN :'shop_idx' = '2' THEN '2'
            WHEN :'shop_idx' = 'reviewer' THEN 'reviewer'
            ELSE 'invalid' END AS selected,
       (SELECT COUNT(*) FROM cand) AS reviewer_candidates,
       (SELECT COUNT(*) FROM target) AS target_rows,
       (SELECT COUNT(*) FROM target) = 1 AS shop_resolved;

\echo '== 1. per-stage timings, latest initial-sync run of the selected shop (UTC, seconds)'
WITH cand AS (
  SELECT s.domain AS k
  FROM public."Shop" s
  WHERE s."uninstalledAt" IS NULL
    AND s.domain <> :'e2e'
    AND s.domain <> :'allowed'
),
target AS (
  SELECT s.domain AS k
  FROM public."Shop" s
  WHERE (:'shop_idx' = '1' AND s.domain = :'e2e')
     OR (:'shop_idx' = '2' AND s.domain = :'allowed')
     OR (:'shop_idx' = 'reviewer' AND s.domain IN (SELECT c.k FROM cand c)
         AND (SELECT COUNT(*) FROM cand) = 1)
),
one AS (
  SELECT t.k FROM target t WHERE (SELECT COUNT(*) FROM target) = 1
),
run AS (
  SELECT MAX(b.started_at) AS run_started_at
  FROM s6_bulk_operations b
  JOIN one o ON b.shop = o.k
  WHERE b.origin = 'reconcile'
    AND b.reconcile_stage = 'companies'
    AND b.closed_at IS NULL
),
ops AS (
  SELECT b.reconcile_stage AS stage_raw,
         b.started_at,
         b.finish_received_at,
         b.completed_at,
         b.next_stage_enqueued_at,
         b.failure_count,
         b.closed_at,
         LEAD(b.started_at) OVER (ORDER BY b.started_at, b.bulk_operation_id) AS next_started_at
  FROM s6_bulk_operations b
  JOIN one o ON b.shop = o.k
  CROSS JOIN run r
  WHERE b.origin = 'reconcile'
    AND b.started_at >= r.run_started_at
)
SELECT ROW_NUMBER() OVER (ORDER BY p.started_at, p.next_started_at) AS op_idx,
       CASE WHEN p.stage_raw = 'companies' THEN 'companies'
            WHEN p.stage_raw = 'customers' THEN 'customers'
            WHEN p.stage_raw = 'orders' THEN 'orders'
            WHEN p.stage_raw = 'draft_orders' THEN 'draft_orders'
            ELSE 'other' END AS stage,
       to_char(p.started_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS started_utc,
       to_char(p.finish_received_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS finish_received_utc,
       to_char(p.completed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS completed_utc,
       to_char(p.next_stage_enqueued_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS next_stage_enqueued_utc,
       to_char(p.next_started_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS next_started_utc,
       round(EXTRACT(EPOCH FROM (p.finish_received_at - p.started_at)))::int AS start_to_finish_webhook_sec,
       round(EXTRACT(EPOCH FROM (p.completed_at - p.finish_received_at)))::int AS finish_webhook_to_completed_sec,
       round(EXTRACT(EPOCH FROM (p.next_stage_enqueued_at - p.completed_at)))::int AS completed_to_next_enqueued_sec,
       round(EXTRACT(EPOCH FROM (p.next_started_at - p.next_stage_enqueued_at)))::int AS next_enqueued_to_next_start_sec,
       round(EXTRACT(EPOCH FROM (p.completed_at - p.started_at)))::int AS op_wall_sec,
       p.failure_count,
       p.closed_at IS NOT NULL AS closed
FROM ops p
ORDER BY op_idx;

\echo '== 1b. run summary: Start sync enqueue (RECONCILE_COMPANIES enqueued_at) to last stage completed (UTC, seconds)'
WITH cand AS (
  SELECT s.domain AS k
  FROM public."Shop" s
  WHERE s."uninstalledAt" IS NULL
    AND s.domain <> :'e2e'
    AND s.domain <> :'allowed'
),
target AS (
  SELECT s.domain AS k
  FROM public."Shop" s
  WHERE (:'shop_idx' = '1' AND s.domain = :'e2e')
     OR (:'shop_idx' = '2' AND s.domain = :'allowed')
     OR (:'shop_idx' = 'reviewer' AND s.domain IN (SELECT c.k FROM cand c)
         AND (SELECT COUNT(*) FROM cand) = 1)
),
one AS (
  SELECT t.k FROM target t WHERE (SELECT COUNT(*) FROM target) = 1
),
run AS (
  SELECT MAX(b.started_at) AS run_started_at
  FROM s6_bulk_operations b
  JOIN one o ON b.shop = o.k
  WHERE b.origin = 'reconcile'
    AND b.reconcile_stage = 'companies'
    AND b.closed_at IS NULL
),
enq AS (
  SELECT MAX(a.enqueued_at) AS sync_enqueued_at
  FROM pgmq.a_s6_sync a
  JOIN one o ON a.message->>'shop' = o.k
  CROSS JOIN run r
  WHERE a.message->>'topic' = 'RECONCILE_COMPANIES'
    AND a.enqueued_at <= r.run_started_at
    AND a.enqueued_at >= r.run_started_at - INTERVAL '1 hour'
),
agg AS (
  SELECT COUNT(*) AS ops,
         COUNT(*) FILTER (WHERE b.completed_at IS NOT NULL) AS ops_completed,
         COUNT(*) FILTER (WHERE b.failure_count > 0) AS ops_with_failures,
         MAX(b.completed_at) AS last_completed_at
  FROM s6_bulk_operations b
  JOIN one o ON b.shop = o.k
  CROSS JOIN run r
  WHERE b.origin = 'reconcile'
    AND b.started_at >= r.run_started_at
)
SELECT to_char(e.sync_enqueued_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS sync_enqueued_utc,
       to_char(r.run_started_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS run_started_utc,
       to_char(g.last_completed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS last_completed_utc,
       round(EXTRACT(EPOCH FROM (r.run_started_at - e.sync_enqueued_at)))::int AS enqueue_to_first_start_sec,
       round(EXTRACT(EPOCH FROM (g.last_completed_at - e.sync_enqueued_at)))::int AS enqueue_to_last_completed_sec,
       g.ops,
       g.ops_completed,
       g.ops_with_failures
FROM run r
CROSS JOIN enq e
CROSS JOIN agg g
WHERE r.run_started_at IS NOT NULL;

\echo '== 2a. queue wait for the selected shop since its latest run started (archived_at - enqueued_at, seconds)'
WITH cand AS (
  SELECT s.domain AS k
  FROM public."Shop" s
  WHERE s."uninstalledAt" IS NULL
    AND s.domain <> :'e2e'
    AND s.domain <> :'allowed'
),
target AS (
  SELECT s.domain AS k
  FROM public."Shop" s
  WHERE (:'shop_idx' = '1' AND s.domain = :'e2e')
     OR (:'shop_idx' = '2' AND s.domain = :'allowed')
     OR (:'shop_idx' = 'reviewer' AND s.domain IN (SELECT c.k FROM cand c)
         AND (SELECT COUNT(*) FROM cand) = 1)
),
one AS (
  SELECT t.k FROM target t WHERE (SELECT COUNT(*) FROM target) = 1
),
run AS (
  SELECT MAX(b.started_at) AS run_started_at
  FROM s6_bulk_operations b
  JOIN one o ON b.shop = o.k
  WHERE b.origin = 'reconcile'
    AND b.reconcile_stage = 'companies'
    AND b.closed_at IS NULL
),
arch AS (
  SELECT 's6_sync' AS q, a.message->>'topic' AS tp, a.read_ct AS rc,
         EXTRACT(EPOCH FROM (a.archived_at - a.enqueued_at)) AS w
  FROM pgmq.a_s6_sync a
  JOIN one o ON a.message->>'shop' = o.k
  CROSS JOIN run r
  WHERE a.enqueued_at >= r.run_started_at - INTERVAL '1 hour'
  UNION ALL
  SELECT 's6_bulk', a.message->>'topic', a.read_ct,
         EXTRACT(EPOCH FROM (a.archived_at - a.enqueued_at))
  FROM pgmq.a_s6_bulk a
  JOIN one o ON a.message->>'shop' = o.k
  CROSS JOIN run r
  WHERE a.enqueued_at >= r.run_started_at - INTERVAL '1 hour'
)
SELECT CASE WHEN x.q = 's6_sync' THEN 's6_sync' ELSE 's6_bulk' END AS queue,
       CASE WHEN x.tp = 'RECONCILE_COMPANIES' THEN 'RECONCILE_COMPANIES'
            WHEN x.tp = 'RECONCILE_CUSTOMERS' THEN 'RECONCILE_CUSTOMERS'
            WHEN x.tp = 'RECONCILE_ORDERS' THEN 'RECONCILE_ORDERS'
            WHEN x.tp = 'RECONCILE_DRAFT_ORDERS' THEN 'RECONCILE_DRAFT_ORDERS'
            WHEN x.tp = 'BULK_OPERATIONS_FINISH' THEN 'BULK_OPERATIONS_FINISH'
            ELSE 'other' END AS topic,
       COUNT(*) AS msgs,
       COUNT(*) FILTER (WHERE x.rc > 1) AS read_ct_gt1,
       round(percentile_cont(0.5) WITHIN GROUP (ORDER BY x.w))::int AS wait_p50_sec,
       round(percentile_cont(0.95) WITHIN GROUP (ORDER BY x.w))::int AS wait_p95_sec,
       round(max(x.w))::int AS wait_max_sec
FROM arch x
GROUP BY 1, 2
ORDER BY 1, 2;

\echo '== 2b. queue wait, all shops, last 24 hours (archived_at - enqueued_at, seconds)'
WITH arch AS (
  SELECT 's6_sync' AS q, a.message->>'topic' AS tp, a.read_ct AS rc,
         EXTRACT(EPOCH FROM (a.archived_at - a.enqueued_at)) AS w
  FROM pgmq.a_s6_sync a
  WHERE a.enqueued_at >= NOW() - INTERVAL '24 hours'
  UNION ALL
  SELECT 's6_bulk', a.message->>'topic', a.read_ct,
         EXTRACT(EPOCH FROM (a.archived_at - a.enqueued_at))
  FROM pgmq.a_s6_bulk a
  WHERE a.enqueued_at >= NOW() - INTERVAL '24 hours'
)
SELECT CASE WHEN x.q = 's6_sync' THEN 's6_sync' ELSE 's6_bulk' END AS queue,
       CASE WHEN x.tp = 'RECONCILE_COMPANIES' THEN 'RECONCILE_COMPANIES'
            WHEN x.tp = 'RECONCILE_CUSTOMERS' THEN 'RECONCILE_CUSTOMERS'
            WHEN x.tp = 'RECONCILE_ORDERS' THEN 'RECONCILE_ORDERS'
            WHEN x.tp = 'RECONCILE_DRAFT_ORDERS' THEN 'RECONCILE_DRAFT_ORDERS'
            WHEN x.tp = 'BULK_OPERATIONS_FINISH' THEN 'BULK_OPERATIONS_FINISH'
            ELSE 'other' END AS topic,
       COUNT(*) AS msgs,
       COUNT(*) FILTER (WHERE x.rc > 1) AS read_ct_gt1,
       round(percentile_cont(0.5) WITHIN GROUP (ORDER BY x.w))::int AS wait_p50_sec,
       round(percentile_cont(0.95) WITHIN GROUP (ORDER BY x.w))::int AS wait_p95_sec,
       round(max(x.w))::int AS wait_max_sec
FROM arch x
GROUP BY 1, 2
ORDER BY 1, 2;

\echo '== 3. pg_cron s10_drain_every_minute, last hour (status counts, start gaps, durations; no command or return text)'
WITH runs AS (
  SELECT CASE WHEN d.status = 'succeeded' THEN 'succeeded'
              WHEN d.status = 'failed' THEN 'failed'
              ELSE 'other' END AS st,
         d.start_time,
         EXTRACT(EPOCH FROM (d.start_time - LAG(d.start_time) OVER (ORDER BY d.start_time))) AS gap,
         EXTRACT(EPOCH FROM (d.end_time - d.start_time)) * 1000 AS dur
  FROM cron.job_run_details d
  JOIN cron.job j ON j.jobid = d.jobid
  WHERE j.jobname = 's10_drain_every_minute'
    AND d.start_time >= NOW() - INTERVAL '1 hour'
)
SELECT COUNT(*) AS runs,
       COUNT(*) FILTER (WHERE r.st = 'succeeded') AS succeeded,
       COUNT(*) FILTER (WHERE r.st = 'failed') AS failed,
       COUNT(*) FILTER (WHERE r.st = 'other') AS other_status,
       COUNT(*) FILTER (WHERE r.gap > 90) AS gaps_over_90s,
       to_char(min(r.start_time) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS first_start_utc,
       to_char(max(r.start_time) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS last_start_utc,
       round(percentile_cont(0.5) WITHIN GROUP (ORDER BY r.gap))::int AS gap_p50_sec,
       round(max(r.gap))::int AS gap_max_sec,
       round(percentile_cont(0.5) WITHIN GROUP (ORDER BY r.dur))::int AS dur_p50_ms,
       round(max(r.dur))::int AS dur_max_ms
FROM runs r;

\echo '== 4. pg_net responses, last hour (counts by status_code and timed_out; no content or error text)'
SELECT h.status_code,
       h.timed_out,
       COUNT(*) AS responses,
       COUNT(*) FILTER (WHERE h.error_msg IS NOT NULL) AS with_error
FROM net._http_response h
WHERE h.created >= NOW() - INTERVAL '1 hour'
GROUP BY h.status_code, h.timed_out
ORDER BY h.status_code, h.timed_out;

ROLLBACK;
