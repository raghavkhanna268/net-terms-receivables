/**
 * Guard Test: App Name Consistency
 *
 * This test ensures the app's merchant-visible name is consistently
 * "Termwise: Net Terms & Credit" and that no old name variants
 * appear in UI string literals, including across line breaks.
 *
 * Run: npm test -- tests/unit/app-name.test.ts
 */

import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";

const NEW_APP_NAME = "Termwise: Net Terms & Credit";

const OLD_NAME_PATTERN = /Net\s+Terms\s+Receivables/gi;

const SKIP_PATHS = [
  ".github/workflows",
  "scripts/ci",
  "app/generated",
];

const ALLOWLIST_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /"name":\s*"net-terms-receivables"/, reason: "package.json name field" },
  { pattern: /APP_HANDLE.*net-terms-receivables/i, reason: "APP_HANDLE env var" },
  { pattern: /net-terms-receivables\.[^/]+\.workers\.dev/, reason: "Worker URL" },
  { pattern: /github\.com\/[^/]+\/net-terms-receivables/, reason: "GitHub URL" },
  { pattern: /\/charges\/net-terms-receivables/, reason: "Admin charges URL" },
  { pattern: /\/apps\/net-terms-receivables/, reason: "Admin apps URL" },
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
  {
    file: "app/services/compliance/compliance.server.ts",
    line: 972,
    reason: "pending follow-up: remove after Developer PR merges",
  },
  {
    file: "app/services/compliance/compliance.server.ts",
    line: 976,
    reason: "pending follow-up: remove after Developer PR merges",
  },
  {
    file: "app/services/compliance/compliance.server.ts",
    line: 985,
    reason: "pending follow-up: remove after Developer PR merges",
  },
  {
    file: "app/services/compliance/compliance.server.ts",
    line: 998,
    reason: "pending follow-up: remove after Developer PR merges",
  },
  {
    file: "app/routes/privacy.tsx",
    line: 266,
    reason: "pending follow-up: rename in second PR (after #357 merged)",
  },
  {
    file: "app/services/compliance/__tests__/compliance.test.ts",
    line: 1051,
    reason: "pending follow-up: remove after Developer PR merges",
  },
  {
    file: "app/services/compliance/__tests__/compliance.test.ts",
    line: 1053,
    reason: "pending follow-up: remove after Developer PR merges",
  },
  {
    file: "app/routes/__tests__/privacy.test.ts",
    line: 105,
    reason: "pending follow-up: rename in second PR (after #357 merged)",
  },
];

export interface OldNameMatch {
  file: string;
  line: number;
  text: string;
  offset: number;
}

/**
 * Given file content, returns the 1-based line number for a character offset.
 */
export function offsetToLine(content: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < content.length; i++) {
    if (content[i] === "\n") {
      line++;
    }
  }
  return line;
}

/**
 * Pure function: scans content for old app name occurrences.
 * Uses whitespace-normalized matching to catch names split across lines.
 * Returns matches with their starting line numbers.
 */
export function scanForOldName(
  content: string,
  filePath: string
): OldNameMatch[] {
  const matches: OldNameMatch[] = [];
  const lines = content.split("\n");

  const normalized = content.replace(/\s+/g, " ");

  const pattern = new RegExp(OLD_NAME_PATTERN.source, "gi");
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(normalized)) !== null) {
    let originalOffset = 0;
    let normalizedOffset = 0;

    while (normalizedOffset < match.index && originalOffset < content.length) {
      const char = content[originalOffset];
      if (/\s/.test(char)) {
        while (
          originalOffset < content.length - 1 &&
          /\s/.test(content[originalOffset + 1])
        ) {
          originalOffset++;
        }
      }
      originalOffset++;
      normalizedOffset++;
    }

    const lineNumber = offsetToLine(content, originalOffset);
    const lineText = lines[lineNumber - 1] || "";

    matches.push({
      file: filePath,
      line: lineNumber,
      text: lineText.trim().slice(0, 100),
      offset: originalOffset,
    });
  }

  return matches;
}

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

function isAllowlisted(content: string, offset: number, matchLength: number): boolean {
  const contextStart = Math.max(0, offset - 100);
  const contextEnd = Math.min(content.length, offset + matchLength + 100);
  const context = content.slice(contextStart, contextEnd);

  return ALLOWLIST_PATTERNS.some(({ pattern }) => pattern.test(context));
}

