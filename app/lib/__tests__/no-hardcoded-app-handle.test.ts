import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "fs";
import { join, relative } from "path";

/**
 * Guard test: No hardcoded app handle in source files.
 *
 * This test walks app/ and workers/ source files (excluding tests) and fails
 * if any contains the app handle as a literal in a handle position:
 * - `/charges/<handle>` - pricing plan URL pattern
 * - `/apps/<handle>` - embedded app URL pattern
 * - `app_installations/app/<handle>` - app installation pattern
 * - Quoted string equal to "net-terms-receivables" or "net-terms-receivables-1"
 *
 * Legitimate non-handle uses that should NOT trigger:
 * - GitHub URLs: github.com/raghavkhanna268/net-terms-receivables/...
 * - Worker URLs: net-terms-receivables.raghavkhanna.workers.dev
 * - Worker name references in documentation strings
 * - Package names in imports
 */

const HANDLE_POSITION_PATTERNS = [
  /\/charges\/net-terms-receivables(-1)?/,
  /\/apps\/net-terms-receivables(-1)?/,
  /app_installations\/app\/net-terms-receivables(-1)?/,
  /"net-terms-receivables(-1)?"/,
  /'net-terms-receivables(-1)?'/,
  /`net-terms-receivables(-1)?`/,
];

const FALSE_POSITIVE_PATTERNS = [
  /github\.com\/[^/]+\/net-terms-receivables/,
  /net-terms-receivables\.[^/]+\.workers\.dev/,
  /net-terms-receivables\.raghavkhanna\.workers\.dev/,
  /Worker\s+`net-terms-receivables`/,
  /Worker.*net-terms-receivables/,
  /"name":\s*"net-terms-receivables"/,
];

function walkDir(dir: string, ext: string[]): string[] {
  const files: string[] = [];

  function walk(currentDir: string) {
    const entries = readdirSync(currentDir);
    for (const entry of entries) {
      const fullPath = join(currentDir, entry);
      const stat = statSync(fullPath);

      if (stat.isDirectory()) {
        if (entry === "node_modules" || entry === ".git" || entry === "__tests__") {
          continue;
        }
        walk(fullPath);
      } else if (stat.isFile()) {
        if (ext.some((e) => entry.endsWith(e)) && !entry.includes(".test.")) {
          files.push(fullPath);
        }
      }
    }
  }

  walk(dir);
  return files;
}

function findHardcodedHandles(filePath: string): { line: number; content: string }[] {
  const content = readFileSync(filePath, "utf-8");
  const lines = content.split("\n");
  const violations: { line: number; content: string }[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNumber = i + 1;

    const isFalsePositive = FALSE_POSITIVE_PATTERNS.some((p) => p.test(line));
    if (isFalsePositive) {
      continue;
    }

    const isViolation = HANDLE_POSITION_PATTERNS.some((p) => p.test(line));
    if (isViolation) {
      violations.push({ line: lineNumber, content: line.trim() });
    }
  }

  return violations;
}

describe("No hardcoded app handle in source files", () => {
  it("app/ and workers/ source files have no hardcoded app handle literals in handle positions", () => {
    const rootDir = process.cwd();
    const appDir = join(rootDir, "app");
    const workersDir = join(rootDir, "workers");

    const extensions = [".ts", ".tsx", ".js", ".jsx"];
    const files: string[] = [];

    if (statSync(appDir).isDirectory()) {
      files.push(...walkDir(appDir, extensions));
    }

    if (statSync(workersDir).isDirectory()) {
      files.push(...walkDir(workersDir, extensions));
    }

    const allViolations: { file: string; violations: { line: number; content: string }[] }[] = [];

    for (const file of files) {
      const violations = findHardcodedHandles(file);
      if (violations.length > 0) {
        allViolations.push({
          file: relative(rootDir, file),
          violations,
        });
      }
    }

    if (allViolations.length > 0) {
      const message = allViolations
        .map(({ file, violations }) => {
          const violationLines = violations
            .map((v) => `  Line ${v.line}: ${v.content}`)
            .join("\n");
          return `${file}:\n${violationLines}`;
        })
        .join("\n\n");

      expect.fail(
        `Found hardcoded app handle literals in handle positions:\n\n${message}\n\n` +
          `Use getAppHandle() from ~/lib/plan-url instead.`
      );
    }

    expect(allViolations).toHaveLength(0);
  });
});
