/**
 * Guard test that validates test environment secret isolation.
 *
 * Ensures:
 * 1. All listed secret vars are set to fake values during tests
 * 2. No undeclared secret-looking vars exist in app/ source code
 *
 * This is a non-DB test that runs in the Parallel project.
 */

import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  SECRET_ENV_VARS,
  SECRET_VAR_NAMES,
  SECRET_NAME_PATTERN,
  isFakeValue,
} from "../helpers/env-secrets";

describe("env-secrets-guard", () => {
  describe("secret vars have fake values", () => {
    it.each(SECRET_ENV_VARS.map((v) => [v.name, v.fakeValue]))(
      "%s is set to fake value",
      (name, expectedFake) => {
        const actual = process.env[name];
        expect(
          isFakeValue(actual),
          `${name} is not recognized as a fake value`
        ).toBe(true);
        expect(
          actual === expectedFake,
          `${name} does not match its expected fake value`
        ).toBe(true);
      }
    );
  });

  describe("no unset secret vars", () => {
    it("all listed secret vars are defined", () => {
      const unset: string[] = [];
      for (const { name } of SECRET_ENV_VARS) {
        if (process.env[name] === undefined) {
          unset.push(name);
        }
      }
      expect(unset).toEqual([]);
    });
  });

  describe("static scan for undeclared secret vars", () => {
    it("app/ source has no undeclared secret-looking vars", () => {
      const appDir = path.resolve(__dirname, "../../app");
      const undeclared = scanForUndeclaredSecrets(appDir);
      if (undeclared.length > 0) {
        const message = undeclared
          .map((u) => `  ${u.file}:${u.line}: ${u.varName}`)
          .join("\n");
        expect.fail(
          `Found ${undeclared.length} undeclared secret-looking var(s) in app/:\n${message}\n\n` +
            "Add missing vars to tests/helpers/env-secrets.ts SECRET_ENV_VARS"
        );
      }
    });
  });
});

interface UndeclaredSecret {
  file: string;
  line: number;
  varName: string;
}

function scanForUndeclaredSecrets(dir: string): UndeclaredSecret[] {
  const results: UndeclaredSecret[] = [];
  const files = walkDir(dir, /\.(ts|tsx)$/);

  for (const file of files) {
    if (file.includes("__tests__") || file.includes(".test.")) {
      continue;
    }

    const content = fs.readFileSync(file, "utf-8");
    const lines = content.split("\n");

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      const processEnvMatches = line.matchAll(/process\.env\.([A-Z][A-Z0-9_]*)/g);
      for (const match of processEnvMatches) {
        const varName = match[1];
        if (SECRET_NAME_PATTERN.test(varName) && !SECRET_VAR_NAMES.has(varName)) {
          if (!isExcludedVar(varName)) {
            results.push({
              file: path.relative(path.resolve(__dirname, "../.."), file),
              line: i + 1,
              varName,
            });
          }
        }
      }

      const envDotMatches = line.matchAll(/env\.([A-Z][A-Z0-9_]*)/g);
      for (const match of envDotMatches) {
        const varName = match[1];
        if (SECRET_NAME_PATTERN.test(varName) && !SECRET_VAR_NAMES.has(varName)) {
          if (!isExcludedVar(varName)) {
            results.push({
              file: path.relative(path.resolve(__dirname, "../.."), file),
              line: i + 1,
              varName,
            });
          }
        }
      }
    }
  }

  const seen = new Set<string>();
  return results.filter((r) => {
    const key = `${r.file}:${r.line}:${r.varName}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function isExcludedVar(name: string): boolean {
  const excluded = new Set([
    "TEST_DATABASE_URL",
    "DATABASE_URL",
    "DATABASE_URL_TEST",
    "DATABASE_URL_MIGRATIONS",
  ]);
  return excluded.has(name);
}

function walkDir(dir: string, pattern: RegExp): string[] {
  const results: string[] = [];

  function walk(currentDir: string): void {
    const entries = fs.readdirSync(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "node_modules" && entry.name !== "build" && entry.name !== ".react-router") {
          walk(fullPath);
        }
      } else if (entry.isFile() && pattern.test(entry.name)) {
        results.push(fullPath);
      }
    }
  }

  walk(dir);
  return results;
}
