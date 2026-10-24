# scripts/readonly

Committed, read-only SQL that the `prod-readonly-query` and `prod-diagnostics`
workflows run against production. Their output lands in **public** Actions logs.

## Public-logs rule (Team Lead, 2026-10-24 17:58 IST)

Every printed column must be one of:

| kind         | examples                                                                                                                                                |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`         | `invoice_id`, `order_gid`, `msg_id`, row indexes like `shop_idx`                                                                                        |
| `count`      | `COUNT(*)`, `read_ct`, `syncVersion`                                                                                                                    |
| `enum`       | `status`, `topic`, regex-guarded codes, `CASE` mappings to literals; app-written fixed-code TEXT columns such as `dueBasis`/`due_basis` and `dueSource` |
| `boolean`    | `x IS NOT NULL`, `outstanding > 0`, `bool_or(...)`                                                                                                      |
| `timestamp`  | `*_at`, `MIN(at)`; includes ages/intervals derived from timestamps (e.g. `issued_at_days_ago`, `past_due_by`)                                           |
| `config_int` | named merchant settings only, whole numbers 0 to 365: currently just `defaultTermsDays`                                                                 |

`config_int` (Team Lead ruling via QA on #193) is for named merchant settings
on the explicit list `CONFIG_INT_COLUMNS` in the checker. Its value must be a
whole number from 0 to 365, so clamp it in SQL
(`CASE WHEN x BETWEEN 0 AND 365 THEN x END`). The check fails
(`config_int_not_listed`) if the output name, or any source column it passes
through, is not on the list. Adding a name needs Team Lead / QA sign-off. It
never bypasses the sensitive check below.

Never: shop domains, PII (names, emails, phones, addresses, notes, narration,
payer text), free text, raw error/reason text, payloads, tokens, or per-shop
money (amount, outstanding, balance, credit limit, price). Map such values to
an enum, boolean or count in SQL instead.

## CI check: `scripts/ci/check-readonly-columns.ts`

Runs in `ci.yml` next to the logging guard (`npx tsx scripts/ci/check-readonly-columns.ts`).
For each statement it finds the outermost select list (all `UNION` branches;
an unaliased `json_build_object` is expanded per key) and classifies every
output column:

1. **Derived from the expression** (no annotation needed): `COUNT` → count;
   `ROW_NUMBER/RANK/DENSE_RANK OVER` → id; comparisons, `IS [NOT] NULL`,
   `EXISTS`, `LIKE`, `IN`, `bool_and/bool_or` → boolean; string literal → enum;
   `CASE` whose results are all literals/NULL or guarded passthroughs
   (`WHEN x ~ '^[A-Z0-9_]{1,40}$' THEN x`, `WHEN x IN ('a','b') THEN x`) → enum;
   `COALESCE`, casts, `MIN/MAX` keep the inner kind; `NOW() - x` → timestamp
   only when that is the whole expression (`x` a column, cast column or
   `INTERVAL '...'` literal).

   **Guards.** The `WHEN` must be exactly `x ~ 're'` / `x IN ('a', ...)` on the
   same `x` the `THEN` prints, or an AND-only conjunction containing it (any
   top-level `OR` disqualifies it). The regex must be anchored `^...$` and use
   only literal characters and non-negated `[...]` classes from
   `A-Z a-z 0-9 _ : -`, groups, `|`, `?` and `{m,n}` with `n <= 64`. No `.`,
   `@`, `/`, `,`, spaces, backslash escapes, `[^...]`, POSIX classes, `*`/`+`.
   The guarded column still gets the sensitive-name check, so a guarded
   `shopDomain` fails.

2. **Annotation** in the file header, for plain passthrough columns:

   ```sql
   -- @col status, topic, "holdState": enum
   -- @col read_ct: count
   -- @col "manualHold", bypass: boolean
   ```

   Names are Postgres output names (alias, else column name; unquoted names
   fold to lower case). Annotations that name no output column fail
   (`stale_annotation`). Only annotate what really is one of the six kinds;
   the annotation is the reviewer's checklist.

3. **Naming convention**: `id`, `*_id`, `*Id`, `*_gid`, `*Gid`, `*_idx` → id;
   `at`, `*_at`, `*At`, `*_date`, `*Date` → timestamp. It applies only when the
   expression is a plain column ref (optionally cast, `COALESCE(ref, literal)`
   or `ref->>'key'`) **and the source column / key follows the same
   convention**. `SELECT address1 AS addr_id` or `max(zip) AS last_at` is not
   an id/timestamp. Other functions (`row_to_json`, `to_json`, `string_agg`,
   `array_agg`, `concat`, `format`, `replace` ...) are unclassified unless
   annotated. A whole-row reference (`SELECT s FROM "Shop" s`,
   `row_to_json(s)`) always fails (`whole_row`), annotated or not.

Separately, any column that is not a derived count/boolean is rejected as
`sensitive` if its output name, or a column / JSON key it passes through,
looks like a domain/shop, email, phone, address, name, note, narration, payer,
text/message/payload/body/raw, error/reason (unless `*_code`, `*_kind`,
`*_format`, ...), money (amount, price, balance, outstanding, limit), token or
secret. Annotations cannot override that. `SELECT *`, `SUM/AVG` and other
unclassifiable expressions fail too, as does any statement other than
`SELECT`/`WITH`/`SHOW`/`BEGIN`/`COMMIT`/`ROLLBACK`. A `UNION`/`INTERSECT`/
`EXCEPT` branch must be a plain `SELECT` (`VALUES`, `TABLE`, a parenthesised
branch, or `WITH ... TABLE x` are `unparseable`).

**psql meta commands.** Only `\set ON_ERROR_STOP 1` and `\echo` with
single-quoted literals (psql does not expand `:var` inside single quotes) are
allowed. Any other backslash command, at line start or after a query (`\copy`,
`\g`, `\gset`, `\gx`, `\o`, `\!`, `\i`/`\ir`, `\qecho`, `\x`, `\pset`, an
unquoted `:var`, backticks ...), fails as `unsupported_statement`.

### Burn-down allowlist

`scripts/ci/readonly-columns-allowlist.json` lists existing violations as
`{file, column, issue, count}`. CI fails on any violation not covered and on
any entry whose count is higher than what the checker now finds (stale), so
the list can only shrink. Do not add new entries; fix the SQL. It is currently
empty (`"entries": []`); the mechanism stays for future burn-downs.

- Entries with issue `sensitive`, `star`, `unsupported_statement`,
  `bad_annotation`, `config_int_not_listed` or `whole_row` are rejected, as are
  duplicate keys and non-positive counts.
- Shrink-only across commits: a test pins the committed entry set and total
  (`scripts/ci/__tests__/check-readonly-columns.test.ts`), so any new entry or
  higher count needs a visible test edit in review.

Local run: `npx tsx scripts/ci/check-readonly-columns.ts` (add `--report` to
list every column with its kind and how it was classified).
