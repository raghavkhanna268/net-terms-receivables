import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { checkSql } from "../check-readonly-columns";

/**
 * G3 follow-up: scripts/readonly/g3-noninr-is-dev-store.sql must print exactly
 * one count and one boolean, stay read-only, compare against the :allowed
 * psql variable only (set from the ALLOWED_DEV_STORE secret), use the same
 * #337 cutoff and non-INR rule as g3-shop-config-currency-counts.sql, and be
 * runnable from prod-readonly-query.yml without any shop input.
 */

const root = path.resolve(__dirname, "../../..");
const rel = "scripts/readonly/g3-noninr-is-dev-store.sql";
const sql = fs.readFileSync(path.join(root, rel), "utf8");
const code = sql
  .split("\n")
  .filter((l) => !l.trimStart().startsWith("--"))
  .join("\n");
const sqlOnly = code
  .split("\n")
  .filter((l) => !/^\\(set ON_ERROR_STOP 1|echo '[^']*')$/.test(l.trim()))
  .join("\n")
  .replace(/'[^']*'/g, "''");
const wf = fs.readFileSync(
  path.join(root, ".github/workflows/prod-readonly-query.yml"),
  "utf8",
);

describe("g3-noninr-is-dev-store.sql", () => {
  it("passes the public-logs column check with one count and one boolean", () => {
    const { violations, columns } = checkSql(rel, sql);
    expect(violations).toEqual([]);
    expect(columns).toEqual([
      { column: "noninr_count", kind: "count", via: "derived" },
      { column: "noninr_is_dev_store", kind: "boolean", via: "derived" },
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

  it("uses the same #337 cutoff and non-INR rule as g3-shop-config-currency-counts.sql", () => {
    const literals = code.match(/TIMESTAMPTZ '[^']+'/g) ?? [];
    expect(new Set(literals)).toEqual(
      new Set(["TIMESTAMPTZ '2026-10-26 00:16:21+00'"]),
    );
    expect(code).toMatch(/s\."uninstalledAt" IS NULL/);
    expect(code).toMatch(/currency IS DISTINCT FROM 'INR'/);
  });

  it("compares only against the :allowed psql variable, inside SQL", () => {
    const vars = code.match(/:'?[a-z_]+'?/gi) ?? [];
    expect(new Set(vars)).toEqual(new Set([":'allowed'"]));
    expect(code).toMatch(/bool_and\(s\.domain = :'allowed'\)/);
    // domain appears only inside the comparison, never as an output column
    expect(code.match(/\bdomain\b/g)).toHaveLength(1);
  });

  it("is a choice option of prod-readonly-query.yml and takes no shop input", () => {
    expect(wf).toMatch(/^\s+- g3-noninr-is-dev-store$/m);
    expect(wf).not.toMatch(/^\s{6}shop:/m);
  });

  it("gets :allowed from the ALLOWED_DEV_STORE secret, validated and masked, and fails closed", () => {
    expect(wf).toContain("ALLOWED_DEV_STORE: ${{ secrets.ALLOWED_DEV_STORE }}");
    expect(wf).toContain('echo "::add-mask::$ALLOWED"');
    expect(wf).toContain('-v "allowed=${ALLOWED}"');
    expect(wf).toMatch(
      /if \[ "\$QUERY_NAME" = "g3-noninr-is-dev-store" \] && \[ -z "\$ALLOWED" \]; then\n\s+echo "::error::[^"]*"\n\s+exit 1/,
    );
    const maskAt = wf.indexOf('echo "::add-mask::$ALLOWED"');
    const validateAt = wf.indexOf("myshopify");
    expect(validateAt).toBeGreaterThan(-1);
    expect(validateAt).toBeLessThan(maskAt);
  });
});
