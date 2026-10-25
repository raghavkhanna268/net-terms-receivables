-- 200-delete-seed-orphans.sql (one-off, #200)
--
-- Deletes EXACTLY the 3 orphaned seed BuyerAccount rows on the dev store whose
-- Shopify CompanyLocation node is gone (Admin nodes(ids:) returned null):
--   gid://shopify/CompanyLocation/24539463845
--   gid://shopify/CompanyLocation/24539529381
--   gid://shopify/CompanyLocation/24539594917
-- Approved by Raghav 2026-10-25 09:25 IST for these 3 rows only.
--
-- Run ONLY via .github/workflows/ops-200-delete-seed-orphans.yml.
-- psql variables (all required):
--   shop        dev-store domain from the ALLOWED_DEV_STORE secret (never printed)
--   mode        dry-run | apply
--   nodes_null  'true' only if the workflow's Admin API check found all 3 nodes null
--
-- Safety:
--   * One transaction. Every check runs before any write; any failed check
--     RAISEs 'refuse_200:<code>', psql exits non-zero (ON_ERROR_STOP) and the
--     transaction is rolled back: no writes.
--   * dry-run: never deletes, always ends with ROLLBACK (the workflow also runs
--     it with default_transaction_read_only=on).
--   * apply: locks the 3 rows, re-runs every check, deletes by the 3 locked ids
--     only, asserts 3 rows deleted and 0 remaining, then COMMIT.
--   * Output: counts, ids, gids, enums and booleans only. No domain, name,
--     email, money or free text. The shop domain only enters via set_config
--     and is compared, never selected.
--
-- Seed row definition, kind = COMPANY, id matched EXACTLY against the row's own
-- columns (no prefix/LIKE match). scripts/seed.ts has written two formats:
--   legacy  id = 'seed-account-' || "companyLocationId"
--           (seed.ts from #48 90f4d69 until #163 e04a908 / #170 3c22fef;
--            the 3 orphans were created by this version, see dry run 40171618161)
--   current id = 'seed-account-' || "shopId" || '-' || "companyLocationId"
--           (scripts/seed.ts:3558 and :3664 on main)
-- Dependents checked (must all be 0):
--   FK: "Invoice" (NO ACTION, composite buyerAccountId+shopId), "PayerAlias" (CASCADE)
--   via Invoice: "Match", rejected_matches, "ReminderLog"
--   no FK: s8_draft_orders.buyer_account_id, "AuditEvent".data->>'buyerAccountId',
--          live pgmq.q_s6_sync messages (message->>'buyerAccountId')
--   runtime: every FK in pg_constraint that references "BuyerAccount" (catches
--            any FK table added after this script was written)
-- Reported, not blocking (history/logs that #200 says can stay):
--   s6_processed_webhooks credit_recompute/credit_resync dedupe rows,
--   pgmq.a_s6_sync archived messages, s6_dead_letter messages.
\set ON_ERROR_STOP 1
BEGIN;

SELECT set_config('ntr200.shop_domain', :'shop', true) IS NOT NULL AS shop_param_set,
       set_config('ntr200.mode', :'mode', true) IN ('dry-run', 'apply') AS mode_valid,
       set_config('ntr200.nodes_null', :'nodes_null', true) = 'true' AS admin_nodes_all_null,
       current_setting('ntr200.mode') = 'apply' AS is_apply
\gset

\echo '== P0 params'
SELECT :'shop_param_set'::boolean AS shop_param_set,
       :'mode_valid'::boolean AS mode_valid,
       :'is_apply'::boolean AS is_apply,
       :'admin_nodes_all_null'::boolean AS admin_nodes_all_null;

\echo '== P1 dev shop resolved (domain not printed)'
SELECT COUNT(*) AS dev_shop_rows
FROM "Shop" s WHERE s.domain = current_setting('ntr200.shop_domain');

\echo '== R1 allowlisted gids on the dev shop'
WITH g(company_location_gid) AS (
  SELECT 'gid://shopify/CompanyLocation/24539463845' UNION ALL
  SELECT 'gid://shopify/CompanyLocation/24539529381' UNION ALL
  SELECT 'gid://shopify/CompanyLocation/24539594917'
)
SELECT g.company_location_gid,
       ba.id AS buyer_account_id,
       ba.id IS NOT NULL AS matched,
       ba.kind,
       (ba.id = 'seed-account-' || ba."companyLocationId" OR ba.id = 'seed-account-' || ba."shopId" || '-' || ba."companyLocationId") AS is_seed,
       (SELECT COUNT(*) FROM "Invoice" i WHERE i."buyerAccountId" = ba.id) AS invoices,
       (SELECT COUNT(*) FROM "Match" m JOIN "Invoice" i ON i.id = m."invoiceId" WHERE i."buyerAccountId" = ba.id) AS matches,
       (SELECT COUNT(*) FROM rejected_matches r JOIN "Invoice" i ON i.id = r."invoiceId" WHERE i."buyerAccountId" = ba.id) AS rejected_matches,
       (SELECT COUNT(*) FROM "ReminderLog" rl JOIN "Invoice" i ON i.id = rl."invoiceId" WHERE i."buyerAccountId" = ba.id) AS reminder_logs,
       (SELECT COUNT(*) FROM "PayerAlias" pa WHERE pa."buyerAccountId" = ba.id) AS payer_aliases,
       (SELECT COUNT(*) FROM s8_draft_orders d WHERE d.buyer_account_id = ba.id) AS draft_orders,
       (SELECT COUNT(*) FROM "AuditEvent" e WHERE e.data->>'buyerAccountId' = ba.id) AS audit_events,
       (SELECT COUNT(*) FROM pgmq.q_s6_sync q WHERE q.message->>'buyerAccountId' = ba.id) AS queued_messages,
       (SELECT COUNT(*) FROM s6_processed_webhooks w
         WHERE w.webhook_id LIKE 'credit_recompute:' || ba.id || ':%'
            OR w.webhook_id LIKE 'credit_resync:' || ba.id || ':%') AS info_dedupe_rows,
       (SELECT COUNT(*) FROM pgmq.a_s6_sync a WHERE a.message->>'buyerAccountId' = ba.id) AS info_archived_messages,
       (SELECT COUNT(*) FROM s6_dead_letter dl WHERE dl.message->>'buyerAccountId' = ba.id) AS info_dead_letter_rows
FROM g
LEFT JOIN "Shop" s ON s.domain = current_setting('ntr200.shop_domain')
LEFT JOIN "BuyerAccount" ba ON ba."shopId" = s.id AND ba."companyLocationId" = g.company_location_gid
ORDER BY 1;

\echo '== R2 runtime FK scan: every FK referencing BuyerAccount, rows pointing at the 3 targets'
WITH t AS (
  SELECT ba.id
  FROM "BuyerAccount" ba JOIN "Shop" s ON s.id = ba."shopId"
  WHERE s.domain = current_setting('ntr200.shop_domain')
    AND ba."companyLocationId" IN ('gid://shopify/CompanyLocation/24539463845',
                                   'gid://shopify/CompanyLocation/24539529381',
                                   'gid://shopify/CompanyLocation/24539594917')
),
fk AS (
  SELECT c.conname, c.conrelid, c.confdeltype, a.attname AS child_col
  FROM pg_constraint c
  CROSS JOIN LATERAL unnest(c.conkey, c.confkey) AS k(child_attnum, parent_attnum)
  JOIN pg_attribute pa ON pa.attrelid = c.confrelid AND pa.attnum = k.parent_attnum
  JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.child_attnum
  WHERE c.contype = 'f'
    AND c.confrelid = '"BuyerAccount"'::regclass
    AND pa.attname = 'id'
)
SELECT fk.conrelid::regclass::text AS fk_table_id,
       fk.conname AS fk_constraint_id,
       CASE fk.confdeltype WHEN 'a' THEN 'NO_ACTION' WHEN 'r' THEN 'RESTRICT' WHEN 'c' THEN 'CASCADE'
                           WHEN 'n' THEN 'SET_NULL' WHEN 'd' THEN 'SET_DEFAULT' ELSE 'OTHER' END AS on_delete,
       fk.conrelid::regclass::text IN ('"Invoice"', '"PayerAlias"') AS expected_fk_table,
       (xpath('/row/n/text()',
              query_to_xml(format('SELECT COUNT(*) AS n FROM %s WHERE %I = ANY(%L::text[])',
                                  fk.conrelid::regclass, fk.child_col,
                                  (SELECT COALESCE(array_agg(t.id), '{}') FROM t)),
                           false, true, '')))[1]::text::bigint AS referencing_rows
FROM fk
ORDER BY 1, 2;

\echo '== G1 guard (refuse_200:<code> on any failure; no writes before this passes)'
DO $guard$
DECLARE
  v_ids        text[];
  v_n          bigint;
  v_shop_id    text;
  v_fk         record;
  v_apply      boolean := current_setting('ntr200.mode') = 'apply';
  v_gids       text[] := ARRAY['gid://shopify/CompanyLocation/24539463845',
                               'gid://shopify/CompanyLocation/24539529381',
                               'gid://shopify/CompanyLocation/24539594917'];
BEGIN
  IF current_setting('ntr200.mode') NOT IN ('dry-run', 'apply') THEN
    RAISE EXCEPTION 'refuse_200:bad_mode';
  END IF;
  IF current_setting('ntr200.nodes_null') <> 'true' THEN
    RAISE EXCEPTION 'refuse_200:admin_nodes_not_all_null';
  END IF;

  SELECT COUNT(*) INTO v_n FROM "Shop" WHERE domain = current_setting('ntr200.shop_domain');
  IF v_n <> 1 THEN RAISE EXCEPTION 'refuse_200:dev_shop_rows_%', v_n; END IF;
  SELECT id INTO v_shop_id FROM "Shop" WHERE domain = current_setting('ntr200.shop_domain');

  -- Target rows: allowlisted gids on the dev shop only. Locked in apply mode.
  IF v_apply THEN
    SELECT array_agg(id ORDER BY id) INTO v_ids FROM (
      SELECT id FROM "BuyerAccount"
      WHERE "shopId" = v_shop_id AND "companyLocationId" = ANY(v_gids)
      FOR UPDATE) x;
  ELSE
    SELECT array_agg(id ORDER BY id) INTO v_ids FROM "BuyerAccount"
    WHERE "shopId" = v_shop_id AND "companyLocationId" = ANY(v_gids);
  END IF;
  IF COALESCE(cardinality(v_ids), 0) <> 3 THEN
    RAISE EXCEPTION 'refuse_200:matched_rows_%', COALESCE(cardinality(v_ids), 0);
  END IF;

  SELECT COUNT(*) INTO v_n FROM "BuyerAccount" ba
  WHERE ba.id = ANY(v_ids)
    AND (ba.id = 'seed-account-' || ba."companyLocationId" OR ba.id = 'seed-account-' || ba."shopId" || '-' || ba."companyLocationId")
    AND ba.id LIKE 'seed-account-%'
    AND ba.kind = 'COMPANY';
  IF v_n <> 3 THEN RAISE EXCEPTION 'refuse_200:seed_rows_%', v_n; END IF;

  -- Explicit dependents (schema.prisma + #200 impact analysis).
  SELECT COUNT(*) INTO v_n FROM "Invoice" WHERE "buyerAccountId" = ANY(v_ids);
  IF v_n <> 0 THEN RAISE EXCEPTION 'refuse_200:invoices_%', v_n; END IF;
  SELECT COUNT(*) INTO v_n FROM "Match" m JOIN "Invoice" i ON i.id = m."invoiceId" WHERE i."buyerAccountId" = ANY(v_ids);
  IF v_n <> 0 THEN RAISE EXCEPTION 'refuse_200:matches_%', v_n; END IF;
  SELECT COUNT(*) INTO v_n FROM rejected_matches r JOIN "Invoice" i ON i.id = r."invoiceId" WHERE i."buyerAccountId" = ANY(v_ids);
  IF v_n <> 0 THEN RAISE EXCEPTION 'refuse_200:rejected_matches_%', v_n; END IF;
  SELECT COUNT(*) INTO v_n FROM "ReminderLog" rl JOIN "Invoice" i ON i.id = rl."invoiceId" WHERE i."buyerAccountId" = ANY(v_ids);
  IF v_n <> 0 THEN RAISE EXCEPTION 'refuse_200:reminder_logs_%', v_n; END IF;
  SELECT COUNT(*) INTO v_n FROM "PayerAlias" WHERE "buyerAccountId" = ANY(v_ids);
  IF v_n <> 0 THEN RAISE EXCEPTION 'refuse_200:payer_aliases_%', v_n; END IF;
  SELECT COUNT(*) INTO v_n FROM s8_draft_orders WHERE buyer_account_id = ANY(v_ids);
  IF v_n <> 0 THEN RAISE EXCEPTION 'refuse_200:draft_orders_%', v_n; END IF;
  SELECT COUNT(*) INTO v_n FROM "AuditEvent" WHERE data->>'buyerAccountId' = ANY(v_ids);
  IF v_n <> 0 THEN RAISE EXCEPTION 'refuse_200:audit_events_%', v_n; END IF;
  SELECT COUNT(*) INTO v_n FROM pgmq.q_s6_sync WHERE message->>'buyerAccountId' = ANY(v_ids);
  IF v_n <> 0 THEN RAISE EXCEPTION 'refuse_200:queued_messages_%', v_n; END IF;

  -- Runtime FK scan: any FK to BuyerAccount.id, known or not, must have 0 rows.
  FOR v_fk IN
    SELECT c.conrelid, a.attname AS child_col
    FROM pg_constraint c
    CROSS JOIN LATERAL unnest(c.conkey, c.confkey) AS k(child_attnum, parent_attnum)
    JOIN pg_attribute pa ON pa.attrelid = c.confrelid AND pa.attnum = k.parent_attnum
    JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.child_attnum
    WHERE c.contype = 'f' AND c.confrelid = '"BuyerAccount"'::regclass AND pa.attname = 'id'
  LOOP
    EXECUTE format('SELECT COUNT(*) FROM %s WHERE %I = ANY($1)', v_fk.conrelid::regclass, v_fk.child_col)
      INTO v_n USING v_ids;
    IF v_n <> 0 THEN RAISE EXCEPTION 'refuse_200:fk_rows_%', v_n; END IF;
  END LOOP;

  PERFORM set_config('ntr200.guard_passed', 'true', true);

  IF v_apply THEN
    DELETE FROM "BuyerAccount" WHERE id = ANY(v_ids) AND "shopId" = v_shop_id;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    IF v_n <> 3 THEN RAISE EXCEPTION 'refuse_200:deleted_rows_%', v_n; END IF;
    SELECT COUNT(*) INTO v_n FROM "BuyerAccount" WHERE id = ANY(v_ids);
    IF v_n <> 0 THEN RAISE EXCEPTION 'refuse_200:remaining_rows_%', v_n; END IF;
    PERFORM set_config('ntr200.deleted_rows', '3', true);
  ELSE
    PERFORM set_config('ntr200.deleted_rows', '0', true);
  END IF;
END
$guard$;

\echo '== S1 result'
SELECT current_setting('ntr200.guard_passed') = 'true' AS guard_passed,
       current_setting('ntr200.deleted_rows')::int AS deleted_rows,
       (SELECT COUNT(*) FROM "BuyerAccount" ba JOIN "Shop" s ON s.id = ba."shopId"
         WHERE s.domain = current_setting('ntr200.shop_domain')
           AND ba."companyLocationId" IN ('gid://shopify/CompanyLocation/24539463845',
                                          'gid://shopify/CompanyLocation/24539529381',
                                          'gid://shopify/CompanyLocation/24539594917')) AS target_rows_now,
       (SELECT COUNT(*) FROM "BuyerAccount" ba WHERE ba.id LIKE 'seed-account-%') AS seed_accounts_now,
       :'is_apply'::boolean AS will_commit;

\if :is_apply
COMMIT;
\echo '== committed=true'
\else
ROLLBACK;
\echo '== committed=false (dry-run, rolled back)'
\endif
