#!/usr/bin/env npx tsx
/**
 * CI guard: public-logs column check for scripts/readonly/*.sql (#190 F5).
 *
 * The prod-readonly-query / prod-diagnostics workflows print the output of
 * these files into PUBLIC Actions logs. Team Lead's public-logs rule
 * (2026-10-24 17:58 IST): output columns may only be
 *
 *     id | count | enum | boolean | timestamp | config_int
 *
 * (id includes row indexes such as shop_idx; timestamp includes time-derived
 * values such as intervals and day ages). Never shop domains, PII/emails,
 * free text, raw errors or per-shop money.
 *
 * config_int (Team Lead ruling via QA on #193): a whole number 0..365 that is
 * a NAMED merchant setting. Only columns listed in CONFIG_INT_COLUMNS may use
 * it (currently just defaultTermsDays), and every source column the value
 * passes through must be on that list too, so it cannot relabel another
 * integer. It never bypasses the sensitive check: money, balances, credit
 * limits and any per-buyer value stay forbidden. Clamp the range in SQL, e.g.
 * CASE WHEN x BETWEEN 0 AND 365 THEN x END.
 *
 * How it works (deliberately small, no SQL grammar dependency):
 *   1. Strip comments and psql meta lines (\set, \echo ...), split on `;`.
 *   2. For every top-level SELECT / WITH ... SELECT / SHOW statement, find the
 *      outermost select list (and every UNION branch) and split it into
 *      output columns. An unaliased json_build_object(...) is expanded into
 *      one column per key. Column names follow Postgres rules (alias, else
 *      the column/function name; unquoted identifiers fold to lower case).
 *      A ref to a CTE / FROM-subquery column is replaced by the inner
 *      expression it names (recursively; see resolveExpr), so an inner alias
 *      cannot launder a column. A UNION body or ambiguous name yields several
 *      variants and every variant must pass.
 *   3. Classify each column, in order:
 *      a. Derived from the expression shape (no annotation needed):
 *         COUNT(...)                      -> count
 *         ROW_NUMBER/RANK/DENSE_RANK OVER -> id (index)
 *         comparison, IS [NOT] NULL, EXISTS, LIKE, IN, bool_and/bool_or,
 *         TRUE/FALSE                      -> boolean
 *         string literal                  -> enum
 *         'prefix' || (ROW_NUMBER/RANK/DENSE_RANK() OVER (...))[::text]
 *           (prefix ^[a-z][a-z0-9_]{0,31}$, e.g. shop_kind other_N)
 *                                         -> enum
 *         CASE whose results are all literals / NULL / guarded passthroughs
 *           (WHEN x ~ '^[...]{1,N}$' THEN x, or WHEN x IN ('a','b') THEN x)
 *                                         -> enum
 *         COALESCE(x, literal...), x::type, (x) -> kind of x
 *         MIN/MAX(x)                      -> kind of x
 *         NOW() - x (whole expression only, x a ref/cast/INTERVAL literal)
 *                                         -> timestamp (interval)
 *         Guards: WHEN must be exactly x ~ 're' / x IN (...) or an AND-only
 *         conjunction containing it (no OR). Regex: see isSafeGuardRegex
 *         (A-Za-z0-9_:- classes, no negation/escapes/./@, bound <= 64).
 *         The guarded column still gets the sensitive check (step 4).
 *      b. An explicit file annotation:   -- @col <name>[, <name>...]: <kind>
 *         This is how plain passthrough columns (status, type, kind,
 *         "holdState", "manualHold", read_ct ...) are declared. A reviewer
 *         reads the annotation, so annotate only what is truly one of the
 *         six kinds.
 *      c. Naming convention, only for a plain column ref (optionally cast,
 *         COALESCE(ref, literal) or ref->>'key') whose SOURCE name follows the
 *         same convention as the output name:
 *         id, *_id, *Id, *_gid, *Gid, *_idx -> id
 *         at, *_at, *At, *_date, *Date      -> timestamp
 *         A whole-row reference (SELECT s / row_to_json(s)) always fails
 *         (`whole_row`).
 *   4. Independently of 3b/3c, a column is REJECTED as `sensitive` when it is
 *      not a derived count/boolean and its output name, or any column / JSON
 *      key it passes through, looks like a domain, shop, email, phone,
 *      address, name, note, narration, payer, free text/message/payload,
 *      raw error/reason, money (amount/price/balance/outstanding/limit) or a
 *      token/secret. An annotation cannot override this; map the value to an
 *      enum/boolean/count in SQL instead.
 *   4b. Session credential columns (SESSION_CREDENTIAL_COLUMNS: the OAuth
 *      tokens, their expiry times and the OAuth state) may only feed a
 *      DERIVED boolean or count, e.g. `bool_or(se."refreshToken" IS NOT NULL)`
 *      or `se."refreshTokenExpires" > NOW()`. Any other use (passthrough,
 *      annotation, convention, CASE result, to_char, ...) is rejected as
 *      `sensitive`, so a token value or an expiry time can never be printed.
 *      Also rejected: SELECT * (`star`), SUM/AVG and other unclassifiable
 *      expressions (`unclassified`), statements that are not SELECT/WITH/
 *      SHOW/BEGIN/COMMIT/ROLLBACK, e.g. SET (`unsupported_statement`), unparseable
 *      select lists (`unparseable`), annotations naming a column that is not
 *      in the output (`stale_annotation`), an invalid kind
 *      (`bad_annotation`) or config_int on a column / source that is not in
 *      CONFIG_INT_COLUMNS (`config_int_not_listed`).
 *
 *   5. psql meta commands: only `\set ON_ERROR_STOP 1` and `\echo '<literal>'`.
 *      Anything else (\copy, \g*, \o, \!, \i, \qecho, :var ...) is
 *      `unsupported_statement`. Set-operator branches must be plain SELECTs.
 *
 * Burn-down allowlist: scripts/ci/readonly-columns-allowlist.json, entries
 * {file, column, issue, count}. CI fails on any violation not covered, and on
 * any entry whose count is now higher than the actual count (stale), so the
 * list can only shrink. Never-allowlist issues (NEVER_ALLOWLIST) and duplicate
 * keys are rejected; a test pins the committed entries (shrink-only).
 *
 * Usage: npx tsx scripts/ci/check-readonly-columns.ts
 * Env (tests): READONLY_COLUMNS_ROOT (repo root), READONLY_COLUMNS_ALLOWLIST.
 */

import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

export const KINDS = [
  "id",
  "count",
  "enum",
  "boolean",
  "timestamp",
  "config_int",
] as const;
export type Kind = (typeof KINDS)[number];

/**
 * Named merchant settings allowed to print as config_int (whole number 0..365).
 * Adding a name here needs Team Lead / QA sign-off.
 */
export const CONFIG_INT_COLUMNS: readonly string[] = ["defaultTermsDays"];

/**
 * Session (prisma/schema.prisma model Session) columns that hold a credential
 * or its expiry time. Matched case-insensitively against every column the
 * output expression reads; allowed only inside a derived boolean/count.
 */
export const SESSION_CREDENTIAL_COLUMNS: readonly string[] = [
  "accessToken",
  "refreshToken",
  "refreshTokenExpires",
  "expires",
  "state",
];
const SESSION_CREDENTIAL_SET = new Set(
  SESSION_CREDENTIAL_COLUMNS.map((c) => c.toLowerCase()),
);

export type Issue =
  | "sensitive"
  | "unclassified"
  | "star"
  | "unparseable"
  | "unsupported_statement"
  | "stale_annotation"
  | "bad_annotation"
  | "config_int_not_listed"
  | "whole_row";

/** Issues that can never be allowlisted: fix the SQL instead. */
export const NEVER_ALLOWLIST: readonly Issue[] = [
  "sensitive",
  "star",
  "unsupported_statement",
  "bad_annotation",
  "config_int_not_listed",
  "whole_row",
];

export interface Violation {
  file: string;
  column: string;
  issue: Issue;
  detail: string;
}

export interface AllowlistEntry {
  file: string;
  column: string;
  issue: Issue;
  count: number;
  note?: string;
}

// ============================================================================
// Tokenizer
// ============================================================================

type TokType =
  "ident" | "qident" | "string" | "number" | "op" | "punct" | "var";
interface Tok {
  t: TokType;
  v: string; // normalized value: unquoted idents lower-cased, strings unquoted
  raw: string;
}

/**
 * Tokenize SQL. psql meta commands (a backslash outside strings/comments, at
 * line start or mid-line) are removed from the token stream and, when `metas`
 * is given, collected there (the backslash to end of line) for checkMeta().
 */
