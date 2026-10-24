-- hold-audit-s12.sql (READ-ONLY)
-- Developer's S12 hold questions (Q1-Q6). SELECT only, inside a READ ONLY transaction.
-- Prints only ids, enums, booleans, timestamps and counts. Never selects
-- name, holdNote, emails, domains, money amounts, payloads or free-text JSON fields.
-- Note: AuditEvent's timestamp column is "at" (no createdAt).
-- Var: since (ISO-8601 UTC, e.g. 2026-10-24T09:30:00Z)
-- Output column kinds for passthrough columns (scripts/ci/check-readonly-columns.ts,
-- see scripts/readonly/README.md). Derived counts/booleans/CASE enums need no entry.
-- @col holdState, type, status, proname: enum
-- @col manualHold, bypass, syncPending: boolean
-- @col syncVersion: count
-- @col gated_at_pos: id
\set ON_ERROR_STOP 1
BEGIN TRANSACTION READ ONLY;

\echo '== Q1 BuyerAccount count by holdState (all / seed fixtures / non-seed)'
SELECT "holdState", COUNT(*) AS total,
       COUNT(*) FILTER (WHERE id LIKE 'seed-account-%') AS seed_fixtures,
       COUNT(*) FILTER (WHERE id NOT LIKE 'seed-account-%') AS non_seed,
       COUNT(*) FILTER (WHERE "manualHold") AS manual_hold,
       COUNT(*) FILTER (WHERE bypass) AS bypass
FROM "BuyerAccount" GROUP BY 1 ORDER BY 1;

\echo '== Q1b holdReasonCode distribution (identifier-shaped codes only)'
SELECT "holdState",
       CASE WHEN "holdReasonCode" ~ '^[A-Z0-9_]{1,40}$' THEN "holdReasonCode"
            WHEN "holdReasonCode" IS NULL THEN NULL ELSE '<other>' END AS hold_reason_code,
       COUNT(*)
FROM "BuyerAccount" GROUP BY 1, 2 ORDER BY 1, 2;

\echo '== Q2 hold-related AuditEvent types since :since'
SELECT type, COUNT(*) AS n, MIN(at) AS min_at, MAX(at) AS max_at
FROM "AuditEvent"
WHERE at > (:'since')::timestamptz AND type ILIKE '%hold%'
GROUP BY 1 ORDER BY 1;

\echo '== Q2b all AuditEvent types since :since (context)'
SELECT type, COUNT(*) AS n, MIN(at) AS min_at, MAX(at) AS max_at
FROM "AuditEvent"
WHERE at > (:'since')::timestamptz
GROUP BY 1 ORDER BY 1;

\echo '== Q3 hold released/cleared audit events since :since (id/enum JSON fields only)'
WITH ev AS (
  SELECT e.id AS audit_event_id, e.type, e.at, e.actor,
         e.data->>'buyerAccountId' AS buyer_account_id,
         COALESCE(e.data->>'reasonCode', e.data->>'holdReasonCode', e.data->>'reason_code') AS reason_code_raw,
         e.data->>'source' AS source_raw
  FROM "AuditEvent" e
  WHERE e.at > (:'since')::timestamptz
    AND e.type ILIKE '%hold%'
    AND (e.type ILIKE '%releas%' OR e.type ILIKE '%clear%' OR e.type ILIKE '%lift%' OR e.type ILIKE '%remov%')
)
SELECT ev.audit_event_id, ev.type, ev.at,
       CASE WHEN ev.actor IN ('system','webhook') THEN ev.actor ELSE '<user>' END AS actor_kind,
       ev.buyer_account_id,
       CASE WHEN ev.reason_code_raw ~ '^[A-Za-z0-9_.:-]{1,40}$' THEN ev.reason_code_raw END AS reason_code,
       CASE WHEN ev.source_raw ~ '^[A-Za-z0-9_.:-]{1,40}$' THEN ev.source_raw END AS source,
       i.id AS invoice_id, i.status, (i.outstanding > 0) AS outstanding_gt_0, (i."dueAt" IS NULL) AS due_at_is_null,
       -- Invoice has no paidAt column; status='paid' + updatedAt is the closest signal
       CASE WHEN i.status = 'paid' THEN i."updatedAt" END AS paid_status_updated_at
FROM ev
LEFT JOIN "Invoice" i ON i."buyerAccountId" = ev.buyer_account_id
ORDER BY ev.at, ev.audit_event_id, i.id
LIMIT 500;

\echo '== Q3b non-seed accounts updated since :since (state now + invoices); hold transitions are not audited in app code'
SELECT ba.id AS buyer_account_id, ba."holdState", ba."manualHold", ba.bypass,
       CASE WHEN ba."holdReasonCode" ~ '^[A-Z0-9_]{1,40}$' THEN ba."holdReasonCode" END AS hold_reason_code,
       ba."syncPending", ba."syncVersion", ba."updatedAt",
       i.id AS invoice_id, i.status, (i.outstanding > 0) AS outstanding_gt_0, (i."dueAt" IS NULL) AS due_at_is_null,
       i."dueAt", CASE WHEN i.status = 'paid' THEN i."updatedAt" END AS paid_status_updated_at
FROM "BuyerAccount" ba
LEFT JOIN "Invoice" i ON i."buyerAccountId" = ba.id
WHERE ba."updatedAt" > (:'since')::timestamptz
ORDER BY ba."updatedAt", ba.id, i.id
LIMIT 500;

\echo '== Q4 CompanyLocations 24539398309 / 24544084133: account + open invoices outstanding > 0'
SELECT replace(ba."companyLocationId", 'gid://shopify/CompanyLocation/', '') AS company_location_id,
       ba.id AS buyer_account_id, ba."holdState", ba."manualHold", ba.bypass,
       ba."syncPending", ba."syncVersion", (ba.gated_at IS NOT NULL) AS gated,
       i.id AS invoice_id, i.status, (i.outstanding > 0) AS outstanding_gt_0, i."dueAt",
       NOW() - i."dueAt" AS past_due_by,
       (i."dueAt" < NOW() - INTERVAL '1 day') AS more_than_1_day_past_due
FROM "BuyerAccount" ba
LEFT JOIN "Invoice" i ON i."buyerAccountId" = ba.id AND i.status = 'open' AND i.outstanding > 0
WHERE ba."companyLocationId" IN ('gid://shopify/CompanyLocation/24539398309',
                                 'gid://shopify/CompanyLocation/24544084133')
ORDER BY 1, i."dueAt";

\echo '== Q5 enqueue_credit_status_recomputes: position of gated_at in prosrc (0 = #127 version)'
SELECT proname, position('gated_at' in prosrc) AS gated_at_pos
FROM pg_proc WHERE proname = 'enqueue_credit_status_recomputes';

\echo '== Q6 s6_sync live queue count and DLQ counts'
SELECT 'q_s6_sync' AS what, COUNT(*) AS n FROM pgmq.q_s6_sync
UNION ALL
SELECT 'dlq_total', COUNT(*) FROM s6_dead_letter
UNION ALL
SELECT 'dlq_s6_sync', COUNT(*) FROM s6_dead_letter WHERE original_queue = 's6_sync'
UNION ALL
SELECT 'dlq_since', COUNT(*) FROM s6_dead_letter WHERE dead_lettered_at > (:'since')::timestamptz;

ROLLBACK;
