import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { checkSql } from "../check-readonly-columns";

/**
 * G3: scripts/readonly/g3-shop-config-currency-counts.sql must print exactly
 * three integer counts (a, b, c), stay read-only, carry the #337 cutoff as a
 * constant, and be runnable from prod-readonly-query.yml.
 */

const root = path.resolve(__dirname, "../../..");
const rel = "scripts/readonly/g3-shop-config-currency-counts.sql";
const sql = fs.readFileSync(path.join(root, rel), "utf8");
const code = sql
  .split("\n")
  .filter((l) => !l.trimStart().startsWith("--"))
  .join("\n");
// SQL only: drop the allowed psql meta lines (\set ON_ERROR_STOP 1, \echo '...')
// and string literals before keyword checks.
const sqlOnly = code
  .split("\n")
  .filter((l) => !/^\\(set ON_ERROR_STOP 1|echo '[^']*')$/.test(l.trim()))
  .join("\n")
  .replace(/'[^']*'/g, "''");

describe("g3-shop-config-currency-counts.sql", () => {
  it("passes the public-logs column check with exactly three derived counts a, b, c", () => {
    const { violations, columns } = checkSql(rel, sql);
    expect(violations).toEqual([]);
    expect(columns).toEqual([
      { column: "a", kind: "count", via: "derived" },
      { column: "b", kind: "count", via: "derived" },
      { column: "c", kind: "count", via: "derived" },
    ]);
  });

  it("has exactly one SELECT, wrapped in a read-only transaction that rolls back", () => {
    expect(sqlOnly).not.toMatch(/\\/);
    expect(sqlOnly.match(/\bSELECT\b/gi)).toHaveLength(1);
    expect(code).toMatch(/BEGIN TRANSACTION READ ONLY;/);
    expect(code.trimEnd()).toMatch(/ROLLBACK;$/);
    expect(sqlOnly).not.toMatch(
      /\b(INSERT|UPDATE|DELETE|MERGE|TRUNCATE|CREATE|ALTER|DROP|GRANT|REVOKE|COPY|CALL|DO|SET|COMMIT|nextval|setval|pg_\w+)\b/i,
    );
  });

  it("uses the #337 merge time as a constant cutoff and no psql variables", () => {
    const literals = code.match(/TIMESTAMPTZ '[^']+'/g) ?? [];
    expect(literals.length).toBeGreaterThan(0);
    expect(new Set(literals)).toEqual(
      new Set(["TIMESTAMPTZ '2026-10-26 00:16:21+00'"]),
    );
    expect(sql).toContain("e46c08b15db022e102c275d509bd9a471df85c3e");
    expect(code).not.toMatch(/:['"]?[a-z_]+/i);
  });

  it("counts NULL currency as not INR", () => {
    expect(code).toMatch(/currency IS DISTINCT FROM 'INR'/);
  });

  it("is a choice option of prod-readonly-query.yml", () => {
    const wf = fs.readFileSync(
      path.join(root, ".github/workflows/prod-readonly-query.yml"),
      "utf8",
    );
    expect(wf).toMatch(/^\s+- g3-shop-config-currency-counts$/m);
  });
});