export function tokenize(sql: string, metas?: string[]): Tok[] {
  const toks: Tok[] = [];
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const c = sql[i];
    if (c === "\n") {
      i++;
      continue;
    }
    if (c === " " || c === "\t" || c === "\r") {
      i++;
      continue;
    }
    // psql meta command: backslash to end of line (line start or mid-line)
    if (c === "\\") {
      const start = i;
      while (i < n && sql[i] !== "\n") i++;
      metas?.push(sql.slice(start, i).trim());
      continue;
    }
    if (c === "-" && sql[i + 1] === "-") {
      while (i < n && sql[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && sql[i + 1] === "*") {
      const end = sql.indexOf("*/", i + 2);
      i = end < 0 ? n : end + 2;
      continue;
    }
    if (c === "'" || ((c === "E" || c === "e") && sql[i + 1] === "'")) {
      const start = i;
      if (c !== "'") i++;
      i++;
      let val = "";
      while (i < n) {
        if (sql[i] === "'" && sql[i + 1] === "'") {
          val += "'";
          i += 2;
        } else if (sql[i] === "'") {
          i++;
          break;
        } else {
          val += sql[i++];
        }
      }
      toks.push({ t: "string", v: val, raw: sql.slice(start, i) });
      continue;
    }
    if (c === '"') {
      const start = i++;
      let val = "";
      while (i < n) {
        if (sql[i] === '"' && sql[i + 1] === '"') {
          val += '"';
          i += 2;
        } else if (sql[i] === '"') {
          i++;
          break;
        } else {
          val += sql[i++];
        }
      }
      toks.push({ t: "qident", v: val, raw: sql.slice(start, i) });
      continue;
    }
    // psql variable :'x' / :"x" / :x  (but not the :: cast operator)
    if (c === ":" && sql[i + 1] !== ":" && sql[i - 1] !== ":") {
      const m = /^:(?:'[^']*'|"[^"]*"|[A-Za-z_][A-Za-z0-9_]*)/.exec(
        sql.slice(i),
      );
      if (m) {
        toks.push({ t: "var", v: m[0], raw: m[0] });
        i += m[0].length;
        continue;
      }
    }
    if (/[A-Za-z_]/.test(c)) {
      const m = /^[A-Za-z_][A-Za-z0-9_$]*/.exec(sql.slice(i))!;
      toks.push({ t: "ident", v: m[0].toLowerCase(), raw: m[0] });
      i += m[0].length;
      continue;
    }
    if (/[0-9]/.test(c)) {
      const m = /^[0-9]+(?:\.[0-9]+)?/.exec(sql.slice(i))!;
      toks.push({ t: "number", v: m[0], raw: m[0] });
      i += m[0].length;
      continue;
    }
    if ("(),;[].".includes(c)) {
      toks.push({ t: "punct", v: c, raw: c });
      i++;
      continue;
    }
    const m =
      /^(?:->>|->|#>>|#>|::|<>|!=|<=|>=|!~\*|!~|~\*|\|\||[-+*/%<>=~!?@#&|^])/.exec(
        sql.slice(i),
      );
    if (m) {
      toks.push({ t: "op", v: m[0], raw: m[0] });
      i += m[0].length;
      continue;
    }
    i++; // unknown char: skip
  }
  return toks;
}

/**
 * psql meta commands allowed in scripts/readonly: only `\set ON_ERROR_STOP 1`
 * and `\echo` followed by single-quoted literals (psql does not interpolate
 * :vars inside single quotes). Everything else (\copy, \g*, \o, \!, \i,
 * \qecho, \x, \pset, an unquoted :var, backticks ...) can print or run
 * something the column check cannot see. Returns the offending commands.
 */
export function checkMeta(metas: string[]): string[] {
  const bad: string[] = [];
  for (const m of metas) {
    if (/^\\set\s+ON_ERROR_STOP\s+(1|on)\s*$/i.test(m)) continue;
    if (/^\\echo(\s+'(?:[^'\\]|''|\\[nt'\\])*')+\s*$/.test(m)) continue;
    bad.push(m);
  }
  return bad;
}

const isKw = (tok: Tok | undefined, ...kws: string[]) =>
  !!tok && tok.t === "ident" && kws.includes(tok.v);
const isP = (tok: Tok | undefined, p: string) =>
  !!tok && (tok.t === "punct" || tok.t === "op") && tok.v === p;

function splitStatements(toks: Tok[]): Tok[][] {
  const out: Tok[][] = [];
  let cur: Tok[] = [];
  let depth = 0;
  for (const tk of toks) {
    if (isP(tk, "(")) depth++;
    if (isP(tk, ")")) depth--;
    if (isP(tk, ";") && depth <= 0) {
      if (cur.length) out.push(cur);
      cur = [];
      depth = 0;
      continue;
    }
    cur.push(tk);
  }
  if (cur.length) out.push(cur);
  return out;
}

/** Depth map: paren depth before each token (CASE..END does not count). */
function depths(toks: Tok[]): number[] {
  const d: number[] = [];
  let depth = 0;
  for (const tk of toks) {
    if (isP(tk, ")")) depth--;
    d.push(depth);
    if (isP(tk, "(")) depth++;
  }
  return d;
}

/** Split on commas at paren depth 0. */
function splitTop(toks: Tok[], sep = ","): Tok[][] {
  const out: Tok[][] = [];
  const d = depths(toks);
  let cur: Tok[] = [];
  toks.forEach((tk, i) => {
    if (d[i] === 0 && isP(tk, sep)) {
      out.push(cur);
      cur = [];
    } else cur.push(tk);
  });
  out.push(cur);
  return out;
}

/** Remove redundant outer parentheses. */
function unwrap(toks: Tok[]): Tok[] {
  let t = toks;
  while (t.length >= 2 && isP(t[0], "(") && isP(t[t.length - 1], ")")) {
    const d = depths(t);
    // outer parens wrap everything iff no token in between is at depth 0
    if (d.slice(1, -1).some((x) => x === 0)) break;
    if (isKw(t[1], "select", "with")) break; // scalar subquery, keep
    t = t.slice(1, -1);
  }
  return t;
}

const text = (toks: Tok[]) => toks.map((x) => x.raw).join(" ");

// ============================================================================
// Select-list extraction
// ============================================================================

interface OutCol {
  name: string;
  expr: Tok[];
}

const SELECT_END = new Set([
  "from",
  "where",
  "group",
  "order",
  "limit",
  "having",
  "window",
  "offset",
  "fetch",
  "into",
  "union",
  "intersect",
  "except",
]);

/** Return the select lists (one per UNION branch) of the outermost query. */
function outerSelectLists(stmt: Tok[]): Tok[][] | null {
  const d = depths(stmt);
  const lists: Tok[][] = [];
  let i = 0;
  // skip WITH ... : first depth-0 SELECT. Between CTE bodies only `,` / AS /
  // SELECT may follow a depth-0 `)`, so `WITH x AS (...) TABLE x` / `VALUES`
  // is unparseable (fail closed) rather than silently skipped.
  while (i < stmt.length && !(d[i] === 0 && isKw(stmt[i], "select"))) {
    if (
      d[i] === 0 &&
      isP(stmt[i], ")") &&
      !(isP(stmt[i + 1], ",") || isKw(stmt[i + 1], "as", "select"))
    )
      return null;
    i++;
  }
  if (i >= stmt.length) return null;
  while (i < stmt.length) {
    i++; // past SELECT
    if (isKw(stmt[i], "distinct", "all")) {
      if (isKw(stmt[i], "distinct") && isKw(stmt[i + 1], "on")) {
        // DISTINCT ON (...)
        i += 2;
        let depth = 0;
        do {
          if (isP(stmt[i], "(")) depth++;
          if (isP(stmt[i], ")")) depth--;
          i++;
        } while (i < stmt.length && depth > 0);
      } else i++;
    }
    const start = i;
    let caseDepth = 0;
    while (i < stmt.length) {
      const tk = stmt[i];
      if (d[i] === 0) {
        if (isKw(tk, "case")) caseDepth++;
        else if (isKw(tk, "end")) caseDepth--;
        else if (caseDepth === 0 && tk.t === "ident" && SELECT_END.has(tk.v)) {
          // IS [NOT] DISTINCT FROM
          if (tk.v === "from" && isKw(stmt[i - 1], "distinct")) {
            i++;
            continue;
          }
          break;
        }
      }
      i++;
    }
    lists.push(stmt.slice(start, i));
    // find next depth-0 UNION/INTERSECT/EXCEPT ... SELECT
    let found = false;
    while (i < stmt.length) {
      if (d[i] === 0 && isKw(stmt[i], "union", "intersect", "except")) {
        // the next branch must be a plain SELECT; VALUES / TABLE / (subquery)
        // branches are not inspected, so fail closed (unparseable)
        let j = i + 1;
        if (isKw(stmt[j], "all", "distinct")) j++;
        if (!isKw(stmt[j], "select")) return null;
        i = j;
        found = true;
        break;
      }
      i++;
    }
    if (!found) break;
  }
  return lists;
}

