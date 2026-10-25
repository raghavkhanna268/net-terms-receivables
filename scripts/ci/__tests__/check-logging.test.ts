import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { runAnalysis } from "../check-logging";

/**
 * Tests for the AST-based logging guard (check-logging.ts).
 *
 * Covers all items from QA review:
 * P1.1: Unanchored regex with phone/address/notes, snake_case support
 * P1.2: Text pass for .sh/.mjs with token prefixes
 * P2.3: Template interpolation matches last property name
 * P2.4: Check values (identifier values, .message/.stack, raw error args)
 * P2.5: Sentry setUser and setTag/setExtra value checking
 * P2.6: Stale/over-counted allowlist entries FAIL (ratchet)
 * P2.7: String concatenation
 * P3.8: Directory skip logic is path-specific
 * P3.9: raw-capture catches any catch-clause variable
 * P3.10: Walk arrays
 */

describe("check-logging.ts (AST-based)", () => {
  let tmpDir: string;
  let appDir: string;
  let scriptsDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "logging-test-"));
    appDir = path.join(tmpDir, "app");
    scriptsDir = path.join(tmpDir, "scripts");
    fs.mkdirSync(appDir, { recursive: true });
    fs.mkdirSync(path.join(tmpDir, "workers"), { recursive: true });
    fs.mkdirSync(scriptsDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const runGuard = (
    allowlist: string[] = []
  ): { exitCode: number; output: string } => {
    const allowlistFile = path.join(tmpDir, "logging-allowlist.txt");
    const loggerMockAllowlistFile = path.join(tmpDir, "logger-mock-allowlist.txt");
    fs.writeFileSync(allowlistFile, allowlist.join("\n"));
    fs.writeFileSync(loggerMockAllowlistFile, "");
    return runAnalysis(tmpDir, allowlistFile, loggerMockAllowlistFile);
  };

  // =========================================================================
  // P1.1: Unanchored regex with phone/address/notes, snake_case
  // =========================================================================
  describe("P1.1: Unanchored key matching with extensions", () => {
    it("fails for buyerEmail (prefixed email)", () => {
      fs.writeFileSync(
        path.join(appDir, "test.ts"),
        `export function test(buyerEmail: string) { console.log("Buyer", { buyerEmail }); }`
      );
      const { exitCode, output } = runGuard();
      expect(exitCode).not.toBe(0);
      expect(output).toContain("buyerEmail");
    });

    it("fails for customerEmail", () => {
      fs.writeFileSync(
        path.join(appDir, "test.ts"),
        `export function test(customerEmail: string) { console.log("Customer", { customerEmail }); }`
      );
      const { exitCode, output } = runGuard();
      expect(exitCode).not.toBe(0);
      expect(output).toContain("customerEmail");
    });

    it("fails for companyName", () => {
      fs.writeFileSync(
        path.join(appDir, "test.ts"),
        `export function test(companyName: string) { console.log("Company", { companyName }); }`
      );
      const { exitCode, output } = runGuard();
      expect(exitCode).not.toBe(0);
      expect(output).toContain("companyName");
    });

    it("fails for firstName", () => {
      fs.writeFileSync(
        path.join(appDir, "test.ts"),
        `export function test(firstName: string) { console.log("User", { firstName }); }`
      );
      const { exitCode, output } = runGuard();
      expect(exitCode).not.toBe(0);
      expect(output).toContain("firstName");
    });

    it("fails for payerName", () => {
      fs.writeFileSync(
        path.join(appDir, "test.ts"),
        `export function test(payerName: string) { console.log("Payer", { payerName }); }`
      );
      const { exitCode, output } = runGuard();
      expect(exitCode).not.toBe(0);
      expect(output).toContain("payerName");
    });

    it("fails for myshopifyDomain", () => {
      fs.writeFileSync(
        path.join(appDir, "test.ts"),
        `export function test(myshopifyDomain: string) { console.log("Domain", { myshopifyDomain }); }`
      );
      const { exitCode, output } = runGuard();
      expect(exitCode).not.toBe(0);
      expect(output).toContain("myshopifyDomain");
    });

    it("fails for shop_domain (snake_case)", () => {
      fs.writeFileSync(
        path.join(appDir, "test.ts"),
        `export function test(shop_domain: string) { console.log("Shop", { shop_domain }); }`
      );
      const { exitCode, output } = runGuard();
      expect(exitCode).not.toBe(0);
      expect(output).toContain("shop_domain");
    });

    it("fails for phone", () => {
      fs.writeFileSync(
        path.join(appDir, "test.ts"),
        `export function test(phone: string) { console.log("Contact", { phone }); }`
      );
      const { exitCode, output } = runGuard();
      expect(exitCode).not.toBe(0);
      expect(output).toContain("phone");
    });

    it("fails for address", () => {
      fs.writeFileSync(
        path.join(appDir, "test.ts"),
        `export function test(address: string) { console.log("Location", { address }); }`
      );
      const { exitCode, output } = runGuard();
      expect(exitCode).not.toBe(0);
      expect(output).toContain("address");
    });

    it("fails for notes", () => {
      fs.writeFileSync(
        path.join(appDir, "test.ts"),
        `export function test(notes: string) { console.log("Record", { notes }); }`
      );
      const { exitCode, output } = runGuard();
      expect(exitCode).not.toBe(0);
      expect(output).toContain("notes");
    });
  });

  // =========================================================================
  // P1.2: Text pass for .sh/.mjs with token prefixes
  // =========================================================================
  describe("P1.2: Script file scanning", () => {
    it("fails for shpat_ token prefix in shell script", () => {
      fs.writeFileSync(
        path.join(scriptsDir, "test.sh"),
        `#!/bin/bash\nTOKEN="shpat_1234567890"\necho $TOKEN`
      );
      const { exitCode, output } = runGuard();
      expect(exitCode).not.toBe(0);
      expect(output).toContain("script-token");
    });

    it("fails for myshopify.com in mjs script", () => {
      fs.writeFileSync(
        path.join(scriptsDir, "test.mjs"),
        `const shop = "test.myshopify.com";\nconsole.log(shop);`
      );
      const { exitCode, output } = runGuard();
      expect(exitCode).not.toBe(0);
      expect(output).toContain("script-domain");
    });

    it("fails for echo $SHOP in shell script", () => {
      fs.writeFileSync(
        path.join(scriptsDir, "test.sh"),
        `#!/bin/bash\nSHOP="example.myshopify.com"\necho "Shop: $SHOP"`
      );
      const { exitCode, output } = runGuard();
      expect(exitCode).not.toBe(0);
      expect(output).toContain("script-shop-var");
    });
  });

  // =========================================================================
  // P2.3: Template interpolation matches last property name
  // =========================================================================
  describe("P2.3: Template last property matching", () => {
    it("fails for ${session.shop}", () => {
      fs.writeFileSync(
        path.join(appDir, "test.ts"),
        `export function test(session: { shop: string }) { console.log(\`Processing \${session.shop}\`); }`
      );
      const { exitCode, output } = runGuard();
      expect(exitCode).not.toBe(0);
      expect(output).toContain("session.shop");
    });

    it("fails for ${payload.shop}", () => {
      fs.writeFileSync(
        path.join(appDir, "test.ts"),
        `export function test(payload: { shop: string }) { console.log(\`Webhook for \${payload.shop}\`); }`
      );
      const { exitCode, output } = runGuard();
      expect(exitCode).not.toBe(0);
      expect(output).toContain("payload.shop");
    });

    it("fails for ${x.shopDomain}", () => {
      fs.writeFileSync(
        path.join(appDir, "test.ts"),
        `export function test(x: { shopDomain: string }) { console.log(\`Domain: \${x.shopDomain}\`); }`
      );
      const { exitCode, output } = runGuard();
      expect(exitCode).not.toBe(0);
      expect(output).toContain("x.shopDomain");
    });
  });

  // =========================================================================
  // P2.4: Check values (identifier, .message, raw error args)
  // =========================================================================
  describe("P2.4: Value checking", () => {
    it("fails for { store: shop } (sensitive identifier as value)", () => {
      fs.writeFileSync(
        path.join(appDir, "test.ts"),
        `export function test(shop: string) { console.log("Info", { store: shop }); }`
      );
      const { exitCode, output } = runGuard();
      expect(exitCode).not.toBe(0);
      expect(output).toContain("sensitive-value");
    });

    it("fails for { error: err.message }", () => {
      fs.writeFileSync(
        path.join(appDir, "test.ts"),
        `export function test(err: Error) { console.log("Error", { error: err.message }); }`
      );
      const { exitCode, output } = runGuard();
      expect(exitCode).not.toBe(0);
      expect(output).toContain("error-message");
    });

    it("fails for { trace: err.stack }", () => {
      fs.writeFileSync(
        path.join(appDir, "test.ts"),
        `export function test(err: Error) { console.log("Stack", { trace: err.stack }); }`
      );
      const { exitCode, output } = runGuard();
      expect(exitCode).not.toBe(0);
      expect(output).toContain("error-message");
    });

    it("fails for console.error(x, err) - raw error positionally", () => {
      fs.writeFileSync(
        path.join(appDir, "test.ts"),
        `export function test() { try { throw new Error(); } catch (err) { console.error("Failed:", err); } }`
      );
      const { exitCode, output } = runGuard();
      expect(exitCode).not.toBe(0);
      expect(output).toContain("raw-error-arg");
    });

    // Extended P2.4: Direct arguments (no argIndex > 0 condition)
    it("fails for console.error(\"x\", err.message) - property access argument", () => {
      fs.writeFileSync(
        path.join(appDir, "test.ts"),
        `export function test(err: Error) { console.error("Failed:", err.message); }`
      );
      const { exitCode, output } = runGuard();
      expect(exitCode).not.toBe(0);
      expect(output).toContain("error-message");
    });

    it("fails for console.error(\"x\", String(err)) - stringified error argument", () => {
      fs.writeFileSync(
        path.join(appDir, "test.ts"),
        `export function test(err: Error) { console.error("Error:", String(err)); }`
      );
      const { exitCode, output } = runGuard();
      expect(exitCode).not.toBe(0);
      expect(output).toContain("error-stringify");
    });

    it("fails for console.log(\"x\", session.shop) - sensitive property access", () => {
      fs.writeFileSync(
        path.join(appDir, "test.ts"),
        `export function test(session: { shop: string }) { console.log("Shop:", session.shop); }`
      );
      const { exitCode, output } = runGuard();
      expect(exitCode).not.toBe(0);
      expect(output).toContain("sensitive-value");
    });

    it("fails for console.error(err) - error as first argument", () => {
      fs.writeFileSync(
        path.join(appDir, "test.ts"),
        `export function test(err: Error) { console.error(err); }`
      );
      const { exitCode, output } = runGuard();
      expect(exitCode).not.toBe(0);
      expect(output).toContain("raw-error-arg");
    });

    it("fails for console.log(shopDomain) - sensitive identifier as first argument", () => {
      fs.writeFileSync(
        path.join(appDir, "test.ts"),
        `export function test(shopDomain: string) { console.log(shopDomain); }`
      );
      const { exitCode, output } = runGuard();
      expect(exitCode).not.toBe(0);
      expect(output).toContain("sensitive-value");
    });
  });

  // =========================================================================
  // Boolean-prefix exclusion for isErrorLikeIdentifier
  // =========================================================================
  describe("Boolean-prefix error identifier exclusion", () => {
    // These should NOT be flagged (boolean indicator prefixes)
    it("does NOT flag isRetryableError (boolean flag)", () => {
      fs.writeFileSync(
        path.join(appDir, "test.ts"),
        `export function test(e: Error) {
          const isRetryableError = e instanceof TypeError;
          console.log("Info", { retryable: isRetryableError });
        }`
      );
      const { exitCode } = runGuard();
      expect(exitCode).toBe(0);
    });

    it("does NOT flag hasError (boolean flag)", () => {
      fs.writeFileSync(
        path.join(appDir, "test.ts"),
        `export function test() {
          const hasError = false;
          console.log("Status", { hasError });
        }`
      );
      const { exitCode } = runGuard();
      expect(exitCode).toBe(0);
    });

    // These SHOULD be flagged (real error variables that happen to start with prefix letters)
    it("flags issueError (not a boolean prefix)", () => {
      fs.writeFileSync(
        path.join(appDir, "test.ts"),
        `export function test() {
          const issueError = new Error("issue");
          console.error(issueError);
        }`
      );
      const { exitCode, output } = runGuard();
      expect(exitCode).not.toBe(0);
      expect(output).toContain("raw-error-arg");
    });

    it("flags cancelError (not a boolean prefix)", () => {
      fs.writeFileSync(
        path.join(appDir, "test.ts"),
        `export function test() {
          const cancelError = new Error("cancelled");
          console.error(cancelError);
        }`
      );
      const { exitCode, output } = runGuard();
      expect(exitCode).not.toBe(0);
      expect(output).toContain("raw-error-arg");
    });

    it("flags hashErr (not a boolean prefix)", () => {
      fs.writeFileSync(
        path.join(appDir, "test.ts"),
        `export function test() {
          const hashErr = new Error("hash failed");
          console.error(hashErr);
        }`
      );
      const { exitCode, output } = runGuard();
      expect(exitCode).not.toBe(0);
      expect(output).toContain("raw-error-arg");
    });

    it("flags wasmError (not a boolean prefix)", () => {
      fs.writeFileSync(
        path.join(appDir, "test.ts"),
        `export function test() {
          const wasmError = new Error("wasm failed");
          console.error(wasmError);
        }`
      );
      const { exitCode, output } = runGuard();
      expect(exitCode).not.toBe(0);
      expect(output).toContain("raw-error-arg");
    });

    it("flags hashError (not a boolean prefix)", () => {
      fs.writeFileSync(
        path.join(appDir, "test.ts"),
        `export function test() {
          const hashError = new Error("hash failed");
          console.error(hashError);
        }`
      );
      const { exitCode, output } = runGuard();
      expect(exitCode).not.toBe(0);
      expect(output).toContain("raw-error-arg");
    });

    it("flags canonicalError (not a boolean prefix)", () => {
      fs.writeFileSync(
        path.join(appDir, "test.ts"),
        `export function test() {
          const canonicalError = new Error("canonical failed");
          console.error(canonicalError);
        }`
      );
      const { exitCode, output } = runGuard();
      expect(exitCode).not.toBe(0);
      expect(output).toContain("raw-error-arg");
    });
  });

  // =========================================================================
  // P2 Extended: Template spans with .message/.stack and sensitive property
  // =========================================================================
  describe("P2 Extended: Template property access", () => {
    it("fails for ${err.message} in template", () => {
      fs.writeFileSync(
        path.join(appDir, "test.ts"),
        `export function test(err: Error) { console.log(\`Error: \${err.message}\`); }`
      );
      const { exitCode, output } = runGuard();
      expect(exitCode).not.toBe(0);
      expect(output).toContain("err.message");
    });

    it("fails for ${buyer.email} in template", () => {
      fs.writeFileSync(
        path.join(appDir, "test.ts"),
        `export function test(buyer: { email: string }) { console.log(\`Buyer: \${buyer.email}\`); }`
      );
      const { exitCode, output } = runGuard();
      expect(exitCode).not.toBe(0);
      expect(output).toContain("buyer.email");
    });

    it("fails for ${company.name} in template", () => {
      fs.writeFileSync(
        path.join(appDir, "test.ts"),
        `export function test(company: { name: string }) { console.log(\`Company: \${company.name}\`); }`
      );
      const { exitCode, output } = runGuard();
      expect(exitCode).not.toBe(0);
      expect(output).toContain("company.name");
    });
  });

  // =========================================================================
  // P2.5: Sentry setUser and setTag/setExtra value checking
  // =========================================================================
  describe("P2.5: Sentry value checking", () => {
    it("fails for Sentry.setUser", () => {
      fs.writeFileSync(
        path.join(appDir, "test.ts"),
        `import * as Sentry from "@sentry/cloudflare";\nexport function test() { Sentry.setUser({ id: "123" }); }`
      );
      const { exitCode, output } = runGuard();
      expect(exitCode).not.toBe(0);
      expect(output).toContain("sentry-setuser");
    });

    it("fails for setTag with sensitive value", () => {
      fs.writeFileSync(
        path.join(appDir, "test.ts"),
        `import * as Sentry from "@sentry/cloudflare";\nexport function test(shopDomain: string) { Sentry.setTag("store", shopDomain); }`
      );
      const { exitCode, output } = runGuard();
      expect(exitCode).not.toBe(0);
      expect(output).toContain("sensitive-value");
    });

    it("fails for setExtra with .message", () => {
      fs.writeFileSync(
        path.join(appDir, "test.ts"),
        `import * as Sentry from "@sentry/cloudflare";\nexport function test(err: Error) { Sentry.setExtra("error", err.message); }`
      );
      const { exitCode, output } = runGuard();
      expect(exitCode).not.toBe(0);
      expect(output).toContain("error-message");
    });
  });

  // =========================================================================
  // P2.6: Stale/over-counted allowlist entries FAIL (ratchet)
  // =========================================================================
  describe("P2.6: Allowlist ratchet", () => {
    it("fails when allowlist count exceeds actual violations (stale)", () => {
      fs.writeFileSync(
        path.join(appDir, "test.ts"),
        `export function test(shopId: string) { console.log("Safe", { shopId }); }`
      );
      // Allowlist says 2 violations but file has 0
      const { exitCode, output } = runGuard(["app/test.ts:shop-interpolation:2"]);
      expect(exitCode).not.toBe(0);
      expect(output).toContain("stale");
    });

    it("fails when allowlist count is higher than actual", () => {
      fs.writeFileSync(
        path.join(appDir, "test.ts"),
        `export function test(shop: string) { console.log(\`Processing \${shop}\`); }`
      );
      // Allowlist says 3 violations but file has 1
      const { exitCode, output } = runGuard(["app/test.ts:shop-interpolation:3"]);
      expect(exitCode).not.toBe(0);
      expect(output).toContain("allowed 3, found only 1");
    });

    it("passes when allowlist count matches actual violations", () => {
      fs.writeFileSync(
        path.join(appDir, "test.ts"),
        `export function test(shop: string) { console.log(\`Processing \${shop}\`); }`
      );
      const { exitCode } = runGuard(["app/test.ts:shop-interpolation:1"]);
      expect(exitCode).toBe(0);
    });
  });

  // =========================================================================
  // P2.7: String concatenation
  // =========================================================================
  describe("P2.7: String concatenation", () => {
    it("fails for \"sync \" + shop", () => {
      fs.writeFileSync(
        path.join(appDir, "test.ts"),
        `export function test(shop: string) { console.log("Processing " + shop); }`
      );
      const { exitCode, output } = runGuard();
      expect(exitCode).not.toBe(0);
      expect(output).toContain("concat-sensitive");
    });

    it("fails for concatenation with property access", () => {
      fs.writeFileSync(
        path.join(appDir, "test.ts"),
        `export function test(data: { domain: string }) { console.log("Domain: " + data.domain); }`
      );
      const { exitCode, output } = runGuard();
      expect(exitCode).not.toBe(0);
      expect(output).toContain("concat-sensitive");
    });
  });

  // =========================================================================
  // P3.9: raw-capture catches any catch-clause variable
  // =========================================================================
  describe("P3.9: raw-capture any variable", () => {
    it("fails for captureException(e)", () => {
      fs.writeFileSync(
        path.join(appDir, "test.ts"),
        `import { captureException } from "./sentry";\nexport function test() { try { throw new Error(); } catch (e) { captureException(e); } }`
      );
      const { exitCode, output } = runGuard();
      expect(exitCode).not.toBe(0);
      expect(output).toContain("raw-capture");
    });

    it("fails for captureException(caught)", () => {
      fs.writeFileSync(
        path.join(appDir, "test.ts"),
        `import { captureException } from "./sentry";\nexport function test() { try { throw new Error(); } catch (caught) { captureException(caught); } }`
      );
      const { exitCode, output } = runGuard();
      expect(exitCode).not.toBe(0);
      expect(output).toContain("raw-capture");
    });

    it("fails for captureException(exception)", () => {
      fs.writeFileSync(
        path.join(appDir, "test.ts"),
        `import { captureException } from "./sentry";\nexport function test() { try { throw new Error(); } catch (exception) { captureException(exception); } }`
      );
      const { exitCode, output } = runGuard();
      expect(exitCode).not.toBe(0);
      expect(output).toContain("raw-capture");
    });
  });

  // =========================================================================
  // P3.10: Walk arrays
  // =========================================================================
  describe("P3.10: Array walking", () => {
    it("fails for { items: [{ email }] }", () => {
      fs.writeFileSync(
        path.join(appDir, "test.ts"),
        `export function test(email: string) { console.log("Users", { items: [{ email }] }); }`
      );
      const { exitCode, output } = runGuard();
      expect(exitCode).not.toBe(0);
      expect(output).toContain("email");
    });

    it("fails for nested arrays with sensitive data", () => {
      fs.writeFileSync(
        path.join(appDir, "test.ts"),
        `export function test(shop: string) { console.log("Data", { outer: [{ inner: [{ shop }] }] }); }`
      );
      const { exitCode, output } = runGuard();
      expect(exitCode).not.toBe(0);
      expect(output).toContain("shop");
    });
  });

  // =========================================================================
  // Passing cases (safe keys)
  // =========================================================================
  describe("Safe keys pass", () => {
    it("passes for shopId", () => {
      fs.writeFileSync(
        path.join(appDir, "test.ts"),
        `export function test(shopId: string) { console.log("Info", { shopId }); }`
      );
      const { exitCode } = runGuard();
      expect(exitCode).toBe(0);
    });

    it("passes for shopHash", () => {
      fs.writeFileSync(
        path.join(appDir, "test.ts"),
        `export function test(shopHash: string) { console.log("Info", { shopHash }); }`
      );
      const { exitCode } = runGuard();
      expect(exitCode).toBe(0);
    });

    it("passes for totalCount", () => {
      fs.writeFileSync(
        path.join(appDir, "test.ts"),
        `export function test(totalCount: number) { console.log("Metrics", { totalCount }); }`
      );
      const { exitCode } = runGuard();
      expect(exitCode).toBe(0);
    });

    it("passes for functionName", () => {
      fs.writeFileSync(
        path.join(appDir, "test.ts"),
        `export function test(functionName: string) { console.log("Meta", { functionName }); }`
      );
      const { exitCode } = runGuard();
      expect(exitCode).toBe(0);
    });
  });

  // =========================================================================
  // Gap 1: Sentry context vars - resolve const identifiers
  // =========================================================================
  describe("Gap 1: Sentry context vars with identifiers", () => {
    it("fails for setContext with unresolved identifier", () => {
      fs.writeFileSync(
        path.join(appDir, "test.ts"),
        `import * as Sentry from "@sentry/cloudflare";
export function test(data: { shop: string }) {
  Sentry.setContext("payment", data);
}`
      );
      const { exitCode, output } = runGuard();
      expect(exitCode).not.toBe(0);
      expect(output).toContain("sentry-context-unresolved");
    });

    it("fails for setExtras with unresolved identifier", () => {
      fs.writeFileSync(
        path.join(appDir, "test.ts"),
        `import * as Sentry from "@sentry/cloudflare";
export function test(extras: { email: string }) {
  Sentry.setExtras(extras);
}`
      );
      const { exitCode, output } = runGuard();
      expect(exitCode).not.toBe(0);
      expect(output).toContain("sentry-context-unresolved");
    });

    it("passes for setContext with resolved const object literal", () => {
      fs.writeFileSync(
        path.join(appDir, "test.ts"),
        `import * as Sentry from "@sentry/cloudflare";
export function test() {
  const ctx = { shopId: "uuid-123", status: "active" };
  Sentry.setContext("payment", ctx);
}`
      );
      const { exitCode } = runGuard();
      expect(exitCode).toBe(0);
    });

    it("fails for setContext with resolved const containing sensitive key", () => {
      fs.writeFileSync(
        path.join(appDir, "test.ts"),
        `import * as Sentry from "@sentry/cloudflare";
export function test() {
  const ctx = { shop: "example.myshopify.com" };
  Sentry.setContext("payment", ctx);
}`
      );
      const { exitCode, output } = runGuard();
      expect(exitCode).not.toBe(0);
      expect(output).toContain("sensitive-key");
    });
  });

  // =========================================================================
  // Gap 2: Unwrap wrappers
  // =========================================================================
  describe("Gap 2: Wrapper unwrapping", () => {
    it("fails for JSON.stringify wrapping error", () => {
      fs.writeFileSync(
        path.join(appDir, "test.ts"),
        `export function test(err: Error) { console.log("Error:", JSON.stringify(err)); }`
      );
      const { exitCode, output } = runGuard();
      expect(exitCode).not.toBe(0);
      expect(output).toContain("error");
    });

    it("fails for String() wrapping error", () => {
      fs.writeFileSync(
        path.join(appDir, "test.ts"),
        `export function test(err: Error) { console.log("Error:", String(err)); }`
      );
      const { exitCode, output } = runGuard();
      expect(exitCode).not.toBe(0);
      expect(output).toContain("error-stringify");
    });

    it("fails for ternary with sensitive value", () => {
      fs.writeFileSync(
        path.join(appDir, "test.ts"),
        `export function test(shopDomain: string | null, fallback: string) {
  console.log("Shop:", shopDomain ? shopDomain : fallback);
}`
      );
      const { exitCode, output } = runGuard();
      expect(exitCode).not.toBe(0);
      expect(output).toContain("sensitive-value");
    });

    it("fails for nullish coalescing with error", () => {
      fs.writeFileSync(
        path.join(appDir, "test.ts"),
        `export function test(err: Error | undefined, defaultErr: Error) {
  console.log("Error:", err ?? defaultErr);
}`
      );
      const { exitCode, output } = runGuard();
      expect(exitCode).not.toBe(0);
      expect(output).toContain("raw-error-arg");
    });

    it("fails for logical OR with sensitive value", () => {
      fs.writeFileSync(
        path.join(appDir, "test.ts"),
        `export function test(shop: string | undefined, defaultShop: string) {
  console.log("Shop:", shop || defaultShop);
}`
      );
      const { exitCode, output } = runGuard();
      expect(exitCode).not.toBe(0);
      expect(output).toContain("sensitive-value");
    });

    it("fails for parentheses wrapping sensitive value", () => {
      fs.writeFileSync(
        path.join(appDir, "test.ts"),
        `export function test(email: string) { console.log("Contact:", (email)); }`
      );
      const { exitCode, output } = runGuard();
      expect(exitCode).not.toBe(0);
      expect(output).toContain("sensitive-value");
    });

    it("fails for as cast wrapping sensitive value", () => {
      fs.writeFileSync(
        path.join(appDir, "test.ts"),
        `export function test(domain: unknown) { console.log("Domain:", domain as string); }`
      );
      const { exitCode, output } = runGuard();
      expect(exitCode).not.toBe(0);
      expect(output).toContain("sensitive-value");
    });

    it("passes for safe wrapped values", () => {
      fs.writeFileSync(
        path.join(appDir, "test.ts"),
        `export function test(shopId: string | null, defaultId: string) {
  console.log("Shop ID:", shopId ?? defaultId);
}`
      );
      const { exitCode } = runGuard();
      expect(exitCode).toBe(0);
    });
  });

  // =========================================================================
  // Gap 3: Bare ${err} in template literals
  // =========================================================================
  describe("Gap 3: Bare error in template literals", () => {
    it("fails for bare ${err} in console.log", () => {
      fs.writeFileSync(
        path.join(appDir, "test.ts"),
        "export function test(err: Error) { console.log(`Failed: ${err}`); }"
      );
      const { exitCode, output } = runGuard();
      expect(exitCode).not.toBe(0);
      expect(output).toContain("raw-error-arg");
      expect(output).toContain("Bare error identifier");
    });

    it("fails for bare ${error} in console.error", () => {
      fs.writeFileSync(
        path.join(appDir, "test.ts"),
        "export function test(error: Error) { console.error(`Operation failed: ${error}`); }"
      );
      const { exitCode, output } = runGuard();
      expect(exitCode).not.toBe(0);
      expect(output).toContain("raw-error-arg");
    });

    it("fails for bare ${e} in console.warn", () => {
      fs.writeFileSync(
        path.join(appDir, "test.ts"),
        "export function test(e: Error) { console.warn(`Warning: ${e}`); }"
      );
      const { exitCode, output } = runGuard();
      expect(exitCode).not.toBe(0);
      expect(output).toContain("raw-error-arg");
    });

    it("fails for bare ${syncError} in console.log (ends with error)", () => {
      fs.writeFileSync(
        path.join(appDir, "test.ts"),
        "export function test(syncError: Error) { console.log(`Sync failed: ${syncError}`); }"
      );
      const { exitCode, output } = runGuard();
      expect(exitCode).not.toBe(0);
      expect(output).toContain("raw-error-arg");
    });

    it("passes for ${toErrorCode(err)}", () => {
      fs.writeFileSync(
        path.join(appDir, "test.ts"),
        `const toErrorCode = (e: Error) => e.name;
export function test(err: Error) { console.log(\`Failed with code: \${toErrorCode(err)}\`); }`
      );
      const { exitCode } = runGuard();
      expect(exitCode).toBe(0);
    });

    it("passes for ${errorCount} (not an error-like identifier)", () => {
      fs.writeFileSync(
        path.join(appDir, "test.ts"),
        "export function test(errorCount: number) { console.log(`Errors: ${errorCount}`); }"
      );
      const { exitCode } = runGuard();
      expect(exitCode).toBe(0);
    });

    it("passes for ${isError} (boolean flag prefix)", () => {
      fs.writeFileSync(
        path.join(appDir, "test.ts"),
        "export function test(isError: boolean) { console.log(`Is error: ${isError}`); }"
      );
      const { exitCode } = runGuard();
      expect(exitCode).toBe(0);
    });
  });

  // =========================================================================
  // Gap 4: Test file scanning for token-prefix and domain-literal only
  // P1 fix: Now checks token VALUE - only flags real-looking 32+ hex tokens
  // =========================================================================
  describe("Gap 4: Test file scanning", () => {
    it("fails for real-looking token in test file (32 hex chars)", () => {
      fs.mkdirSync(path.join(appDir, "__tests__"), { recursive: true });
      // Build real-looking token at test generation time (never committed to repo)
      // This simulates what a developer might accidentally commit
      const realLookingToken = "shpat_" + "a1b2c3d4e5f67890abcdef1234567890";
      fs.writeFileSync(
        path.join(appDir, "__tests__", "example.test.ts"),
        `const token = "${realLookingToken}";
export function test() { return token; }`
      );
      const { exitCode, output } = runGuard();
      expect(exitCode).not.toBe(0);
      expect(output).toContain("token-prefix");
      expect(output).toContain("Real-looking token");
    });

    it("allows synthetic tokens (short, repeated chars, contains test)", () => {
      fs.mkdirSync(path.join(appDir, "__tests__"), { recursive: true });
      fs.writeFileSync(
        path.join(appDir, "__tests__", "example.test.ts"),
        `const shortToken = "shpat_1234567890";
const repeatedToken = "shpat_${"a".repeat(32)}";
const testToken = "shpat_test_token_1234567890123456";
export function test() { return shortToken; }`
      );
      const { exitCode } = runGuard();
      expect(exitCode).toBe(0);
    });

    it("does NOT fail for console.log with sensitive data in test file (logging rules skipped)", () => {
      fs.mkdirSync(path.join(appDir, "__tests__"), { recursive: true });
      fs.writeFileSync(
        path.join(appDir, "__tests__", "example.test.ts"),
        `export function test(shopDomain: string) { console.log("Shop:", shopDomain); }`
      );
      const { exitCode } = runGuard();
      expect(exitCode).toBe(0);
    });

    it("allows test mock domains like test-shop.myshopify.com", () => {
      fs.mkdirSync(path.join(appDir, "__tests__"), { recursive: true });
      fs.writeFileSync(
        path.join(appDir, "__tests__", "example.test.ts"),
        `const TEST_SHOP = "test-shop.myshopify.com";
const EXAMPLE_SHOP = "example.myshopify.com";
export function test() { return TEST_SHOP; }`
      );
      const { exitCode } = runGuard();
      expect(exitCode).toBe(0);
    });

    it("fails for real-looking domain in test file (not in fake allowlist)", () => {
      fs.mkdirSync(path.join(appDir, "__tests__"), { recursive: true });
      // Build real-looking domain at test generation time (never committed to repo)
      // This simulates what a developer might accidentally commit
      const realLookingDomain = "bright" + "furniture" + ".myshopify.com";
      fs.writeFileSync(
        path.join(appDir, "__tests__", "example.test.ts"),
        `const domain = "${realLookingDomain}";
export function test() { return domain; }`
      );
      const { exitCode, output } = runGuard();
      expect(exitCode).not.toBe(0);
      expect(output).toContain("domain-literal");
      expect(output).toContain("Real-looking domain");
    });

    // P1 FAIL tests for specific real-looking domains (QA examples)
    it("fails for acmewholesale.myshopify.com", () => {
      fs.mkdirSync(path.join(appDir, "__tests__"), { recursive: true });
      const domain = "acme" + "wholesale" + ".myshopify.com";
      fs.writeFileSync(
        path.join(appDir, "__tests__", "example.test.ts"),
        `const domain = "${domain}"; export function test() { return domain; }`
      );
      const { exitCode, output } = runGuard();
      expect(exitCode).not.toBe(0);
      expect(output).toContain("domain-literal");
    });

    it("fails for clearwater-wholesale.myshopify.com (prefix without boundary)", () => {
      fs.mkdirSync(path.join(appDir, "__tests__"), { recursive: true });
      const domain = "clearwater" + "-wholesale" + ".myshopify.com";
      fs.writeFileSync(
        path.join(appDir, "__tests__", "example.test.ts"),
        `const domain = "${domain}"; export function test() { return domain; }`
      );
      const { exitCode, output } = runGuard();
      expect(exitCode).not.toBe(0);
      expect(output).toContain("domain-literal");
    });

    it("fails for brightfurniture-shop.myshopify.com (removed -shop$ rule)", () => {
      fs.mkdirSync(path.join(appDir, "__tests__"), { recursive: true });
      const domain = "bright" + "furniture-shop" + ".myshopify.com";
      fs.writeFileSync(
        path.join(appDir, "__tests__", "example.test.ts"),
        `const domain = "${domain}"; export function test() { return domain; }`
      );
      const { exitCode, output } = runGuard();
      expect(exitCode).not.toBe(0);
      expect(output).toContain("domain-literal");
    });

    it("fails for customer-goods.myshopify.com (prefix needs boundary)", () => {
      fs.mkdirSync(path.join(appDir, "__tests__"), { recursive: true });
      const domain = "customer" + "-goods" + ".myshopify.com";
      fs.writeFileSync(
        path.join(appDir, "__tests__", "example.test.ts"),
        `const domain = "${domain}"; export function test() { return domain; }`
      );
      const { exitCode, output } = runGuard();
      expect(exitCode).not.toBe(0);
      expect(output).toContain("domain-literal");
    });

    it("fails for log-cabin.myshopify.com (prefix needs boundary)", () => {
      fs.mkdirSync(path.join(appDir, "__tests__"), { recursive: true });
      const domain = "log" + "-cabin" + ".myshopify.com";
      fs.writeFileSync(
        path.join(appDir, "__tests__", "example.test.ts"),
        `const domain = "${domain}"; export function test() { return domain; }`
      );
      const { exitCode, output } = runGuard();
      expect(exitCode).not.toBe(0);
      expect(output).toContain("domain-literal");
    });

    it("fails for urban-shop.myshopify.com (removed -shop$ rule)", () => {
      fs.mkdirSync(path.join(appDir, "__tests__"), { recursive: true });
      const domain = "urban" + "-shop" + ".myshopify.com";
      fs.writeFileSync(
        path.join(appDir, "__tests__", "example.test.ts"),
        `const domain = "${domain}"; export function test() { return domain; }`
      );
      const { exitCode, output } = runGuard();
      expect(exitCode).not.toBe(0);
      expect(output).toContain("domain-literal");
    });

    it("fails for second real domain on line after fake domain", () => {
      fs.mkdirSync(path.join(appDir, "__tests__"), { recursive: true });
      // Line has fake domain first, then real domain - both should be checked
      const realDomain = "merchant" + "store" + ".myshopify.com";
      fs.writeFileSync(
        path.join(appDir, "__tests__", "example.test.ts"),
        `const domains = ["test-shop.myshopify.com", "${realDomain}"];
export function test() { return domains; }`
      );
      const { exitCode, output } = runGuard();
      expect(exitCode).not.toBe(0);
      expect(output).toContain("domain-literal");
    });

    // PASS tests for fake domains
    it("allows exact fake subdomain: test", () => {
      fs.mkdirSync(path.join(appDir, "__tests__"), { recursive: true });
      fs.writeFileSync(
        path.join(appDir, "__tests__", "example.test.ts"),
        `const domain = "test.myshopify.com"; export function test() { return domain; }`
      );
      const { exitCode } = runGuard();
      expect(exitCode).toBe(0);
    });

    it("allows test- prefix with boundary", () => {
      fs.mkdirSync(path.join(appDir, "__tests__"), { recursive: true });
      fs.writeFileSync(
        path.join(appDir, "__tests__", "example.test.ts"),
        `const domain = "test-customer-goods.myshopify.com"; export function test() { return domain; }`
      );
      const { exitCode } = runGuard();
      expect(exitCode).toBe(0);
    });

    it("allows test1 (prefix + digit boundary)", () => {
      fs.mkdirSync(path.join(appDir, "__tests__"), { recursive: true });
      fs.writeFileSync(
        path.join(appDir, "__tests__", "example.test.ts"),
        `const domain = "test1.myshopify.com"; export function test() { return domain; }`
      );
      const { exitCode } = runGuard();
      expect(exitCode).toBe(0);
    });

    it("allows s20- test suite prefix", () => {
      fs.mkdirSync(path.join(appDir, "__tests__"), { recursive: true });
      fs.writeFileSync(
        path.join(appDir, "__tests__", "example.test.ts"),
        `const domain = "s20-integration.myshopify.com"; export function test() { return domain; }`
      );
      const { exitCode } = runGuard();
      expect(exitCode).toBe(0);
    });

    // P1 Round 4: FAIL tests for removed line-wide skips
    it("fails for real domain on same line as template domain", () => {
      fs.mkdirSync(path.join(appDir, "__tests__"), { recursive: true });
      const realDomain = "clearwater" + "-wholesale" + ".myshopify.com";
      fs.writeFileSync(
        path.join(appDir, "__tests__", "example.test.ts"),
        `const domains = [\`\${shopId}.myshopify.com\`, "${realDomain}"];
export function test() { return domains; }`
      );
      const { exitCode, output } = runGuard();
      expect(exitCode).not.toBe(0);
      expect(output).toContain("domain-literal");
    });

    it("fails for real domain with quote-plus-operator concat on same line", () => {
      fs.mkdirSync(path.join(appDir, "__tests__"), { recursive: true });
      const realDomain = "clearwater" + "-wholesale" + ".myshopify.com";
      fs.writeFileSync(
        path.join(appDir, "__tests__", "example.test.ts"),
        `const x = "prefix" + shopVar; const d = "${realDomain}";
export function test() { return x + d; }`
      );
      const { exitCode, output } = runGuard();
      expect(exitCode).not.toBe(0);
      expect(output).toContain("domain-literal");
    });

    it("fails for real domain on line containing .test(", () => {
      fs.mkdirSync(path.join(appDir, "__tests__"), { recursive: true });
      const realDomain = "clearwater" + "-wholesale" + ".myshopify.com";
      fs.writeFileSync(
        path.join(appDir, "__tests__", "example.test.ts"),
        `if (/pattern/.test(x)) { const d = "${realDomain}"; }
export function test() { return d; }`
      );
      const { exitCode, output } = runGuard();
      expect(exitCode).not.toBe(0);
      expect(output).toContain("domain-literal");
    });

    it("fails for real domain on line containing foo.test.ts path", () => {
      fs.mkdirSync(path.join(appDir, "__tests__"), { recursive: true });
      const realDomain = "clearwater" + "-wholesale" + ".myshopify.com";
      fs.writeFileSync(
        path.join(appDir, "__tests__", "example.test.ts"),
        `import { x } from "./foo.test.ts"; const d = "${realDomain}";
export function test() { return d; }`
      );
      const { exitCode, output } = runGuard();
      expect(exitCode).not.toBe(0);
      expect(output).toContain("domain-literal");
    });

    it("fails for ALL_CAPS domain without underscore (CLEARWATER)", () => {
      fs.mkdirSync(path.join(appDir, "__tests__"), { recursive: true });
      fs.writeFileSync(
        path.join(appDir, "__tests__", "example.test.ts"),
        `const domain = "CLEARWATER.myshopify.com"; export function test() { return domain; }`
      );
      const { exitCode, output } = runGuard();
      expect(exitCode).not.toBe(0);
      expect(output).toContain("domain-literal");
    });

    it("allows ALL_CAPS constant with underscore (TEST_SHOP)", () => {
      fs.mkdirSync(path.join(appDir, "__tests__"), { recursive: true });
      fs.writeFileSync(
        path.join(appDir, "__tests__", "example.test.ts"),
        `const domain = "TEST_SHOP.myshopify.com"; export function test() { return domain; }`
      );
      const { exitCode } = runGuard();
      expect(exitCode).toBe(0);
    });

    // P2 Round 4: Token tests for fetch-header and URL/path cases
    it("fails for real token in fetch header (not in regex)", () => {
      fs.mkdirSync(path.join(appDir, "__tests__"), { recursive: true });
      // Build real-looking token at test generation time
      const realToken = "shpat_" + "a1b2c3d4e5f67890abcdef1234567890";
      fs.writeFileSync(
        path.join(appDir, "__tests__", "example.test.ts"),
        `fetch(url, { headers: { "X-Shopify-Access-Token": "${realToken}" } });
export function test() { return true; }`
      );
      const { exitCode, output } = runGuard();
      expect(exitCode).not.toBe(0);
      expect(output).toContain("token-prefix");
    });

    it("fails for real token in URL/path string (not in regex)", () => {
      fs.mkdirSync(path.join(appDir, "__tests__"), { recursive: true });
      // Build real-looking token at test generation time
      const realToken = "shpat_" + "a1b2c3d4e5f67890abcdef1234567890";
      fs.writeFileSync(
        path.join(appDir, "__tests__", "example.test.ts"),
        `const url = "/admin/api/2024-01/shop.json?token=${realToken}";
export function test() { return url; }`
      );
      const { exitCode, output } = runGuard();
      expect(exitCode).not.toBe(0);
      expect(output).toContain("token-prefix");
    });

    it("allows token in actual regex literal", () => {
      fs.mkdirSync(path.join(appDir, "__tests__"), { recursive: true });
      fs.writeFileSync(
        path.join(appDir, "__tests__", "example.test.ts"),
        `const pattern = /shpat_[a-f0-9]{32}/gi;
export function test() { return pattern; }`
      );
      const { exitCode } = runGuard();
      expect(exitCode).toBe(0);
    });

    it("allows token in RegExp constructor", () => {
      fs.mkdirSync(path.join(appDir, "__tests__"), { recursive: true });
      fs.writeFileSync(
        path.join(appDir, "__tests__", "example.test.ts"),
        `const pattern = new RegExp("shpat_[a-f0-9]{32}", "gi");
export function test() { return pattern; }`
      );
      const { exitCode } = runGuard();
      expect(exitCode).toBe(0);
    });

    // P2 Round 5: Token in URL path with trailing segment
    it("fails for real token in URL path with trailing segment", () => {
      fs.mkdirSync(path.join(appDir, "__tests__"), { recursive: true });
      // Build real-looking token at test generation time
      const realToken = "shpat_" + "a1b2c3d4e5f67890abcdef1234567890";
      fs.writeFileSync(
        path.join(appDir, "__tests__", "example.test.ts"),
        `const url = "/tokens/${realToken}/revoke";
export function test() { return url; }`
      );
      const { exitCode, output } = runGuard();
      expect(exitCode).not.toBe(0);
      expect(output).toContain("token-prefix");
    });

    // P1 Round 5: isValidShopDomain and escaped-regex tests
    it("fails for isValidShopDomain with real domain (built by concat)", () => {
      fs.mkdirSync(path.join(appDir, "__tests__"), { recursive: true });
      const realDomain = "clearwater" + "-wholesale" + ".myshopify.com";
      fs.writeFileSync(
        path.join(appDir, "__tests__", "example.test.ts"),
        `expect(isValidShopDomain("${realDomain}")).toBe(true);
export function test() { return true; }`
      );
      const { exitCode, output } = runGuard();
      expect(exitCode).not.toBe(0);
      expect(output).toContain("domain-literal");
    });

    it("allows escaped-regex pattern (no literal domain)", () => {
      fs.mkdirSync(path.join(appDir, "__tests__"), { recursive: true });
      fs.writeFileSync(
        path.join(appDir, "__tests__", "example.test.ts"),
        `const pattern = /^[a-z0-9-]+\\.myshopify\\.com$/;
export function test() { return pattern; }`
      );
      const { exitCode } = runGuard();
      expect(exitCode).toBe(0);
    });

    it("allows isValidShopDomain with fake domain", () => {
      fs.mkdirSync(path.join(appDir, "__tests__"), { recursive: true });
      fs.writeFileSync(
        path.join(appDir, "__tests__", "example.test.ts"),
        `expect(isValidShopDomain("test-shop.myshopify.com")).toBe(true);
export function test() { return true; }`
      );
      const { exitCode } = runGuard();
      expect(exitCode).toBe(0);
    });

    // P3 Round 5: TLD boundary tests
    it("fails for domain with fake TLD prefix (.testing)", () => {
      fs.mkdirSync(path.join(appDir, "__tests__"), { recursive: true });
      const domain = "clearwater" + ".testing" + ".myshopify.com";
      fs.writeFileSync(
        path.join(appDir, "__tests__", "example.test.ts"),
        `const domain = "${domain}"; export function test() { return domain; }`
      );
      const { exitCode, output } = runGuard();
      expect(exitCode).not.toBe(0);
      expect(output).toContain("domain-literal");
    });

    it("fails for domain with suffix after TLD (.myshopify.com-evil)", () => {
      fs.mkdirSync(path.join(appDir, "__tests__"), { recursive: true });
      fs.writeFileSync(
        path.join(appDir, "__tests__", "example.test.ts"),
        `const domain = "clearwater.myshopify.com-evil"; export function test() { return domain; }`
      );
      const { exitCode, output } = runGuard();
      expect(exitCode).not.toBe(0);
      expect(output).toContain("domain-literal");
    });
  });

  // =========================================================================
  // #190: Per-match VALIDATION_PATTERNS (not line-wide skip)
  // No FAKE_SUBDOMAINS exemptions in non-test paths (script, log, Sentry)
  // =========================================================================
  describe("#190: Per-match VALIDATION_PATTERNS", () => {
    // Script file scan (~line 300)
    describe("Script file scan", () => {
      it("PASS: Pure escaped-regex validation pattern in script", () => {
        fs.writeFileSync(
          path.join(scriptsDir, "validate.sh"),
          `#!/bin/bash\nif [[ "$1" =~ \\.myshopify\\.com$ ]]; then echo valid; fi`
        );
        const { exitCode } = runGuard();
        expect(exitCode).toBe(0);
      });

      it("FAIL: Real domain + validation pattern on same line in script", () => {
        const realDomain = "clearwater" + "-wholesale" + ".myshopify.com";
        fs.writeFileSync(
          path.join(scriptsDir, "mixed.sh"),
          `#!/bin/bash\nif [[ "$1" =~ \\.myshopify\\.com$ ]]; then SHOP="${realDomain}"; fi`
        );
        const { exitCode, output } = runGuard();
        expect(exitCode).not.toBe(0);
        expect(output).toContain("script-domain");
      });

      // P1a: Fake subdomains must be flagged in script files
      it("FAIL: test.myshopify.com in script (no fake exemption)", () => {
        fs.writeFileSync(
          path.join(scriptsDir, "fake-test.sh"),
          `#!/bin/bash\nSHOP="test.myshopify.com"`
        );
        const { exitCode, output } = runGuard();
        expect(exitCode).not.toBe(0);
        expect(output).toContain("script-domain");
      });

      it("FAIL: shop.myshopify.com in script (no fake exemption)", () => {
        fs.writeFileSync(
          path.join(scriptsDir, "fake-shop.sh"),
          `#!/bin/bash\nSHOP="shop.myshopify.com"`
        );
        const { exitCode, output } = runGuard();
        expect(exitCode).not.toBe(0);
        expect(output).toContain("script-domain");
      });

      it("FAIL: my-store.myshopify.com in script (no fake exemption)", () => {
        fs.writeFileSync(
          path.join(scriptsDir, "fake-mystore.sh"),
          `#!/bin/bash\nSHOP="my-store.myshopify.com"`
        );
        const { exitCode, output } = runGuard();
        expect(exitCode).not.toBe(0);
        expect(output).toContain("script-domain");
      });

      // P1b: Template and bare domain forms
      it("FAIL: ${shop}.myshopify.com in script", () => {
        fs.writeFileSync(
          path.join(scriptsDir, "template.sh"),
          `#!/bin/bash\nURL="\${SHOP}.myshopify.com"`
        );
        const { exitCode, output } = runGuard();
        expect(exitCode).not.toBe(0);
        expect(output).toContain("script-domain");
      });

      it("FAIL: bare myshopify.com in script", () => {
        fs.writeFileSync(
          path.join(scriptsDir, "bare.sh"),
          `#!/bin/bash\necho "Connect to myshopify.com"`
        );
        const { exitCode, output } = runGuard();
        expect(exitCode).not.toBe(0);
        expect(output).toContain("script-domain");
      });

      it("FAIL: https://myshopify.com in script", () => {
        fs.writeFileSync(
          path.join(scriptsDir, "https.sh"),
          `#!/bin/bash\ncurl https://myshopify.com/admin`
        );
        const { exitCode, output } = runGuard();
        expect(exitCode).not.toBe(0);
        expect(output).toContain("script-domain");
      });
    });

    // Log args (~line 479)
    describe("Log args (checkArgument)", () => {
      it("PASS: Pure escaped-regex validation pattern in log string", () => {
        fs.writeFileSync(
          path.join(appDir, "validate.ts"),
          `export function test() { console.log("Pattern: /[a-z]+\\\\.myshopify\\\\.com/"); }`
        );
        const { exitCode } = runGuard();
        expect(exitCode).toBe(0);
      });

      it("FAIL: Real domain + validation pattern in same log string", () => {
        const realDomain = "clearwater" + "-wholesale" + ".myshopify.com";
        fs.writeFileSync(
          path.join(appDir, "mixed.ts"),
          `export function test() { console.log("Pattern: /[a-z]+\\\\.myshopify\\\\.com/ example: ${realDomain}"); }`
        );
        const { exitCode, output } = runGuard();
        expect(exitCode).not.toBe(0);
        expect(output).toContain("domain-literal");
      });

      // P1a: Fake subdomains must be flagged in log args
      it("FAIL: test.myshopify.com in log string (no fake exemption)", () => {
        fs.writeFileSync(
          path.join(appDir, "log-test.ts"),
          `export function test() { console.log("Shop: test.myshopify.com"); }`
        );
        const { exitCode, output } = runGuard();
        expect(exitCode).not.toBe(0);
        expect(output).toContain("domain-literal");
      });

      it("FAIL: shop.myshopify.com in log string (no fake exemption)", () => {
        fs.writeFileSync(
          path.join(appDir, "log-shop.ts"),
          `export function test() { console.log("Shop: shop.myshopify.com"); }`
        );
        const { exitCode, output } = runGuard();
        expect(exitCode).not.toBe(0);
        expect(output).toContain("domain-literal");
      });

      it("FAIL: my-store.myshopify.com in log string (no fake exemption)", () => {
        fs.writeFileSync(
          path.join(appDir, "log-mystore.ts"),
          `export function test() { console.log("Shop: my-store.myshopify.com"); }`
        );
        const { exitCode, output } = runGuard();
        expect(exitCode).not.toBe(0);
        expect(output).toContain("domain-literal");
      });

      // P1b: Template and bare domain forms
      it("FAIL: bare myshopify.com in log string", () => {
        fs.writeFileSync(
          path.join(appDir, "log-bare.ts"),
          `export function test() { console.log("connect to myshopify.com"); }`
        );
        const { exitCode, output } = runGuard();
        expect(exitCode).not.toBe(0);
        expect(output).toContain("domain-literal");
      });

      it("FAIL: https://myshopify.com in log string", () => {
        fs.writeFileSync(
          path.join(appDir, "log-https.ts"),
          `export function test() { console.log("URL: https://myshopify.com/admin"); }`
        );
        const { exitCode, output } = runGuard();
        expect(exitCode).not.toBe(0);
        expect(output).toContain("domain-literal");
      });

    });

    // Sentry args (~line 908)
    describe("Sentry args (checkSentryCall)", () => {
      it("PASS: Pure escaped-regex validation pattern in Sentry message", () => {
        fs.writeFileSync(
          path.join(appDir, "sentry-validate.ts"),
          `import * as Sentry from "@sentry/cloudflare";
export function test() { Sentry.captureMessage("Pattern: /[a-z]+\\\\.myshopify\\\\.com/", { tags: { type: "validation" } }); }`
        );
        const { exitCode } = runGuard();
        expect(exitCode).toBe(0);
      });

      it("FAIL: Real domain + validation pattern in same Sentry string", () => {
        const realDomain = "clearwater" + "-wholesale" + ".myshopify.com";
        fs.writeFileSync(
          path.join(appDir, "sentry-mixed.ts"),
          `import * as Sentry from "@sentry/cloudflare";
export function test() { Sentry.captureMessage("Pattern: /[a-z]+\\\\.myshopify\\\\.com/ fail: ${realDomain}", { tags: { type: "test" } }); }`
        );
        const { exitCode, output } = runGuard();
        expect(exitCode).not.toBe(0);
        expect(output).toContain("domain-literal");
      });

      // P1a: Fake subdomains must be flagged in Sentry args
      it("FAIL: test.myshopify.com in Sentry string (no fake exemption)", () => {
        fs.writeFileSync(
          path.join(appDir, "sentry-test.ts"),
          `import * as Sentry from "@sentry/cloudflare";
export function test() { Sentry.captureMessage("Shop: test.myshopify.com", { tags: { t: "1" } }); }`
        );
        const { exitCode, output } = runGuard();
        expect(exitCode).not.toBe(0);
        expect(output).toContain("domain-literal");
      });

      it("FAIL: shop.myshopify.com in Sentry string (no fake exemption)", () => {
        fs.writeFileSync(
          path.join(appDir, "sentry-shop.ts"),
          `import * as Sentry from "@sentry/cloudflare";
export function test() { Sentry.captureMessage("Shop: shop.myshopify.com", { tags: { t: "1" } }); }`
        );
        const { exitCode, output } = runGuard();
        expect(exitCode).not.toBe(0);
        expect(output).toContain("domain-literal");
      });

      it("FAIL: my-store.myshopify.com in Sentry string (no fake exemption)", () => {
        fs.writeFileSync(
          path.join(appDir, "sentry-mystore.ts"),
          `import * as Sentry from "@sentry/cloudflare";
export function test() { Sentry.captureMessage("Shop: my-store.myshopify.com", { tags: { t: "1" } }); }`
        );
        const { exitCode, output } = runGuard();
        expect(exitCode).not.toBe(0);
        expect(output).toContain("domain-literal");
      });

      // P1b: Bare domain forms
      it("FAIL: bare myshopify.com in Sentry string", () => {
        fs.writeFileSync(
          path.join(appDir, "sentry-bare.ts"),
          `import * as Sentry from "@sentry/cloudflare";
export function test() { Sentry.captureMessage("connect to myshopify.com", { tags: { t: "1" } }); }`
        );
        const { exitCode, output } = runGuard();
        expect(exitCode).not.toBe(0);
        expect(output).toContain("domain-literal");
      });

      it("FAIL: https://myshopify.com in Sentry string", () => {
        fs.writeFileSync(
          path.join(appDir, "sentry-https.ts"),
          `import * as Sentry from "@sentry/cloudflare";
export function test() { Sentry.captureMessage("URL: https://myshopify.com/admin", { tags: { t: "1" } }); }`
        );
        const { exitCode, output } = runGuard();
        expect(exitCode).not.toBe(0);
        expect(output).toContain("domain-literal");
      });
    });
  });

  // =========================================================================
  // Gap 5: No-mock-logger rule
  // =========================================================================
  describe("Gap 5: No-mock-logger rule", () => {
    it("fails for vi.mock with log.server path", () => {
      fs.mkdirSync(path.join(appDir, "__tests__"), { recursive: true });
      fs.writeFileSync(
        path.join(appDir, "__tests__", "mock.test.ts"),
        `import { vi } from "vitest";
vi.mock("~/lib/log.server", () => ({
  safeLog: vi.fn(),
}));`
      );
      const { exitCode, output } = runGuard();
      expect(exitCode).not.toBe(0);
      expect(output).toContain("logger mock violation");
      expect(output).toContain("log.server");
    });

    it("fails for vi.mock with relative log.server path", () => {
      fs.mkdirSync(path.join(appDir, "__tests__"), { recursive: true });
      fs.writeFileSync(
        path.join(appDir, "__tests__", "mock.test.ts"),
        `import { vi } from "vitest";
vi.mock("../../lib/log.server", () => ({
  safeLog: vi.fn(),
}));`
      );
      const { exitCode, output } = runGuard();
      expect(exitCode).not.toBe(0);
      expect(output).toContain("logger mock violation");
      expect(output).toContain("log.server");
    });

    it("fails for vi.mock factory replacing safeLog", () => {
      fs.mkdirSync(path.join(appDir, "__tests__"), { recursive: true });
      fs.writeFileSync(
        path.join(appDir, "__tests__", "mock.test.ts"),
        `import { vi } from "vitest";
vi.mock("./utils", () => ({
  safeLog: vi.fn(),
  toErrorCode: vi.fn(),
}));`
      );
      const { exitCode, output } = runGuard();
      expect(exitCode).not.toBe(0);
      expect(output).toContain("logger mock violation");
      expect(output).toContain("safeLog");
    });

    it("passes when test file uses console.log spy (not mocking logger)", () => {
      fs.mkdirSync(path.join(appDir, "__tests__"), { recursive: true });
      fs.writeFileSync(
        path.join(appDir, "__tests__", "spy.test.ts"),
        `import { vi } from "vitest";
const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});`
      );
      const { exitCode } = runGuard();
      expect(exitCode).toBe(0);
    });
  });
});
