/**
 * Static audit tests for public-logs hygiene (QA 2 audit).
 *
 * Scans the SQL files and workflow steps for:
 * - Selected id columns that would print IDs to public logs
 * - Hardcoded GIDs (gid://shopify/...) or UUIDs
 *
 * This is a fail-closed check: any match fails the test.
 */
import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";

const ROOT = path.resolve(__dirname, "../../..");
const SQL_DIR = path.join(ROOT, "scripts", "readonly");
const WORKFLOW_PATH = path.join(ROOT, ".github", "workflows", "prod-diagnostics.yml");

/**
 * Patterns for hardcoded GIDs and UUIDs that should not appear in the tree.
 * Note: SQL column selection is checked by check-readonly-columns.ts with proper SQL parsing.
 */
const HARDCODED_ID_PATTERNS = [
  // Shopify GIDs with numeric IDs (not parameterized)
  /gid:\/\/shopify\/\w+\/\d+/gi,
  // UUIDs
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi,
];

/**
 * Known exceptions: lines that match patterns but are actually safe.
 * These are parameterized references or comments.
 */
const SAFE_PATTERNS = [
  // Parameterized GID patterns using psql variables
  /\|\|\s*:'[\w_]+'/,
  // Comments documenting the pattern
  /^--/,
  /^\s*#/,
  // Example patterns in comments
  /Example:/i,
  /e\.g\./i,
];

function isSafeLine(line: string): boolean {
  return SAFE_PATTERNS.some(p => p.test(line));
}

interface Violation {
  file: string;
  line: number;
  content: string;
  pattern: string;
}

function scanFile(filePath: string, patterns: RegExp[]): Violation[] {
  const violations: Violation[] = [];
  const content = fs.readFileSync(filePath, "utf8");
  const lines = content.split("\n");

  lines.forEach((line, idx) => {
    if (isSafeLine(line)) return;

    for (const pattern of patterns) {
      pattern.lastIndex = 0; // Reset regex state
      const match = pattern.exec(line);
      if (match) {
        violations.push({
          file: path.relative(ROOT, filePath),
          line: idx + 1,
          content: line.trim().slice(0, 100),
          pattern: pattern.source.slice(0, 50),
        });
      }
    }
  });

  return violations;
}

describe("public-logs-static-audit: SQL files", () => {
  const sqlFiles = fs.existsSync(SQL_DIR)
    ? fs.readdirSync(SQL_DIR).filter(f => f.endsWith(".sql")).map(f => path.join(SQL_DIR, f))
    : [];

  // NOTE: SQL column selection patterns are checked by check-readonly-columns.ts
  // which uses proper SQL parsing. This static test only checks for hardcoded GIDs/UUIDs
  // that escaped removal. CTE internal references are allowed since they don't appear
  // in output columns.

  it("SQL files should not contain hardcoded GIDs or UUIDs (excluding parameterized)", () => {
    const violations: Violation[] = [];

    for (const file of sqlFiles) {
      violations.push(...scanFile(file, HARDCODED_ID_PATTERNS));
    }

    if (violations.length > 0) {
      const report = violations
        .map(v => `${v.file}:${v.line}: ${v.content}`)
        .join("\n");
      expect.fail(
        `Found ${violations.length} hardcoded GID/UUID(s) in SQL files:\n${report}\n\n` +
        "Use parameterized variables from masked environment secrets instead."
      );
    }
  });
});

describe("public-logs-static-audit: workflow file", () => {
  it("prod-diagnostics.yml should not print fixture IDs in jq output", () => {
    if (!fs.existsSync(WORKFLOW_PATH)) {
      return; // Skip if workflow doesn't exist
    }

    const content = fs.readFileSync(WORKFLOW_PATH, "utf8");
    const lines = content.split("\n");
    const violations: Violation[] = [];

    // Look for jq output that includes id fields
    const idOutputPatterns = [
      // jq selections that output id fields directly
      /\{buyer_account_id,/gi,
      /\{.*company_location_id,/gi,
      /\{.*customer_id,/gi,
      /\{.*company_id,/gi,
      // echo or printf that would print fixture ids
      /echo.*\$\{.*_id\}/gi,
    ];

    lines.forEach((line, idx) => {
      if (isSafeLine(line)) return;

      for (const pattern of idOutputPatterns) {
        pattern.lastIndex = 0;
        if (pattern.test(line)) {
          violations.push({
            file: path.relative(ROOT, WORKFLOW_PATH),
            line: idx + 1,
            content: line.trim().slice(0, 100),
            pattern: pattern.source.slice(0, 50),
          });
        }
      }
    });

    if (violations.length > 0) {
      const report = violations
        .map(v => `${v.file}:${v.line}: ${v.content}`)
        .join("\n");
      expect.fail(
        `Found ${violations.length} fixture ID output(s) in workflow:\n${report}\n\n` +
        "Print counts only, not individual IDs."
      );
    }
  });

  it("prod-diagnostics.yml should not contain hardcoded GIDs", () => {
    if (!fs.existsSync(WORKFLOW_PATH)) {
      return;
    }

    const violations = scanFile(WORKFLOW_PATH, HARDCODED_ID_PATTERNS);

    if (violations.length > 0) {
      const report = violations
        .map(v => `${v.file}:${v.line}: ${v.content}`)
        .join("\n");
      expect.fail(
        `Found ${violations.length} hardcoded GID/UUID(s) in workflow:\n${report}\n\n` +
        "Use masked secrets for production IDs."
      );
    }
  });
});

describe("public-logs-static-audit: backstop-backfill.ts", () => {
  const BACKSTOP_PATH = path.join(ROOT, "scripts", "backstop-backfill.ts");

  it("backstop-backfill.ts should not print buyer account IDs", () => {
    if (!fs.existsSync(BACKSTOP_PATH)) {
      return;
    }

    const content = fs.readFileSync(BACKSTOP_PATH, "utf8");
    const lines = content.split("\n");
    const violations: Violation[] = [];

    // Look for console.log that prints account IDs
    const idPrintPatterns = [
      /console\.log.*buyerAccountId/gi,
      /console\.log.*account:\s*\$\{/gi,
    ];

    lines.forEach((line, idx) => {
      if (isSafeLine(line)) return;

      for (const pattern of idPrintPatterns) {
        pattern.lastIndex = 0;
        if (pattern.test(line)) {
          violations.push({
            file: path.relative(ROOT, BACKSTOP_PATH),
            line: idx + 1,
            content: line.trim().slice(0, 100),
            pattern: pattern.source.slice(0, 50),
          });
        }
      }
    });

    if (violations.length > 0) {
      const report = violations
        .map(v => `${v.file}:${v.line}: ${v.content}`)
        .join("\n");
      expect.fail(
        `Found ${violations.length} buyer account ID print(s) in backstop script:\n${report}\n\n` +
        "Print counts or generic status only."
      );
    }
  });
});