function defaultName(expr: Tok[]): string {
  let e = unwrap(expr);
  // strip trailing ::type casts
  const d = depths(e);
  for (let k = e.length - 1; k > 0; k--) {
    if (d[k] === 0 && isP(e[k], "::")) {
      e = e.slice(0, k);
      break;
    }
  }
  e = unwrap(e);
  if (e.length === 0) return "?column?";
  const last = e[e.length - 1];
  // column ref: ident(.ident)*
  const isRef = e.every((tk, k) =>
    k % 2 === 0 ? tk.t === "ident" || tk.t === "qident" : isP(tk, "."),
  );
  if (isRef) return last.v;
  if (e[0].t === "ident" && isP(e[1], "(")) {
    // function call spanning the whole expression (incl. FILTER / OVER)
    if (isKw(e[0], "exists")) return "exists";
    return e[0].v;
  }
  if (isKw(e[0], "case")) return "case";
  return "?column?";
}

function splitAlias(item: Tok[]): { expr: Tok[]; alias: string | null } {
  const n = item.length;
  if (
    n >= 3 &&
    isKw(item[n - 2], "as") &&
    (item[n - 1].t === "ident" || item[n - 1].t === "qident")
  ) {
    return { expr: item.slice(0, n - 2), alias: item[n - 1].v };
  }
  // bare alias: `expr alias`
  if (n >= 2 && (item[n - 1].t === "ident" || item[n - 1].t === "qident")) {
    const prev = item[n - 2];
    const reserved = [
      "null",
      "true",
      "false",
      "end",
      "and",
      "or",
      "not",
      "is",
      "in",
      "like",
      "ilike",
      "then",
      "else",
      "when",
      "distinct",
      "from",
      "as",
      "zone",
    ];
    const lastIsKw =
      item[n - 1].t === "ident" && reserved.includes(item[n - 1].v);
    const prevOk =
      isP(prev, ")") ||
      isKw(prev, "end") ||
      prev.t === "string" ||
      prev.t === "number" ||
      prev.t === "qident" ||
      (prev.t === "ident" &&
        ![
          "is",
          "not",
          "and",
          "or",
          "as",
          "distinct",
          "time",
          "zone",
          "in",
          "like",
          "ilike",
          "at",
        ].includes(prev.v));
    if (!lastIsKw && prevOk && !isP(prev, ".") && prev.t !== "op") {
      return { expr: item.slice(0, n - 1), alias: item[n - 1].v };
    }
  }
  return { expr: item, alias: null };
}

/** Output columns per UNION branch. */
export function outputColumns(stmt: Tok[]): OutCol[][] | null {
  const lists = outerSelectLists(stmt);
  if (!lists) return null;
  return lists.map((list) => {
    const cols: OutCol[] = [];
    for (const item of splitTop(list)) {
      if (item.length === 0) continue;
      const { expr, alias } = splitAlias(item);
      const u = unwrap(expr);
      if (
        !alias &&
        u.length > 3 &&
        isKw(u[0], "json_build_object", "jsonb_build_object") &&
        isP(u[1], "(") &&
        isP(u[u.length - 1], ")")
      ) {
        const args = splitTop(u.slice(2, -1));
        for (let k = 0; k + 1 < args.length; k += 2) {
          const key =
            args[k].length === 1 && args[k][0].t === "string"
              ? args[k][0].v
              : "?key?";
          cols.push({ name: key, expr: args[k + 1] });
        }
        continue;
      }
      cols.push({ name: alias ?? defaultName(expr), expr });
    }
    return cols;
  });
}

// ============================================================================
// Classification
// ============================================================================

function words(id: string): string[] {
  return id
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/([A-Za-z])([0-9])/g, "$1_$2") // address1 -> address_1
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

const SENSITIVE_WORDS = new Set([
  "domain",
  "domains",
  "myshopify",
  "email",
  "emails",
  "phone",
  "address",
  "addresses",
  "name",
  "names",
  "firstname",
  "lastname",
  "note",
  "notes",
  "narration",
  "payer",
  "remitter",
  "text",
  "message",
  "messages",
  "payload",
  "body",
  "raw",
  "amount",
  "amounts",
  "price",
  "balance",
  "outstanding",
  "paise",
  "money",
  "limit",
  "token",
  "secret",
  "password",
  "error",
  "errors",
  "reason",
  "description",
  "comment",
  "data",
]);
/** Words that make error/reason/shop/limit/message names enum- or id-shaped. */
const SAFE_QUALIFIERS = new Set([
  "code",
  "codes",
  "kind",
  "format",
  "disposition",
  "class",
  "category",
  "idx",
  "index",
  "id",
  "gid",
  "ids",
  "count",
  "pos",
  "exists",
  "present",
  "match",
  "type",
]);
const QUALIFIABLE = new Set([
  "error",
  "errors",
  "reason",
  "shop",
  "message",
  "messages",
  "limit",
  "data",
]);

/** Return the offending word, or null. */
export function sensitiveWord(id: string): string | null {
  const w = words(id);
  const qualified = w.some((x) => SAFE_QUALIFIERS.has(x));
  for (const x of w) {
    if (x === "shop" && !qualified) return x;
    if (SENSITIVE_WORDS.has(x)) {
      if (QUALIFIABLE.has(x) && qualified) continue;
      return x;
    }
  }
  return null;
}

/** Naming convention on a single name (see plainRef for when it applies). */
function nameConvention(name: string): Kind | null {
  if (/^(id|.*_id|.*[a-z0-9]Id|.*_gid|.*[a-z0-9]Gid|.*_idx)$/.test(name))
    return "id";
  if (/^(at|.*_at|.*[a-z0-9]At|.*_date|.*[a-z0-9]Date)$/.test(name))
    return "timestamp";
  return null;
}

const BOOL_OPS = new Set([
  "=",
  "<>",
  "!=",
  "<",
  ">",
  "<=",
  ">=",
  "~",
  "~*",
  "!~",
  "!~*",
]);

/**
 * A regex literal that can only match a short code-like token.
 * Allowed: anchored ^...$; literal characters and non-negated [...] classes
 * drawn only from A-Z a-z 0-9 _ : - ; groups ( ) (?: ) and |; the quantifiers
 * ? and {m,n} with n <= 64. Rejected: . @ / , spaces, any backslash escape,
 * negated classes [^...], POSIX classes, * + and unbounded {m,}.
 */
export const GUARD_MAX_REPEAT = 64;
export function isSafeGuardRegex(re: string): boolean {
  if (re.length < 3 || !re.startsWith("^") || !re.endsWith("$")) return false;
  const body = re.slice(1, -1);
  const lit = /[A-Za-z0-9_:-]/;
  let k = 0;
  while (k < body.length) {
    const ch = body[k];
    if (ch === "[") {
      const close = body.indexOf("]", k + 1);
      if (close < 0) return false;
      const cls = body.slice(k + 1, close);
      if (cls.length === 0 || cls.startsWith("^") || cls.includes("["))
        return false;
      if (![...cls].every((c) => lit.test(c))) return false;
      // ranges must stay inside one of A-Z, a-z, 0-9
      for (const m of cls.matchAll(/(.)-(.)/g)) {
        const [a, b] = [m[1], m[2]];
        const ok =
          (/[A-Z]/.test(a) && /[A-Z]/.test(b)) ||
          (/[a-z]/.test(a) && /[a-z]/.test(b)) ||
          (/[0-9]/.test(a) && /[0-9]/.test(b));
        if (!ok || a > b) return false;
      }
      k = close + 1;
      continue;
    }
    if (ch === "{") {
      const m = /^\{(\d+)(?:,(\d+))?\}/.exec(body.slice(k));
      if (!m) return false;
      if (Number(m[2] ?? m[1]) > GUARD_MAX_REPEAT) return false;
      k += m[0].length;
      continue;
    }
    if (ch === "(" && body.startsWith("(?:", k)) {
      k += 3;
      continue;
    }
    if (ch === "(" || ch === ")" || ch === "|" || ch === "?") {
      k++;
      continue;
    }
    if (lit.test(ch)) {
      k++;
      continue;
    }
    return false; // . @ / , space, backslash, * + $ ^ ...
  }
  return true;
}

/** ident(.ident)* */
function isRef(e: Tok[]): boolean {
  return (
    e.length > 0 &&
    e.length % 2 === 1 &&
    e.every((tk, k) =>
      k % 2 === 0 ? tk.t === "ident" || tk.t === "qident" : isP(tk, "."),
    )
  );
}

