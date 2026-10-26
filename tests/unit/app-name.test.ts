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

const OLD_NAME_PATTERNS = [
  /Net Terms Receivables/gi,
];

const SLOT_FILES = new Set([
  "log.server.ts",
  "log.server.tsx",
  "compliance.server.ts",
  "reminders.server.ts",
  "reconcile.server.ts",
  "after-auth.ts",
  "after-auth.server.ts",
  "apply.server.ts",
  "drain.ts",
  "drain.server.ts",
  "plan.server.ts",
  "request-context.server.ts",
  "sentry.ts",
]);

const SLOT_PATHS = [
  // app/lib/banks is a slot directory
  "app/lib/banks",
  // ci workflows
  ".github/workflows",
  "scripts/ci",
  // generated files (Prisma, etc.)
  "app/generated",
  // tests for slot files
  "app/services/compliance/__tests__",
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

function isSlotFile(filePath: string): boolean {
  const fileName = path.basename(filePath);
  if (SLOT_FILES.has(fileName)) {
    return true;
  }
  for (const slotPath of SLOT_PATHS) {
    if (filePath.includes(slotPath)) {
      return true;
    }
  }
  return false;
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

describe("App Name Guard", () => {
  it("shopify.app.toml has correct app name", () => {
    const tomlPath = path.join(process.cwd(), "shopify.app.toml");
    const content = fs.readFileSync(tomlPath, "utf-8");
    const nameMatch = content.match(/^name\s*=\s*"([^"]+)"/m);

    expect(nameMatch).not.toBeNull();
    expect(nameMatch![1]).toBe(NEW_APP_NAME);
  });

  it("no old app name in UI strings (app/**/*.{ts,tsx})", () => {
    const appDir = path.join(process.cwd(), "app");
    const files = findTsFiles(appDir);
    const violations: Array<{ file: string; line: number; text: string }> = [];

    for (const filePath of files) {
      const relativePath = path.relative(process.cwd(), filePath);

      if (isSlotFile(relativePath)) {
        continue;
      }

      const content = fs.readFileSync(filePath, "utf-8");
      const lines = content.split("\n");

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];

        if (isInComment(line)) {
          continue;
        }

        if (isAllowlisted(line)) {
          continue;
        }

        for (const pattern of OLD_NAME_PATTERNS) {
          pattern.lastIndex = 0;
          const match = pattern.exec(line);
          if (match && isInStringLiteral(line, match)) {
            violations.push({
              file: relativePath,
              line: i + 1,
              text: line.trim().slice(0, 100),
            });
          }
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

      if (isSlotFile(relativePath)) {
        continue;
      }

      const content = fs.readFileSync(filePath, "utf-8");
      const lines = content.split("\n");

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];

        if (isInComment(line)) {
          continue;
        }

        for (const pattern of OLD_NAME_PATTERNS) {
          pattern.lastIndex = 0;
          const match = pattern.exec(line);
          if (match && isInStringLiteral(line, match)) {
            violations.push({
              file: relativePath,
              line: i + 1,
              text: line.trim().slice(0, 100),
            });
          }
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
