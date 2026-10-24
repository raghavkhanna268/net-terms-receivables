import { describe, it, expect, beforeEach, afterEach, beforeAll } from "vitest";
import { execSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

/**
 * Tests for the AST-based logging guard (check-logging.ts).
 *
 * Tests cover:
 * - Gap 1: Multi-line calls now properly detected
 * - Gap 2: Amount/paise/total/outstanding/balance keys caught
 * - Gap 3: Lines with type/interface/import are not skipped
 * - Gap 4: Sentry methods (addBreadcrumb, setExtra, etc.) checked
 * - Gap 5: Shorthand properties ({ shop }) detected
 * - Allowlist mechanics: at-count passes, over-count fails, stale reported
 */

describe("check-logging.ts (AST-based)", () => {
  let tmpDir: string;
  let appDir: string;
  let scriptPath: string;

  beforeAll(() => {
    // Verify the script exists
    scriptPath = path.join(__dirname, "..", "check-logging.ts");
    expect(fs.existsSync(scriptPath)).toBe(true);
  });

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "logging-test-"));
    appDir = path.join(tmpDir, "app");
    fs.mkdirSync(appDir, { recursive: true });
    // Also create workers and scripts dirs (the checker scans these)
    fs.mkdirSync(path.join(tmpDir, "workers"), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, "scripts"), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  /**
   * Run the logging guard against a test directory with optional allowlist.
   * Uses environment variables to override the root and allowlist paths.
   */
  const runGuard = (
    allowlist: string[] = []
  ): { exitCode: number; output: string } => {
    const allowlistFile = path.join(tmpDir, "logging-allowlist.txt");
    fs.writeFileSync(allowlistFile, allowlist.join("\n"));

    try {
      const output = execSync(`npx tsx "${scriptPath}"`, {
        encoding: "utf-8",
        cwd: tmpDir,
        env: {
          ...process.env,
          LOGGING_GUARD_ROOT: tmpDir,
          LOGGING_GUARD_ALLOWLIST: allowlistFile,
        },
      });
      return { exitCode: 0, output };
    } catch (err) {
      const error = err as { status: number; stdout: string; stderr: string };
      return {
        exitCode: error.status || 1,
        output: (error.stdout || "") + (error.stderr || ""),
      };
    }
  };

  describe("Gap 1: Multi-line calls", () => {
    it("fails for multi-line console.log with shop interpolation", () => {
      fs.writeFileSync(
        path.join(appDir, "multiline.ts"),
        `
export function test(shop: string) {
  console.log(
    \`Processing webhook for \${shop}\`
  );
}
        `
      );

      const { exitCode, output } = runGuard();
      expect(exitCode).not.toBe(0);
      expect(output).toContain("shop-interpolation");
    });

    it("fails for multi-line safeLog with sensitive key in object literal", () => {
      fs.writeFileSync(
        path.join(appDir, "multiline-safelog.ts"),
        `
function safeLog(_l: string, _e: string, _f: Record<string, unknown>) {}

export function test(amount: number) {
  safeLog("info", "event", {
    amount,
    currency: "INR"
  });
}
        `
      );

      const { exitCode, output } = runGuard();
      expect(exitCode).not.toBe(0);
      expect(output).toContain("sensitive-key");
    });

    it("passes for multi-line call with only safe keys", () => {
      fs.writeFileSync(
        path.join(appDir, "multiline-safe.ts"),
        `
export function test(shopId: string) {
  console.log(
    "[test] Processing completed",
    { shopId, count: 5 }
  );
}
        `
      );

      const { exitCode } = runGuard();
      expect(exitCode).toBe(0);
    });
  });

  describe("Gap 2: Amount keys with variations", () => {
    it("fails for amountPaise key", () => {
      fs.writeFileSync(
        path.join(appDir, "amount.ts"),
        `
export function test() {
  console.log("Payment", { amountPaise: 50000 });
}
        `
      );

      const { exitCode, output } = runGuard();
      expect(exitCode).not.toBe(0);
      expect(output).toContain("sensitive-key");
      expect(output).toContain("amountPaise");
    });

    it("fails for totalPaise key", () => {
      fs.writeFileSync(
        path.join(appDir, "total.ts"),
        `
export function test() {
  console.log("Order", { totalPaise: 100000 });
}
        `
      );

      const { exitCode, output } = runGuard();
      expect(exitCode).not.toBe(0);
      expect(output).toContain("totalPaise");
    });

    it("fails for outstandingPaise key", () => {
      fs.writeFileSync(
        path.join(appDir, "outstanding.ts"),
        `
export function test() {
  console.log("Balance", { outstandingPaise: 25000 });
}
        `
      );

      const { exitCode, output } = runGuard();
      expect(exitCode).not.toBe(0);
      expect(output).toContain("outstandingPaise");
    });

    it("fails for balance key", () => {
      fs.writeFileSync(
        path.join(appDir, "balance.ts"),
        `
export function test() {
  console.log("Account", { balance: 5000 });
}
        `
      );

      const { exitCode, output } = runGuard();
      expect(exitCode).not.toBe(0);
      expect(output).toContain("balance");
    });

    it("passes for count keys (aggregate metrics)", () => {
      fs.writeFileSync(
        path.join(appDir, "counts.ts"),
        `
export function test() {
  console.log("Metrics", { count: 5, totalCount: 100, orderCount: 50 });
}
        `
      );

      const { exitCode } = runGuard();
      expect(exitCode).toBe(0);
    });
  });

  describe("Gap 3: Lines with type/interface/import are not skipped", () => {
    it("fails for console.log after import statement", () => {
      fs.writeFileSync(
        path.join(appDir, "with-import.ts"),
        `
import { something } from "somewhere";

export function test(shop: string) {
  console.log(\`Processing \${shop}\`);
}
        `
      );

      const { exitCode, output } = runGuard();
      expect(exitCode).not.toBe(0);
      expect(output).toContain("shop-interpolation");
    });

    it("fails for console.log in file with interface", () => {
      fs.writeFileSync(
        path.join(appDir, "with-interface.ts"),
        `
interface OrderInfo {
  totalAmount: number;
  shopDomain: string;
}

export function test(shopDomain: string): OrderInfo {
  console.log(\`Webhook received for \${shopDomain}\`);
  return { totalAmount: 0, shopDomain };
}
        `
      );

      const { exitCode, output } = runGuard();
      expect(exitCode).not.toBe(0);
      expect(output).toContain("shop-interpolation");
    });

    it("fails for console.log with inline comment", () => {
      fs.writeFileSync(
        path.join(appDir, "with-comment.ts"),
        `
export function test(shop: string) {
  console.log(\`Processing \${shop}\`); // this is the domain
}
        `
      );

      const { exitCode, output } = runGuard();
      expect(exitCode).not.toBe(0);
      expect(output).toContain("shop-interpolation");
    });
  });

  describe("Gap 4: Sentry methods are checked", () => {
    it("fails for addBreadcrumb with sensitive data", () => {
      fs.writeFileSync(
        path.join(appDir, "sentry-breadcrumb.ts"),
        `
import * as Sentry from "@sentry/cloudflare";

export function test(shop: string) {
  Sentry.addBreadcrumb({
    message: "Processing",
    data: { shop },
  });
}
        `
      );

      const { exitCode, output } = runGuard();
      expect(exitCode).not.toBe(0);
      expect(output).toContain("sensitive-key");
    });

    it("fails for setExtra with sensitive key", () => {
      fs.writeFileSync(
        path.join(appDir, "sentry-extra.ts"),
        `
import * as Sentry from "@sentry/cloudflare";

export function test(amount: number) {
  Sentry.setExtra("amount", amount);
}
        `
      );

      const { exitCode, output } = runGuard();
      expect(exitCode).not.toBe(0);
      expect(output).toContain("sensitive-key");
    });

    it("fails for setContext with shop in object", () => {
      fs.writeFileSync(
        path.join(appDir, "sentry-context.ts"),
        `
import * as Sentry from "@sentry/cloudflare";

export function test(shop: string) {
  Sentry.setContext("payment", {
    shop,
    narration: "Payment",
  });
}
        `
      );

      const { exitCode, output } = runGuard();
      expect(exitCode).not.toBe(0);
      expect(output).toContain("sensitive-key");
    });

    it("fails for setTag with domain", () => {
      fs.writeFileSync(
        path.join(appDir, "sentry-tag.ts"),
        `
import * as Sentry from "@sentry/cloudflare";

export function test(domain: string) {
  Sentry.setTag("domain", domain);
}
        `
      );

      const { exitCode, output } = runGuard();
      expect(exitCode).not.toBe(0);
      expect(output).toContain("sensitive-key");
    });

    it("fails for captureException with raw error (no tags)", () => {
      fs.writeFileSync(
        path.join(appDir, "sentry-capture.ts"),
        `
import { captureException } from "./sentry";

export function test() {
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

    it("passes for safe Sentry usage with shopId and errorCode", () => {
      fs.writeFileSync(
        path.join(appDir, "sentry-safe.ts"),
        `
import * as Sentry from "@sentry/cloudflare";

export function test(shopId: string, errorCode: string) {
  Sentry.setTag("shopId", shopId);
  Sentry.setTag("code", errorCode);
  Sentry.addBreadcrumb({
    message: "Processing",
    data: { shopId, status: "received" },
  });
}
        `
      );

      const { exitCode } = runGuard();
      expect(exitCode).toBe(0);
    });
  });

  describe("Gap 5: Shorthand properties ({ shop }) are detected", () => {
    it("fails for { shop } shorthand", () => {
      fs.writeFileSync(
        path.join(appDir, "shorthand.ts"),
        `
export function test(shop: string) {
  console.log("Order", { shop });
}
        `
      );

      const { exitCode, output } = runGuard();
      expect(exitCode).not.toBe(0);
      expect(output).toContain("sensitive-key");
      expect(output).toContain("shop");
    });

    it("fails for { shopDomain } shorthand", () => {
      fs.writeFileSync(
        path.join(appDir, "shorthand-domain.ts"),
        `
export function test(shopDomain: string) {
  console.log("Webhook", { shopDomain, topic: "orders/create" });
}
        `
      );

      const { exitCode, output } = runGuard();
      expect(exitCode).not.toBe(0);
      expect(output).toContain("shopDomain");
    });

    it("fails for { email } shorthand", () => {
      fs.writeFileSync(
        path.join(appDir, "shorthand-email.ts"),
        `
export function test(email: string) {
  console.log("User", { email });
}
        `
      );

      const { exitCode, output } = runGuard();
      expect(exitCode).not.toBe(0);
      expect(output).toContain("email");
    });

    it("fails for multiple shorthand sensitive keys", () => {
      fs.writeFileSync(
        path.join(appDir, "shorthand-multi.ts"),
        `
export function test(shop: string, amount: number, payer: string) {
  console.log("Details", { shop, amount, payer });
}
        `
      );

      const { exitCode, output } = runGuard();
      expect(exitCode).not.toBe(0);
      // Should find all three sensitive keys
      expect(output).toMatch(/shop|amount|payer/);
    });

    it("passes for safe shorthand keys", () => {
      fs.writeFileSync(
        path.join(appDir, "shorthand-safe.ts"),
        `
export function test(shopId: string, count: number, status: string) {
  console.log("Safe", { shopId, count, status });
}
        `
      );

      const { exitCode } = runGuard();
      expect(exitCode).toBe(0);
    });
  });

  describe("Allowlist mechanics (file:rule:count)", () => {
    it("passes when violation count equals allowlist", () => {
      fs.writeFileSync(
        path.join(appDir, "allowed.ts"),
        `
export function test(shop: string) {
  console.log(\`Processing for \${shop}\`);
}
        `
      );

      const { exitCode } = runGuard(["app/allowed.ts:shop-interpolation:1"]);
      expect(exitCode).toBe(0);
    });

    it("fails when violation count exceeds allowlist", () => {
      fs.writeFileSync(
        path.join(appDir, "over-allowed.ts"),
        `
export function test(shop: string) {
  console.log(\`Processing for \${shop}\`);
  console.log(\`Done for \${shop}\`);
}
        `
      );

      // Only allow 1 but file has 2
      const { exitCode, output } = runGuard([
        "app/over-allowed.ts:shop-interpolation:1",
      ]);
      expect(exitCode).not.toBe(0);
      expect(output).toContain("found 2, allowed 1");
    });

    it("reports stale allowlist entries (no violations found)", () => {
      fs.writeFileSync(
        path.join(appDir, "clean.ts"),
        `
export function test(shopId: string) {
  console.log("Clean", { shopId });
}
        `
      );

      // Allowlist has entry but file is clean
      const { output } = runGuard(["app/clean.ts:shop-interpolation:1"]);
      expect(output).toContain("stale");
      expect(output).toContain("app/clean.ts:shop-interpolation:1");
    });

    it("reports stale allowlist entries (fewer violations than allowed)", () => {
      fs.writeFileSync(
        path.join(appDir, "reduced.ts"),
        `
export function test(shop: string) {
  console.log(\`Processing \${shop}\`);
}
        `
      );

      // Allowlist allows 3 but file only has 1
      const { output } = runGuard(["app/reduced.ts:shop-interpolation:3"]);
      expect(output).toContain("stale");
      expect(output).toContain("found only 1");
    });

    it("line number shifts do not break allowlist", () => {
      // Initial file
      fs.writeFileSync(
        path.join(appDir, "shifting.ts"),
        `
export function test(shop: string) {
  console.log(\`Processing for \${shop}\`);
}
        `
      );

      const { exitCode: exitCode1 } = runGuard([
        "app/shifting.ts:shop-interpolation:1",
      ]);
      expect(exitCode1).toBe(0);

      // Add comments, shifting the violation to a different line
      fs.writeFileSync(
        path.join(appDir, "shifting.ts"),
        `
// Comment 1
// Comment 2
// Comment 3
// Comment 4
// Comment 5
export function test(shop: string) {
  console.log(\`Processing for \${shop}\`);
}
        `
      );

      // Same allowlist should still pass
      const { exitCode: exitCode2 } = runGuard([
        "app/shifting.ts:shop-interpolation:1",
      ]);
      expect(exitCode2).toBe(0);
    });

    it("adding a new violation fails even with existing allowlist", () => {
      fs.writeFileSync(
        path.join(appDir, "growing.ts"),
        `
export function test1(shop: string) {
  console.log(\`Processing for \${shop}\`);
}
export function test2(shop: string) {
  console.log(\`Done for \${shop}\`);
}
        `
      );

      // Only allow 1 violation
      const { exitCode, output } = runGuard([
        "app/growing.ts:shop-interpolation:1",
      ]);
      expect(exitCode).not.toBe(0);
      expect(output).toContain("NEW logging violation");
    });
  });

  describe("Passing cases", () => {
    it("passes for safeLog with shopId", () => {
      fs.writeFileSync(
        path.join(appDir, "good.ts"),
        `
function safeLog(_l: string, _e: string, _f: Record<string, unknown>) {}

export function test() {
  safeLog("info", "test_event", { shopId: "shop-123", count: 5 });
}
        `
      );

      const { exitCode } = runGuard();
      expect(exitCode).toBe(0);
    });

    it("passes for safeLog with shopHash", () => {
      fs.writeFileSync(
        path.join(appDir, "hash.ts"),
        `
function safeLog(_l: string, _e: string, _f: Record<string, unknown>) {}
async function shopHash(_s: string): Promise<string> { return "abc123"; }

export async function test(shop: string) {
  safeLog("warn", "test_event", { shopHash: await shopHash(shop) });
}
        `
      );

      const { exitCode } = runGuard();
      expect(exitCode).toBe(0);
    });

    it("passes for validation regex with myshopify.com", () => {
      fs.writeFileSync(
        path.join(appDir, "validation.ts"),
        `
const isValidShopDomain = (shop: string) => /\\.myshopify\\.com$/.test(shop);
        `
      );

      const { exitCode } = runGuard();
      expect(exitCode).toBe(0);
    });

    it("passes for captureExceptionWithTags", () => {
      fs.writeFileSync(
        path.join(appDir, "sentry-with-tags.ts"),
        `
function captureExceptionWithTags(_e: unknown, _t: Record<string, string>) {}

export function test() {
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

    it("passes for IDs and GIDs", () => {
      fs.writeFileSync(
        path.join(appDir, "ids.ts"),
        `
export function test(orderId: string, orderGid: string, customerId: string) {
  console.log("Order", { orderId, orderGid, customerId, requestId: "req-123" });
}
        `
      );

      const { exitCode } = runGuard();
      expect(exitCode).toBe(0);
    });

    it("passes for timing metrics", () => {
      fs.writeFileSync(
        path.join(appDir, "timing.ts"),
        `
export function test() {
  console.log("Performance", { durationMs: 150, elapsedMs: 200 });
}
        `
      );

      const { exitCode } = runGuard();
      expect(exitCode).toBe(0);
    });
  });
});