/**
 * The column a passthrough expression prints, or null: a plain ref, optionally
 * wrapped in parens, ::casts or COALESCE(ref, literal...).
 */
function plainRef(exprIn: Tok[]): Tok[] | null {
  let e = unwrap(exprIn);
  for (;;) {
    const d = depths(e);
    const castAt = e.findIndex((tk, k) => d[k] === 0 && isP(tk, "::"));
    if (castAt > 0) {
      e = unwrap(e.slice(0, castAt));
      continue;
    }
    if (
      isKw(e[0], "coalesce") &&
      isP(e[1], "(") &&
      isP(e[e.length - 1], ")") &&
      !d.slice(2, -1).some((x) => x === 0)
    ) {
      const args = splitTop(e.slice(2, -1));
      if (
        args
          .slice(1)
          .every(
            (a) =>
              a.length === 1 &&
              (a[0].t === "string" ||
                a[0].t === "number" ||
                isKw(a[0], "null")),
          )
      ) {
        e = unwrap(args[0]);
        continue;
      }
      return null;
    }
    break;
  }
  if (isRef(e)) return e;
  // JSON key: ref ->> 'key' (the key is the printed source name)
  if (
    e.length >= 3 &&
    isP(e[e.length - 2], "->>") &&
    e[e.length - 1].t === "string" &&
    isRef(e.slice(0, -2))
  ) {
    return [{ t: "qident", v: e[e.length - 1].v, raw: e[e.length - 1].raw }];
  }
  return null;
}

interface Ctx {
  /** columns / JSON keys passed through to the output (for the sensitive check) */
  sources: string[];
  /** unqualified refs (not after `.`), for the whole-row check */
  bare?: string[];
}

/** Kind of an expression from its shape, or null when not derivable. */
function deriveKind(exprIn: Tok[], ctx: Ctx): Kind | null {
  const e = unwrap(exprIn);
  if (e.length === 0) return null;
  const d = depths(e);
  const top = (pred: (tk: Tok, k: number) => boolean) =>
    e.some((tk, k) => d[k] === 0 && pred(tk, k));

  // CASE ... END spanning the whole expression (possibly followed by ::cast)
  if (isKw(e[0], "case")) {
    let depth = 0;
    let endIdx = -1;
    for (let k = 0; k < e.length; k++) {
      if (d[k] !== 0) continue;
      if (isKw(e[k], "case")) depth++;
      if (isKw(e[k], "end")) {
        depth--;
        if (depth === 0) {
          endIdx = k;
          break;
        }
      }
    }
    if (endIdx === e.length - 1 || (endIdx > 0 && isP(e[endIdx + 1], "::")))
      return caseKind(e.slice(0, endIdx + 1), ctx);
  }

  // boolean shapes at depth 0 (outside nested CASE)
  {
    let cd = 0;
    let bool = false;
    e.forEach((tk, k) => {
      if (d[k] !== 0) return;
      if (isKw(tk, "case")) cd++;
      else if (isKw(tk, "end")) cd--;
      else if (cd === 0) {
        if (tk.t === "op" && BOOL_OPS.has(tk.v)) bool = true;
        if (
          isKw(
            tk,
            "is",
            "like",
            "ilike",
            "in",
            "and",
            "or",
            "between",
            "similar",
          )
        )
          bool = true;
        if (isKw(tk, "not", "exists") && k === 0) bool = true;
      }
    });
    if (bool) return "boolean";
  }
  // 'prefix' || (ROW_NUMBER|RANK|DENSE_RANK() OVER (...))[::text] -> enum.
  // A short lower-case literal plus a window row index, e.g. the shop
  // identity label 'other_' || ROW_NUMBER() OVER (...). The OVER clause is
  // not a passthrough (only the index is printed), so it adds no sources.
  if (isLabelPlusRank(e)) return "enum";
  if (e.length === 1) {
    const tk = e[0];
    if (isKw(tk, "true", "false")) return "boolean";
    if (tk.t === "string") return "enum";
    if (tk.t === "number") return "count";
    if (isKw(tk, "null")) return null;
  }
  // trailing ::type cast
  const castAt = e.findIndex((tk, k) => d[k] === 0 && isP(tk, "::"));
  if (castAt > 0) {
    // passthrough cast (x::text) keeps the inner kind; else needs annotation
    return deriveKind(e.slice(0, castAt), ctx);
  }
  // NOW() - x  (interval) / x - NOW(): only when the whole expression is
  // exactly now()/current_timestamp minus a ref / cast ref / INTERVAL literal
  {
    const minus = e.findIndex((tk, k) => d[k] === 0 && isP(tk, "-"));
    if (minus > 0 && top((tk) => isKw(tk, "now", "current_timestamp"))) {
      const isNow = (x: Tok[]) => {
        const u = unwrap(x);
        return (
          (u.length === 1 && isKw(u[0], "current_timestamp")) ||
          (u.length === 3 &&
            isKw(u[0], "now") &&
            isP(u[1], "(") &&
            isP(u[2], ")"))
        );
      };
      const isOperand = (x: Tok[]) => {
        const u = unwrap(x);
        return (
          plainRef(u) !== null ||
          (u.length === 2 && isKw(u[0], "interval") && u[1].t === "string")
        );
      };
      const lhs = e.slice(0, minus);
      const rhs = e.slice(minus + 1);
      const otherOps = e.some(
        (tk, k) =>
          k !== minus &&
          d[k] === 0 &&
          ((tk.t === "op" && tk.v !== "::") ||
            isKw(tk, "and", "or", "is", "in", "like", "between")),
      );
      if (
        !otherOps &&
        ((isNow(lhs) && isOperand(rhs)) || (isOperand(lhs) && isNow(rhs)))
      ) {
        collectSources(isNow(lhs) ? rhs : lhs, ctx);
        return "timestamp";
      }
      collectSources(e, ctx);
      return null;
    }
  }

  // function call spanning whole expression
  if (e[0].t === "ident" && isP(e[1], "(")) {
    let depth = 0;
    let close = -1;
    for (let k = 1; k < e.length; k++) {
      if (isP(e[k], "(")) depth++;
      if (isP(e[k], ")")) {
        depth--;
        if (depth === 0) {
          close = k;
          break;
        }
      }
    }
    const rest = e.slice(close + 1);
    const restOk = rest.length === 0 || isKw(rest[0], "filter", "over");
    if (close > 0 && restOk) {
      const fn = e[0].v;
      const args = splitTop(e.slice(2, close));
      if (fn === "count") return "count";
      if (
        ["row_number", "rank", "dense_rank"].includes(fn) &&
        isKw(rest[0], "over")
      )
        return "id";
      if (["bool_and", "bool_or", "every"].includes(fn)) return "boolean";
      if (fn === "exists") return "boolean";
      if (fn === "coalesce" || fn === "nullif") {
        const kinds = args.map((a) => deriveKind(a, ctx));
        const firstUnresolved = kinds[0] === null;
        // COALESCE(x, 'literal') where x is a passthrough: kind of x (annotation/convention), keep sources
        const others = kinds.slice(1).filter((k) => k !== null);
        if (
          !firstUnresolved &&
          others.every(
            (k) =>
              k === kinds[0] || (kinds[0] === "boolean" && k === "boolean"),
          )
        )
          return kinds[0];
        if (!firstUnresolved && kinds[0] === "boolean") return "boolean";
        collectSources(args[0], ctx);
        return null;
      }
      if (fn === "min" || fn === "max") {
        const inner = deriveKind(args[0] ?? [], ctx);
        if (inner) return inner;
        collectSources(args[0] ?? [], ctx);
        const ref = plainRef(args[0] ?? []);
        return ref ? nameConvention(ref[ref.length - 1].v) : null;
      }
      if (fn === "to_regclass" || fn === "to_regprocedure") return null;
    }
  }
  // scalar subquery (SELECT agg FROM ...)
  if (isP(exprIn[0], "(") && isKw(e[1], "select")) {
    const inner = outerSelectLists(e.slice(1, -1));
    if (inner && inner.length === 1) {
      const items = splitTop(inner[0]);
      if (items.length === 1) return deriveKind(splitAlias(items[0]).expr, ctx);
    }
    return null;
  }
  collectSources(e, ctx);
  return null;
}

/** Literal prefix allowed in 'prefix' || <rank> OVER (...) labels. */
export const LABEL_PREFIX_RE = /^[a-z][a-z0-9_]{0,31}$/;

