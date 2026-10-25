-- s8-draft-orders-exposure.sql (READ-ONLY)
-- Counts-only view of S8 draft orders and the pending draft exposure they add to
-- credit status. SELECT only, inside a READ ONLY transaction. Prints only counts,
-- enums and booleans: no ids, names, domains or money amounts (total / creditLimit
-- appear only inside comparisons).
-- "terms_open" mirrors computeExposure() (credit-status.server.ts) and backstop:
--   has_payment_terms = true AND status IN ('open','invoice_sent').
-- "terms_not_completed" mirrors getPendingExposure() (draft-order.server.ts):
--   has_payment_terms = true AND status <> 'completed'.
-- Whether Shopify still has a draft needs the Admin API and is NOT checked here.
-- @col status, "holdState", topic: enum
-- @col has_payment_terms: boolean
\set ON_ERROR_STOP 1
BEGIN TRANSACTION READ ONLY;

\echo '== D1 s8_draft_orders rows by status / has_payment_terms / buyer link'
SELECT d.status,
       d.has_payment_terms,
       d.buyer_account_id IS NOT NULL AS buyer_linked,
       ba.id IS NOT NULL AS buyer_exists,
       COUNT(*) AS n,
       COUNT(*) FILTER (WHERE d.total > 0) AS n_nonzero
FROM s8_draft_orders d
LEFT JOIN "BuyerAccount" ba ON ba.id = d.buyer_account_id
GROUP BY 1, 2, 3, 4
ORDER BY 1, 2, 3, 4;

\echo '== D2 s8_draft_orders total rows'
SELECT COUNT(*) AS n FROM s8_draft_orders;

\echo '== D3 buyer accounts with nonzero pending draft exposure, by holdState'
WITH acct AS (
  SELECT d.buyer_account_id,
         bool_or(d.total > 0 AND d.status IN ('open', 'invoice_sent')) AS terms_open,
         bool_or(d.total > 0 AND d.status <> 'completed') AS terms_not_completed
  FROM s8_draft_orders d
  WHERE d.has_payment_terms = true AND d.buyer_account_id IS NOT NULL
  GROUP BY d.buyer_account_id
)
SELECT ba."holdState",
       COUNT(*) FILTER (WHERE a.terms_open) AS accounts_terms_open,
       COUNT(*) FILTER (WHERE a.terms_not_completed) AS accounts_terms_not_completed
FROM acct a
JOIN "BuyerAccount" ba ON ba.id = a.buyer_account_id
GROUP BY 1
ORDER BY 1;

\echo '== D4 DRAFT_ORDERS_* rows in edge receipts and drain dedupe (all time retained)'
SELECT 'webhook_receipts' AS source, topic, COUNT(*) AS n
FROM webhook_receipts WHERE topic LIKE 'DRAFT\_ORDERS\_%' GROUP BY 2
UNION ALL
SELECT 's6_processed_webhooks' AS source, topic, COUNT(*) AS n
FROM s6_processed_webhooks WHERE topic LIKE 'DRAFT\_ORDERS\_%' GROUP BY 2
ORDER BY 1, 2;

COMMIT;
