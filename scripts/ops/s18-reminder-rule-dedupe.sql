-- s18-reminder-rule-dedupe.sql (one-off, S18 duplicate ReminderRule bug)
--
-- Deletes the NEWER copy (by "createdAt", then id) of each duplicate default
-- email ReminderRule pair on the main USD dev store ONLY, keeping the older
-- copy. Scope (Team Lead, after Raghav's "Yes" 2026-10-26 20:35 IST): exactly
-- the 3 groups (offsetDays, channel) = (-3, email), (0, email), (7, email) on
-- that shop, 3 rows, nothing else. Sizing came from read-only run 40344367330
-- of scripts/readonly/s18-reminder-rule-dupes.sql (shop_idx 2: 3 groups, n=2
-- each, all enabled, 0 ReminderLog rows).
--
-- Run ONLY via .github/workflows/ops-s18-reminder-rule-dedupe.yml.
-- psql variables (both required, neither is a workflow input):
--   shop   dev-store domain from the ALLOWED_DEV_STORE secret (never printed)
--   apply  'false' (dry run, default) or 'true'
--
-- Safety:
--   * Dry run: BEGIN TRANSACTION READ ONLY ... ROLLBACK (the workflow also sets
--     default_transaction_read_only=on). Nothing can be written.
--   * Apply: one read-write transaction. The shop's ReminderRule rows are
--     locked FOR UPDATE, every count and assertion is recomputed from scratch
--     (nothing is carried over from a dry run), and the DELETE runs only if all
--     of them hold. The DELETE is by the computed ids, on that shop, and
--     re-checks NOT EXISTS ReminderLog (the FK is NO ACTION). Afterwards it
--     asserts deleted_rows = 3, the 3 kept rows still exist and 0 duplicate
--     groups remain on the shop; otherwise RAISE, so the transaction rolls back.
--   * Guard failures RAISE 'refuse_rrd:<code>' after the counts are printed;
--     psql exits non-zero (ON_ERROR_STOP) and the transaction rolls back.
--   * Shop guard: exactly 1 "Shop" row with domain = the secret, its currency
--     is 'USD', and its shop_idx (DENSE_RANK() OVER (ORDER BY id), as in
--     s18-reminder-rule-dupes.sql) is 2.
--   * Output: counts, booleans, shop_idx and a refuse code only. No domain,
--     shop/rule ids, GIDs, currency value or text columns are selected; the
--     domain only enters via set_config and is compared, never output.
\set ON_ERROR_STOP 1
SELECT :'apply' IN ('true', 'false') AS apply_valid,
       :'apply' = 'true' AS is_apply
\gset
\if :apply_valid
\else
DO $bad$ BEGIN RAISE EXCEPTION 'refuse_rrd:bad_apply_var'; END $bad$;
\endif

\if :is_apply
BEGIN;
\else
BEGIN TRANSACTION READ ONLY;
\endif
SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '60s';

SELECT set_config('ntr_rrd.shop_domain', :'shop', true) <> '' AS shop_param_set,
       set_config('ntr_rrd.apply', :'apply', true) = 'true' AS is_apply_param
\gset

\echo '== P0 params'
SELECT :'shop_param_set'::boolean AS shop_param_set,
       :'is_apply'::boolean AS is_apply;

-- Compute (and in apply: delete) in one block. Counts go to ntr_rrd.* settings
-- so they print below even when a guard fails; the refuse is raised after.
DO $rrd$
DECLARE
  v_apply        boolean := current_setting('ntr_rrd.apply') = 'true';
  v_domain       text := current_setting('ntr_rrd.shop_domain');
  v_shop_rows    bigint;
  v_shop_id      text;
  v_currency_ok  boolean := false;
  v_shop_idx     bigint;
  v_groups_all   bigint := 0;
  v_groups       bigint := 0;
  v_target_ids   text[];
  v_kept_ids     text[];
  v_with_logs    bigint := 0;
  v_log_rows     bigint := 0;
  v_fk_rows      bigint := 0;
  v_fk           record;
  v_n            bigint;
  v_refuse       text := '';
  v_deleted      bigint := 0;
BEGIN
  IF current_setting('ntr_rrd.apply') NOT IN ('true', 'false') THEN
    RAISE EXCEPTION 'refuse_rrd:bad_apply';
  END IF;

  -- Shop guard (domain from the secret; never output).
  SELECT COUNT(*) INTO v_shop_rows FROM "Shop" s WHERE v_domain <> '' AND s.domain = v_domain;
  IF v_shop_rows = 1 THEN
    SELECT s.id, COALESCE(s.currency = 'USD', false) INTO v_shop_id, v_currency_ok
    FROM "Shop" s WHERE s.domain = v_domain;
    SELECT x.shop_idx INTO v_shop_idx FROM (
      SELECT s.id AS shop_id, DENSE_RANK() OVER (ORDER BY s.id) AS shop_idx FROM "Shop" s
    ) x WHERE x.shop_id = v_shop_id;
  END IF;

  IF v_shop_id IS NOT NULL THEN
    IF v_apply THEN
      -- Lock the shop's rules before counting: no concurrent edit, and no new
      -- ReminderLog can reference a target (its FK check needs KEY SHARE).
      PERFORM 1 FROM "ReminderRule" r WHERE r."shopId" = v_shop_id FOR UPDATE;
    END IF;

    WITH ranked AS (
      SELECT r.id AS rule_id,
             r."offsetDays" AS rk_offset,
             r.channel::text AS rk_channel,
             COUNT(*) OVER (PARTITION BY r."shopId", r."offsetDays", r.channel) AS grp_n,
             ROW_NUMBER() OVER (
               PARTITION BY r."shopId", r."offsetDays", r.channel
               ORDER BY r."createdAt", r.id
             ) AS rn
      FROM "ReminderRule" r
      WHERE r."shopId" = v_shop_id
    ),
    scoped AS (
      SELECT k.* FROM ranked k
      WHERE k.grp_n > 1
        AND (k.rk_offset, k.rk_channel) IN ((-3, 'email'), (0, 'email'), (7, 'email'))
    )
    SELECT (SELECT COUNT(DISTINCT (k.rk_offset, k.rk_channel)) FROM ranked k WHERE k.grp_n > 1),
           (SELECT COUNT(DISTINCT (s.rk_offset, s.rk_channel)) FROM scoped s),
           (SELECT array_agg(s.rule_id ORDER BY s.rule_id) FROM scoped s WHERE s.rn > 1),
           (SELECT array_agg(s.rule_id ORDER BY s.rule_id) FROM scoped s WHERE s.rn = 1)
    INTO v_groups_all, v_groups, v_target_ids, v_kept_ids;

    SELECT COUNT(DISTINCT rl."ruleId"), COUNT(rl."ruleId")
    INTO v_with_logs, v_log_rows
    FROM "ReminderLog" rl
    WHERE rl."ruleId" = ANY(COALESCE(v_target_ids, '{}'));

    -- Runtime FK scan: every FK column referencing ReminderRule.id, known or
    -- not, must have 0 rows pointing at a target.
    FOR v_fk IN
      SELECT c.conrelid, a.attname AS child_col
      FROM pg_constraint c
      CROSS JOIN LATERAL unnest(c.conkey, c.confkey) AS k(child_attnum, parent_attnum)
      JOIN pg_attribute pa ON pa.attrelid = c.confrelid AND pa.attnum = k.parent_attnum
      JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.child_attnum
      WHERE c.contype = 'f' AND c.confrelid = '"ReminderRule"'::regclass AND pa.attname = 'id'
    LOOP
      EXECUTE format('SELECT COUNT(*) FROM %s WHERE %I = ANY($1)', v_fk.conrelid::regclass, v_fk.child_col)
        INTO v_n USING COALESCE(v_target_ids, '{}');
      v_fk_rows := v_fk_rows + v_n;
    END LOOP;
  END IF;

  -- Guards, in order; the first failure is the refuse code.
  IF v_shop_rows <> 1 THEN v_refuse := 'shop_rows_' || v_shop_rows;
  ELSIF NOT v_currency_ok THEN v_refuse := 'currency_not_usd';
  ELSIF v_shop_idx IS DISTINCT FROM 2 THEN v_refuse := 'shop_idx_not_2';
  ELSIF v_groups_all <> 3 THEN v_refuse := 'dup_groups_on_shop_' || v_groups_all;
  ELSIF v_groups <> 3 THEN v_refuse := 'groups_' || v_groups;
  ELSIF COALESCE(cardinality(v_target_ids), 0) <> 3 THEN v_refuse := 'target_rows_' || COALESCE(cardinality(v_target_ids), 0);
  ELSIF COALESCE(cardinality(v_kept_ids), 0) <> 3 THEN v_refuse := 'kept_rows_' || COALESCE(cardinality(v_kept_ids), 0);
  ELSIF v_log_rows <> 0 OR v_with_logs <> 0 THEN v_refuse := 'target_log_rows_' || v_log_rows;
  ELSIF v_fk_rows <> 0 THEN v_refuse := 'fk_rows_' || v_fk_rows;
  END IF;

  PERFORM set_config('ntr_rrd.shop_rows', v_shop_rows::text, true),
          set_config('ntr_rrd.currency_ok', v_currency_ok::text, true),
          set_config('ntr_rrd.shop_idx', COALESCE(v_shop_idx, 0)::text, true),
          set_config('ntr_rrd.dup_groups_on_shop', v_groups_all::text, true),
          set_config('ntr_rrd.groups', v_groups::text, true),
          set_config('ntr_rrd.target_rows', COALESCE(cardinality(v_target_ids), 0)::text, true),
          set_config('ntr_rrd.target_rows_with_logs', v_with_logs::text, true),
          set_config('ntr_rrd.target_log_rows', v_log_rows::text, true),
          set_config('ntr_rrd.target_fk_rows', v_fk_rows::text, true),
          set_config('ntr_rrd.kept_rows', COALESCE(cardinality(v_kept_ids), 0)::text, true),
          set_config('ntr_rrd.refuse', v_refuse, true),
          set_config('ntr_rrd.guard_passed', (v_refuse = '')::text, true),
          set_config('ntr_rrd.deleted_rows', '0', true);

  IF v_apply AND v_refuse = '' THEN
    DELETE FROM "ReminderRule" r
    WHERE r.id = ANY(v_target_ids)
      AND r."shopId" = v_shop_id
      AND NOT EXISTS (SELECT 1 FROM "ReminderLog" rl WHERE rl."ruleId" = r.id);
    GET DIAGNOSTICS v_deleted = ROW_COUNT;
    IF v_deleted <> 3 THEN RAISE EXCEPTION 'refuse_rrd:deleted_rows_%', v_deleted; END IF;

    SELECT COUNT(*) INTO v_n FROM "ReminderRule" r WHERE r.id = ANY(v_target_ids);
    IF v_n <> 0 THEN RAISE EXCEPTION 'refuse_rrd:targets_remaining_%', v_n; END IF;
    SELECT COUNT(*) INTO v_n FROM "ReminderRule" r WHERE r.id = ANY(v_kept_ids) AND r."shopId" = v_shop_id;
    IF v_n <> 3 THEN RAISE EXCEPTION 'refuse_rrd:kept_rows_after_%', v_n; END IF;
    SELECT COUNT(*) INTO v_n FROM (
      SELECT 1 FROM "ReminderRule" r WHERE r."shopId" = v_shop_id
      GROUP BY r."offsetDays", r.channel HAVING COUNT(*) > 1
    ) d;
    IF v_n <> 0 THEN RAISE EXCEPTION 'refuse_rrd:dup_groups_after_%', v_n; END IF;
    PERFORM set_config('ntr_rrd.deleted_rows', v_deleted::text, true);
  END IF;
END
$rrd$;

\echo '== R1 counts (shop resolved from the secret; domain and ids not printed)'
SELECT current_setting('ntr_rrd.shop_rows')::int AS shop_rows,
       current_setting('ntr_rrd.currency_ok')::boolean AS currency_is_usd,
       current_setting('ntr_rrd.shop_idx')::int AS shop_idx,
       current_setting('ntr_rrd.dup_groups_on_shop')::int AS dup_groups_on_shop,
       current_setting('ntr_rrd.groups')::int AS groups,
       current_setting('ntr_rrd.target_rows')::int AS target_rows,
       current_setting('ntr_rrd.target_rows_with_logs')::int AS target_rows_with_logs,
       current_setting('ntr_rrd.target_log_rows')::int AS target_log_rows,
       current_setting('ntr_rrd.target_fk_rows')::int AS target_fk_rows,
       current_setting('ntr_rrd.kept_rows')::int AS kept_rows,
       current_setting('ntr_rrd.guard_passed')::boolean AS guard_passed,
       NULLIF(current_setting('ntr_rrd.refuse'), '') AS refuse_code;

\echo '== R2 after (apply: rows deleted; dry run: 0 and nothing changed)'
SELECT current_setting('ntr_rrd.deleted_rows')::int AS deleted_rows,
       (SELECT COUNT(*) FROM (
          SELECT 1 FROM "ReminderRule" r JOIN "Shop" s ON s.id = r."shopId"
          WHERE s.domain = current_setting('ntr_rrd.shop_domain')
          GROUP BY r."offsetDays", r.channel HAVING COUNT(*) > 1) d) AS dup_groups_on_shop_now,
       (SELECT COUNT(*) FROM "ReminderRule" r JOIN "Shop" s ON s.id = r."shopId"
          WHERE s.domain = current_setting('ntr_rrd.shop_domain')) AS shop_rules_now,
       (SELECT COUNT(*) FILTER (WHERE r.enabled) FROM "ReminderRule" r JOIN "Shop" s ON s.id = r."shopId"
          WHERE s.domain = current_setting('ntr_rrd.shop_domain')) AS shop_rules_enabled_now,
       :'is_apply'::boolean AS apply_mode;

-- Fail closed: a refused guard exits non-zero and rolls back (no writes were made).
DO $guard$
BEGIN
  IF current_setting('ntr_rrd.guard_passed') <> 'true' THEN
    RAISE EXCEPTION 'refuse_rrd:%', current_setting('ntr_rrd.refuse');
  END IF;
END
$guard$;

\if :is_apply
COMMIT;
\echo '== committed=true'
\else
ROLLBACK;
\echo '== committed=false (dry run, read-only, rolled back)'
\endif