/**
 * True for exactly `'prefix' || <rank>` where prefix matches LABEL_PREFIX_RE
 * and <rank> is ROW_NUMBER() / RANK() / DENSE_RANK() OVER (...), optionally
 * parenthesised and/or cast ::text / ::varchar. Nothing else may follow.
 */
function isLabelPlusRank(e: Tok[]): boolean {
  if (e.length < 7) return false;
  if (e[0].t !== "string" || !LABEL_PREFIX_RE.test(e[0].v)) return false;
  if (!(e[1].t === "op" && e[1].v === "||")) return false;
  let r = unwrap(e.slice(2));
  const rd = depths(r);
  const castAt = r.findIndex((tk, k) => rd[k] === 0 && isP(tk, "::"));
  if (castAt >= 0) {
    const ty = r.slice(castAt + 1);
    if (!(ty.length === 1 && isKw(ty[0], "text", "varchar"))) return false;
    r = unwrap(r.slice(0, castAt));
  }
  if (!(r[0]?.t === "ident" && ["row_number", "rank", "dense_rank"].includes(r[0].v)))
    return false;
  if (!(isP(r[1], "(") && isP(r[2], ")") && isKw(r[3], "over") && isP(r[4], "(")))
    return false;
  // the OVER ( ... ) group must close on the last token
  const d = depths(r);
  return isP(r[r.length - 1], ")") && d[r.length - 1] === d[4] &&
    r.slice(5, -1).every((_, k) => d[k + 5] > d[4]);
}

/** Record identifiers and JSON keys referenced by a passthrough expression. */
function collectSources(e: Tok[], ctx: Ctx) {
  e.forEach((tk, k) => {
    const next = e[k + 1];
    const isJsonContainer =
      !!next && next.t === "op" && ["->>", "->", "#>>", "#>"].includes(next.v);
    if (
      (tk.t === "ident" || tk.t === "qident") &&
      !isP(next, "(") &&
      !isP(next, ".") &&
      !isJsonContainer
    ) {
      if (
        tk.t === "ident" &&
        [
          "null",
          "true",
          "false",
          "now",
          "interval",
          "text",
          "int",
          "bigint",
          "integer",
          "boolean",
          "timestamptz",
          "date",
          "in",
          "from",
          "day",
          "zone",
          "time",
          "at",
        ].includes(tk.v)
      )
        return;
      if (isP(e[k - 1], "::")) return; // type name
      ctx.sources.push(tk.v);
      if (!isP(e[k - 1], ".")) ctx.bare?.push(tk.v);
    }
    if (tk.t === "string" && isP(e[k - 1], "->>")) ctx.sources.push(tk.v);
    if (tk.t === "string" && isP(e[k - 1], "->")) ctx.sources.push(tk.v);
  });
}

/** CASE expression: enum when every result is a literal/NULL/guarded passthrough. */
function caseKind(e: Tok[], ctx: Ctx): Kind | null {
  // collect (condition, result) segments at this CASE level
  const d = depths(e);
  let cd = 0;
  const segs: { kw: string; toks: Tok[] }[] = [];
  let cur: { kw: string; toks: Tok[] } | null = null;
  for (let k = 0; k < e.length; k++) {
    const tk = e[k];
    if (d[k] === 0 && isKw(tk, "case")) {
      cd++;
      if (cd === 1) {
        cur = { kw: "subject", toks: [] };
        continue;
      }
    }
    if (d[k] === 0 && isKw(tk, "end")) {
      cd--;
      if (cd === 0) {
        if (cur) segs.push(cur);
        break;
      }
    }
    if (cd === 1 && d[k] === 0 && isKw(tk, "when", "then", "else")) {
      if (cur) segs.push(cur);
      cur = { kw: tk.v, toks: [] };
      continue;
    }
    cur?.toks.push(tk);
  }
  const kinds: Kind[] = [];
  let lastWhen: Tok[] = [];
  for (const s of segs) {
    if (s.kw === "when") {
      lastWhen = s.toks;
      continue;
    }
    if (s.kw !== "then" && s.kw !== "else") continue;
    const r = unwrap(s.toks);
    if (r.length === 1 && isKw(r[0], "null")) continue;
    if (s.kw === "then" && isGuarded(r, lastWhen)) {
      collectSources(r, ctx); // guarded source still gets the sensitive-name check
      kinds.push("enum");
      continue;
    }
    const sub: Ctx = { sources: [], bare: [] };
    const k = deriveKind(r, sub);
    if (k) {
      kinds.push(k);
      continue;
    }
    // passthrough result: classify by its own name convention, keep sources
    ctx.sources.push(...sub.sources);
    ctx.bare?.push(...(sub.bare ?? []));
    const ref = plainRef(r);
    const conv = ref ? nameConvention(ref[ref.length - 1].v) : null;
    if (!conv) return null;
    kinds.push(conv);
  }
  if (kinds.length === 0) return null;
  return kinds.every((k) => k === kinds[0]) ? kinds[0] : null;
}

/**
 * THEN x guarded by WHEN x ~ '^[...]{1,N}$' or WHEN x IN ('a', ...). The WHEN
 * condition must be exactly that test, or an AND-only conjunction (at depth 0)
 * with one conjunct exactly that test. Any depth-0 OR disqualifies it.
 */
function isGuarded(result: Tok[], when: Tok[]): boolean {
  const r = text(unwrap(result));
  const w = unwrap(when);
  const d = depths(w);
  let cd = 0;
  const conjuncts: Tok[][] = [[]];
  for (let k = 0; k < w.length; k++) {
    const tk = w[k];
    if (d[k] === 0 && isKw(tk, "case")) cd++;
    if (d[k] === 0 && isKw(tk, "end")) cd--;
    if (d[k] === 0 && cd === 0 && isKw(tk, "or")) return false;
    if (
      d[k] === 0 &&
      cd === 0 &&
      isKw(tk, "and") &&
      !w.slice(0, k).some((x, j) => d[j] === 0 && isKw(x, "between"))
    ) {
      conjuncts.push([]);
      continue;
    }
    conjuncts[conjuncts.length - 1].push(tk);
  }
  return conjuncts.some((cIn) => {
    const c = unwrap(cIn);
    // x ~ 're'
    const opAt = c.findIndex(
      (tk) => tk.t === "op" && (tk.v === "~" || tk.v === "~*"),
    );
    if (opAt > 0 && opAt === c.length - 2) {
      const re = c[opAt + 1];
      return (
        text(unwrap(c.slice(0, opAt))) === r &&
        re.t === "string" &&
        isSafeGuardRegex(re.v)
      );
    }
    // x IN ('a', 'b')
    const inAt = c.findIndex((tk) => isKw(tk, "in"));
    if (inAt > 0 && isP(c[inAt + 1], "(") && isP(c[c.length - 1], ")")) {
      const list = c.slice(inAt + 2, -1);
      const allLit =
        list.length > 0 &&
        list.every((tk, j) => (j % 2 === 0 ? tk.t === "string" : isP(tk, ",")));
      return allLit && text(unwrap(c.slice(0, inAt))) === r;
    }
    return false;
  });
}

// ============================================================================
// File check
// ============================================================================

export function parseAnnotations(sql: string): {
  ann: Map<string, Kind>;
  bad: string[];
} {
  const ann = new Map<string, Kind>();
  const bad: string[] = [];
  for (const line of sql.split("\n")) {
    const m = /^\s*--\s*@col\s+(.+?)\s*:\s*([A-Za-z_]+)\s*$/.exec(line);
    if (!m) {
      if (/^\s*--\s*@col\b/.test(line)) bad.push(line.trim());
      continue;
    }
    const kind = m[2].toLowerCase();
    for (const raw of m[1].split(",")) {
      const nm = raw.trim().replace(/^"(.*)"$/, "$1");
      if (!(KINDS as readonly string[]).includes(kind))
        bad.push(`${nm}: ${kind}`);
      else ann.set(nm, kind as Kind);
    }
  }
  return { ann, bad };
}

export interface ColumnReport {
  column: string;
  kind: Kind | null;
  via: "derived" | "annotation" | "convention" | null;
}

