-- hold-audit-s12.sql (READ-ONLY)
-- Developer's S12 hold questions (Q1-Q6). SELECT only, inside a READ ONLY transaction.
-- Prints only enums, booleans, timestamps and counts. Never selects
-- name, holdNote, emails, domains, money amounts, payloads, free-text JSON fields,
-- or individual buyer/invoice/company IDs (QA 2 audit: aggregates only).
-- Note: AuditEvent's timestamp column is "at" (no createdAt).
-- Vars:
--   since (ISO-8601 UTC, e.g. 2026-10-24T09:30:00Z)
-- Q4's location set is derived inside the SQL from COMPANY_LOCATIONS_DELETE webhooks.
-- Output column kinds for passthrough columns (scripts/ci/check-readonly-columns.ts,
-- see scripts/readonly/README.md). Derived counts/booleans/CASE enums need no entry.
-- @col holdState, type, proname: enum
-- @col manualHold, bypass, syncPending: boolean
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

\echo '== Q3 hold released/cleared audit events since :since (aggregated by type and reason)'
-- QA 2 audit: individual event/buyer/invoice IDs removed; aggregated by type and reason.
WITH ev AS (
  SELECT e.type,
         CASE WHEN e.actor IN ('system','webhook') THEN e.actor ELSE '<user>' END AS actor_kind,
         COALESCE(e.data->>'reasonCode', e.data->>'holdReasonCode', e.data->>'reason_code') AS reason_code_unchecked,
         e.data->>'source' AS source_unchecked,
         e.data->>'buyerAccountId' AS buyer_account_id
  FROM "AuditEvent" e
  WHERE e.at > (:'since')::timestamptz
    AND e.type ILIKE '%hold%'
    AND (e.type ILIKE '%releas%' OR e.type ILIKE '%clear%' OR e.type ILIKE '%lift%' OR e.type ILIKE '%remov%')
)
SELECT ev.type, ev.actor_kind,
       CASE WHEN ev.reason_code_unchecked ~ '^[A-Za-z0-9_:-]{1,40}$' THEN ev.reason_code_unchecked END AS reason_code,
       CASE WHEN ev.source_unchecked ~ '^[A-Za-z0-9_:-]{1,40}$' THEN ev.source_unchecked END AS source,
       COUNT(*) AS event_count,
       COUNT(DISTINCT ev.buyer_account_id) AS distinct_accounts,
       COUNT(DISTINCT i.id) AS distinct_invoices,
       COUNT(*) FILTER (WHERE i.outstanding > 0) AS outstanding_gt_0_count,
       COUNT(*) FILTER (WHERE i."dueAt" IS NULL) AS due_at_is_null_count,
       COUNT(*) FILTER (WHERE i.status = 'paid') AS paid_count
FROM ev
LEFT JOIN "Invoice" i ON i."buyerAccountId" = ev.buyer_account_id
GROUP BY 1, 2, 3, 4
ORDER BY 1, 2, 3, 4;

\echo '== Q3b non-seed accounts updated since :since (aggregated by holdState); hold transitions are not audited in app code'
-- QA 2 audit: individual buyer_account_id and invoice_id removed; aggregated by holdState.
SELECT ba."holdState", ba."manualHold", ba.bypass,
       CASE WHEN ba."holdReasonCode" ~ '^[A-Z0-9_]{1,40}$' THEN ba."holdReasonCode" END AS hold_reason_code,
       ba."syncPending",
       COUNT(DISTINCT ba.id) AS account_count,
       COUNT(DISTINCT i.id) AS invoice_count,
       COUNT(*) FILTER (WHERE i.outstanding > 0) AS outstanding_gt_0_count,
       COUNT(*) FILTER (WHERE i."dueAt" IS NULL) AS due_at_is_null_count,
       COUNT(*) FILTER (WHERE i.status = 'paid') AS paid_count
FROM "BuyerAccount" ba
LEFT JOIN "Invoice" i ON i."buyerAccountId" = ba.id
WHERE ba."updatedAt" > (:'since')::timestamptz
GROUP BY 1, 2, 3, 4, 5
ORDER BY 1, 2, 3, 4, 5;

\echo '== Q4 Deleted CompanyLocations (from COMPANY_LOCATIONS_DELETE webhooks): aggregated account + invoice state'
-- QA 2 audit: Location set derived inside SQL from COMPANY_LOCATIONS_DELETE webhook records.
-- No psql variables or workflow dispatch inputs needed.
-- Output is aggregated by holdState; no individual IDs are printed.
WITH deleted_locations AS (
  SELECT DISTINCT
    CASE
      WHEN w.resource_gid LIKE 'gid://shopify/CompanyLocation/%' THEN w.resource_gid
      ELSE 'gid://shopify/CompanyLocation/' || w.resource_gid
    END AS company_location_gid
  FROM s6_processed_webhooks w
  WHERE w.topic = 'COMPANY_LOCATIONS_DELETE'
  UNION
  SELECT DISTINCT
    CASE
      WHEN wr.resource_gid LIKE 'gid://shopify/CompanyLocation/%' THEN wr.resource_gid
      ELSE 'gid://shopify/CompanyLocation/' || wr.resource_gid
    END AS company_location_gid
  FROM webhook_receipts wr
  WHERE wr.topic = 'COMPANY_LOCATIONS_DELETE'
)
SELECT ba."holdState", ba."manualHold", ba.bypass, ba."syncPending",
       (ba.gated_at IS NOT NULL) AS gated,
       COUNT(DISTINCT ba.id) AS account_count,
       COUNT(DISTINCT i.id) AS invoice_count,
       COUNT(*) FILTER (WHERE i.outstanding > 0) AS outstanding_gt_0_count,
       COUNT(*) FILTER (WHERE i."dueAt" < NOW() - INTERVAL '1 day') AS more_than_1_day_past_due_count
FROM deleted_locations dl
JOIN "BuyerAccount" ba ON ba."companyLocationId" = dl.company_location_gid
LEFT JOIN "Invoice" i ON i."buyerAccountId" = ba.id AND i.status = 'open' AND i.outstanding > 0
GROUP BY 1, 2, 3, 4, 5
ORDER BY 1, 2, 3, 4, 5;

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
