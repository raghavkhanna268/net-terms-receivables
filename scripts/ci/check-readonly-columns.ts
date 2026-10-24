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
 *   3. Classify each column, in order:
 *      a. Derived from the expression shape (no annotation needed):
 *         COUNT(...)                      -> count
 *         ROW_NUMBER/RANK/DENSE_RANK OVER -> id (index)
 *         comparison, IS [NOT] NULL, EXISTS, LIKE, IN, bool_and/bool_or,
 *         TRUE/FALSE                      -> boolean
 *         string literal                  -> enum
 *         CASE whose results are all literals / NULL / guarded passthroughs
 *           (WHEN x ~ '^[...]{1,N}$' THEN x, or WHEN x IN ('a','b') THEN x)
 *                                         -> enum
 *         COALESCE(x, literal...), x::type, (x) -> kind of x
 *         MIN/MAX(x)                      -> kind of x
 *         NOW() - x                       -> timestamp (interval)
 *      b. An explicit file annotation:   -- @col <name>[, <name>...]: <kind>
 *         This is how plain passthrough columns (status, type, kind,
 *         "holdState", "manualHold", read_ct ...) are declared. A reviewer
 *         reads the annotation, so annotate only what is truly one of the
 *         six kinds.
 *      c. Naming convention on the output name:
 *         id, *_id, *Id, *_gid, *_idx      -> id
 *         at, *_at, *At, *_date, *Date     -> timestamp
 *   4. Independently of 3b/3c, a column is REJECTED as `sensitive` when it is
 *      not a derived count/boolean and its output name, or any column / JSON
 *      key it passes through, looks like a domain, shop, email, phone,
 *      address, name, note, narration, payer, free text/message/payload,
 *      raw error/reason, money (amount/price/balance/outstanding/limit) or a
 *      token/secret. An annotation cannot override this; map the value to an
 *      enum/boolean/count in SQL instead.
 *      Also rejected: SELECT * (`star`), SUM/AVG and other unclassifiable
 *      expressions (`unclassified`), statements that are not SELECT/WITH/
 *      SHOW/BEGIN/COMMIT/ROLLBACK (`unsupported_statement`), unparseable
 *      select lists (`unparseable`), annotations naming a column that is not
 *      in the output (`stale_annotation`), an invalid kind
 *      (`bad_annotation`) or config_int on a column / source that is not in
 *      CONFIG_INT_COLUMNS (`config_int_not_listed`).
 *
 * Burn-down allowlist: scripts/ci/readonly-columns-allowlist.json, entries
 * {file, column, issue, count}. CI fails on any violation not covered, and on
 * any entry whose count is now higher than the actual count (stale), so the
 * list can only shrink.
 *
 * Usage: npx tsx scripts/ci/check-readonly-columns.ts
 * Env (tests): READONLY_COLUMNS_ROOT (repo root), READONLY_COLUMNS_ALLOWLIST.
 */

import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

export const KINDS = ["id", "count", "enum", "boolean", "timestamp", "config_int"] as const;
export type Kind = (typeof KINDS)[number];

/**
 * Named merchant settings allowed to print as config_int (whole number 0..365).
 * Adding a name here needs Team Lead / QA sign-off.
 */
export const CONFIG_INT_COLUMNS: readonly string[] = ["defaultTermsDays"];

export type Issue =
  | "sensitive"
  | "unclassified"
  | "star"
  | "unparseable"
  | "unsupported_statement"
  | "stale_annotation"
  | "bad_annotation"
  | "config_int_not_listed";

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

type TokType = "ident" | "qident" | "string" | "number" | "op" | "punct" | "var";
interface Tok {
  t: TokType;
  v: string; // normalized value: unquoted idents lower-cased, strings unquoted
  raw: string;
}