export function checkSql(
  file: string,
  sql: string,
): { violations: Violation[]; columns: ColumnReport[] } {
  const violations: Violation[] = [];
  const columns: ColumnReport[] = [];
  const { ann, bad } = parseAnnotations(sql);
  for (const b of bad)
    violations.push({
      file,
      column: b.split(":")[0].replace(/^--\s*@col\s*/, ""),
      issue: "bad_annotation",
      detail: "kind must be one of " + KINDS.join("|"),
    });
  const used = new Set<string>();
  const metas: string[] = [];
  const toks = tokenize(sql, metas);
  for (const m of checkMeta(metas)) {
    violations.push({
      file,
      column: "(psql)",
      issue: "unsupported_statement",
      detail: `psql meta command not allowed: ${m.split(/\s/)[0]}`,
    });
  }

  for (const stmt of splitStatements(toks)) {
    const relations = relationNames(stmt);
    const head = stmt[0];
    if (isKw(head, "begin", "commit", "rollback", "end", "start")) continue;
    if (isKw(head, "show")) {
      const nm = stmt[1]?.v ?? "?";
      const k = ann.get(nm) ?? null;
      if (k) used.add(nm);
      columns.push({ column: nm, kind: k, via: k ? "annotation" : null });
      if (!k)
        violations.push({
          file,
          column: nm,
          issue: "unclassified",
          detail: "SHOW output needs an @col annotation",
        });
      else if (k === "config_int" && !CONFIG_INT_COLUMNS.includes(nm))
        violations.push({
          file,
          column: nm,
          issue: "config_int_not_listed",
          detail: "config_int is only for named settings",
        });
      continue;
    }
    if (
      !isKw(head, "select", "with") &&
      !(isP(head, "(") && stmt.some((t) => isKw(t, "select")))
    ) {
      violations.push({
        file,
        column: "(statement)",
        issue: "unsupported_statement",
        detail: `starts with '${head.raw}'`,
      });
      continue;
    }
    const branches = outputColumns(stmt);
    if (!branches || branches.length === 0 || branches[0].length === 0) {
      violations.push({
        file,
        column: "(statement)",
        issue: "unparseable",
        detail: "could not find the outer select list",
      });
      continue;
    }
    const names = branches[0].map((c) => c.name);
    const derived = derivedRelations(stmt);
    branches.forEach((cols, bi) => {
      if (cols.length !== names.length) {
        violations.push({
          file,
          column: "(statement)",
          issue: "unparseable",
          detail: "UNION branches differ in width",
        });
        return;
      }
      cols.forEach((col, ci) => {
        const nm = names[ci];
        if (
          (col.expr.length === 1 && isP(col.expr[0], "*")) ||
          (col.expr.length >= 3 &&
            isP(col.expr[col.expr.length - 1], "*") &&
            isP(col.expr[col.expr.length - 2], "."))
        ) {
          violations.push({
            file,
            column: "*",
            issue: "star",
            detail: "SELECT * prints every column",
          });
          return;
        }
        // Resolve refs to CTE / derived-table columns to the inner expression
        // they name (recursively), so an inner alias cannot launder a column.
        // A UNION body or an ambiguous unqualified name gives several
        // variants; every variant must pass.
        let variants: Tok[][];
        try {
          variants = resolveExpr(col.expr, derived, new Set(), 0);
        } catch (err) {
          violations.push({
            file,
            column: nm,
            issue: "unparseable",
            detail: `cannot resolve through CTE/subquery: ${(err as Error).message}`,
          });
          return;
        }
        let firstKind: Kind | null | undefined;
        let firstVia: ColumnReport["via"] = null;
        for (const expr of variants) {
          const r = classifyColumn(nm, expr, ann, relations);
          if (r.used) used.add(nm);
          if (r.violation) {
            if (bi === 0 && firstKind === undefined)
              columns.push({ column: nm, kind: r.kind, via: r.via });
            violations.push({ file, column: nm, ...r.violation });
            return;
          }
          if (firstKind === undefined) {
            firstKind = r.kind;
            firstVia = r.via;
          } else if (r.kind !== firstKind) {
            if (bi === 0) columns.push({ column: nm, kind: null, via: null });
            violations.push({
              file,
              column: nm,
              issue: "unclassified",
              detail: "UNION / ambiguous source resolves to different kinds",
            });
            return;
          }
        }
        if (bi === 0)
          columns.push({ column: nm, kind: firstKind ?? null, via: firstVia });
      });
    });
  }
  for (const nm of ann.keys()) {
    if (!used.has(nm))
      violations.push({
        file,
        column: nm,
        issue: "stale_annotation",
        detail: "@col names a column that is not in any output",
      });
  }
  return { violations, columns };
}

interface ColResult {
  kind: Kind | null;
  via: ColumnReport["via"];
  used: boolean;
  violation?: { issue: Violation["issue"]; detail: string };
}

/** Classify one (resolved) output column expression. */
function classifyColumn(
  nm: string,
  expr: Tok[],
  ann: Map<string, Kind>,
  relations: Set<string>,
): ColResult {
  const ctx: Ctx = { sources: [], bare: [] };
  let kind = deriveKind(expr, ctx);
  let via: ColumnReport["via"] = kind ? "derived" : null;
  const annK = ann.get(nm);
  const used = !!annK;
  if (!kind && annK) {
    kind = annK;
    via = "annotation";
  }
  // whole-row reference (`SELECT s ...`, row_to_json(s)): always fails
  const wholeRow = (ctx.bare ?? []).find((src) => relations.has(src));
  const ref = plainRef(expr);
  if (wholeRow || (ref && ref.length === 1 && relations.has(ref[0].v))) {
    return {
      kind,
      via,
      used,
      violation: {
        issue: "whole_row",
        detail: `prints a whole row of ${wholeRow ?? ref![0].v}`,
      },
    };
  }
  // naming convention: only for a plain column ref whose SOURCE name
  // has the same convention (an alias alone proves nothing)
  if (!kind && ref) {
    const conv = nameConvention(nm);
    if (conv && nameConvention(ref[ref.length - 1].v) === conv) {
      kind = conv;
      via = "convention";
    }
  }
  // sensitive check: skip only for derived count/boolean (they cannot carry the value)
  const derivedSafe =
    via === "derived" && (kind === "count" || kind === "boolean");
  // 4b: Session credential / expiry columns only inside a derived boolean/count
  if (!derivedSafe) {
    const all: Ctx = { sources: [], bare: [] };
    collectSources(expr, all);
    const cred = [...all.sources, ...ctx.sources].find((src) =>
      SESSION_CREDENTIAL_SET.has(src.toLowerCase()),
    );
    if (cred) {
      return {
        kind,
        via,
        used,
        violation: {
          issue: "sensitive",
          detail: `reads Session credential column ${cred} outside a derived boolean/count`,
        },
      };
    }
  }
  if (!derivedSafe) {
    const hits = [nm, ...ctx.sources]
      .map((s) => [s, sensitiveWord(s)] as const)
      .filter(([, w]) => w);
    if (hits.length) {
      return {
        kind,
        via,
        used,
        violation: {
          issue: "sensitive",
          detail: `looks like '${hits[0][1]}' (from ${hits[0][0] === nm ? "output name" : "source " + hits[0][0]})`,
        },
      };
    }
  }
  if (kind === "config_int") {
    const offList = [nm, ...ctx.sources].filter(
      (s) => !CONFIG_INT_COLUMNS.includes(s),
    );
    if (offList.length) {
      return {
        kind,
        via,
        used,
        violation: {
          issue: "config_int_not_listed",
          detail: `config_int is only for named settings (${CONFIG_INT_COLUMNS.join(", ")}); not listed: ${offList[0]}`,
        },
      };
    }
  }
  if (!kind)
    return {
      kind,
      via,
      used,
      violation: {
        issue: "unclassified",
        detail: `no derived kind, @col annotation or naming convention for: ${text(expr).slice(0, 80)}`,
      },
    };
  return { kind, via, used };
}

/** Table names and aliases introduced by FROM / JOIN anywhere in a statement. */
function relationNames(stmt: Tok[]): Set<string> {
  const out = new Set<string>();
  const notAlias = new Set([
    "on",
    "using",
    "where",
    "group",
    "order",
    "limit",
    "join",
    "left",
    "right",
    "inner",
    "outer",
    "full",
    "cross",
    "natural",
    "lateral",
    "union",
    "intersect",
    "except",
    "having",
    "window",
    "offset",
    "fetch",
    "for",
    "as",
    "with",
    "select",
  ]);
  for (let k = 0; k < stmt.length; k++) {
    if (!isKw(stmt[k], "from", "join") || isKw(stmt[k - 1], "distinct"))
      continue;
    let j = k + 1;
    if (isKw(stmt[j], "lateral", "only")) j++;
    if (stmt[j] && (stmt[j].t === "ident" || stmt[j].t === "qident")) {
      while (isP(stmt[j + 1], ".") && stmt[j + 2]) j += 2;
      out.add(stmt[j].v);
      j++;
    } else if (isP(stmt[j], "(")) {
      let depth = 0;
      do {
        if (isP(stmt[j], "(")) depth++;
        if (isP(stmt[j], ")")) depth--;
        j++;
      } while (j < stmt.length && depth > 0);
    } else continue;
    if (isKw(stmt[j], "as")) j++;
    const a = stmt[j];
    if (a && (a.t === "qident" || (a.t === "ident" && !notAlias.has(a.v))))
      out.add(a.v);
  }
  return out;
}

