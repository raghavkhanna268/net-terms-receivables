import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

describe("check-logging.sh", () => {
  let tmpDir: string;
  let fixtureDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "logging-test-"));
    fixtureDir = path.join(tmpDir, "app");
    fs.mkdirSync(fixtureDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const runGuard = (allowlist: string[] = []): { exitCode: number; output: string } => {
    const allowlistFile = path.join(tmpDir, "logging-allowlist.txt");
    fs.writeFileSync(allowlistFile, allowlist.join("\n"));

    const scriptPath = path.join(__dirname, "..", "check-logging.sh");
    const env = {
      ...process.env,
      REPO_ROOT: tmpDir,
    };

    try {
      // Modify the script to use our test directory
      const script = fs.readFileSync(scriptPath, "utf-8");
      const modifiedScript = script
        .replace(
          'REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"',
          `REPO_ROOT="${tmpDir}"`
        )
        .replace(
          'ALLOWLIST_FILE="$SCRIPT_DIR/logging-allowlist.txt"',
          `ALLOWLIST_FILE="${allowlistFile}"`
        );

      const testScript = path.join(tmpDir, "test-check-logging.sh");
      fs.writeFileSync(testScript, modifiedScript);
      fs.chmodSync(testScript, 0o755);

      // Create workers directory as well
      fs.mkdirSync(path.join(tmpDir, "workers"), { recursive: true });

      const output = execSync(testScript, {
        encoding: "utf-8",
        env,
      });
      return { exitCode: 0, output };
    } catch (err) {
      const error = err as { status: number; stdout: string };
      return { exitCode: error.status || 1, output: error.stdout || "" };
    }
  };

  describe("passing cases", () => {
    it("passes for safeLog with shopId", () => {
      fs.writeFileSync(
        path.join(fixtureDir, "good.ts"),
        `
import { safeLog } from "~/lib/log.server";

export function logEvent() {
  safeLog("info", "test_event", { shopId: "shop-123", count: 5 });
}
        `
      );

      const { exitCode } = runGuard();
      expect(exitCode).toBe(0);
    });

    it("passes for safeLog with shopHash", () => {
      fs.writeFileSync(
        path.join(fixtureDir, "good.ts"),
        `
import { safeLog, shopHashSync } from "~/lib/log.server";

export function logEvent(shop: string) {
  safeLog("warn", "test_event", { shopHash: shopHashSync(shop) });
}
        `
      );

      const { exitCode } = runGuard();
      expect(exitCode).toBe(0);
    });

    it("passes for validation regex with myshopify.com", () => {
      fs.writeFileSync(
        path.join(fixtureDir, "validation.ts"),
        `
const isValidShopDomain = (shop: string) => /\\.myshopify\\.com$/.test(shop);
        `
      );

      const { exitCode } = runGuard();
      expect(exitCode).toBe(0);
    });
  });

  describe("failing cases", () => {
    it("fails for console.log with shop interpolation", () => {
      fs.writeFileSync(
        path.join(fixtureDir, "bad.ts"),
        `
export function logEvent(shop: string) {
  console.log(\`Processing for \${shop}\`);
}
        `
      );

      const { exitCode, output } = runGuard();
      expect(exitCode).not.toBe(0);
      expect(output).toContain("shop-interpolation");
    });

    it("fails for console.log with shopDomain interpolation", () => {
      fs.writeFileSync(
        path.join(fixtureDir, "bad.ts"),
        `
export function logEvent(shopDomain: string) {
  console.error(\`Error for \${shopDomain}\`);
}
        `
      );

      const { exitCode, output } = runGuard();
      expect(exitCode).not.toBe(0);
      expect(output).toContain("shop-interpolation");
    });

    it("fails for captureException with raw error", () => {
      fs.writeFileSync(
        path.join(fixtureDir, "bad.ts"),
        `
import { captureException } from "./sentry";

export function handleError() {
  try {
    throw new Error("test");
  } catch (err) {
    captureException(err);
  }
}
        `
      );

      const { exitCode, output } = runGuard();
      expect(exitCode).not.toBe(0);
      expect(output).toContain("raw-capture");
    });

    it("passes for captureExceptionWithTags (not raw)", () => {
      fs.writeFileSync(
        path.join(fixtureDir, "good.ts"),
        `
import { captureExceptionWithTags } from "./sentry";

export function handleError() {
  try {
    throw new Error("test");
  } catch (err) {
    captureExceptionWithTags(err, { code: "test_error" });
  }
}
        `
      );

      const { exitCode } = runGuard();
      expect(exitCode).toBe(0);
    });
  });

  describe("allowlist", () => {
    it("passes when violation is in allowlist", () => {
      fs.writeFileSync(
        path.join(fixtureDir, "allowed.ts"),
        `
export function logEvent(shop: string) {
  console.log(\`Processing for \${shop}\`);
}
        `
      );

      // Line 3 has the violation
      const { exitCode } = runGuard(["app/allowed.ts:3"]);
      expect(exitCode).toBe(0);
    });

    it("fails when violation is NOT in allowlist", () => {
      fs.writeFileSync(
        path.join(fixtureDir, "not-allowed.ts"),
        `
export function logEvent(shop: string) {
  console.log(\`Processing for \${shop}\`);
}
        `
      );

      // Wrong file in allowlist
      const { exitCode } = runGuard(["app/other.ts:3"]);
      expect(exitCode).not.toBe(0);
    });
  });
});
