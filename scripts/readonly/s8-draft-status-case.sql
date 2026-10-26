-- s8-draft-status-case.sql (READ-ONLY)
-- Sizing for a possible backfill of s8_draft_orders.status casing. mapDraftOrder may
-- store Shopify's UPPERCASE DraftOrderStatus (e.g. OPEN), while the pending-exposure
-- SQL filters on lowercase values. Aggregated across all shops (no shop ids):
--   1. rows whose status is not lowercase (status <> lower(status)), grouped by status
--   2. rows whose status is already lowercase, grouped by status (context)
--   3. total row count of s8_draft_orders
-- Statuses are printed only when they match a fixed-code regex; anything else is
-- mapped to 'OTHER' / 'other'. Counts and enums only. No names, totals or ids.
-- Vars: none.
-- Output column kinds: all derived (COUNT, guarded CASE enums), no @col entries needed
-- (scripts/ci/check-readonly-columns.ts, see scripts/readonly/README.md).
\set ON_ERROR_STOP 1
BEGIN TRANSACTION READ ONLY;

\echo '== s8_draft_orders: non-lowercase status (status <> lower(status))'
SELECT CASE WHEN d.status ~ '^[A-Z_]{1,40}$' THEN d.status ELSE 'OTHER' END AS status,
       COUNT(*) AS draft_orders
FROM s8_draft_orders d
WHERE d.status <> lower(d.status)
GROUP BY 1
ORDER BY 1;

\echo '== s8_draft_orders: lowercase status (context)'
SELECT CASE WHEN d.status ~ '^[a-z_]{1,40}$' THEN d.status ELSE 'other' END AS status,
       COUNT(*) AS draft_orders
FROM s8_draft_orders d
WHERE d.status = lower(d.status)
GROUP BY 1
ORDER BY 1;

\echo '== s8_draft_orders: totals'
SELECT COUNT(*) AS total_rows,
       COUNT(*) FILTER (WHERE d.status <> lower(d.status)) AS non_lowercase_rows
FROM s8_draft_orders d;

ROLLBACK;