// ============================================================================
// CTE / derived-table resolution
// ============================================================================

interface Derived {
  /** output column name -> inner expression(s), one per UNION branch */
  cols: Map<string, Tok[][]>;
  /** qualifiers of `q.*` items ("" for a bare `*`) */
  stars: string[];
  /** body could not be parsed: any ref into it fails closed */
  opaque: boolean;
}

const MAX_RESOLVE_DEPTH = 16;
const MAX_VARIANTS = 32;

const REL_STOP = new Set([
  "select",
  "from",
  "where",
  "join",
  "on",
  "using",
  "group",
  "order",
  "having",
  "limit",
  "offset",
  "window",
  "with",
  "union",
  "intersect",
  "except",
  "returning",
  "values",
]);

const NOT_ALIAS = new Set([
  "on",
  "using",
  "where",
  "group",
  "order",
  "limit",
  "join",
  "left",
  "right",
  "inner",
  "outer",
  "full",
  "cross",
  "natural",
  "lateral",
  "union",
  "intersect",
  "except",
  "having",
  "window",
  "offset",
  "fetch",
  "for",
  "as",
  "with",
  "select",
]);

function matchParen(toks: Tok[], open: number): number {
  let depth = 0;
  for (let k = open; k < toks.length; k++) {
    if (isP(toks[k], "(")) depth++;
    if (isP(toks[k], ")") && --depth === 0) return k;
  }
  return -1;
}

const isName = (tk: Tok | undefined) =>
  !!tk && (tk.t === "qident" || (tk.t === "ident" && !NOT_ALIAS.has(tk.v)));

/** `(` / ident at k sits in a FROM list (after FROM / JOIN / LATERAL / `,` of a FROM). */
function inFromList(toks: Tok[], d: number[], k: number): boolean {
  const prev = toks[k - 1];
  if (isKw(prev, "from", "join", "lateral", "only")) return true;
  // parenthesised FROM item: FROM ((SELECT ...) q JOIN ...)
  if (isP(prev, "(") && k >= 2) return inFromList(toks, d, k - 1);
  if (!isP(prev, ",")) return false;
  for (let j = k - 2; j >= 0; j--) {
    if (d[j] < d[k]) return false;
    if (d[j] === d[k] && toks[j].t === "ident" && REL_STOP.has(toks[j].v))
      return toks[j].v === "from";
  }
  return false;
}

function parseBody(body: Tok[], colList: string[] | null): Derived {
  const rel: Derived = { cols: new Map(), stars: [], opaque: false };
  const branches = outputColumns(body);
  if (!branches || branches.length === 0) {
    rel.opaque = true;
    return rel;
  }
  const isStar = (e: Tok[]) =>
    (e.length === 1 && isP(e[0], "*")) ||
    (e.length >= 3 && isP(e[e.length - 1], "*") && isP(e[e.length - 2], "."));
  // branch-0 names of the non-star columns (later UNION branches take them positionally)
  const names0 = branches[0].filter((c) => !isStar(c.expr)).map((c) => c.name);
  for (const branch of branches) {
    let pos = 0;
    for (const col of branch) {
      const e = col.expr;
      if (e.length === 1 && isP(e[0], "*")) {
        rel.stars.push("");
        continue;
      }
      if (
        e.length >= 3 &&
        isP(e[e.length - 1], "*") &&
        isP(e[e.length - 2], ".")
      ) {
        rel.stars.push(e[e.length - 3].v);
        continue;
      }
      // past a short column list Postgres keeps the original names
      const name = colList?.[pos] ?? names0[pos] ?? col.name;
      pos++;
      const list = rel.cols.get(name) ?? [];
      list.push(e);
      rel.cols.set(name, list);
    }
  }
  if (colList && rel.stars.length) rel.opaque = true;
  return rel;
}

function columnList(
  toks: Tok[],
  open: number,
): { names: string[]; end: number } | null {
  if (!isP(toks[open], "(")) return null;
  const close = matchParen(toks, open);
  if (close < 0) return null;
  const inner = toks.slice(open + 1, close);
  if (!inner.every((tk, k) => (k % 2 === 0 ? isName(tk) : isP(tk, ","))))
    return null;
  return {
    names: inner.filter((_, k) => k % 2 === 0).map((tk) => tk.v),
    end: close,
  };
}

/**
 * CTEs (`name [(cols)] AS [NOT] [MATERIALIZED] (body)`) and FROM-list
 * subqueries (`(body) [AS] alias [(cols)]`) anywhere in a statement, plus
 * aliases of CTE references (`FROM c x`). An unaliased subquery is registered
 * under a synthetic name so unqualified refs still resolve.
 */
export function derivedRelations(stmt: Tok[]): Map<string, Derived[]> {
  const d = depths(stmt);
  // every definition per name (an alias can be reused in an inner scope);
  // a ref to the name must pass for each of them
  const rels = new Map<string, Derived[]>();
  const add = (name: string, rel: Derived) => {
    const list = rels.get(name) ?? [];
    if (!list.includes(rel)) list.push(rel);
    rels.set(name, list);
  };
  for (let k = 0; k < stmt.length; k++) {
    const tk = stmt[k];
    // CTE
    if (
      isName(tk) &&
      (isKw(stmt[k - 1], "with", "recursive") || isP(stmt[k - 1], ","))
    ) {
      let j = k + 1;
      let cols: string[] | null = null;
      const cl = columnList(stmt, j);
      if (cl) {
        cols = cl.names;
        j = cl.end + 1;
      }
      if (!isKw(stmt[j], "as")) continue;
      j++;
      if (isKw(stmt[j], "not")) j++;
      if (isKw(stmt[j], "materialized")) j++;
      if (!isP(stmt[j], "(")) continue;
      const close = matchParen(stmt, j);
      if (close < 0) continue;
      const body = stmt.slice(j + 1, close);
      add(
        tk.v,
        isKw(body[0], "select", "with")
          ? parseBody(body, cols)
          : { cols: new Map(), stars: [], opaque: true },
      );
      continue;
    }
    // FROM-list subquery
    if (isP(tk, "(") && inFromList(stmt, d, k)) {
      const close = matchParen(stmt, k);
      if (close < 0) continue;
      // redundant parentheses: FROM ((SELECT ...)) q
      let open = k;
      while (
        isP(stmt[open + 1], "(") &&
        matchParen(stmt, open + 1) === close - (open + 1 - k)
      )
        open++;
      if (!isKw(stmt[open + 1], "select", "with", "values", "table")) continue;
      const body = stmt.slice(open + 1, close - (open - k));
      let j = close + 1;
      if (isKw(stmt[j], "as")) j++;
      let name = `(subquery@${k})`;
      let cols: string[] | null = null;
      if (isName(stmt[j])) {
        name = stmt[j].v;
        const cl = columnList(stmt, j + 1);
        if (cl) cols = cl.names;
      }
      add(
        name,
        isKw(body[0], "select", "with")
          ? parseBody(body, cols)
          : { cols: new Map(), stars: [], opaque: true },
      );
    }
  }
  // aliases of CTE references: FROM c x / JOIN c AS x
  for (let k = 0; k < stmt.length; k++) {
    const tk = stmt[k];
    if (!isName(tk) || !rels.has(tk.v) || !inFromList(stmt, d, k)) continue;
    if (isP(stmt[k + 1], "(") || isP(stmt[k + 1], ".")) continue;
    let j = k + 1;
    if (isKw(stmt[j], "as")) j++;
    if (isName(stmt[j]) && stmt[j].v !== tk.v)
      for (const r of rels.get(tk.v)!) add(stmt[j].v, r);
  }
  return rels;
}

const NOT_REF = new Set([
  "null",
  "true",
  "false",
  "now",
  "interval",
  "case",
  "when",
  "then",
  "else",
  "end",
  "and",
  "or",
  "not",
  "is",
  "in",
  "like",
  "ilike",
  "between",
  "distinct",
  "from",
  "as",
  "at",
  "time",
  "zone",
  "day",
  "filter",
  "where",
  "over",
  "partition",
  "by",
  "order",
  "asc",
  "desc",
  "nulls",
  "first",
  "last",
  "current_timestamp",
  "current_date",
  "exists",
  "select",
]);

/**
 * Replace refs to CTE / derived-table columns with `( inner expr )`,
 * recursively. Returns every variant (UNION branches, ambiguous unqualified
 * names). A relation already on the expansion chain is not resolved again
 * (its inner refs are to its own FROM). Throws when a ref hits an opaque
 * relation or the expansion is too deep / too wide.
 */
