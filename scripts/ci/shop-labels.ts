/**
 * Canonical shop identity label CTE for scripts/readonly/*.sql.
 *
 * shop_kind is derived in SQL from the masked psql vars :'allowed'
 * (ALLOWED_DEV_STORE) and :'e2e' (E2E_SHOP):
 *   main     the Shop whose domain = :'allowed'
 *   e2e      the Shop whose domain = :'e2e'
 *   other_N  every other Shop, numbered by Shop.id among the non-main,
 *            non-e2e shops. N is stable within ONE run (every section of a
 *            script uses the same CTE over all Shop rows) but it does NOT
 *            identify a shop across runs: a new shop whose id sorts first
 *            renumbers the others.
 *   unknown  every Shop, when either secret is empty or both are equal.
 * Domains are only compared, never printed. Each listed file embeds this text
 * verbatim; scripts/ci/__tests__/shop-identity-labels.test.ts pins it.
 */
export const SHOP_LABELS_CTE = `shop_labels AS (
  SELECT s.id AS shop_id,
         CASE WHEN :'allowed' = '' OR :'e2e' = '' OR :'allowed' = :'e2e' THEN 'unknown'
              WHEN s.domain = :'allowed' THEN 'main'
              WHEN s.domain = :'e2e' THEN 'e2e'
              ELSE 'other_' || (ROW_NUMBER() OVER (
                     PARTITION BY s.domain IN (:'allowed', :'e2e')
                     ORDER BY s.id))::text
         END AS shop_kind
  FROM "Shop" s
)`;

/** Read-only scripts that label shops with SHOP_LABELS_CTE. */
export const SHOP_LABEL_SCRIPTS = [
  "offline-session-preflight",
  "post-drain-aggregates",
  "s12-hold-coverage",
  "s18-reminder-rule-dupes",
  "s18-reminders-due-7d",
  "schedule-dueat-utc-time",
] as const;

/** Values shop_kind may take. */
export const SHOP_KIND_RE = /^(main|e2e|unknown|other_[1-9][0-9]*)$/;

/** Remove every embedded copy of the CTE (for "no .domain / no vars" checks). */
export function stripShopLabelsCte(sql: string): string {
  return sql.split(SHOP_LABELS_CTE).join("shop_labels AS (/* canonical */)");
}