export function tokenize(sql: string): Tok[] {
  const toks: Tok[] = [];
  let i = 0;
  let lineStart = true;
  const n = sql.length;
  while (i < n) {
    const c = sql[i];
    if (c === "\n") {
      lineStart = true;
      i++;
      continue;
    }
    if (c === " " || c === "\t" || c === "\r") {
      i++;
      continue;
    }
    // psql meta command: whole line
    if (lineStart && c === "\\") {
      while (i < n && sql[i] !== "\n") i++;
      continue;
    }
    lineStart = false;
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
      const m = /^:(?:'[^']*'|"[^"]*"|[A-Za-z_][A-Za-z0-9_]*)/.exec(sql.slice(i));
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
    const m = /^(?:->>|->|#>>|#>|::|<>|!=|<=|>=|!~\*|!~|~\*|\|\||[-+*/%<>=~!?@#&|^])/.exec(sql.slice(i));
    if (m) {
      toks.push({ t: "op", v: m[0], raw: m[0] });
      i += m[0].length;
      continue;
    }
    i++; // unknown char: skip
  }
  return toks;
}

const isKw = (tok: Tok | undefined, ...kws: string[]) => !!tok && tok.t === "ident" && kws.includes(tok.v);
const isP = (tok: Tok | undefined, p: string) => !!tok && (tok.t === "punct" || tok.t === "op") && tok.v === p;

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

const SELECT_END = new Set(["from", "where", "group", "order", "limit", "having", "window", "offset", "fetch", "into", "union", "intersect", "except"]);

/** Return the select lists (one per UNION branch) of the outermost query. */
function outerSelectLists(stmt: Tok[]): Tok[][] | null {
  const d = depths(stmt);
  const lists: Tok[][] = [];
  let i = 0;
  // skip WITH ... : first depth-0 SELECT
  while (i < stmt.length && !(d[i] === 0 && isKw(stmt[i], "select"))) i++;
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
        let j = i + 1;
        while (j < stmt.length && !(d[j] === 0 && isKw(stmt[j], "select"))) j++;
        i = j;
        found = j < stmt.length;
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
  const isRef = e.every((tk, k) => (k % 2 === 0 ? tk.t === "ident" || tk.t === "qident" : isP(tk, ".")));
  if (isRef) return last.v;
  if ((e[0].t === "ident") && isP(e[1], "(")) {
    // function call spanning the whole expression (incl. FILTER / OVER)
    if (isKw(e[0], "exists")) return "exists";
    return e[0].v;
  }
  if (isKw(e[0], "case")) return "case";
  return "?column?";
}

function splitAlias(item: Tok[]): { expr: Tok[]; alias: string | null } {
  const n = item.length;
  if (n >= 3 && isKw(item[n - 2], "as") && (item[n - 1].t === "ident" || item[n - 1].t === "qident")) {
    return { expr: item.slice(0, n - 2), alias: item[n - 1].v };
  }
  // bare alias: `expr alias`
  if (n >= 2 && (item[n - 1].t === "ident" || item[n - 1].t === "qident")) {
    const prev = item[n - 2];
    const reserved = ["null", "true", "false", "end", "and", "or", "not", "is", "in", "like", "ilike", "then", "else", "when", "distinct", "from", "as", "zone"];
    const lastIsKw = item[n - 1].t === "ident" && reserved.includes(item[n - 1].v);
    const prevOk = isP(prev, ")") || isKw(prev, "end") || prev.t === "string" || prev.t === "number" ||
      prev.t === "qident" || (prev.t === "ident" && !["is", "not", "and", "or", "as", "distinct", "time", "zone", "in", "like", "ilike", "at"].includes(prev.v));
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
      if (!alias && u.length > 3 && isKw(u[0], "json_build_object", "jsonb_build_object") && isP(u[1], "(") && isP(u[u.length - 1], ")")) {
        const args = splitTop(u.slice(2, -1));
        for (let k = 0; k + 1 < args.length; k += 2) {
          const key = args[k].length === 1 && args[k][0].t === "string" ? args[k][0].v : "?key?";
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
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

const SENSITIVE_WORDS = new Set([
  "domain", "domains", "myshopify", "email", "emails", "phone", "address", "addresses", "name", "names",
  "firstname", "lastname", "note", "notes", "narration", "payer", "remitter", "text", "message", "messages",
  "payload", "body", "raw", "amount", "amounts", "price", "balance", "outstanding", "paise", "money",
  "limit", "token", "secret", "password", "error", "errors", "reason", "description", "comment", "data",
]);
/** Words that make error/reason/shop/limit/message names enum- or id-shaped. */
const SAFE_QUALIFIERS = new Set(["code", "codes", "kind", "format", "disposition", "class", "category", "idx", "index", "id", "gid", "ids", "count", "pos", "exists", "present", "match", "type"]);
const QUALIFIABLE = new Set(["error", "errors", "reason", "shop", "message", "messages", "limit", "data"]);

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

function nameConvention(name: string): Kind | null {
  if (/^(id|.*_id|.*[a-z0-9]Id|.*_gid|.*_idx)$/.test(name)) return "id";
  if (/^(at|.*_at|.*[a-z0-9]At|.*_date|.*[a-z0-9]Date)$/.test(name)) return "timestamp";
  return null;
}

const BOOL_OPS = new Set(["=", "<>", "!=", "<", ">", "<=", ">=", "~", "~*", "!~", "!~*"]);

/** A regex literal that can only match a short identifier-like token. */
export function isSafeGuardRegex(re: string): boolean {
  if (!re.startsWith("^") || !re.endsWith("$")) return false;
  if (/[*+]/.test(re)) return false;
  // no '.' or whitespace outside/inside char classes
  let inClass = false;
  for (let k = 0; k < re.length; k++) {
    const ch = re[k];
    if (ch === "\\") {
      // \s, \S, \W can match spaces / arbitrary text
      if (/[sSW]/.test(re[k + 1] ?? "")) return false;
      k++;
      continue;
    }
    if (ch === "[") inClass = true;
    else if (ch === "]") inClass = false;
    else if (ch === " ") return false;
    else if (ch === "." && !inClass) return false;
  }
  // every repetition must be bounded {m,n} with n <= 200
  for (const m of re.matchAll(/\{(\d+)(?:,(\d*))?\}/g)) {
    if (m[2] === "") return false;
    if (Number(m[2] ?? m[1]) > 200) return false;
  }
  return true;
}

interface Ctx {
  /** columns / JSON keys passed through to the output (for the sensitive check) */
  sources: string[];
}

/** Kind of an expression from its shape, or null when not derivable. */
function deriveKind(exprIn: Tok[], ctx: Ctx): Kind | null {
  const e = unwrap(exprIn);
  if (e.length === 0) return null;
  const d = depths(e);
  const top = (pred: (tk: Tok, k: number) => boolean) => e.some((tk, k) => d[k] === 0 && pred(tk, k));

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
    if (endIdx === e.length - 1 || (endIdx > 0 && isP(e[endIdx + 1], "::"))) return caseKind(e.slice(0, endIdx + 1), ctx);
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
        if (isKw(tk, "is", "like", "ilike", "in", "and", "or", "between", "similar")) bool = true;
        if (isKw(tk, "not", "exists") && k === 0) bool = true;
      }
    });
    if (bool) return "boolean";
  }
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
  // NOW() - x  (interval) / x - NOW()
  if (top((tk) => isP(tk, "-")) && e.some((tk) => isKw(tk, "now", "current_timestamp"))) return "timestamp";

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
      if (["row_number", "rank", "dense_rank"].includes(fn) && isKw(rest[0], "over")) return "id";
      if (["bool_and", "bool_or", "every"].includes(fn)) return "boolean";
      if (fn === "exists") return "boolean";
      if (fn === "coalesce" || fn === "nullif") {
        const kinds = args.map((a) => deriveKind(a, ctx));
        const firstUnresolved = kinds[0] === null;
        // COALESCE(x, 'literal') where x is a passthrough: kind of x (annotation/convention), keep sources
        const others = kinds.slice(1).filter((k) => k !== null);
        if (!firstUnresolved && others.every((k) => k === kinds[0] || (kinds[0] === "boolean" && k === "boolean"))) return kinds[0];
        if (!firstUnresolved && kinds[0] === "boolean") return "boolean";
        collectSources(args[0], ctx);
        return null;
      }
      if (fn === "min" || fn === "max") {
        const inner = deriveKind(args[0] ?? [], ctx);
        if (inner) return inner;
        const nm = defaultName(args[0] ?? []);
        collectSources(args[0] ?? [], ctx);
        return nameConvention(nm);
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

/** Record identifiers and JSON keys referenced by a passthrough expression. */
function collectSources(e: Tok[], ctx: Ctx) {
  e.forEach((tk, k) => {
    const next = e[k + 1];
    const isJsonContainer = !!next && next.t === "op" && ["->>", "->", "#>>", "#>"].includes(next.v);
    if ((tk.t === "ident" || tk.t === "qident") && !isP(next, "(") && !isP(next, ".") && !isJsonContainer) {
      if (tk.t === "ident" && ["null", "true", "false", "now", "interval", "text", "int", "bigint", "integer", "boolean", "timestamptz", "date", "in", "from", "day", "zone", "time", "at"].includes(tk.v)) return;
      if (isP(e[k - 1], "::")) return; // type name
      ctx.sources.push(tk.v);
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
      kinds.push("enum");
      continue;
    }
    const sub: Ctx = { sources: [] };
    const k = deriveKind(r, sub);
    if (k) {
      kinds.push(k);
      continue;
    }
    // passthrough result: classify by its own name convention, keep sources
    ctx.sources.push(...sub.sources);
    const conv = nameConvention(defaultName(r));
    if (!conv) return null;
    kinds.push(conv);
  }
  if (kinds.length === 0) return null;
  return kinds.every((k) => k === kinds[0]) ? kinds[0] : null;
}

/** THEN x guarded by WHEN x ~ '^[...]{1,N}$' or WHEN x IN ('a', ...). */
function isGuarded(result: Tok[], when: Tok[]): boolean {
  const r = text(result);
  for (let k = 0; k < when.length; k++) {
    const tk = when[k];
    if (tk.t === "op" && (tk.v === "~" || tk.v === "~*")) {
      const lhs = when.slice(0, k);
      // allow `AND` chains: take the operand after the last AND/OR
      let s = 0;
      lhs.forEach((x, i) => {
        if (isKw(x, "and", "or")) s = i + 1;
      });
      const re = when[k + 1];
      if (text(unwrap(lhs.slice(s))) === r && re?.t === "string" && isSafeGuardRegex(re.v)) return true;
    }
    if (isKw(tk, "in") && isP(when[k + 1], "(")) {
      let s = 0;
      when.slice(0, k).forEach((x, i) => {
        if (isKw(x, "and", "or")) s = i + 1;
      });
      const lhs = text(unwrap(when.slice(s, k)));
      let j = k + 2;
      let allLit = true;
      while (j < when.length && !isP(when[j], ")")) {
        if (!(when[j].t === "string" || isP(when[j], ","))) allLit = false;
        j++;
      }
      if (lhs === r && allLit) return true;
    }
  }
  return false;
}

// ============================================================================
// File check
// ============================================================================

export function parseAnnotations(sql: string): { ann: Map<string, Kind>; bad: string[] } {
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
      if (!(KINDS as readonly string[]).includes(kind)) bad.push(`${nm}: ${kind}`);
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

export function checkSql(file: string, sql: string): { violations: Violation[]; columns: ColumnReport[] } {
  const violations: Violation[] = [];
  const columns: ColumnReport[] = [];
  const { ann, bad } = parseAnnotations(sql);
  for (const b of bad) violations.push({ file, column: b.split(":")[0].replace(/^--\s*@col\s*/, ""), issue: "bad_annotation", detail: "kind must be one of " + KINDS.join("|") });
  const used = new Set<string>();

  for (const stmt of splitStatements(tokenize(sql))) {
    const head = stmt[0];
    if (isKw(head, "begin", "commit", "rollback", "end", "start")) continue;
    if (isKw(head, "set") && !stmt.some((t) => isKw(t, "select"))) continue;
    if (isKw(head, "show")) {
      const nm = stmt[1]?.v ?? "?";
      const k = ann.get(nm) ?? null;
      if (k) used.add(nm);
      columns.push({ column: nm, kind: k, via: k ? "annotation" : null });
      if (!k) violations.push({ file, column: nm, issue: "unclassified", detail: "SHOW output needs an @col annotation" });
      else if (k === "config_int" && !CONFIG_INT_COLUMNS.includes(nm)) violations.push({ file, column: nm, issue: "config_int_not_listed", detail: "config_int is only for named settings" });
      continue;
    }
    if (!isKw(head, "select", "with") && !(isP(head, "(") && stmt.some((t) => isKw(t, "select")))) {
      violations.push({ file, column: "(statement)", issue: "unsupported_statement", detail: `starts with '${head.raw}'` });
      continue;
    }
    const branches = outputColumns(stmt);
    if (!branches || branches.length === 0 || branches[0].length === 0) {
      violations.push({ file, column: "(statement)", issue: "unparseable", detail: "could not find the outer select list" });
      continue;
    }
    const names = branches[0].map((c) => c.name);
    branches.forEach((cols, bi) => {
      if (cols.length !== names.length) {
        violations.push({ file, column: "(statement)", issue: "unparseable", detail: "UNION branches differ in width" });
        return;
      }
      cols.forEach((col, ci) => {
        const nm = names[ci];
        if (col.expr.length === 1 && isP(col.expr[0], "*") || (col.expr.length >= 3 && isP(col.expr[col.expr.length - 1], "*") && isP(col.expr[col.expr.length - 2], "."))) {
          violations.push({ file, column: "*", issue: "star", detail: "SELECT * prints every column" });
          return;
        }
        const ctx: Ctx = { sources: [] };
        let kind = deriveKind(col.expr, ctx);
        let via: ColumnReport["via"] = kind ? "derived" : null;
        const annK = ann.get(nm);
        if (annK) used.add(nm);
        if (!kind && annK) {
          kind = annK;
          via = "annotation";
        }
        if (!kind) {
          const conv = nameConvention(nm);
          if (conv) {
            kind = conv;
            via = "convention";
          }
        }
        if (bi === 0) columns.push({ column: nm, kind, via });
        // sensitive check: skip only for derived count/boolean (they cannot carry the value)
        const derivedSafe = via === "derived" && (kind === "count" || kind === "boolean");
        if (!derivedSafe) {
          const hits = [nm, ...ctx.sources].map((s) => [s, sensitiveWord(s)] as const).filter(([, w]) => w);
          if (hits.length) {
            violations.push({ file, column: nm, issue: "sensitive", detail: `looks like '${hits[0][1]}' (from ${hits[0][0] === nm ? "output name" : "source " + hits[0][0]})` });
            return;
          }
        }
        if (kind === "config_int") {
          const offList = [nm, ...ctx.sources].filter((s) => !CONFIG_INT_COLUMNS.includes(s));
          if (offList.length) {
            violations.push({ file, column: nm, issue: "config_int_not_listed", detail: `config_int is only for named settings (${CONFIG_INT_COLUMNS.join(", ")}); not listed: ${offList[0]}` });
            return;
          }
        }
        if (!kind) violations.push({ file, column: nm, issue: "unclassified", detail: `no derived kind, @col annotation or naming convention for: ${text(col.expr).slice(0, 80)}` });
      });
    });
  }
  for (const nm of ann.keys()) {
    if (!used.has(nm)) violations.push({ file, column: nm, issue: "stale_annotation", detail: "@col names a column that is not in any output" });
  }
  return { violations, columns };
}

// ============================================================================
// Allowlist ratchet
// ============================================================================

export function compareAllowlist(violations: Violation[], allowlist: AllowlistEntry[]) {
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
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith(".sql")).sort() : [];
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
    allowlist = Array.isArray(parsed) ? parsed : parsed.entries ?? [];
  }
  const { newViolations, stale } = compareAllowlist(all, allowlist);
  console.log(`readonly column guard: ${files.length} files, ${columnCount} output columns, ${all.length} violations, ${allowlist.length} allowlist entries`);
  for (const v of newViolations) console.log(`::error file=${v.file}::${v.file}: column ${v.column}: ${v.issue}: ${v.detail}`);
  for (const s of stale) console.log(`::error file=${s.entry.file}::stale allowlist entry ${s.entry.file}:${s.entry.column}:${s.entry.issue} allows ${s.entry.count}, found ${s.actual}. Lower or remove it (counts only go down).`);
  if (newViolations.length || stale.length) {
    console.log("FAIL: see scripts/readonly/README.md for allowed kinds and @col annotations.");
    return 1;
  }
  console.log("OK");
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  const root = process.env.READONLY_COLUMNS_ROOT ?? path.resolve(__dirname, "../..");
  const allow = process.env.READONLY_COLUMNS_ALLOWLIST ?? path.join(__dirname, "readonly-columns-allowlist.json");
  if (process.argv.includes("--report")) {
    const dir = path.join(root, "scripts", "readonly");
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(".sql")).sort()) {
      const res = checkSql(`scripts/readonly/${f}`, fs.readFileSync(path.join(dir, f), "utf8"));
      for (const c of res.columns) console.log(`${f}\t${c.column}\t${c.kind ?? "-"}\t${c.via ?? "-"}`);
      for (const v of res.violations) console.log(`VIOLATION\t${f}\t${v.column}\t${v.issue}\t${v.detail}`);
    }
    process.exit(0);
  }
  process.exit(run(root, allow));
}
