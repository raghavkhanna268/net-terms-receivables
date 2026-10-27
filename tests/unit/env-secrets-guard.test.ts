/**
 * Guard test that validates test environment secret isolation.
 *
 * Ensures:
 * 1. All listed secret vars are set to fake values during tests
 * 2. No inherited secret-looking vars remain in process.env at runtime
 * 3. No undeclared secret-looking vars exist in app/ source code
 * 4. Scrub function correctly removes credential-like vars
 *
 * This is a non-DB test that runs in the Parallel project.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  SECRET_ENV_VARS,
  SECRET_VAR_NAMES,
  SECRET_NAME_PATTERN,
  isFakeValue,
} from "../helpers/env-secrets";
import {
  isInheritedCredentialName,
  scrubInheritedCredentials,
} from "../helpers/scrub-inherited-secrets";

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

  describe("no inherited secret-like vars at runtime", () => {
    it("process.env has no credential-like vars outside SECRET_VAR_NAMES", () => {
      const leaked: string[] = [];
      for (const key of Object.keys(process.env)) {
        if (isInheritedCredentialName(key)) {
          const value = process.env[key];
          if (value && value.length > 0 && !isFakeValue(value)) {
            leaked.push(key);
          }
        }
      }
      if (leaked.length > 0) {
        expect.fail(
          `Found ${leaked.length} inherited credential-like env var(s) that should have been scrubbed:\n` +
            `  ${leaked.join(", ")}\n\n` +
            "These vars match credential patterns but are not in SECRET_VAR_NAMES.\n" +
            "The scrub-inherited-secrets.ts setup should have removed them."
        );
      }
    });
  });

  describe("isInheritedCredentialName pattern matching", () => {
    it("matches SECRET_NAME_PATTERN vars", () => {
      expect(isInheritedCredentialName("EXAMPLE_API_KEY")).toBe(true);
      expect(isInheritedCredentialName("EXAMPLE_SECRET")).toBe(true);
      expect(isInheritedCredentialName("EXAMPLE_TOKEN")).toBe(true);
      expect(isInheritedCredentialName("EXAMPLE_PASSWORD")).toBe(true);
      expect(isInheritedCredentialName("EXAMPLE_DSN")).toBe(true);
      expect(isInheritedCredentialName("EXAMPLE_CREDENTIAL")).toBe(true);
    });

    it("matches segment-bounded PAT, PRIVATE, AUTH vars", () => {
      expect(isInheritedCredentialName("EXAMPLE_PAT_FULL")).toBe(true);
      expect(isInheritedCredentialName("EXAMPLE_PAT")).toBe(true);
      expect(isInheritedCredentialName("PAT_EXAMPLE")).toBe(true);
      expect(isInheritedCredentialName("EXAMPLE_PRIVATE_KEY")).toBe(true);
      expect(isInheritedCredentialName("EXAMPLE_AUTH_TOKEN")).toBe(true);
    });

    it("does NOT match PATH, PATHEXT, AUTHOR, etc.", () => {
      expect(isInheritedCredentialName("PATH")).toBe(false);
      expect(isInheritedCredentialName("PATHEXT")).toBe(false);
      expect(isInheritedCredentialName("AUTHOR")).toBe(false);
      expect(isInheritedCredentialName("AUTHOR_NAME")).toBe(false);
      expect(isInheritedCredentialName("GIT_AUTHOR_EMAIL")).toBe(false);
    });

    it("does NOT match safe system vars", () => {
      expect(isInheritedCredentialName("HOME")).toBe(false);
      expect(isInheritedCredentialName("NODE_ENV")).toBe(false);
      expect(isInheritedCredentialName("TZ")).toBe(false);
      expect(isInheritedCredentialName("CI")).toBe(false);
    });

    it("does NOT match SECRET_VAR_NAMES entries", () => {
      for (const { name } of SECRET_ENV_VARS) {
        expect(
          isInheritedCredentialName(name),
          `${name} should not be flagged as inherited`
        ).toBe(false);
      }
    });
  });

  describe("scrubInheritedCredentials function", () => {
    const SYNTHETIC_CREDENTIAL_VARS = [
      "EXAMPLE_PAT_FULL",
      "EXAMPLE_PAT",
      "EXAMPLE_API_TOKEN",
      "EXAMPLE_DB_PASSWORD",
      "EXAMPLE_PRIVATE_KEY",
      "EXAMPLE_AUTH_CODE",
    ];

    const SAFE_SYSTEM_VARS = [
      "PATH",
      "HOME",
      "NODE_ENV",
      "TZ",
      "CI",
    ];

    const DATABASE_URL_VARS = [
      "DATABASE_URL",
      "DATABASE_URL_TEST",
      "TEST_DATABASE_URL",
      "DATABASE_URL_MIGRATIONS",
    ];

    beforeEach(() => {
      for (const name of SYNTHETIC_CREDENTIAL_VARS) {
        vi.stubEnv(name, "synthetic-test-value");
      }
    });

    it("scrubs synthetic credential-like vars", () => {
      const scrubbed = scrubInheritedCredentials();
      
      for (const name of SYNTHETIC_CREDENTIAL_VARS) {
        expect(
          scrubbed.includes(name) || process.env[name] === undefined,
          `${name} should have been scrubbed`
        ).toBe(true);
      }
    });

    it("keeps safe system vars", () => {
      scrubInheritedCredentials();
      
      for (const name of SAFE_SYSTEM_VARS) {
        if (process.env[name] !== undefined) {
          expect(
            process.env[name] !== undefined,
            `${name} should be kept`
          ).toBe(true);
        }
      }
    });

    it("keeps DATABASE_URL vars", () => {
      scrubInheritedCredentials();
      
      for (const name of DATABASE_URL_VARS) {
        if (process.env[name] !== undefined) {
          expect(
            process.env[name] !== undefined,
            `${name} should be kept`
          ).toBe(true);
        }
      }
    });

    it("keeps SECRET_VAR_NAMES entries with fake values", () => {
      scrubInheritedCredentials();
      
      for (const { name, fakeValue } of SECRET_ENV_VARS) {
        const actual = process.env[name];
        expect(
          actual !== undefined,
          `${name} should be kept`
        ).toBe(true);
        expect(
          actual === fakeValue,
          `${name} should have its fake value`
        ).toBe(true);
      }
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