function isInComment(content: string, offset: number): boolean {
  const lineStart = content.lastIndexOf("\n", offset) + 1;
  const lineContent = content.slice(lineStart, offset);
  const trimmed = lineContent.trim();

  if (trimmed.startsWith("//")) return true;
  if (trimmed.startsWith("*")) return true;

  const lastBlockOpen = content.lastIndexOf("/*", offset);
  const lastBlockClose = content.lastIndexOf("*/", offset);
  if (lastBlockOpen !== -1 && lastBlockOpen > lastBlockClose) {
    return true;
  }

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
 * An entry is stale if the starting line no longer contains the old name
 * (even with whitespace normalization, the match must START on that line).
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
    const matches = scanForOldName(content, entry.file);

    const hasMatchOnLine = matches.some((m) => m.line === entry.line);
    if (!hasMatchOnLine) {
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

  it("listing/icon.svg is well-formed XML (no bare &)", () => {
    const svgPath = path.join(process.cwd(), "listing/icon.svg");
    const content = fs.readFileSync(svgPath, "utf-8");

    const bareAmpersand = /&(?!amp;|lt;|gt;|quot;|apos;|#\d+;|#x[0-9a-fA-F]+;)/;
    const match = bareAmpersand.exec(content);

    if (match) {
      const lineNumber = offsetToLine(content, match.index);
      expect.fail(
        `listing/icon.svg contains bare '&' at line ${lineNumber}. Use '&amp;' for XML.`
      );
    }
  });

  it("pending followup allowlist entries are not stale", () => {
    const staleEntries = checkForStaleAllowlistEntries();

    if (staleEntries.length > 0) {
      const message = staleEntries.map((e) => `  ${e}`).join("\n");
      expect.fail(`stale allowlist entry, remove it:\n${message}`);
    }
  });

  it("no old app name in UI strings (app/**/*.{ts,tsx})", () => {
    const appDir = path.join(process.cwd(), "app");
    const files = findTsFiles(appDir);
    const violations: OldNameMatch[] = [];

    for (const filePath of files) {
      const relativePath = path.relative(process.cwd(), filePath);

      if (isInSkipPath(relativePath)) {
        continue;
      }

      const content = fs.readFileSync(filePath, "utf-8");
      const matches = scanForOldName(content, relativePath);

      for (const match of matches) {
        if (isInComment(content, match.offset)) {
          continue;
        }

        if (isAllowlisted(content, match.offset, 22)) {
          continue;
        }

        if (isPendingFollowup(relativePath, match.line)) {
          continue;
        }

        violations.push(match);
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
    const violations: OldNameMatch[] = [];

    for (const filePath of files) {
      const relativePath = path.relative(process.cwd(), filePath);

      if (isInSkipPath(relativePath)) {
        continue;
      }

      const content = fs.readFileSync(filePath, "utf-8");
      const matches = scanForOldName(content, relativePath);

      for (const match of matches) {
        if (isInComment(content, match.offset)) {
          continue;
        }

        if (isPendingFollowup(relativePath, match.line)) {
          continue;
        }

        violations.push(match);
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

describe("scanForOldName (unit tests with fixtures)", () => {
  it("detects old name in multi-line template literal footer", () => {
    const fixture = `
const footer = \`
  <p>This is a reminder from
  Net Terms
  Receivables</p>
\`;
`;
    const matches = scanForOldName(fixture, "test-fixture.ts");
    expect(matches.length).toBeGreaterThan(0);
    expect(matches[0].line).toBe(4);
  });

  it("detects old name split across two lines of JSX text", () => {
    const fixture = `
export function Component() {
  return (
    <div>
      Welcome to Net Terms
      Receivables app
    </div>
  );
}
`;
    const matches = scanForOldName(fixture, "test-fixture.tsx");
    expect(matches.length).toBeGreaterThan(0);
    expect(matches[0].line).toBe(5);
  });

  it("detects old name on single line", () => {
    const fixture = `const name = "Net Terms Receivables";`;
    const matches = scanForOldName(fixture, "test-fixture.ts");
    expect(matches.length).toBe(1);
    expect(matches[0].line).toBe(1);
  });

  it("returns empty array when no old name present", () => {
    const fixture = `const name = "Termwise: Net Terms & Credit";`;
    const matches = scanForOldName(fixture, "test-fixture.ts");
    expect(matches.length).toBe(0);
  });

  it("handles multiple occurrences", () => {
    const fixture = `
const a = "Net Terms Receivables";
const b = "Net Terms Receivables";
`;
    const matches = scanForOldName(fixture, "test-fixture.ts");
    expect(matches.length).toBe(2);
    expect(matches[0].line).toBe(2);
    expect(matches[1].line).toBe(3);
  });
});
