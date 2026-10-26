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
    file: "app/services/compliance/__tests__/compliance.test.ts",
    line: 1051,
    reason: "pending follow-up: remove after Developer PR merges",
  },
  {
    file: "app/services/compliance/__tests__/compliance.test.ts",
    line: 1053,
    reason: "pending follow-up: remove after Developer PR merges",
  },
];

export interface OldNameMatch {
  file: string;
  line: number;
  text: string;
  offset: number;
  matchLength: number;
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
    const normalizedMatchLength = match[0].length;
    const normalizedMatchEnd = match.index + normalizedMatchLength;

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

    const matchStartOriginal = originalOffset;

    while (normalizedOffset < normalizedMatchEnd && originalOffset < content.length) {
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

    const matchLength = originalOffset - matchStartOriginal;
    const lineNumber = offsetToLine(content, matchStartOriginal);
    const lineText = lines[lineNumber - 1] || "";

    matches.push({
      file: filePath,
      line: lineNumber,
      text: lineText.trim().slice(0, 100),
      offset: matchStartOriginal,
      matchLength,
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

/**
 * Check if the offset is on a line matching an allowlist pattern.
 * Uses exact line matching (not a context window).
 */
export function isAllowlisted(content: string, offset: number): boolean {
  const lineStart = content.lastIndexOf("\n", offset - 1) + 1;
  const lineEnd = content.indexOf("\n", offset);
  const line = content.slice(lineStart, lineEnd === -1 ? content.length : lineEnd);

  return ALLOWLIST_PATTERNS.some(({ pattern }) => pattern.test(line));
}

/**
 * Check if offset is inside a string literal.
 * Handles single quotes, double quotes, and template literals.
 */
function isInsideStringLiteral(content: string, offset: number): boolean {
  let inSingle = false;
  let inDouble = false;
  let inTemplate = false;

  for (let i = 0; i < offset && i < content.length; i++) {
    const char = content[i];
    const prev = i > 0 ? content[i - 1] : "";

    if (prev === "\\") continue;

    if (char === "'" && !inDouble && !inTemplate) {
      inSingle = !inSingle;
    } else if (char === '"' && !inSingle && !inTemplate) {
      inDouble = !inDouble;
    } else if (char === "`" && !inSingle && !inDouble) {
      inTemplate = !inTemplate;
    }
  }

  return inSingle || inDouble || inTemplate;
}

/**
 * Check if offset is inside a comment (line or block).
 * Properly handles line comments, block comments, unclosed block comments
 * (not treated as comments), and comment markers inside string literals.
 */
export function isInComment(content: string, offset: number): boolean {
  const lineStart = content.lastIndexOf("\n", offset) + 1;
  const lineContent = content.slice(lineStart, offset);
  const trimmed = lineContent.trim();

  if (trimmed.startsWith("//")) return true;
  if (trimmed.startsWith("*")) return true;

  let lastValidBlockOpen = -1;
  let searchStart = 0;

  while (true) {
    const blockOpen = content.indexOf("/*", searchStart);
    if (blockOpen === -1 || blockOpen >= offset) break;

    if (!isInsideStringLiteral(content, blockOpen)) {
      const blockClose = content.indexOf("*/", blockOpen + 2);
      if (blockClose === -1 || blockClose >= offset) {
        lastValidBlockOpen = blockOpen;
        break;
      }
      searchStart = blockClose + 2;
    } else {
      searchStart = blockOpen + 2;
    }
  }

  if (lastValidBlockOpen !== -1) {
    const nextClose = content.indexOf("*/", offset);
    if (nextClose !== -1) {
      return true;
    }
  }

  return false;
}

/**
 * Find violations in file content after applying comment and allowlist filters.
 * This is the core logic used by the guard test.
 */
export function findViolations(
  content: string,
  filePath: string,
  pendingAllowlist: Array<{ file: string; line: number }> = []
): OldNameMatch[] {
  const matches = scanForOldName(content, filePath);
  const violations: OldNameMatch[] = [];

  for (const match of matches) {
    if (isInComment(content, match.offset)) {
      continue;
    }

    if (isAllowlisted(content, match.offset)) {
      continue;
    }

    const isPending = pendingAllowlist.some(
      (entry) => filePath === entry.file && match.line === entry.line
    );
    if (isPending) {
      continue;
    }

    violations.push(match);
  }

  return violations;
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
    const allViolations: OldNameMatch[] = [];

    for (const filePath of files) {
      const relativePath = path.relative(process.cwd(), filePath);

      if (isInSkipPath(relativePath)) {
        continue;
      }

      const content = fs.readFileSync(filePath, "utf-8");
      const violations = findViolations(content, relativePath, PENDING_FOLLOWUP_ALLOWLIST);
      allViolations.push(...violations);
    }

    if (allViolations.length > 0) {
      const message = allViolations
        .map((v) => `  ${v.file}:${v.line}: ${v.text}`)
        .join("\n");
      expect.fail(
        `Found ${allViolations.length} occurrence(s) of old app name in UI strings:\n${message}`
      );
    }
  });

  it("no old app name in email templates (outside slot files)", () => {
    const emailsDir = path.join(process.cwd(), "app", "emails");
    if (!fs.existsSync(emailsDir)) {
      return;
    }

    const files = findTsFiles(emailsDir);
    const allViolations: OldNameMatch[] = [];

    for (const filePath of files) {
      const relativePath = path.relative(process.cwd(), filePath);

      if (isInSkipPath(relativePath)) {
        continue;
      }

      const content = fs.readFileSync(filePath, "utf-8");
      const violations = findViolations(content, relativePath, PENDING_FOLLOWUP_ALLOWLIST);
      allViolations.push(...violations);
    }

    if (allViolations.length > 0) {
      const message = allViolations
        .map((v) => `  ${v.file}:${v.line}: ${v.text}`)
        .join("\n");
      expect.fail(
        `Found ${allViolations.length} occurrence(s) of old app name in email templates:\n${message}`
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

  it("computes matchLength from actual matched text (fails on hardcoded 22)", () => {
    const fixture = `const name = "Net Terms Receivables";`;
    const matches = scanForOldName(fixture, "test-fixture.ts");
    expect(matches.length).toBe(1);
    expect(matches[0].matchLength).toBe(21);
  });

  it("computes matchLength correctly for multi-line split name", () => {
    const fixture = `const name = "Net Terms
    Receivables";`;
    const matches = scanForOldName(fixture, "test-fixture.ts");
    expect(matches.length).toBe(1);
    expect(matches[0].matchLength).toBe(25);
  });
});

describe("isInComment (unit tests)", () => {
  it("filters match inside line comment", () => {
    const fixture = `// Net Terms Receivables comment
const x = 1;`;
    const violations = findViolations(fixture, "test-fixture.ts");
    expect(violations.length).toBe(0);
  });

  it("filters match inside properly closed block comment", () => {
    const fixture = `/* Net Terms Receivables */ const x = 1;`;
    const violations = findViolations(fixture, "test-fixture.ts");
    expect(violations.length).toBe(0);
  });

  it("unclosed /* does not hide a later real match (fails on main)", () => {
    const fixture = `const x = "text /* not a comment";
const y = "Net Terms Receivables";`;
    const violations = findViolations(fixture, "test-fixture.ts");
    expect(violations.length).toBe(1);
    expect(violations[0].line).toBe(2);
  });

  it("/* inside string literal does not hide later match (fails on main)", () => {
    const fixture = `const regex = "pattern /* here";
const name = "Net Terms Receivables";
const end = "and */ done";`;
    const violations = findViolations(fixture, "test-fixture.ts");
    expect(violations.length).toBe(1);
    expect(violations[0].line).toBe(2);
  });

  it("real block comment still filters correctly", () => {
    const fixture = `const before = 1;
/* 
Net Terms Receivables inside comment
*/
const after = "Net Terms Receivables";`;
    const violations = findViolations(fixture, "test-fixture.ts");
    expect(violations.length).toBe(1);
    expect(violations[0].line).toBe(5);
  });
});

describe("isAllowlisted (unit tests)", () => {
  it("allowlist entry only exempts its exact line (fails on main)", () => {
    const fixture = `const url = "github.com/user/net-terms-receivables";
const name = "Net Terms Receivables";`;
    const violations = findViolations(fixture, "test-fixture.ts");
    expect(violations.length).toBe(1);
    expect(violations[0].line).toBe(2);
  });

  it("allowlist pattern on same line filters the match", () => {
    const fixture = `const url = "github.com/user/net-terms-receivables Net Terms Receivables";`;
    const violations = findViolations(fixture, "test-fixture.ts");
    expect(violations.length).toBe(0);
  });

  it("allowlist does not apply across lines within 100 chars (fails on main)", () => {
    const fixture = `const h = "net-terms-receivables";
const m = "Net Terms Receivables";`;
    const violations = findViolations(fixture, "test-fixture.ts");
    expect(violations.length).toBe(1);
    expect(violations[0].line).toBe(2);
  });
});
