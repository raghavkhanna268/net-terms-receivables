-- s18-reminder-rule-dupes.sql (READ-ONLY)
-- Sizing for the duplicate ReminderRule bug: rules that share the same
-- (shopId, offsetDays, channel). Feeds Raghav's dedupe decision. Nothing is
-- changed here; the dedupe itself is a separate, approved step.
--
-- A  one row per duplicate group (GROUP BY shopId, offsetDays, channel
--    HAVING COUNT(*) > 1): has_shop, offset_days, channel, n (rules in the
--    group), distinct_create_minutes (distinct createdAt minutes; 1 = the
--    copies were created in the same minute, e.g. a double submit / race),
--    n_enabled, rules_with_logs and log_rows (ReminderLog rows on the group's
--    rules; NoAction FK, so a logged rule cannot simply be deleted).
-- B  totals over all duplicate groups: rules with any ReminderLog row
--    (COUNT(DISTINCT rl."ruleId")) and total ReminderLog rows.
-- C  shops affected, duplicate groups, rules in those groups, and excess rules
--    (rules beyond the first per group = what a dedupe would remove).
--
-- shop_idx = DENSE_RANK over all Shop ids, as in s12-hold-coverage.sql. Raw
-- shop / rule ids are never printed. offset_days is the rule's day offset
-- (merchant config, e.g. -3, 0, 7), printed only through a digits-only guard;
-- channel is the ReminderChannel enum (native | email), guarded to those values.
-- No text columns are selected. Counts, enums, booleans and ids only. Vars: none.
\set ON_ERROR_STOP 1
BEGIN TRANSACTION READ ONLY;

\echo '== A duplicate ReminderRule groups (shopId, offsetDays, channel) with n > 1'
WITH shops AS (
  SELECT s.id AS shop_id,
         DENSE_RANK() OVER (ORDER BY s.id) AS shop_idx
  FROM "Shop" s
),
grp AS (
  SELECT r."shopId" AS grp_shop,
         r."offsetDays" AS grp_offset,
         r.channel AS grp_channel,
         COUNT(*) AS n,
         COUNT(DISTINCT date_trunc('minute', r."createdAt")) AS distinct_create_minutes,
         COUNT(*) FILTER (WHERE r.enabled = true) AS n_enabled
  FROM "ReminderRule" r
  GROUP BY r."shopId", r."offsetDays", r.channel
  HAVING COUNT(*) > 1
),
logs AS (
  SELECT r."shopId" AS log_shop,
         r."offsetDays" AS log_offset,
         r.channel AS log_channel,
         COUNT(DISTINCT rl."ruleId") AS rules_with_logs,
         COUNT(rl."ruleId") AS log_rows
  FROM "ReminderRule" r
  INNER JOIN grp g
      ON g.grp_shop = r."shopId"
      AND g.grp_offset = r."offsetDays"
      AND g.grp_channel = r.channel
  LEFT JOIN "ReminderLog" rl ON rl."ruleId" = r.id
  GROUP BY r."shopId", r."offsetDays", r.channel
)
SELECT sh.shop_idx,
       g.grp_shop IS NOT NULL AS has_shop,
       CASE WHEN g.grp_offset::TEXT ~ '^-?[0-9]{1,4}$' THEN g.grp_offset::TEXT END AS offset_days,
       CASE WHEN g.grp_channel::TEXT IN ('native', 'email') THEN g.grp_channel::TEXT END AS channel,
       g.n,
       g.distinct_create_minutes,
       g.n_enabled,
       l.rules_with_logs,
       l.log_rows
FROM grp g
LEFT JOIN shops sh ON sh.shop_id = g.grp_shop
LEFT JOIN logs l
    ON l.log_shop = g.grp_shop
    AND l.log_offset = g.grp_offset
    AND l.log_channel = g.grp_channel
ORDER BY sh.shop_idx, g.grp_offset, g.grp_channel;

\echo '== B ReminderLog over rules in duplicate groups (totals)'
WITH grp AS (
  SELECT r."shopId" AS grp_shop,
         r."offsetDays" AS grp_offset,
         r.channel AS grp_channel
  FROM "ReminderRule" r
  GROUP BY r."shopId", r."offsetDays", r.channel
  HAVING COUNT(*) > 1
)
SELECT COUNT(DISTINCT rl."ruleId") AS dup_rules_with_logs,
       COUNT(rl."ruleId") AS dup_log_rows
FROM "ReminderRule" r
INNER JOIN grp g
    ON g.grp_shop = r."shopId"
    AND g.grp_offset = r."offsetDays"
    AND g.grp_channel = r.channel
LEFT JOIN "ReminderLog" rl ON rl."ruleId" = r.id;

\echo '== C shops affected, duplicate groups, rules in them, excess rules'
WITH ranked AS (
  SELECT r."shopId" AS rk_shop,
         r."offsetDays" AS rk_offset,
         r.channel AS rk_channel,
         COUNT(*) OVER (PARTITION BY r."shopId", r."offsetDays", r.channel) AS grp_n,
         ROW_NUMBER() OVER (
           PARTITION BY r."shopId", r."offsetDays", r.channel
           ORDER BY r."createdAt", r.id
         ) AS rn
  FROM "ReminderRule" r
)
SELECT COUNT(DISTINCT k.rk_shop) AS shops_affected,
       COUNT(*) FILTER (WHERE k.rn = 1) AS dup_groups,
       COUNT(*) AS dup_rules,
       COUNT(*) FILTER (WHERE k.rn > 1) AS excess_rules
FROM ranked k
WHERE k.grp_n > 1;

ROLLBACK;
