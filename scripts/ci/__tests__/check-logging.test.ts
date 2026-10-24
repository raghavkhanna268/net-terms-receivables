import { describe, it, expect, beforeEach, afterEach, beforeAll } from "vitest";
import { execSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

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
  let scriptPath: string;

  beforeAll(() => {
    scriptPath = path.join(__dirname, "..", "check-logging.ts");
    expect(fs.existsSync(scriptPath)).toBe(true);
  });

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
});
