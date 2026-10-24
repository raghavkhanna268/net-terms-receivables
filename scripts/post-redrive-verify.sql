-- =============================================================================
-- post-redrive-verify.sql: DRAFT, not committed
-- Repo: raghavkhanna268/net-terms-receivables @ c11ed11 (main)
-- Purpose: read-only verification after DevOps phase 2
--          (ORDERS DLQ redrive -> reconcile companies+orders -> drains).
-- Covers S9 (invoice creation/eligibility), S7 (aging + SQL/TS parity),
--        S16 (matcher state invariants), S20 (webhook receipts, dedup, DLQ).
--
-- RULES (enforced by construction):
--   * SELECT-only, inside a READ ONLY transaction that is rolled back at the end.
--     Also run with PGOPTIONS="-c default_transaction_read_only=on" (same as #75).
--   * Every query is scoped to ONE shop (:'shop' domain -> :'shop_id').
--   * Output is counts / booleans / enum labels / day numbers only. Never selects
--     email, display_name, BuyerAccount.name, Invoice.name, Payment.payerText,
--     Payment.narration, PayerAlias.payerKey, s6_dead_letter.error text, or any
--     message body. (DPDP minimisation; PCD Level 1 + email/name, nothing echoed.)
--   * Seed company names appear ONLY in a WHERE clause to locate seeded rows.
--     They are synthetic business names from scripts/seed.ts, and they are never output.
--
-- USAGE
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -v shop="$SHOP_DOMAIN" \
--        [-v as_of='2026-10-25T12:00:00+05:30'] \
--        [-v redrive_started_at='2026-10-24T10:00:00Z'] \
--        -f scripts/post-redrive-verify.sql
--   as_of defaults to now(); redrive_started_at defaults to now() - 24h.
--   Requires psql >= 10 (\if / :{?var}).
--
-- Every result row has a check_id that matches docs/qa/post-redrive-verification.md.
-- A column named "pass" is a boolean when the expectation comes from code or seed.
-- When the expectation is a PLACEHOLDER, pass is NULL and you compare by hand.
-- =============================================================================

\set ON_ERROR_STOP on
\pset null '(null)'

\if :{?shop}
\else
  \echo 'ERROR: pass -v shop=<shop>.myshopify.com'
  \quit
\endif
\if :{?as_of}
\else
  SELECT now()::text AS as_of \gset
\endif
\if :{?redrive_started_at}
\else
  SELECT (now() - interval '24 hours')::text AS redrive_started_at \gset
\endif

BEGIN TRANSACTION READ ONLY;

-- Resolve shop (same pattern as the #75 "Invoices" step)
SELECT id AS shop_id, timezone AS shop_tz FROM "Shop" WHERE domain = :'shop' \gset
\if :{?shop_id}
\else
  \echo 'ERROR: shop not found'
  ROLLBACK;
  \quit
\endif

-- -----------------------------------------------------------------------------
-- P0 Preflight
-- -----------------------------------------------------------------------------
\echo '== P0-1 shop + timezone validity (TS validateTimezone falls back to Asia/Kolkata; SQL parity does NOT validate)'
SELECT 'P0-1' AS check_id,
       (s."uninstalledAt" IS NULL)                                     AS installed,
       EXISTS (SELECT 1 FROM pg_timezone_names WHERE name = s.timezone) AS tz_valid_in_pg,
       (s.timezone = 'Asia/Kolkata')                                    AS tz_is_kolkata,
       s."defaultTermsDays"                                             AS shop_default_terms_days,
       EXISTS (SELECT 1 FROM pg_timezone_names WHERE name = s.timezone) AS pass
FROM "Shop" s WHERE s.id = :'shop_id';

\echo '== P0-2 pending queue messages for this shop (expect 0 after drains, except held topics)'
SELECT 'P0-2' AS check_id, q.queue,
       CASE WHEN q.topic LIKE 'CUSTOMERS_%' OR q.topic LIKE 'DRAFT_ORDERS_%' THEN 'held' ELSE 'not_held' END AS topic_class,
       q.topic, count(*) AS pending,
       NULL::boolean AS pass  -- evaluated below
FROM (
  SELECT 's6_sync' AS queue, message->>'topic' AS topic FROM pgmq.q_s6_sync WHERE message->>'shop' = :'shop'
  UNION ALL
  SELECT 's6_bulk', message->>'topic' FROM pgmq.q_s6_bulk WHERE message->>'shop' = :'shop'
) q
GROUP BY 1,2,3,4 ORDER BY 2,3,4;

SELECT 'P0-2-summary' AS check_id,
       count(*) FILTER (WHERE topic NOT LIKE 'CUSTOMERS_%' AND topic NOT LIKE 'DRAFT_ORDERS_%') AS pending_not_held,
       count(*) FILTER (WHERE topic NOT LIKE 'CUSTOMERS_%' AND topic NOT LIKE 'DRAFT_ORDERS_%') = 0 AS pass
FROM (
  SELECT message->>'topic' AS topic FROM pgmq.q_s6_sync WHERE message->>'shop' = :'shop'
  UNION ALL
  SELECT message->>'topic' FROM pgmq.q_s6_bulk WHERE message->>'shop' = :'shop'
) q;

\echo '== P0-3 reconcile ran: companies then orders bulk ops completed after redrive start'
SELECT 'P0-3' AS check_id, b.reconcile_stage,
       count(*)                                                        AS ops_since_redrive,
       count(*) FILTER (WHERE b.completed_at IS NOT NULL)               AS completed,
       COALESCE(max(b.failure_count), 0)                                AS max_failure_count,
       bool_or(b.completed_at IS NOT NULL)                              AS pass
FROM s6_bulk_operations b
WHERE b.shop = :'shop' AND b.origin = 'reconcile'
  AND b.started_at >= :'redrive_started_at'::timestamptz
GROUP BY b.reconcile_stage ORDER BY b.reconcile_stage;

SELECT 'P0-3b' AS check_id,
       count(*) FILTER (WHERE webhook_id LIKE 'reconcile:' || :'shop' || ':%:companies') AS reconcile_companies_ids_processed,
       count(*) FILTER (WHERE webhook_id LIKE 'reconcile:' || :'shop' || ':%:orders')    AS reconcile_orders_ids_processed,
       count(*) FILTER (WHERE webhook_id = 'reconcile:' || :'shop' || ':' || to_char((:'as_of'::timestamptz AT TIME ZONE 'UTC')::date, 'YYYY-MM-DD') || ':orders') > 0
                                                                                        AS todays_orders_reconcile_processed
FROM s6_processed_webhooks
WHERE webhook_id LIKE 'reconcile:' || :'shop' || ':%'
  AND processed_at >= :'redrive_started_at'::timestamptz;

\echo '== P0-4 null refetches (order older than 60d without read_all_orders); informational'
SELECT 'P0-4' AS check_id, day, count AS null_refetches
FROM s10b_order_refetch_null
WHERE shop = :'shop' AND day >= (:'redrive_started_at'::timestamptz AT TIME ZONE 'UTC')::date - 1
ORDER BY day;

-- -----------------------------------------------------------------------------
-- S9 Invoice creation by eligibility path / dueBasis
-- -----------------------------------------------------------------------------
\echo '== S9-1 all invoices for shop by inferred eligibility path x dueSource x dueBasis x status'
SELECT 'S9-1' AS check_id,
       CASE
         WHEN i."dueSource"::text = 'schedule'                                         THEN 'a_shopify_payment_terms'
         WHEN ba.kind::text = 'COMPANY'          AND i."dueBasis" = 'accountDefault'   THEN 'b_company_explicit_terms'
         WHEN ba.kind::text = 'TAGGED_CUSTOMER'                                         THEN 'c_tagged_customer'
         ELSE 'other'
       END AS inferred_path,
       ba.kind::text AS account_kind, i."dueSource"::text AS due_source,
       COALESCE(i."dueBasis", '(null)') AS due_basis, i.status::text AS status,
       count(*) AS invoices
FROM "Invoice" i JOIN "BuyerAccount" ba ON ba.id = i."buyerAccountId"
WHERE i."shopId" = :'shop_id'
GROUP BY 2,3,4,5,6 ORDER BY 2,3,4,5,6;

-- Seeded rows (scripts/seed.ts @ c11ed11; #77 is reworking the seed, so re-check before use)
\echo '== S9-2 seed B2B accounts located (expect 15 = 5 companies x Net15/30/60)'
SELECT 'S9-2' AS check_id,
       count(*)                                              AS seed_company_accounts,
       count(*) FILTER (WHERE ba.id LIKE 'seed-account-%')   AS with_seed_ids,
       count(*) FILTER (WHERE ba."defaultTermsDays" = 15)    AS net15,
       count(*) FILTER (WHERE ba."defaultTermsDays" = 30)    AS net30,
       count(*) FILTER (WHERE ba."defaultTermsDays" = 60)    AS net60,
       count(*) FILTER (WHERE ba.gated_at IS NOT NULL)       AS gated,
       (count(*) = 15 AND count(*) FILTER (WHERE ba.gated_at IS NOT NULL) = 0) AS pass
FROM "BuyerAccount" ba
WHERE ba."shopId" = :'shop_id' AND ba.kind::text = 'COMPANY'
  AND (ba.id LIKE 'seed-account-%' OR ba.name ILIKE ANY (ARRAY[
        'Acme Wholesale Pvt Ltd%','Bharat Traders Co%','Delhi Distributors LLP%',
        'Mumbai Merchants Pvt Ltd%','Kolkata Commerce House%']));

\echo '== S9-3 seed B2B invoices: expect 30 total, 10 per Net term; basis split is PLACEHOLDER <B2B_WITH_SHOPIFY_TERMS>'
WITH seed_acct AS (
  SELECT ba.id, ba."defaultTermsDays" AS n FROM "BuyerAccount" ba
  WHERE ba."shopId" = :'shop_id' AND ba.kind::text = 'COMPANY'
    AND (ba.id LIKE 'seed-account-%' OR ba.name ILIKE ANY (ARRAY[
          'Acme Wholesale Pvt Ltd%','Bharat Traders Co%','Delhi Distributors LLP%',
          'Mumbai Merchants Pvt Ltd%','Kolkata Commerce House%']))
)
SELECT 'S9-3' AS check_id, sa.n AS account_terms_days,
       count(i.id)                                                         AS invoices,
       count(i.id) FILTER (WHERE i."dueSource"::text = 'schedule')          AS path_a_schedule,
       count(i.id) FILTER (WHERE i."dueBasis" = 'paymentTermsDueInDays')    AS basis_payment_terms_due_in_days,
       count(i.id) FILTER (WHERE i."dueBasis" = 'accountDefault')           AS basis_account_default,
       count(i.id) FILTER (WHERE i."dueBasis" NOT IN ('paymentTermsDueInDays','accountDefault')
                              OR (i."dueBasis" IS NULL AND i."dueSource"::text <> 'schedule')) AS basis_unexpected,
       count(i.id) FILTER (WHERE i.status::text = 'open')                   AS open,
       (count(i.id) = 10)                                                   AS pass
FROM seed_acct sa LEFT JOIN "Invoice" i ON i."buyerAccountId" = sa.id AND i."shopId" = :'shop_id'
GROUP BY sa.n ORDER BY sa.n;

\echo '== S9-4 seed B2B due-date correctness: local(dueAt) = local(issuedAt) + N days, at local end of day'
WITH seed_acct AS (
  SELECT ba.id, ba."defaultTermsDays" AS n FROM "BuyerAccount" ba
  WHERE ba."shopId" = :'shop_id' AND ba.kind::text = 'COMPANY'
    AND (ba.id LIKE 'seed-account-%' OR ba.name ILIKE ANY (ARRAY[
          'Acme Wholesale Pvt Ltd%','Bharat Traders Co%','Delhi Distributors LLP%',
          'Mumbai Merchants Pvt Ltd%','Kolkata Commerce House%']))
)
SELECT 'S9-4' AS check_id, i."dueSource"::text AS due_source, COALESCE(i."dueBasis",'(null)') AS due_basis,
       count(*) AS invoices,
       count(*) FILTER (WHERE (i."dueAt" AT TIME ZONE :'shop_tz')::date
                              = (i."issuedAt" AT TIME ZONE :'shop_tz')::date + sa.n)           AS due_date_matches_terms,
       count(*) FILTER (WHERE (i."dueAt" AT TIME ZONE :'shop_tz')::time >= time '23:59:59')    AS end_of_local_day,
       count(*) FILTER (WHERE i."dueAt" IS NULL)                                               AS null_due_at,
       CASE WHEN i."dueSource"::text = 'inferred'
            THEN count(*) = count(*) FILTER (WHERE (i."dueAt" AT TIME ZONE :'shop_tz')::date
                                              = (i."issuedAt" AT TIME ZONE :'shop_tz')::date + sa.n)
                 AND count(*) = count(*) FILTER (WHERE (i."dueAt" AT TIME ZONE :'shop_tz')::time >= time '23:59:59')
       END AS pass  -- NULL for schedule rows: Shopify computes dueAt; compare by hand
FROM seed_acct sa JOIN "Invoice" i ON i."buyerAccountId" = sa.id AND i."shopId" = :'shop_id'
GROUP BY 2,3 ORDER BY 2,3;

\echo '== S9-5 tagged-customer prerequisites (CUSTOMERS_* held; reconcile does NOT sync customers)'
SELECT 'S9-5' AS check_id,
       (SELECT count(*) FROM s8_tagged_customers tc
         WHERE tc.shop_id = :'shop_id'
           AND EXISTS (SELECT 1 FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(tc.tags::jsonb) = 'array' THEN tc.tags::jsonb ELSE '[]'::jsonb END) t WHERE lower(t) LIKE 'ntr-seed-net%')) AS seed_tagged_tracking_rows,
       (SELECT count(*) FROM s8_tagged_customers tc
         WHERE tc.shop_id = :'shop_id' AND tc.tag_active
           AND EXISTS (SELECT 1 FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(tc.tags::jsonb) = 'array' THEN tc.tags::jsonb ELSE '[]'::jsonb END) t WHERE lower(t) LIKE 'ntr-seed-net%')) AS seed_tagged_active,
       (SELECT count(*) FROM "BuyerAccount" ba
         WHERE ba."shopId" = :'shop_id' AND ba.kind::text = 'TAGGED_CUSTOMER') AS tagged_accounts_total,
       (SELECT count(*) FROM "BuyerAccount" ba
         WHERE ba."shopId" = :'shop_id' AND ba.kind::text = 'TAGGED_CUSTOMER' AND ba.gated_at IS NOT NULL) AS tagged_accounts_gated,
       NULL::boolean AS pass;  -- decides which S9-6 expectation applies (see doc)

\echo '== S9-6 tagged invoices by basis (seed: 5 PENDING orders Net15 x2, Net30 x2, Net60 x1); expected count is PLACEHOLDER <TAGGED_INVOICES_EXPECTED>'
SELECT 'S9-6' AS check_id, ba."defaultTermsSource"::text AS terms_source, ba."defaultTermsDays" AS terms_days,
       COALESCE(i."dueBasis",'(null)') AS due_basis, count(i.id) AS invoices,
       count(i.id) FILTER (WHERE (i."dueAt" AT TIME ZONE :'shop_tz')::date
                                 = (i."issuedAt" AT TIME ZONE :'shop_tz')::date + ba."defaultTermsDays") AS due_date_matches_terms,
       NULL::boolean AS pass
FROM "BuyerAccount" ba JOIN "Invoice" i ON i."buyerAccountId" = ba.id
WHERE ba."shopId" = :'shop_id' AND i."shopId" = :'shop_id' AND ba.kind::text = 'TAGGED_CUSTOMER'
GROUP BY 2,3,4 ORDER BY 2,3,4;

\echo '== S9-7 processed ORDERS_* webhooks with NO invoice (retail / ineligible / terminal status / null refetch / PAID/CANCELLED on unknown order)'
SELECT 'S9-7' AS check_id, p.topic,
       count(*)                                         AS processed_for_shop,
       count(*) FILTER (WHERE i.id IS NULL)              AS processed_without_invoice,
       NULL::boolean AS pass  -- PLACEHOLDER <RETAIL_AND_TERMINAL_SKIPS_EXPECTED>; seed creates none
FROM s6_processed_webhooks p
JOIN webhook_receipts r ON r.webhook_id = p.webhook_id AND r.shop = :'shop'
LEFT JOIN "Invoice" i ON i."shopId" = :'shop_id' AND i."orderId" = p.resource_gid
WHERE p.topic LIKE 'ORDERS_%'
GROUP BY p.topic ORDER BY p.topic;

\echo '== S9-8 terminal statuses: invoices paid/cancelled must have outstanding consistent'
SELECT 'S9-8' AS check_id, i.status::text AS status, count(*) AS invoices,
       count(*) FILTER (WHERE i.outstanding < 0 OR i.outstanding > i.total) AS outstanding_out_of_range,
       count(*) FILTER (WHERE i.status::text = 'open' AND i.outstanding = 0) AS open_with_zero_outstanding,
       (count(*) FILTER (WHERE i.outstanding < 0 OR i.outstanding > i.total) = 0) AS pass
FROM "Invoice" i WHERE i."shopId" = :'shop_id'
GROUP BY 2 ORDER BY 2;

-- -----------------------------------------------------------------------------
-- S7 Aging in shop timezone + SQL/TS parity
-- -----------------------------------------------------------------------------
\echo '== S7-1 bucket distribution, parity expression (verbatim from getAgingBucketsForParity)'
WITH a AS (
  SELECT i.id, i.outstanding,
         CASE WHEN i."dueAt" IS NULL THEN 0
              ELSE EXTRACT(DAY FROM (DATE_TRUNC('day', :'as_of'::timestamptz AT TIME ZONE s.timezone)
                                   - DATE_TRUNC('day', i."dueAt" AT TIME ZONE s.timezone)))::int END AS dpd
  FROM "Invoice" i JOIN "Shop" s ON s.id = i."shopId"
  WHERE i."shopId" = :'shop_id' AND i.status = 'open' AND i.outstanding > 0
)
SELECT 'S7-1' AS check_id,
       CASE WHEN dpd <= 0 THEN 'current' WHEN dpd <= 30 THEN '1-30' WHEN dpd <= 60 THEN '31-60'
            WHEN dpd <= 90 THEN '61-90' ELSE '90+' END AS bucket,
       count(*) AS invoices, min(dpd) AS min_dpd, max(dpd) AS max_dpd
FROM a GROUP BY 2 ORDER BY min(dpd);

\echo '== S7-2 parity: SQL parity bucket == independent mirror of TS (luxon startOf day, validated tz, Asia/Kolkata fallback)'
WITH s AS (
  SELECT id, timezone,
         CASE WHEN EXISTS (SELECT 1 FROM pg_timezone_names WHERE name = timezone) THEN timezone ELSE 'Asia/Kolkata' END AS ts_tz
  FROM "Shop" WHERE id = :'shop_id'
), a AS (
  SELECT
    CASE WHEN i."dueAt" IS NULL THEN 0
         ELSE EXTRACT(DAY FROM (DATE_TRUNC('day', :'as_of'::timestamptz AT TIME ZONE s.timezone)
                              - DATE_TRUNC('day', i."dueAt" AT TIME ZONE s.timezone)))::int END AS dpd_sql,
    CASE WHEN i."dueAt" IS NULL THEN 0
         ELSE (:'as_of'::timestamptz AT TIME ZONE s.ts_tz)::date - (i."dueAt" AT TIME ZONE s.ts_tz)::date END AS dpd_ts
  FROM "Invoice" i JOIN s ON s.id = i."shopId"
  WHERE i."shopId" = :'shop_id' AND i.status = 'open' AND i.outstanding > 0
), b AS (
  SELECT dpd_sql, dpd_ts,
    CASE WHEN dpd_sql <= 0 THEN 'current' WHEN dpd_sql <= 30 THEN '1-30' WHEN dpd_sql <= 60 THEN '31-60' WHEN dpd_sql <= 90 THEN '61-90' ELSE '90+' END AS b_sql,
    CASE WHEN dpd_ts  <= 0 THEN 'current' WHEN dpd_ts  <= 30 THEN '1-30' WHEN dpd_ts  <= 60 THEN '31-60' WHEN dpd_ts  <= 90 THEN '61-90' ELSE '90+' END AS b_ts
  FROM a
)
SELECT 'S7-2' AS check_id, count(*) AS open_invoices,
       count(*) FILTER (WHERE dpd_sql <> dpd_ts) AS dpd_mismatches,
       count(*) FILTER (WHERE b_sql <> b_ts)     AS bucket_mismatches,
       (count(*) FILTER (WHERE b_sql <> b_ts) = 0 AND count(*) FILTER (WHERE dpd_sql <> dpd_ts) = 0) AS pass
FROM b;

\echo '== S7-3 timezone sensitivity: invoices whose bucket differs if computed in UTC (informational; proves shop tz is used)'
WITH a AS (
  SELECT
    CASE WHEN i."dueAt" IS NULL THEN 0 ELSE (:'as_of'::timestamptz AT TIME ZONE :'shop_tz')::date - (i."dueAt" AT TIME ZONE :'shop_tz')::date END AS dpd_local,
    CASE WHEN i."dueAt" IS NULL THEN 0 ELSE (:'as_of'::timestamptz AT TIME ZONE 'UTC')::date - (i."dueAt" AT TIME ZONE 'UTC')::date END AS dpd_utc
  FROM "Invoice" i WHERE i."shopId" = :'shop_id' AND i.status = 'open' AND i.outstanding > 0
)
SELECT 'S7-3' AS check_id, count(*) FILTER (WHERE dpd_local <> dpd_utc) AS dpd_differs_local_vs_utc, NULL::boolean AS pass FROM a;

\echo '== S7-4 seeded B2B aging vs seed design: dpd(stored dueAt) == (asOf_local - issued_local) - N'
WITH seed_acct AS (
  SELECT ba.id, ba."defaultTermsDays" AS n FROM "BuyerAccount" ba
  WHERE ba."shopId" = :'shop_id' AND ba.kind::text = 'COMPANY'
    AND (ba.id LIKE 'seed-account-%' OR ba.name ILIKE ANY (ARRAY[
          'Acme Wholesale Pvt Ltd%','Bharat Traders Co%','Delhi Distributors LLP%',
          'Mumbai Merchants Pvt Ltd%','Kolkata Commerce House%']))
), a AS (
  SELECT (:'as_of'::timestamptz AT TIME ZONE :'shop_tz')::date - (i."dueAt" AT TIME ZONE :'shop_tz')::date AS dpd_stored,
         ((:'as_of'::timestamptz AT TIME ZONE :'shop_tz')::date - (i."issuedAt" AT TIME ZONE :'shop_tz')::date) - sa.n AS dpd_design
  FROM seed_acct sa JOIN "Invoice" i ON i."buyerAccountId" = sa.id AND i."shopId" = :'shop_id'
  WHERE i.status = 'open' AND i.outstanding > 0 AND i."dueAt" IS NOT NULL
)
SELECT 'S7-4' AS check_id, count(*) AS seed_open_invoices,
       count(*) FILTER (WHERE dpd_design <= 0)                     AS design_current,
       count(*) FILTER (WHERE dpd_design BETWEEN 1 AND 30)          AS design_1_30,
       count(*) FILTER (WHERE dpd_design > 30)                      AS design_over_30,
       count(*) FILTER (WHERE dpd_stored <> dpd_design)             AS mismatches,
       (count(*) FILTER (WHERE dpd_stored <> dpd_design) = 0)       AS pass
FROM a;

-- -----------------------------------------------------------------------------
-- S16 Matcher state invariants (counts only; no payer text / narration / alias keys)
-- -----------------------------------------------------------------------------
\echo '== S16-1 inventory'
SELECT 'S16-1' AS check_id,
  (SELECT count(*) FROM "BankImport" WHERE "shopId" = :'shop_id')                                   AS bank_imports,
  (SELECT count(*) FROM "Payment"    WHERE "shopId" = :'shop_id')                                   AS payments,
  (SELECT count(*) FROM "Payment"    WHERE "shopId" = :'shop_id' AND status::text = 'unmatched')    AS payments_unmatched,
  (SELECT count(*) FROM "Payment"    WHERE "shopId" = :'shop_id' AND status::text = 'partial')      AS payments_partial,
  (SELECT count(*) FROM "Payment"    WHERE "shopId" = :'shop_id' AND status::text = 'matched')      AS payments_matched,
  (SELECT count(*) FROM "Match"      WHERE "shopId" = :'shop_id' AND state::text = 'suggested')     AS matches_suggested,
  (SELECT count(*) FROM "Match"      WHERE "shopId" = :'shop_id' AND state::text = 'confirmed')     AS matches_confirmed,
  (SELECT count(*) FROM "Match"      WHERE "shopId" = :'shop_id' AND state::text = 'pushed')        AS matches_pushed,
  (SELECT count(*) FROM "Match"      WHERE "shopId" = :'shop_id' AND state::text = 'unmatched')     AS matches_unmatched,
  (SELECT count(*) FROM rejected_matches WHERE "shopId" = :'shop_id')                               AS rejected_pairs,
  (SELECT count(*) FROM "PayerAlias" pa JOIN "BuyerAccount" ba ON ba.id = pa."buyerAccountId"
     WHERE ba."shopId" = :'shop_id')                                                                AS payer_aliases;

\echo '== S16-2 invariants (each must be 0)'
SELECT 'S16-2' AS check_id, v.invariant, v.violations, (v.violations = 0) AS pass FROM (
  SELECT 'confirmed_missing_confirmedBy_or_At' AS invariant, count(*) AS violations
    FROM "Match" WHERE "shopId" = :'shop_id' AND state::text = 'confirmed' AND ("confirmedBy" IS NULL OR "confirmedAt" IS NULL)
  UNION ALL
  SELECT 'rejected_pair_still_suggested', count(*)
    FROM rejected_matches r JOIN "Match" m ON m."paymentId" = r."paymentId" AND m."invoiceId" = r."invoiceId"
    WHERE r."shopId" = :'shop_id' AND m."shopId" = :'shop_id' AND m.state::text = 'suggested'
  UNION ALL
  SELECT 'rejected_pair_without_unmatched_match_row', count(*)
    FROM rejected_matches r
    WHERE r."shopId" = :'shop_id'
      AND NOT EXISTS (SELECT 1 FROM "Match" m WHERE m."paymentId" = r."paymentId" AND m."invoiceId" = r."invoiceId"
                        AND m."shopId" = :'shop_id' AND m.state::text = 'unmatched')
  UNION ALL
  SELECT 'payment_confirmed_alloc_exceeds_amount', count(*) FROM (
    SELECT p.id FROM "Payment" p JOIN "Match" m ON m."paymentId" = p.id AND m.state::text IN ('confirmed','pushed')
    WHERE p."shopId" = :'shop_id' GROUP BY p.id, p.amount HAVING sum(m.amount) > p.amount) x
  UNION ALL
  SELECT 'invoice_confirmed_alloc_exceeds_total', count(*) FROM (
    SELECT i.id FROM "Invoice" i JOIN "Match" m ON m."invoiceId" = i.id AND m.state::text IN ('confirmed','pushed')
    WHERE i."shopId" = :'shop_id' GROUP BY i.id, i.total HAVING sum(m.amount) > i.total) x
  UNION ALL
  SELECT 'payment_status_inconsistent_with_confirmed_alloc', count(*) FROM (
    SELECT p.id, p.status::text AS st, p.amount, COALESCE(sum(m.amount) FILTER (WHERE m.state::text IN ('confirmed','pushed')), 0) AS alloc,
           count(*) FILTER (WHERE m.state::text = 'suggested') AS sugg
    FROM "Payment" p LEFT JOIN "Match" m ON m."paymentId" = p.id
    WHERE p."shopId" = :'shop_id' GROUP BY p.id, p.status, p.amount) x
    WHERE (alloc >= amount AND alloc > 0 AND st <> 'matched')
       OR (alloc > 0 AND alloc < amount AND st <> 'partial')
       OR (alloc = 0 AND st = 'matched')
  UNION ALL
  SELECT 'match_cross_shop', count(*)
    FROM "Match" m LEFT JOIN "Payment" p ON p.id = m."paymentId" LEFT JOIN "Invoice" i ON i.id = m."invoiceId"
    WHERE m."shopId" = :'shop_id' AND (p."shopId" IS DISTINCT FROM :'shop_id' OR i."shopId" IS DISTINCT FROM :'shop_id')
  UNION ALL
  SELECT 'match_amount_non_positive', count(*) FROM "Match" WHERE "shopId" = :'shop_id' AND amount <= 0
) v ORDER BY v.invariant;

\echo '== S16-3 stale suggestions on invoices closed by the redrive (WARN, not FAIL: matcher filters open at suggest time)'
SELECT 'S16-3' AS check_id, i.status::text AS invoice_status, count(*) AS suggested_matches_on_closed_invoices, NULL::boolean AS pass
FROM "Match" m JOIN "Invoice" i ON i.id = m."invoiceId"
WHERE m."shopId" = :'shop_id' AND m.state::text = 'suggested' AND i.status::text <> 'open'
GROUP BY 2 ORDER BY 2;

-- -----------------------------------------------------------------------------
-- S20 webhook_receipts, dedup, DLQ by topic after redrive
-- -----------------------------------------------------------------------------
\echo '== S20-1 receipts by topic (retention 30d)'
SELECT 'S20-1' AS check_id, r.topic,
       count(*)                                                                         AS receipts,
       count(*) FILTER (WHERE r.received_at >= :'redrive_started_at'::timestamptz)        AS receipts_since_redrive_start,
       count(*) - count(DISTINCT r.webhook_id)                                           AS duplicate_webhook_ids,
       (count(*) = count(DISTINCT r.webhook_id))                                         AS pass
FROM webhook_receipts r WHERE r.shop = :'shop'
GROUP BY r.topic ORDER BY r.topic;

\echo '== S20-2 drain dedup: redriven webhookIds processed at most once; processed rows have receipts'
SELECT 'S20-2' AS check_id,
  (SELECT count(*) FROM s6_processed_webhooks p JOIN webhook_receipts r ON r.webhook_id = p.webhook_id AND r.shop = :'shop'
     WHERE p.topic LIKE 'ORDERS_%')                                                        AS orders_processed_with_receipt,
  (SELECT count(*) FROM s6_processed_webhooks p JOIN webhook_receipts r ON r.webhook_id = p.webhook_id AND r.shop = :'shop'
     WHERE p.topic LIKE 'ORDERS_%' AND p.processed_at >= :'redrive_started_at'::timestamptz) AS orders_processed_since_redrive,
  (SELECT count(*) FROM (
     SELECT p.resource_gid, p.topic FROM s6_processed_webhooks p
     JOIN webhook_receipts r ON r.webhook_id = p.webhook_id AND r.shop = :'shop'
     WHERE p.topic LIKE 'ORDERS_%' GROUP BY p.resource_gid, p.topic HAVING count(*) > 1) x)    AS order_topic_pairs_seen_multiple_webhook_ids_info,
  (SELECT count(*) FROM "Invoice" WHERE "shopId" = :'shop_id')
    - (SELECT count(DISTINCT "orderId") FROM "Invoice" WHERE "shopId" = :'shop_id' AND "orderId" IS NOT NULL)
    - (SELECT count(*) FROM "Invoice" WHERE "shopId" = :'shop_id' AND "orderId" IS NULL)    AS duplicate_invoices_per_order,
  ((SELECT count(*) FROM "Invoice" WHERE "shopId" = :'shop_id')
    - (SELECT count(DISTINCT "orderId") FROM "Invoice" WHERE "shopId" = :'shop_id' AND "orderId" IS NOT NULL)
    - (SELECT count(*) FROM "Invoice" WHERE "shopId" = :'shop_id' AND "orderId" IS NULL)) = 0 AS pass;

\echo '== S20-3 conservation: every ORDERS_* receipt is processed, dead-lettered, or still queued (expect 0 unaccounted)'
SELECT 'S20-3' AS check_id, count(*) AS orders_receipts,
       count(*) FILTER (WHERE NOT EXISTS (SELECT 1 FROM s6_processed_webhooks p WHERE p.webhook_id = r.webhook_id)
                          AND NOT EXISTS (SELECT 1 FROM s6_dead_letter d WHERE d.message->>'webhookId' = r.webhook_id AND d.message->>'shop' = :'shop')
                          AND NOT EXISTS (SELECT 1 FROM pgmq.q_s6_sync q WHERE q.message->>'webhookId' = r.webhook_id AND q.message->>'shop' = :'shop'))
         AS unaccounted,
       count(*) FILTER (WHERE NOT EXISTS (SELECT 1 FROM s6_processed_webhooks p WHERE p.webhook_id = r.webhook_id)
                          AND NOT EXISTS (SELECT 1 FROM s6_dead_letter d WHERE d.message->>'webhookId' = r.webhook_id AND d.message->>'shop' = :'shop')
                          AND NOT EXISTS (SELECT 1 FROM pgmq.q_s6_sync q WHERE q.message->>'webhookId' = r.webhook_id AND q.message->>'shop' = :'shop')) = 0
         AS pass
FROM webhook_receipts r WHERE r.shop = :'shop' AND r.topic LIKE 'ORDERS_%';

\echo '== S20-4 DLQ by topic x error class for this shop (error text never printed)'
SELECT 'S20-4' AS check_id, d.original_queue, d.message->>'topic' AS topic,
       CASE
         WHEN d.error LIKE 'Order has payment terms but no matching BuyerAccount found%'      THEN 'nba_payment_terms'
         WHEN d.error LIKE 'Customer matches tag rule % but no BuyerAccount found%'           THEN 'nba_tag_rule'
         WHEN d.error LIKE 'CompanyLocation exists but no BuyerAccount synced yet%'           THEN 'nba_company_location'
         WHEN d.error LIKE 'No handler registered for topic after %'                          THEN 'no_handler'
         WHEN d.error LIKE 'Non-retryable error:%'                                            THEN 'non_retryable'
         ELSE 'other'
       END AS error_class,
       count(*) AS rows,
       count(*) FILTER (WHERE d.dead_lettered_at >= :'redrive_started_at'::timestamptz) AS since_redrive_start
FROM s6_dead_letter d WHERE d.message->>'shop' = :'shop'
GROUP BY 2,3,4 ORDER BY 2,3,4;

\echo '== S20-5 DLQ pass criteria'
SELECT 'S20-5' AS check_id,
  count(*) FILTER (WHERE d.message->>'topic' LIKE 'ORDERS_%')                                         AS orders_rows_total,
  count(*) FILTER (WHERE d.message->>'topic' LIKE 'ORDERS_%'
                     AND d.error NOT LIKE 'Order has payment terms but no matching BuyerAccount found%'
                     AND d.error NOT LIKE 'Customer matches tag rule % but no BuyerAccount found%'
                     AND d.error NOT LIKE 'CompanyLocation exists but no BuyerAccount synced yet%')    AS orders_rows_not_no_buyer_account,
  count(*) FILTER (WHERE d.message->>'topic' LIKE 'ORDERS_%'
                     AND d.error LIKE 'Customer matches tag rule % but no BuyerAccount found%')         AS orders_rows_tag_rule_nba,   -- PLACEHOLDER <TAGGED_NBA_EXPECTED>
  count(*) FILTER (WHERE d.message->>'topic' LIKE 'ORDERS_%'
                     AND (d.error LIKE 'Order has payment terms but no matching BuyerAccount found%'
                       OR d.error LIKE 'CompanyLocation exists but no BuyerAccount synced yet%'))      AS orders_rows_company_nba,     -- expect 0 after reconcile companies
  count(*) FILTER (WHERE d.message->>'topic' LIKE 'RECONCILE_%')                                       AS reconcile_rows,
  count(*) FILTER (WHERE d.message->>'topic' LIKE 'CUSTOMERS_%')                                       AS customers_rows_held,     -- PLACEHOLDER baseline <DLQ_CUSTOMERS_BASELINE>
  count(*) FILTER (WHERE d.message->>'topic' LIKE 'DRAFT_ORDERS_%')                                    AS draft_orders_rows_held,  -- PLACEHOLDER baseline <DLQ_DRAFT_ORDERS_BASELINE>
  count(*) FILTER (WHERE d.message->>'topic' NOT LIKE 'ORDERS_%' AND d.message->>'topic' NOT LIKE 'CUSTOMERS_%'
                     AND d.message->>'topic' NOT LIKE 'DRAFT_ORDERS_%' AND d.message->>'topic' NOT LIKE 'RECONCILE_%') AS other_topic_rows,
  (count(*) FILTER (WHERE d.message->>'topic' LIKE 'ORDERS_%'
                     AND d.error NOT LIKE 'Order has payment terms but no matching BuyerAccount found%'
                     AND d.error NOT LIKE 'Customer matches tag rule % but no BuyerAccount found%'
                     AND d.error NOT LIKE 'CompanyLocation exists but no BuyerAccount synced yet%') = 0
   AND count(*) FILTER (WHERE d.message->>'topic' LIKE 'ORDERS_%'
                     AND (d.error LIKE 'Order has payment terms but no matching BuyerAccount found%'
                       OR d.error LIKE 'CompanyLocation exists but no BuyerAccount synced yet%')) = 0
   AND count(*) FILTER (WHERE d.message->>'topic' LIKE 'RECONCILE_%') = 0)                             AS pass_code_derived
FROM s6_dead_letter d WHERE d.message->>'shop' = :'shop';

\echo '== S20-6 redriven-and-re-dead-lettered ORDERS_* (same webhookId DLQed again after redrive start)'
SELECT 'S20-6' AS check_id,
       count(*) AS orders_rows_dead_lettered_since_redrive,
       count(*) FILTER (WHERE EXISTS (SELECT 1 FROM s6_processed_webhooks p WHERE p.webhook_id = d.message->>'webhookId')) AS dlq_rows_already_processed,
       (count(*) FILTER (WHERE EXISTS (SELECT 1 FROM s6_processed_webhooks p WHERE p.webhook_id = d.message->>'webhookId')) = 0) AS pass
FROM s6_dead_letter d
WHERE d.message->>'shop' = :'shop' AND d.message->>'topic' LIKE 'ORDERS_%'
  AND d.dead_lettered_at >= :'redrive_started_at'::timestamptz;

ROLLBACK;
