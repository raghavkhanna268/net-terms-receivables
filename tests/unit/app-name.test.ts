/**
 * Guard Test: App Name Consistency
 *
 * This test ensures the app's merchant-visible name is consistently
 * "Termwise: Net Terms & Credit" and that no old name variants
 * appear in UI string literals.
 *
 * Run: npm test -- tests/unit/app-name.test.ts
 */

import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";

const NEW_APP_NAME = "Termwise: Net Terms & Credit";

const OLD_NAME_PATTERN = /Net Terms Receivables/gi;

const SKIP_PATHS = [
  // ci workflows (read-only, must not edit)
  ".github/workflows",
  "scripts/ci",
  // generated files (Prisma, etc.)
  "app/generated",
];

const ALLOWLIST_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  // Package name in package.json (not merchant-visible)
  { pattern: /"name":\s*"net-terms-receivables"/, reason: "package.json name field" },
  // APP_HANDLE env var (not merchant-visible)
  { pattern: /APP_HANDLE.*net-terms-receivables/i, reason: "APP_HANDLE env var" },
  // Worker URLs (not merchant-visible)
  { pattern: /net-terms-receivables\.[^/]+\.workers\.dev/, reason: "Worker URL" },
  // GitHub URLs (not merchant-visible)
  { pattern: /github\.com\/[^/]+\/net-terms-receivables/, reason: "GitHub URL" },
  // Admin URL charges path (not merchant-visible in UI strings)
  { pattern: /\/charges\/net-terms-receivables/, reason: "Admin charges URL" },
  // App installations path (not merchant-visible)
  { pattern: /\/apps\/net-terms-receivables/, reason: "Admin apps URL" },
  // Metafield namespaces/keys (not merchant-visible)
  { pattern: /\$app:/, reason: "Metafield namespace" },
  // Handle in quoted strings (not merchant-visible)
  { pattern: /"net-terms-receivables(-1)?"/, reason: "Handle in quotes" },
  { pattern: /'net-terms-receivables(-1)?'/, reason: "Handle in single quotes" },
  { pattern: /`net-terms-receivables(-1)?`/, reason: "Handle in backticks" },
];

/**
 * Exact file:line allowlist for slot file strings pending follow-up.
 * Each entry specifies an exact file path and line number to skip.
 * These are strings in slot files that will be renamed in a separate PR.
 *
 * IMPORTANT: The test verifies these entries are not stale. If an allowlisted
 * line no longer contains the old name, the test fails with 'stale allowlist entry'.
 */
const PENDING_FOLLOWUP_ALLOWLIST: Array<{
  file: string;
  line: number;
  reason: string;
}> = [
  // pending follow-up: remove after Developer PR merges (compliance.server.ts owner)
  {
    file: "app/services/compliance/compliance.server.ts",
    line: 972,
    reason: "pending follow-up: remove after Developer PR merges",
  },
  // pending follow-up: remove after Developer PR merges (compliance.server.ts owner)
  {
    file: "app/services/compliance/compliance.server.ts",
    line: 976,
    reason: "pending follow-up: remove after Developer PR merges",
  },
  // pending follow-up: remove after Developer PR merges (compliance.server.ts owner)
  {
    file: "app/services/compliance/compliance.server.ts",
    line: 985,
    reason: "pending follow-up: remove after Developer PR merges",
  },
  // pending follow-up: remove after Developer PR merges (compliance.server.ts owner)
  {
    file: "app/services/compliance/compliance.server.ts",
    line: 998,
    reason: "pending follow-up: remove after Developer PR merges",
  },
  // pending follow-up: privacy.tsx title; rename in second PR
  {
    file: "app/routes/privacy.tsx",
    line: 266,
    reason: "pending follow-up: rename in second PR (after #357 merged)",
  },
  // pending follow-up: remove after Developer PR merges (test for compliance.server.ts)
  {
    file: "app/services/compliance/__tests__/compliance.test.ts",
    line: 1051,
    reason: "pending follow-up: remove after Developer PR merges",
  },
  // pending follow-up: remove after Developer PR merges (test for compliance.server.ts)
  {
    file: "app/services/compliance/__tests__/compliance.test.ts",
    line: 1053,
    reason: "pending follow-up: remove after Developer PR merges",
  },
  // pending follow-up: privacy.test.ts title expectation; rename in second PR
  {
    file: "app/routes/__tests__/privacy.test.ts",
    line: 105,
    reason: "pending follow-up: rename in second PR (after #357 merged)",
  },
];

function isInSkipPath(filePath: string): boolean {
  for (const skipPath of SKIP_PATHS) {
    if (filePath.includes(skipPath)) {
      return true;
    }
  }
  return false;
}

function isPendingFollowup(filePath: string, lineNumber: number): boolean {
  return PENDING_FOLLOWUP_ALLOWLIST.some(
    (entry) => filePath === entry.file && lineNumber === entry.line
  );
}

function isAllowlisted(line: string): boolean {
  return ALLOWLIST_PATTERNS.some(({ pattern }) => pattern.test(line));
}

function isInStringLiteral(line: string, match: RegExpMatchArray): boolean {
  const matchStart = match.index!;
  const matchEnd = matchStart + match[0].length;
  const beforeMatch = line.slice(0, matchStart);
  const afterMatch = line.slice(matchEnd);

  const inDoubleQuote =
    (beforeMatch.split('"').length - 1) % 2 === 1 &&
    (afterMatch.split('"').length - 1) % 2 === 1;
  const inSingleQuote =
    (beforeMatch.split("'").length - 1) % 2 === 1 &&
    (afterMatch.split("'").length - 1) % 2 === 1;
  const inBacktick =
    (beforeMatch.split("`").length - 1) % 2 === 1 &&
    (afterMatch.split("`").length - 1) % 2 === 1;
  const inJSX =
    beforeMatch.includes(">") &&
    !beforeMatch.slice(beforeMatch.lastIndexOf(">")).includes("<") &&
    afterMatch.includes("<");

  return inDoubleQuote || inSingleQuote || inBacktick || inJSX;
}