export function resolveExpr(
  e: Tok[],
  rels: Map<string, Derived[]>,
  chain: Set<Derived>,
  depth: number,
): Tok[][] {
  if (rels.size === 0) return [e];
  if (depth > MAX_RESOLVE_DEPTH) throw new Error("nesting too deep");
  let out: Tok[][] = [[]];
  const append = (alts: Tok[][]) => {
    const next: Tok[][] = [];
    for (const pre of out) for (const a of alts) next.push([...pre, ...a]);
    if (next.length > MAX_VARIANTS) throw new Error("too many variants");
    out = next;
  };
  // a plain ref replaces a ref as-is (keeps `ref ->> 'key'` a plain JSON key);
  // anything else is parenthesised
  const wrap = (alts: Tok[][]): Tok[][] =>
    alts.map((a) =>
      isRef(a)
        ? a
        : [
            { t: "punct", v: "(", raw: "(" } as Tok,
            ...a,
            { t: "punct", v: ")", raw: ")" } as Tok,
          ],
    );
  const lookup = (rel: Derived, col: string, orig: Tok[]): Tok[][] => {
    if (rel.opaque) throw new Error(`unparseable CTE/subquery for ${col}`);
    const next = new Set(chain).add(rel);
    const exprs = rel.cols.get(col);
    if (exprs) {
      const alts: Tok[][] = [];
      for (const x of exprs)
        alts.push(...resolveExpr(x, rels, next, depth + 1));
      return wrap(alts);
    }
    if (rel.stars.length === 0) return [orig]; // not a column of it (Postgres would error)
    const q = rel.stars.length === 1 ? rel.stars[0] : "";
    const ref: Tok[] = q
      ? [
          { t: "qident", v: q, raw: `"${q}"` },
          { t: "punct", v: ".", raw: "." },
          { t: "qident", v: col, raw: `"${col}"` },
        ]
      : [{ t: "qident", v: col, raw: `"${col}"` }];
    return wrap(resolveExpr(ref, rels, next, depth + 1));
  };
  for (let k = 0; k < e.length; k++) {
    const tk = e[k];
    const startsRef =
      (tk.t === "ident" || tk.t === "qident") &&
      !isP(e[k - 1], ".") &&
      !isP(e[k - 1], "::") &&
      !isP(e[k + 1], "(") &&
      !(tk.t === "ident" && NOT_REF.has(tk.v));
    if (!startsRef) {
      append([[tk]]);
      continue;
    }
    let end = k;
    while (
      isP(e[end + 1], ".") &&
      e[end + 2] &&
      (e[end + 2].t === "ident" || e[end + 2].t === "qident")
    )
      end += 2;
    const parts = e.slice(k, end + 1).filter((_, i) => i % 2 === 0);
    const orig = e.slice(k, end + 1);
    k = end;
    if (parts.length === 2) {
      const defs = (rels.get(parts[0].v) ?? []).filter((r) => !chain.has(r));
      if (defs.length === 0) append([orig]);
      else {
        const alts: Tok[][] = [];
        for (const r of defs) alts.push(...lookup(r, parts[1].v, orig));
        append(alts);
      }
      continue;
    }
    if (parts.length === 1) {
      const cands = [...new Set([...rels.values()].flat())].filter(
        (r) => !chain.has(r) && (r.opaque || r.cols.has(parts[0].v)),
      );
      const named = cands.filter((r) => !r.opaque);
      if (named.length === 0) {
        // unqualified ref with an opaque relation in scope: cannot prove it is not from it
        if (cands.length)
          throw new Error(`unparseable CTE/subquery may define ${parts[0].v}`);
        append([orig]);
        continue;
      }
      const alts: Tok[][] = [];
      for (const r of named) alts.push(...lookup(r, parts[0].v, orig));
      append(alts);
      continue;
    }
    append([orig]);
  }
  return out;
}

// ============================================================================
// Allowlist ratchet
// ============================================================================

/**
 * Structural checks on the allowlist itself: never-allowlist issues, duplicate
 * keys and non-positive counts are errors. Shrink-only across commits is
 * pinned by a test on the committed entry set (see the test file), so any
 * growth needs a visible test edit in review.
 */
export function validateAllowlist(allowlist: AllowlistEntry[]): string[] {
  const errs: string[] = [];
  const seen = new Set<string>();
  for (const e of allowlist) {
    const k = `${e.file}:${e.column}:${e.issue}`;
    if (NEVER_ALLOWLIST.includes(e.issue))
      errs.push(
        `${k}: issue '${e.issue}' can never be allowlisted; fix the SQL`,
      );
    if (seen.has(k)) errs.push(`${k}: duplicate entry`);
    if (!Number.isInteger(e.count) || e.count < 1)
      errs.push(`${k}: count must be a positive integer`);
    seen.add(k);
  }
  return errs;
}

export function compareAllowlist(
  violations: Violation[],
  allowlist: AllowlistEntry[],
) {
  const key = (f: string, c: string, i: string) => `${f}\u0000${c}\u0000${i}`;
  const actual = new Map<string, Violation[]>();
  for (const v of violations) {
    const k = key(v.file, v.column, v.issue);
    actual.set(k, [...(actual.get(k) ?? []), v]);
  }
  const allowed = new Map<string, AllowlistEntry>();
  for (const e of allowlist) allowed.set(key(e.file, e.column, e.issue), e);
  const newViolations: Violation[] = [];
  const stale: { entry: AllowlistEntry; actual: number }[] = [];
  for (const [k, vs] of actual) {
    const e = allowed.get(k);
    const cap = e?.count ?? 0;
    if (vs.length > cap) newViolations.push(...vs.slice(cap));
  }
  for (const [k, e] of allowed) {
    const n = actual.get(k)?.length ?? 0;
    if (n < e.count) stale.push({ entry: e, actual: n });
  }
  return { newViolations, stale };
}

// ============================================================================
// Main
// ============================================================================

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export function run(root: string, allowlistPath: string): number {
  const dir = path.join(root, "scripts", "readonly");
  const files = fs.existsSync(dir)
    ? fs
        .readdirSync(dir)
        .filter((f) => f.endsWith(".sql"))
        .sort()
    : [];
  const all: Violation[] = [];
  let columnCount = 0;
  for (const f of files) {
    const rel = `scripts/readonly/${f}`;
    const res = checkSql(rel, fs.readFileSync(path.join(dir, f), "utf8"));
    all.push(...res.violations);
    columnCount += res.columns.length;
  }
  let allowlist: AllowlistEntry[] = [];
  if (fs.existsSync(allowlistPath)) {
    const parsed = JSON.parse(fs.readFileSync(allowlistPath, "utf8"));
    allowlist = Array.isArray(parsed) ? parsed : (parsed.entries ?? []);
  }
  const invalid = validateAllowlist(allowlist);
  const { newViolations, stale } = compareAllowlist(all, allowlist);
  console.log(
    `readonly column guard: ${files.length} files, ${columnCount} output columns, ${all.length} violations, ${allowlist.length} allowlist entries`,
  );
  for (const v of newViolations)
    console.log(
      `::error file=${v.file}::${v.file}: column ${v.column}: ${v.issue}: ${v.detail}`,
    );
  for (const s of stale)
    console.log(
      `::error file=${s.entry.file}::stale allowlist entry ${s.entry.file}:${s.entry.column}:${s.entry.issue} allows ${s.entry.count}, found ${s.actual}. Lower or remove it (counts only go down).`,
    );
  for (const e of invalid) console.log(`::error::invalid allowlist entry ${e}`);
  if (newViolations.length || stale.length || invalid.length) {
    console.log(
      "FAIL: see scripts/readonly/README.md for allowed kinds and @col annotations.",
    );
    return 1;
  }
  console.log("OK");
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  const root =
    process.env.READONLY_COLUMNS_ROOT ?? path.resolve(__dirname, "../..");
  const allow =
    process.env.READONLY_COLUMNS_ALLOWLIST ??
    path.join(__dirname, "readonly-columns-allowlist.json");
  if (process.argv.includes("--report")) {
    const dir = path.join(root, "scripts", "readonly");
    for (const f of fs
      .readdirSync(dir)
      .filter((x) => x.endsWith(".sql"))
      .sort()) {
      const res = checkSql(
        `scripts/readonly/${f}`,
        fs.readFileSync(path.join(dir, f), "utf8"),
      );
      for (const c of res.columns)
        console.log(`${f}\t${c.column}\t${c.kind ?? "-"}\t${c.via ?? "-"}`);
      for (const v of res.violations)
        console.log(`VIOLATION\t${f}\t${v.column}\t${v.issue}\t${v.detail}`);
    }
    process.exit(0);
  }
  process.exit(run(root, allow));
}