function isInComment(line: string): boolean {
  const trimmed = line.trim();
  if (trimmed.startsWith("//")) return true;
  if (trimmed.startsWith("*")) return true;
  if (trimmed.startsWith("/*")) return true;
  return false;
}

function findTsFiles(dir: string, files: string[] = []): string[] {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === ".git") continue;
      findTsFiles(fullPath, files);
    } else if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) {
      files.push(fullPath);
    }
  }
  return files;
}

/**
 * Verify that all PENDING_FOLLOWUP_ALLOWLIST entries are still valid.
 * An entry is stale if the line no longer contains the old name pattern.
 */
function checkForStaleAllowlistEntries(): string[] {
  const staleEntries: string[] = [];

  for (const entry of PENDING_FOLLOWUP_ALLOWLIST) {
    const filePath = path.join(process.cwd(), entry.file);
    if (!fs.existsSync(filePath)) {
      staleEntries.push(`${entry.file}:${entry.line} - file does not exist`);
      continue;
    }

    const content = fs.readFileSync(filePath, "utf-8");
    const lines = content.split("\n");
    const lineIndex = entry.line - 1;

    if (lineIndex < 0 || lineIndex >= lines.length) {
      staleEntries.push(`${entry.file}:${entry.line} - line number out of range`);
      continue;
    }

    const line = lines[lineIndex];
    OLD_NAME_PATTERN.lastIndex = 0;
    if (!OLD_NAME_PATTERN.test(line)) {
      staleEntries.push(`${entry.file}:${entry.line} - line no longer contains old name`);
    }
  }

  return staleEntries;
}

describe("App Name Guard", () => {
  it("shopify.app.toml has correct app name", () => {
    const tomlPath = path.join(process.cwd(), "shopify.app.toml");
    const content = fs.readFileSync(tomlPath, "utf-8");
    const nameMatch = content.match(/^name\s*=\s*"([^"]+)"/m);

    expect(nameMatch).not.toBeNull();
    expect(nameMatch![1]).toBe(NEW_APP_NAME);
  });

  it("pending followup allowlist entries are not stale", () => {
    const staleEntries = checkForStaleAllowlistEntries();

    if (staleEntries.length > 0) {
      const message = staleEntries
        .map((e) => `  ${e}`)
        .join("\n");
      expect.fail(
        `stale allowlist entry, remove it:\n${message}`
      );
    }
  });

  it("no old app name in UI strings (app/**/*.{ts,tsx})", () => {
    const appDir = path.join(process.cwd(), "app");
    const files = findTsFiles(appDir);
    const violations: Array<{ file: string; line: number; text: string }> = [];

    for (const filePath of files) {
      const relativePath = path.relative(process.cwd(), filePath);

      if (isInSkipPath(relativePath)) {
        continue;
      }

      const content = fs.readFileSync(filePath, "utf-8");
      const lines = content.split("\n");

      for (let i = 0; i < lines.length; i++) {
        const lineNumber = i + 1;
        const line = lines[i];

        if (isInComment(line)) {
          continue;
        }

        if (isAllowlisted(line)) {
          continue;
        }

        if (isPendingFollowup(relativePath, lineNumber)) {
          continue;
        }

        OLD_NAME_PATTERN.lastIndex = 0;
        const match = OLD_NAME_PATTERN.exec(line);
        if (match && isInStringLiteral(line, match)) {
          violations.push({
            file: relativePath,
            line: lineNumber,
            text: line.trim().slice(0, 100),
          });
        }
      }
    }

    if (violations.length > 0) {
      const message = violations
        .map((v) => `  ${v.file}:${v.line}: ${v.text}`)
        .join("\n");
      expect.fail(
        `Found ${violations.length} occurrence(s) of old app name in UI strings:\n${message}`
      );
    }
  });

  it("no old app name in email templates (outside slot files)", () => {
    const emailsDir = path.join(process.cwd(), "app", "emails");
    if (!fs.existsSync(emailsDir)) {
      return;
    }

    const files = findTsFiles(emailsDir);
    const violations: Array<{ file: string; line: number; text: string }> = [];

    for (const filePath of files) {
      const relativePath = path.relative(process.cwd(), filePath);

      if (isInSkipPath(relativePath)) {
        continue;
      }

      const content = fs.readFileSync(filePath, "utf-8");
      const lines = content.split("\n");

      for (let i = 0; i < lines.length; i++) {
        const lineNumber = i + 1;
        const line = lines[i];

        if (isInComment(line)) {
          continue;
        }

        if (isPendingFollowup(relativePath, lineNumber)) {
          continue;
        }

        OLD_NAME_PATTERN.lastIndex = 0;
        const match = OLD_NAME_PATTERN.exec(line);
        if (match && isInStringLiteral(line, match)) {
          violations.push({
            file: relativePath,
            line: lineNumber,
            text: line.trim().slice(0, 100),
          });
        }
      }
    }

    if (violations.length > 0) {
      const message = violations
        .map((v) => `  ${v.file}:${v.line}: ${v.text}`)
        .join("\n");
      expect.fail(
        `Found ${violations.length} occurrence(s) of old app name in email templates:\n${message}`
      );
    }
  });
});
