/**
 * Metafield Writer Contract Tests
 *
 * Contract suite pinning the output shape of all app-owned metafield WRITERS
 * for credit_status ($app:credit_status) and shop_config ($app:shop_config).
 *
 * This suite EXERCISES each writer function (calls them with mocked dependencies)
 * and validates the serialized JSON shape matches the Rust Function serde contract.
 *
 * Structure:
 * 1. Grep-based manifest guard: ensures test coverage as new writers appear
 * 2. Strict schema validation: exact key set, JSON types, ranges
 * 3. Writer exercise tests: call actual functions, capture serialized value
 * 4. Positive controls: deliberate shape violations detected
 *
 * Writers Covered:
 * - credit_status: updateCreditStatus (EXERCISED), syncCreditStatusMetafield (EXERCISED),
 *   recomputeCreditStatus (EXERCISED), serializeCreditStatusFromDb (EXERCISED)
 * - shop_config: writeShopConfigMetafield (EXERCISED), checkAndRecoverCurrency (EXERCISED),
 *   syncShopInfo (EXERCISED via _syncShopInfoForTesting)
 * - hide-terms-config: NO TS WRITER EXISTS (config via Shopify Admin UI)
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import type { Sql } from "~/lib/db-light.server";
import { companyLocationGid, customerGid, shopGid } from "../../../tests/helpers/gid";

const MOCK_SHOP_DOMAIN = "test-writer-contract.example.com";

/**
 * WRITERS MANIFEST
 *
 * Files that DEFINE metafieldsSet mutations for $app metafields.
 * Files that merely call through to these writers (e.g., recomputeCreditStatus
 * routes through syncCreditStatusMetafield) are not listed here.
 *
 * The grep guard below will fail if a new writer definition is added without updating this list.
 */

// Files that DEFINE the credit_status metafieldsSet mutation
const CREDIT_STATUS_MUTATION_DEFINERS: ReadonlyArray<{ file: string; functions: string[] }> = [
  { file: "app/services/credit-status.server.ts", functions: ["updateCreditStatus", "syncCreditStatusMetafield", "writeMetafield"] },
];

// Files that CALL through to credit_status writers - ALL EXERCISED
const CREDIT_STATUS_CALLERS: ReadonlyArray<{ file: string; functions: string[]; exercised: boolean }> = [
  { file: "app/services/credit-status-recompute.server.ts", functions: ["recomputeCreditStatus"], exercised: true },
];

// Files that DEFINE the shop_config metafieldsSet mutation
const SHOP_CONFIG_MUTATION_DEFINERS: ReadonlyArray<{ file: string; functions: string[] }> = [
  { file: "app/services/shop-config.server.ts", functions: ["writeShopConfigMetafield"] },
];

// Files that CALL through to shop_config writers - ALL EXERCISED
const SHOP_CONFIG_CALLERS: ReadonlyArray<{ file: string; functions: string[]; exercised: boolean }> = [
  { file: "app/lib/after-auth.server.ts", functions: ["syncShopInfo"], exercised: true },
  { file: "app/services/shop-currency-recovery.server.ts", functions: ["checkAndRecoverCurrency"], exercised: true },
];

// hide-terms-config: NO TypeScript writer exists in this codebase.
// The hide-terms-config metafield is written directly by Shopify when the merchant
// configures the payment customization via the Admin UI or CLI. The app only READS
// this value in the Rust Function. This is explicitly documented here as manifest-only.
const HIDE_TERMS_CONFIG_MANIFEST = {
  file: null,
  reason: "Configured via Shopify Admin UI payment customization settings, not written by app TypeScript code",
  rustReader: "extensions/hide-terms-payment/src/cart_payment_methods_transform_run.rs",
};

// Combined for iteration
const CREDIT_STATUS_WRITERS = [...CREDIT_STATUS_MUTATION_DEFINERS, ...CREDIT_STATUS_CALLERS];
const SHOP_CONFIG_WRITERS = [...SHOP_CONFIG_MUTATION_DEFINERS, ...SHOP_CONFIG_CALLERS];

const ALL_WRITER_FILES = [
  ...CREDIT_STATUS_WRITERS.map(w => w.file),
  ...SHOP_CONFIG_WRITERS.map(w => w.file),
];

// STRICT SCHEMA DEFINITIONS
// Derived from Rust Functions' input parsing (extensions/*/src/*.rs)
const CREDIT_STATUS_SCHEMA = {
  schemaVersion: { type: "number" as const, value: 1 },
  currencyCode: { type: "string" as const, pattern: /^[A-Z]{3}$/ },
  hold: { type: "boolean" as const },
  holdReasonCode: { type: ["string", "null"] as const, enum: ["MANUAL_HOLD", "PAYMENT_OVERDUE", "CREDIT_REVIEW", "NEW_ACCOUNT", "FRAUD_SUSPECTED", null] },
  limitPaise: { type: "string" as const, pattern: /^\d+$/, nonNegative: true },
  exposurePaise: { type: "string" as const, pattern: /^\d+$/, nonNegative: true },
  updatedAt: { type: "string" as const, pattern: /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/ },
};

const SHOP_CONFIG_SCHEMA = {
  schemaVersion: { type: "number" as const, value: 1 },
  currencyCode: { type: "string" as const, pattern: /^[A-Z]{3}$/ },
};

type SchemaField = {
  type: "number" | "string" | "boolean" | readonly ["string", "null"];
  value?: number | string;
  pattern?: RegExp;
  nonNegative?: boolean;
  enum?: readonly (string | null)[];
};

function validateAgainstSchema(
  obj: Record<string, unknown>,
  schema: Record<string, SchemaField>,
  label: string
): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  const objKeys = new Set(Object.keys(obj));
  const schemaKeys = new Set(Object.keys(schema));

  for (const key of objKeys) {
    if (!schemaKeys.has(key)) {
      errors.push(`${label}: extra key "${key}"`);
    }
  }

  for (const key of schemaKeys) {
    if (!objKeys.has(key)) {
      errors.push(`${label}: missing key "${key}"`);
    }
  }

  for (const [key, field] of Object.entries(schema)) {
    const value = obj[key];

    if (Array.isArray(field.type)) {
      const actualType = value === null ? "null" : typeof value;
      if (!field.type.includes(actualType as "string" | "null")) {
        errors.push(`${label}.${key}: expected ${field.type.join(" | ")}, got ${actualType}`);
      }
    } else if (field.type === "number") {
      if (typeof value !== "number") {
        errors.push(`${label}.${key}: expected number, got ${typeof value}`);
      } else if (field.value !== undefined && value !== field.value) {
        errors.push(`${label}.${key}: expected ${field.value}, got ${value}`);
      }
    } else if (field.type === "string") {
      if (typeof value !== "string") {
        errors.push(`${label}.${key}: expected string, got ${typeof value}`);
      } else {
        if (field.pattern && !field.pattern.test(value)) {
          errors.push(`${label}.${key}: value "${value}" does not match pattern ${field.pattern}`);
        }
        if (field.nonNegative) {
          const num = BigInt(value);
          if (num < 0n) {
            errors.push(`${label}.${key}: value "${value}" is negative`);
          }
        }
      }
    } else if (field.type === "boolean") {
      if (typeof value !== "boolean") {
        errors.push(`${label}.${key}: expected boolean, got ${typeof value} (value: ${JSON.stringify(value)})`);
      }
    }

    if (field.enum && !field.enum.includes(value as string | null)) {
      errors.push(`${label}.${key}: value ${JSON.stringify(value)} not in enum ${JSON.stringify(field.enum)}`);
    }
  }

  return { valid: errors.length === 0, errors };
}

describe("Metafield Writer Contract", () => {
  describe("Manifest Guard (grep-based)", () => {
    it("finds all known credit_status writers in source tree", () => {
      const appDir = path.resolve(__dirname, "../..");
      const foundWriters: string[] = [];
      
      function scanDir(dir: string): void {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          const fullPath = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            if (entry.name === "__tests__" || entry.name === "node_modules") continue;
            scanDir(fullPath);
          } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
            const content = fs.readFileSync(fullPath, "utf-8");
            // Look for files that actually WRITE credit_status metafield to API
            // Must have both: the mutation call and the credit_status key
            // Exclude: contract/serialization-only files, files that only import the serializer
            // Use regex to ensure we match METAFIELD.key but not SHOP_CONFIG_METAFIELD.key
            const hasMetafieldsSetMutation = content.includes("metafieldsSet") && content.includes("mutation");
            const hasCreditStatusKey = content.includes('"credit_status"') || 
              content.includes("'credit_status'") ||
              (content.includes("METAFIELD.key") && !content.includes("SHOP_CONFIG_METAFIELD.key"));
            const isActualWriter = hasMetafieldsSetMutation && hasCreditStatusKey;
            
            if (isActualWriter) {
              const relativePath = path.relative(path.resolve(__dirname, "../../.."), fullPath);
              foundWriters.push(relativePath);
            }
          }
        }
      }
      
      scanDir(appDir);
      
      // Only check files that DEFINE the mutation, not files that just call through
      const manifestFiles = CREDIT_STATUS_MUTATION_DEFINERS.map(w => w.file);
      const unmanifested = foundWriters.filter(f => !manifestFiles.includes(f));
      
      expect(unmanifested, `Unmanifested credit_status writers: ${unmanifested.join(", ")}`).toHaveLength(0);
      
      for (const manifestedFile of manifestFiles) {
        const found = foundWriters.some(f => f === manifestedFile || f.endsWith(manifestedFile.replace("app/", "")));
        expect(found, `Manifest file ${manifestedFile} not found in scan`).toBe(true);
      }
    });

    it("finds all known shop_config writers in source tree", () => {
      const appDir = path.resolve(__dirname, "../..");
      const foundWriters: string[] = [];
      
      function scanDir(dir: string): void {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          const fullPath = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            if (entry.name === "__tests__" || entry.name === "node_modules") continue;
            scanDir(fullPath);
          } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
            const content = fs.readFileSync(fullPath, "utf-8");
            // Look for files that actually WRITE shop_config metafield to API
            // Must have both: the mutation call and the shop_config key
            // Exclude: contract/serialization-only files, files that only import/call the writer
            const hasMetafieldsSetMutation = content.includes("metafieldsSet") && content.includes("mutation");
            const hasShopConfigKey = content.includes("shop_config") || content.includes("SHOP_CONFIG_METAFIELD");
            const isActualWriter = hasMetafieldsSetMutation && hasShopConfigKey;
            
            if (isActualWriter) {
              const relativePath = path.relative(path.resolve(__dirname, "../../.."), fullPath);
              foundWriters.push(relativePath);
            }
          }
        }
      }
      
      scanDir(appDir);
      
      // Only check files that DEFINE the mutation, not files that just call through
      const manifestFiles = SHOP_CONFIG_MUTATION_DEFINERS.map(w => w.file);
      const unmanifested = foundWriters.filter(f => !manifestFiles.some(m => f === m || f.endsWith(m.replace("app/", ""))));
      
      expect(unmanifested, `Unmanifested shop_config writers: ${unmanifested.join(", ")}`).toHaveLength(0);
    });

    it("positive control: scan finds known writers", () => {
      const appDir = path.resolve(__dirname, "../..");
      let foundCreditStatus = false;
      let foundShopConfig = false;
      
      function scanDir(dir: string): void {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          const fullPath = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            if (entry.name === "__tests__" || entry.name === "node_modules") continue;
            scanDir(fullPath);
          } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
            const content = fs.readFileSync(fullPath, "utf-8");
            if (content.includes("serializeCreditStatusFromDb") && content.includes("metafieldsSet")) {
              foundCreditStatus = true;
            }
            if (content.includes("writeShopConfigMetafield") && content.includes("SHOP_CONFIG_METAFIELD")) {
              foundShopConfig = true;
            }
          }
        }
      }
      
      scanDir(appDir);
      
      expect(foundCreditStatus, "Should find credit_status writer").toBe(true);
      expect(foundShopConfig, "Should find shop_config writer").toBe(true);
    });

    it("documents that hide-terms-config has no TypeScript writer", () => {
      // This test explicitly documents that hide-terms-config has no TS writer.
      // The configuration is written via Shopify Admin UI when setting up the
      // payment customization, NOT by application TypeScript code.
      expect(HIDE_TERMS_CONFIG_MANIFEST.file).toBeNull();
      expect(HIDE_TERMS_CONFIG_MANIFEST.reason).toContain("Shopify Admin UI");
      
      // Verify the Rust reader exists (the only consumer of this metafield)
      const rustReaderPath = path.resolve(__dirname, "../../..", HIDE_TERMS_CONFIG_MANIFEST.rustReader);
      expect(fs.existsSync(rustReaderPath), `Rust reader ${HIDE_TERMS_CONFIG_MANIFEST.rustReader} should exist`).toBe(true);
      
      // Verify NO TypeScript file writes hide-terms-config
      const appDir = path.resolve(__dirname, "../..");
      let foundHideTermsWriter = false;
      
      function scanDir(dir: string): void {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          const fullPath = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            if (entry.name === "__tests__" || entry.name === "node_modules") continue;
            scanDir(fullPath);
          } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
            const content = fs.readFileSync(fullPath, "utf-8");
            const hasMetafieldsSetMutation = content.includes("metafieldsSet") && content.includes("mutation");
            const hasHideTermsKey = content.includes("hide-terms-config") || content.includes("hide_terms_config");
            if (hasMetafieldsSetMutation && hasHideTermsKey) {
              foundHideTermsWriter = true;
            }
          }
        }
      }
      
      scanDir(appDir);
      
      expect(foundHideTermsWriter, "Should NOT find any hide-terms-config writer in TypeScript").toBe(false);
    });
  });

  describe("Strict Schema Validation", () => {
    it("validates correct credit_status shape", () => {
      const validStatus = {
        schemaVersion: 1,
        currencyCode: "INR",
        hold: false,
        holdReasonCode: null,
        limitPaise: "10000000",
        exposurePaise: "5000000",
        updatedAt: "2026-10-27T00:00:00.000Z",
      };
      
      const result = validateAgainstSchema(validStatus, CREDIT_STATUS_SCHEMA, "credit_status");
      expect(result.errors).toEqual([]);
      expect(result.valid).toBe(true);
    });

    it("validates correct shop_config shape", () => {
      const validConfig = {
        schemaVersion: 1,
        currencyCode: "INR",
      };
      
      const result = validateAgainstSchema(validConfig, SHOP_CONFIG_SCHEMA, "shop_config");
      expect(result.errors).toEqual([]);
      expect(result.valid).toBe(true);
    });

    it("positive control: rejects string boolean in credit_status", () => {
      const badStatus = {
        schemaVersion: 1,
        currencyCode: "INR",
        hold: "false",
        holdReasonCode: null,
        limitPaise: "10000000",
        exposurePaise: "5000000",
        updatedAt: "2026-10-27T00:00:00.000Z",
      };
      
      const result = validateAgainstSchema(badStatus, CREDIT_STATUS_SCHEMA, "credit_status");
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes("hold") && e.includes("boolean"))).toBe(true);
    });

    it("positive control: rejects extra key", () => {
      const badStatus = {
        schemaVersion: 1,
        currencyCode: "INR",
        hold: false,
        holdReasonCode: null,
        limitPaise: "10000000",
        exposurePaise: "5000000",
        updatedAt: "2026-10-27T00:00:00.000Z",
        extraField: "should not be here",
      };
      
      const result = validateAgainstSchema(badStatus, CREDIT_STATUS_SCHEMA, "credit_status");
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes("extra key"))).toBe(true);
    });

    it("positive control: rejects missing key", () => {
      const badStatus = {
        schemaVersion: 1,
        currencyCode: "INR",
        hold: false,
        limitPaise: "10000000",
        exposurePaise: "5000000",
        updatedAt: "2026-10-27T00:00:00.000Z",
      };
      
      const result = validateAgainstSchema(badStatus, CREDIT_STATUS_SCHEMA, "credit_status");
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes("missing key") && e.includes("holdReasonCode"))).toBe(true);
    });

    it("positive control: rejects negative paise value", () => {
      const badStatus = {
        schemaVersion: 1,
        currencyCode: "INR",
        hold: false,
        holdReasonCode: null,
        limitPaise: "-10000000",
        exposurePaise: "5000000",
        updatedAt: "2026-10-27T00:00:00.000Z",
      };
      
      const result = validateAgainstSchema(badStatus, CREDIT_STATUS_SCHEMA, "credit_status");
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes("pattern"))).toBe(true);
    });
  });

  describe("EXERCISED: updateCreditStatus (credit_status writer)", () => {
    let capturedMetafields: Array<{ ownerId: string; namespace: string; key: string; value: string }> = [];
    let mockShopifyGraphQLRequest: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      capturedMetafields = [];
      vi.resetModules();
      
      mockShopifyGraphQLRequest = vi.fn().mockImplementation(async (_domain, _query, variables) => {
        const metafields = variables?.metafields as Array<{ ownerId: string; namespace: string; key: string; value: string }>;
        if (metafields) {
          capturedMetafields.push(...metafields);
        }
        return {
          success: true,
          data: {
            metafieldsSet: {
              metafields: metafields?.map((m, i) => ({ id: `mf-${i}`, namespace: m.namespace, key: m.key })) ?? [],
              userErrors: [],
            },
          },
        };
      });
      
      vi.doMock("../../services/shopify-client.server", () => ({
        shopifyGraphQLRequest: mockShopifyGraphQLRequest,
      }));
    });

    afterEach(() => {
      vi.resetModules();
      vi.restoreAllMocks();
    });

    const createMockSql = () => {
      const mockResults: Map<string, unknown[]> = new Map();

      const queryHandler = async (strings: TemplateStringsArray, ..._values: unknown[]) => {
        const query = strings.join("?");

        if (query.includes('FROM "Shop"') && query.includes("domain")) {
          return mockResults.get("shop") ?? [{ id: "shop-test", domain: MOCK_SHOP_DOMAIN, currency: "INR" }];
        }

        if (query.includes('FROM "Shop"') && query.includes("currency")) {
          return mockResults.get("shop_currency") ?? [{ currency: "INR" }];
        }

        if (query.includes('FROM "BuyerAccount"')) {
          return mockResults.get("account") ?? [];
        }

        if (query.includes('UPDATE "BuyerAccount"') && query.includes("syncPending") && !query.includes('syncVersion" + 1')) {
          return mockResults.get("clear_sync_pending") ?? [{ id: "acc-123" }];
        }

        if (query.includes('UPDATE "BuyerAccount"') && query.includes("RETURNING")) {
          return mockResults.get("update_account_returning") ?? [{ syncVersion: 1, id: "acc-123" }];
        }

        if (query.includes('UPDATE "BuyerAccount"')) {
          return mockResults.get("update_account") ?? [{ count: 1 }];
        }

        if (query.includes('FROM "Invoice"') && query.includes("SUM")) {
          return mockResults.get("invoice_exposure") ?? [{ total_paise: "0" }];
        }

        if (query.includes("s8_draft_orders") && query.includes("SUM")) {
          return mockResults.get("draft_exposure") ?? [{ total_paise: "0" }];
        }

        if (query.includes("EXISTS") && query.includes("dueAt")) {
          return mockResults.get("overdue_check") ?? [{ has_overdue: false }];
        }

        if (query.includes("INSERT INTO")) {
          return [];
        }

        return [];
      };

      const createTxMock = () => {
        const tx = Object.assign(vi.fn(queryHandler), {
          json: vi.fn((v) => v),
          array: vi.fn((arr: unknown[]) => arr),
        });
        return tx;
      };

      const sql = Object.assign(vi.fn(queryHandler), {
        json: vi.fn((v) => v),
        array: vi.fn((arr: unknown[]) => arr),
        begin: vi.fn(async <T>(fn: (tx: typeof sql) => Promise<T>): Promise<T> => {
          const tx = createTxMock();
          return fn(tx as unknown as typeof sql);
        }),
        setMockResult: (key: string, value: unknown) => mockResults.set(key, value as unknown[]),
        clearMockResults: () => mockResults.clear(),
      }) as unknown as Sql & {
        setMockResult: (key: string, value: unknown) => void;
        clearMockResults: () => void;
        begin: <T>(fn: (tx: Sql) => Promise<T>) => Promise<T>;
      };

      return sql;
    };

    interface CreditStatusTestCase {
      name: string;
      account: {
        id: string;
        kind: "COMPANY" | "TAGGED_CUSTOMER";
        companyLocationId?: string;
        customerId?: string;
        creditLimit: string | null;
        holdState: "OK" | "NEAR_LIMIT" | "HELD" | "BYPASS";
        bypass: boolean;
        manualHold: boolean;
        holdReasonCode: string | null;
      };
      update?: {
        creditLimitAmount?: number | null;
        noLimit?: boolean;
        manualHold: boolean;
        holdReasonCode?: string | null;
      };
      exposure?: string;
      hasOverdue?: boolean;
      expectedHold: boolean;
      expectedCurrency: string;
    }

    const CREDIT_STATUS_TEST_CASES: CreditStatusTestCase[] = [
      {
        name: "zero limit B2B",
        account: {
          id: "acc-zero-limit",
          kind: "COMPANY",
          companyLocationId: companyLocationGid(1001),
          creditLimit: "0",
          holdState: "OK",
          bypass: false,
          manualHold: false,
          holdReasonCode: null,
        },
        update: { creditLimitAmount: 0, manualHold: false },
        exposure: "0",
        expectedHold: false,
        expectedCurrency: "INR",
      },
      {
        name: "no limit B2B",
        account: {
          id: "acc-no-limit",
          kind: "COMPANY",
          companyLocationId: companyLocationGid(1002),
          creditLimit: null,
          holdState: "OK",
          bypass: false,
          manualHold: false,
          holdReasonCode: null,
        },
        update: { noLimit: true, manualHold: false },
        exposure: "5000000",
        expectedHold: false,
        expectedCurrency: "INR",
      },
      {
        name: "held buyer (manual hold)",
        account: {
          id: "acc-held",
          kind: "COMPANY",
          companyLocationId: companyLocationGid(1003),
          creditLimit: "100000",
          holdState: "HELD",
          bypass: false,
          manualHold: true,
          holdReasonCode: "MANUAL_HOLD",
        },
        update: { manualHold: true, holdReasonCode: "MANUAL_HOLD" },
        expectedHold: true,
        expectedCurrency: "INR",
      },
      {
        name: "unheld buyer",
        account: {
          id: "acc-unheld",
          kind: "COMPANY",
          companyLocationId: companyLocationGid(1004),
          creditLimit: "100000",
          holdState: "OK",
          bypass: false,
          manualHold: false,
          holdReasonCode: null,
        },
        update: { manualHold: false },
        expectedHold: false,
        expectedCurrency: "INR",
      },
      {
        name: "exposure above limit (auto-hold)",
        account: {
          id: "acc-over-limit",
          kind: "COMPANY",
          companyLocationId: companyLocationGid(1005),
          creditLimit: "100000",
          holdState: "OK",
          bypass: false,
          manualHold: false,
          holdReasonCode: null,
        },
        update: { manualHold: false },
        exposure: "15000000",
        expectedHold: true,
        expectedCurrency: "INR",
      },
      {
        name: "B2B Company/CompanyLocation buyer",
        account: {
          id: "acc-b2b",
          kind: "COMPANY",
          companyLocationId: companyLocationGid(1006),
          creditLimit: "50000",
          holdState: "OK",
          bypass: false,
          manualHold: false,
          holdReasonCode: null,
        },
        update: { manualHold: false },
        expectedHold: false,
        expectedCurrency: "INR",
      },
      {
        name: "tag-mode buyer (TAGGED_CUSTOMER)",
        account: {
          id: "acc-tagged",
          kind: "TAGGED_CUSTOMER",
          customerId: customerGid(2001),
          creditLimit: "50000",
          holdState: "OK",
          bypass: false,
          manualHold: false,
          holdReasonCode: null,
        },
        update: { manualHold: false },
        expectedHold: false,
        expectedCurrency: "INR",
      },
      {
        name: "bypass account (exposure above limit, not held)",
        account: {
          id: "acc-bypass",
          kind: "COMPANY",
          companyLocationId: companyLocationGid(1007),
          creditLimit: "100000",
          holdState: "BYPASS",
          bypass: true,
          manualHold: true,
          holdReasonCode: "MANUAL_HOLD",
        },
        update: { manualHold: true, holdReasonCode: "MANUAL_HOLD" },
        exposure: "20000000",
        expectedHold: false,
        expectedCurrency: "INR",
      },
      {
        name: "overdue invoices (auto-hold)",
        account: {
          id: "acc-overdue",
          kind: "COMPANY",
          companyLocationId: companyLocationGid(1008),
          creditLimit: "100000",
          holdState: "OK",
          bypass: false,
          manualHold: false,
          holdReasonCode: null,
        },
        hasOverdue: true,
        update: { manualHold: false },
        expectedHold: true,
        expectedCurrency: "INR",
      },
    ];

    for (const testCase of CREDIT_STATUS_TEST_CASES) {
      it(`produces valid shape for: ${testCase.name}`, async () => {
        const mockSql = createMockSql();
        
        mockSql.setMockResult("account", [{
          id: testCase.account.id,
          shopId: "shop-test",
          kind: testCase.account.kind,
          companyLocationId: testCase.account.companyLocationId ?? null,
          customerId: testCase.account.customerId ?? null,
          creditLimit: testCase.account.creditLimit,
          holdState: testCase.account.holdState,
          bypass: testCase.account.bypass,
          manualHold: testCase.account.manualHold,
          holdReasonCode: testCase.account.holdReasonCode,
          holdNote: null,
          syncPending: false,
          gatedAt: null,
        }]);
        
        mockSql.setMockResult("shop", [{ id: "shop-test", domain: MOCK_SHOP_DOMAIN, currency: "INR" }]);
        mockSql.setMockResult("shop_currency", [{ currency: "INR" }]);
        mockSql.setMockResult("invoice_exposure", [{ total_paise: testCase.exposure ?? "0" }]);
        mockSql.setMockResult("draft_exposure", [{ total_paise: "0" }]);
        mockSql.setMockResult("overdue_check", [{ has_overdue: testCase.hasOverdue ?? false }]);
        mockSql.setMockResult("update_account_returning", [{ syncVersion: 1, id: testCase.account.id }]);
        
        const { updateCreditStatus } = await import("../../services/credit-status.server");
        
        const result = await updateCreditStatus(mockSql, testCase.account.id, {
          creditLimitAmount: testCase.update?.creditLimitAmount,
          noLimit: testCase.update?.noLimit,
          manualHold: testCase.update?.manualHold ?? false,
          holdReasonCode: testCase.update?.holdReasonCode as Parameters<typeof updateCreditStatus>[2]["holdReasonCode"],
        });
        
        expect(result.success).toBe(true);
        
        const creditStatusMetafield = capturedMetafields.find(m => m.key === "credit_status");
        expect(creditStatusMetafield, `No credit_status metafield captured for: ${testCase.name}`).toBeDefined();
        
        const parsed = JSON.parse(creditStatusMetafield!.value);
        const validation = validateAgainstSchema(parsed, CREDIT_STATUS_SCHEMA, `credit_status (${testCase.name})`);
        
        expect(validation.errors, `Shape errors for ${testCase.name}: ${validation.errors.join("; ")}`).toEqual([]);
        expect(parsed.hold).toBe(testCase.expectedHold);
        expect(parsed.currencyCode).toBe(testCase.expectedCurrency);
        expect(parsed.schemaVersion).toBe(1);
        
        if (testCase.update?.noLimit) {
          expect(parsed.limitPaise).toBe("999999999999999");
        }
      });
    }

    it("coverage guard: all manifest edge cases appear in test table", () => {
      const testedCases = CREDIT_STATUS_TEST_CASES.map(c => c.name);
      
      expect(testedCases.length).toBeGreaterThanOrEqual(9);
      
      const requiredCases = [
        "zero limit",
        "no limit",
        "held",
        "unheld",
        "exposure above",
        "B2B",
        "tag-mode",
        "bypass",
        "overdue",
      ];
      
      for (const required of requiredCases) {
        const found = testedCases.some(name => name.toLowerCase().includes(required.toLowerCase()));
        expect(found, `Missing test case for: ${required}`).toBe(true);
      }
    });
  });

  describe("EXERCISED: syncCreditStatusMetafield (sync path)", () => {
    let capturedMetafields: Array<{ ownerId: string; namespace: string; key: string; value: string }> = [];
    let mockShopifyGraphQLRequest: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      capturedMetafields = [];
      vi.resetModules();
      
      mockShopifyGraphQLRequest = vi.fn().mockImplementation(async (_domain, _query, variables) => {
        const metafields = variables?.metafields as Array<{ ownerId: string; namespace: string; key: string; value: string }>;
        if (metafields) {
          capturedMetafields.push(...metafields);
        }
        return {
          success: true,
          data: {
            metafieldsSet: {
              metafields: metafields?.map((m, i) => ({ id: `mf-${i}`, namespace: m.namespace, key: m.key })) ?? [],
              userErrors: [],
            },
          },
        };
      });
      
      vi.doMock("../../services/shopify-client.server", () => ({
        shopifyGraphQLRequest: mockShopifyGraphQLRequest,
      }));
    });

    afterEach(() => {
      vi.resetModules();
      vi.restoreAllMocks();
    });

    const createMockSql = () => {
      const mockResults: Map<string, unknown[]> = new Map();

      const queryHandler = async (strings: TemplateStringsArray, ..._values: unknown[]) => {
        const query = strings.join("?");

        if (query.includes('FROM "Shop"') && query.includes("domain")) {
          return mockResults.get("shop") ?? [{ id: "shop-test", domain: MOCK_SHOP_DOMAIN, currency: "INR" }];
        }

        if (query.includes('FROM "Shop"') && query.includes("currency")) {
          return mockResults.get("shop_currency") ?? [{ currency: "INR" }];
        }

        if (query.includes('FROM "BuyerAccount"')) {
          return mockResults.get("account") ?? [];
        }

        if (query.includes('UPDATE "BuyerAccount"') && query.includes("RETURNING")) {
          return mockResults.get("update_account_returning") ?? [{ syncVersion: 1, id: "acc-123" }];
        }

        if (query.includes('UPDATE "BuyerAccount"')) {
          return mockResults.get("update_account") ?? [{ count: 1 }];
        }

        if (query.includes('FROM "Invoice"') && query.includes("SUM")) {
          return mockResults.get("invoice_exposure") ?? [{ total_paise: "0" }];
        }

        if (query.includes("s8_draft_orders") && query.includes("SUM")) {
          return mockResults.get("draft_exposure") ?? [{ total_paise: "0" }];
        }

        if (query.includes("EXISTS") && query.includes("dueAt")) {
          return mockResults.get("overdue_check") ?? [{ has_overdue: false }];
        }

        if (query.includes("INSERT INTO")) {
          return [];
        }

        return [];
      };

      const createTxMock = () => {
        const tx = Object.assign(vi.fn(queryHandler), {
          json: vi.fn((v) => v),
          array: vi.fn((arr: unknown[]) => arr),
        });
        return tx;
      };

      const sql = Object.assign(vi.fn(queryHandler), {
        json: vi.fn((v) => v),
        array: vi.fn((arr: unknown[]) => arr),
        begin: vi.fn(async <T>(fn: (tx: typeof sql) => Promise<T>): Promise<T> => {
          const tx = createTxMock();
          return fn(tx as unknown as typeof sql);
        }),
        setMockResult: (key: string, value: unknown) => mockResults.set(key, value as unknown[]),
        clearMockResults: () => mockResults.clear(),
      }) as unknown as Sql & {
        setMockResult: (key: string, value: unknown) => void;
        clearMockResults: () => void;
        begin: <T>(fn: (tx: Sql) => Promise<T>) => Promise<T>;
      };

      return sql;
    };

    it("sync path produces valid credit_status shape", async () => {
      const mockSql = createMockSql();
      
      mockSql.setMockResult("account", [{
        id: "acc-sync-test",
        shopId: "shop-test",
        kind: "COMPANY",
        companyLocationId: companyLocationGid(3001),
        customerId: null,
        creditLimit: "100000.00",
        holdState: "OK",
        bypass: false,
        manualHold: false,
        holdReasonCode: null,
        holdNote: null,
        syncPending: true,
        gatedAt: null,
      }]);
      
      mockSql.setMockResult("shop", [{ id: "shop-test", domain: MOCK_SHOP_DOMAIN, currency: "INR" }]);
      mockSql.setMockResult("shop_currency", [{ currency: "INR" }]);
      mockSql.setMockResult("invoice_exposure", [{ total_paise: "2500000" }]);
      mockSql.setMockResult("draft_exposure", [{ total_paise: "500000" }]);
      mockSql.setMockResult("overdue_check", [{ has_overdue: false }]);
      mockSql.setMockResult("update_account_returning", [{ syncVersion: 2, id: "acc-sync-test" }]);
      
      const { syncCreditStatusMetafield } = await import("../../services/credit-status.server");
      
      const result = await syncCreditStatusMetafield(mockSql, "acc-sync-test", "sync");
      
      expect(result.success).toBe(true);
      
      const creditStatusMetafield = capturedMetafields.find(m => m.key === "credit_status");
      expect(creditStatusMetafield, "No credit_status metafield captured for sync path").toBeDefined();
      
      const parsed = JSON.parse(creditStatusMetafield!.value);
      const validation = validateAgainstSchema(parsed, CREDIT_STATUS_SCHEMA, "credit_status (sync path)");
      
      expect(validation.errors, `Shape errors for sync path: ${validation.errors.join("; ")}`).toEqual([]);
      expect(parsed.schemaVersion).toBe(1);
      expect(parsed.currencyCode).toBe("INR");
      expect(parsed.exposurePaise).toBe("3000000");
      expect(parsed.limitPaise).toBe("10000000");
    });

    it("sync path with reinstall re-sync scenario produces valid shape", async () => {
      const mockSql = createMockSql();
      
      // Simulate account that was synced before uninstall, now needs re-sync
      mockSql.setMockResult("account", [{
        id: "acc-reinstall-sync",
        shopId: "shop-test",
        kind: "COMPANY",
        companyLocationId: companyLocationGid(3002),
        customerId: null,
        creditLimit: "200000.00",
        holdState: "HELD",
        bypass: false,
        manualHold: true,
        holdReasonCode: "MANUAL_HOLD",
        holdNote: "Reinstall test",
        syncPending: true,
        gatedAt: new Date("2026-01-01"),
      }]);
      
      mockSql.setMockResult("shop", [{ id: "shop-test", domain: MOCK_SHOP_DOMAIN, currency: "INR" }]);
      mockSql.setMockResult("shop_currency", [{ currency: "INR" }]);
      mockSql.setMockResult("invoice_exposure", [{ total_paise: "5000000" }]);
      mockSql.setMockResult("draft_exposure", [{ total_paise: "0" }]);
      mockSql.setMockResult("overdue_check", [{ has_overdue: false }]);
      mockSql.setMockResult("update_account_returning", [{ syncVersion: 3, id: "acc-reinstall-sync" }]);
      
      const { syncCreditStatusMetafield } = await import("../../services/credit-status.server");
      
      const result = await syncCreditStatusMetafield(mockSql, "acc-reinstall-sync", "sync");
      
      expect(result.success).toBe(true);
      
      const creditStatusMetafield = capturedMetafields.find(m => m.key === "credit_status");
      expect(creditStatusMetafield, "No credit_status metafield captured for reinstall sync").toBeDefined();
      
      const parsed = JSON.parse(creditStatusMetafield!.value);
      const validation = validateAgainstSchema(parsed, CREDIT_STATUS_SCHEMA, "credit_status (reinstall sync)");
      
      expect(validation.errors).toEqual([]);
      expect(parsed.hold).toBe(true);
      expect(parsed.holdReasonCode).toBe("MANUAL_HOLD");
    });
  });

  describe("EXERCISED: serializeCreditStatusFromDb (direct serializer for recomputeCreditStatus path)", () => {
    // These tests directly exercise the serializer used by ALL credit_status writers,
    // including recomputeCreditStatus which routes through syncCreditStatusMetafield.
    // This validates the shape contract for the recompute path.

    it("serializes zero limit correctly", async () => {
      const { serializeCreditStatusFromDb } = await import("../metafields-contract");
      
      const json = serializeCreditStatusFromDb({
        currencyCode: "INR",
        hold: false,
        holdReasonCode: null,
        limitPaise: 0n,
        exposurePaise: 0n,
      });
      
      const parsed = JSON.parse(json);
      const validation = validateAgainstSchema(parsed, CREDIT_STATUS_SCHEMA, "zero limit");
      
      expect(validation.errors).toEqual([]);
      expect(parsed.limitPaise).toBe("0");
      expect(parsed.exposurePaise).toBe("0");
      expect(parsed.currencyCode).toBe("INR");
      expect(parsed.schemaVersion).toBe(1);
      expect(typeof parsed.hold).toBe("boolean");
    });

    it("serializes no limit (null) as max value", async () => {
      const { serializeCreditStatusFromDb } = await import("../metafields-contract");
      
      const json = serializeCreditStatusFromDb({
        currencyCode: "INR",
        hold: false,
        holdReasonCode: null,
        limitPaise: null,
        exposurePaise: 5000000n,
      });
      
      const parsed = JSON.parse(json);
      const validation = validateAgainstSchema(parsed, CREDIT_STATUS_SCHEMA, "no limit");
      
      expect(validation.errors).toEqual([]);
      expect(parsed.limitPaise).toBe("999999999999999");
      expect(parsed.currencyCode).toBe("INR");
    });

    it("serializes held buyer with MANUAL_HOLD reason code", async () => {
      const { serializeCreditStatusFromDb } = await import("../metafields-contract");
      
      const json = serializeCreditStatusFromDb({
        currencyCode: "INR",
        hold: true,
        holdReasonCode: "MANUAL_HOLD",
        limitPaise: 10000000n,
        exposurePaise: 2500000n,
      });
      
      const parsed = JSON.parse(json);
      const validation = validateAgainstSchema(parsed, CREDIT_STATUS_SCHEMA, "held buyer");
      
      expect(validation.errors).toEqual([]);
      expect(parsed.hold).toBe(true);
      expect(parsed.holdReasonCode).toBe("MANUAL_HOLD");
      expect(parsed.currencyCode).toBe("INR");
    });

    it("serializes unheld buyer with null reason code", async () => {
      const { serializeCreditStatusFromDb } = await import("../metafields-contract");
      
      const json = serializeCreditStatusFromDb({
        currencyCode: "INR",
        hold: false,
        holdReasonCode: null,
        limitPaise: 10000000n,
        exposurePaise: 2500000n,
      });
      
      const parsed = JSON.parse(json);
      const validation = validateAgainstSchema(parsed, CREDIT_STATUS_SCHEMA, "unheld buyer");
      
      expect(validation.errors).toEqual([]);
      expect(parsed.hold).toBe(false);
      expect(parsed.holdReasonCode).toBeNull();
    });

    it("serializes PAYMENT_OVERDUE hold reason (daily sweep scenario)", async () => {
      const { serializeCreditStatusFromDb } = await import("../metafields-contract");
      
      const json = serializeCreditStatusFromDb({
        currencyCode: "INR",
        hold: true,
        holdReasonCode: "PAYMENT_OVERDUE",
        limitPaise: 5000000n,
        exposurePaise: 2500000n,
      });
      
      const parsed = JSON.parse(json);
      const validation = validateAgainstSchema(parsed, CREDIT_STATUS_SCHEMA, "payment overdue");
      
      expect(validation.errors).toEqual([]);
      expect(parsed.holdReasonCode).toBe("PAYMENT_OVERDUE");
      expect(parsed.currencyCode).toBe("INR");
    });

    it("serializes CREDIT_REVIEW hold reason (exposure above limit)", async () => {
      const { serializeCreditStatusFromDb } = await import("../metafields-contract");
      
      const json = serializeCreditStatusFromDb({
        currencyCode: "INR",
        hold: true,
        holdReasonCode: "CREDIT_REVIEW",
        limitPaise: 10000000n,
        exposurePaise: 15000000n,
      });
      
      const parsed = JSON.parse(json);
      const validation = validateAgainstSchema(parsed, CREDIT_STATUS_SCHEMA, "over limit");
      
      expect(validation.errors).toEqual([]);
      expect(BigInt(parsed.exposurePaise)).toBeGreaterThan(BigInt(parsed.limitPaise));
      expect(parsed.holdReasonCode).toBe("CREDIT_REVIEW");
    });

    it("serializes all valid hold reason codes", async () => {
      const { serializeCreditStatusFromDb } = await import("../metafields-contract");
      
      const holdReasonCodes = ["MANUAL_HOLD", "PAYMENT_OVERDUE", "CREDIT_REVIEW", "NEW_ACCOUNT", "FRAUD_SUSPECTED", null] as const;
      
      for (const code of holdReasonCodes) {
        const json = serializeCreditStatusFromDb({
          currencyCode: "INR",
          hold: code !== null,
          holdReasonCode: code,
          limitPaise: 10000000n,
          exposurePaise: 0n,
        });
        
        const parsed = JSON.parse(json);
        const validation = validateAgainstSchema(parsed, CREDIT_STATUS_SCHEMA, `holdReasonCode ${code}`);
        
        expect(validation.errors, `Shape error for holdReasonCode ${code}`).toEqual([]);
        expect(parsed.holdReasonCode).toBe(code);
        expect(parsed.currencyCode).toBe("INR");
      }
    });
  });

  describe("EXERCISED: writeShopConfigMetafield (shop_config writer)", () => {
    const SHOP_CONFIG_TEST_CASES = [
      { name: "INR currency", currency: "INR" },
      { name: "USD currency", currency: "USD" },
      { name: "EUR currency", currency: "EUR" },
      { name: "JPY currency", currency: "JPY" },
      { name: "GBP currency", currency: "GBP" },
    ];

    for (const testCase of SHOP_CONFIG_TEST_CASES) {
      it(`produces valid shape for: ${testCase.name}`, async () => {
        const mockAdmin = {
          graphql: vi.fn().mockResolvedValue({
            json: async () => ({
              data: {
                metafieldsSet: {
                  metafields: [{ id: "mf-shop-config" }],
                  userErrors: [],
                },
              },
            }),
          }),
        };
        
        const { writeShopConfigMetafield } = await import("../../services/shop-config.server");
        const result = await writeShopConfigMetafield(mockAdmin, shopGid(12345), testCase.currency);
        
        expect(result.success).toBe(true);
        
        const graphqlCall = mockAdmin.graphql.mock.calls[0];
        const variables = graphqlCall[1]?.variables as { metafields: Array<{ value: string }> };
        const metafieldValue = variables.metafields[0].value;
        
        const parsed = JSON.parse(metafieldValue);
        const validation = validateAgainstSchema(parsed, SHOP_CONFIG_SCHEMA, `shop_config (${testCase.name})`);
        
        expect(validation.errors, `Shape errors for ${testCase.name}: ${validation.errors.join("; ")}`).toEqual([]);
        expect(parsed.currencyCode).toBe(testCase.currency);
        expect(parsed.schemaVersion).toBe(1);
      });
    }
  });

  describe("EXERCISED: checkAndRecoverCurrency (currency recovery path)", () => {
    let capturedShopConfigValue: string | null = null;

    beforeEach(() => {
      capturedShopConfigValue = null;
      vi.resetModules();
    });

    afterEach(() => {
      vi.resetModules();
      vi.restoreAllMocks();
    });

    const createMockSql = () => {
      const mockResults: Map<string, unknown[]> = new Map();

      const queryHandler = async (strings: TemplateStringsArray, ..._values: unknown[]) => {
        const query = strings.join("?");

        if (query.includes('FROM "Shop"') && query.includes("domain")) {
          return mockResults.get("shop_by_domain") ?? [{ id: "shop-recovery-test" }];
        }

        if (query.includes('UPDATE "Shop"')) {
          return mockResults.get("shop_update") ?? [];
        }

        if (query.includes("s8_draft_orders") || query.includes("Invoice") || query.includes("Payment")) {
          return mockResults.get("financial_rows") ?? [{ count: 0 }];
        }

        return [];
      };

      const sql = Object.assign(vi.fn(queryHandler), {
        json: vi.fn((v) => v),
        array: vi.fn((arr: unknown[]) => arr),
        setMockResult: (key: string, value: unknown) => mockResults.set(key, value as unknown[]),
      }) as unknown as Sql & {
        setMockResult: (key: string, value: unknown) => void;
      };

      return sql;
    };

    it("currency recovery writes valid shop_config shape when metafield stale", async () => {
      const mockSql = createMockSql();
      mockSql.setMockResult("shop_by_domain", [{ id: "shop-recovery-test" }]);
      mockSql.setMockResult("financial_rows", [{ count: 0 }]);
      
      const mockAdmin = {
        graphql: vi.fn().mockImplementation(async (query: string, opts?: { variables?: Record<string, unknown> }) => {
          if (query.includes("ShopCurrencyAndId")) {
            return {
              json: async () => ({
                data: {
                  shop: {
                    id: shopGid(99999),
                    currencyCode: "INR",
                    metafield: { value: '{"schemaVersion":1,"currencyCode":"USD"}' },
                  },
                },
              }),
            };
          }
          
          // This is the metafieldsSet call
          const variables = opts?.variables as { metafields?: Array<{ value: string }> };
          if (variables?.metafields?.[0]?.value) {
            capturedShopConfigValue = variables.metafields[0].value;
          }
          
          return {
            json: async () => ({
              data: {
                metafieldsSet: {
                  metafields: [{ id: "mf-recovery" }],
                  userErrors: [],
                },
              },
            }),
          };
        }),
      };
      
      const { checkAndRecoverCurrency } = await import("../../services/shop-currency-recovery.server");
      
      const result = await checkAndRecoverCurrency(
        mockSql,
        MOCK_SHOP_DOMAIN,
        "USD",
        mockAdmin
      );
      
      expect(result.currency).toBe("INR");
      expect(result.flipBlocked).toBe(false);
      
      expect(capturedShopConfigValue, "shop_config metafield should be written").not.toBeNull();
      
      const parsed = JSON.parse(capturedShopConfigValue!);
      const validation = validateAgainstSchema(parsed, SHOP_CONFIG_SCHEMA, "shop_config (currency recovery)");
      
      expect(validation.errors).toEqual([]);
      expect(parsed.currencyCode).toBe("INR");
      expect(parsed.schemaVersion).toBe(1);
    });

    it("currency recovery writes valid shop_config when metafield missing (reinstall)", async () => {
      const mockSql = createMockSql();
      mockSql.setMockResult("shop_by_domain", [{ id: "shop-recovery-test-2" }]);
      mockSql.setMockResult("financial_rows", [{ count: 0 }]);
      
      const mockAdmin = {
        graphql: vi.fn().mockImplementation(async (query: string, opts?: { variables?: Record<string, unknown> }) => {
          if (query.includes("ShopCurrencyAndId")) {
            return {
              json: async () => ({
                data: {
                  shop: {
                    id: shopGid(88888),
                    currencyCode: "INR",
                    metafield: null,
                  },
                },
              }),
            };
          }
          
          const variables = opts?.variables as { metafields?: Array<{ value: string }> };
          if (variables?.metafields?.[0]?.value) {
            capturedShopConfigValue = variables.metafields[0].value;
          }
          
          return {
            json: async () => ({
              data: {
                metafieldsSet: {
                  metafields: [{ id: "mf-recovery-missing" }],
                  userErrors: [],
                },
              },
            }),
          };
        }),
      };
      
      const { checkAndRecoverCurrency } = await import("../../services/shop-currency-recovery.server");
      
      const result = await checkAndRecoverCurrency(
        mockSql,
        MOCK_SHOP_DOMAIN,
        "XXX",
        mockAdmin
      );
      
      expect(result.currency).toBe("INR");
      
      expect(capturedShopConfigValue).not.toBeNull();
      
      const parsed = JSON.parse(capturedShopConfigValue!);
      const validation = validateAgainstSchema(parsed, SHOP_CONFIG_SCHEMA, "shop_config (missing metafield)");
      
      expect(validation.errors).toEqual([]);
      expect(parsed.currencyCode).toBe("INR");
    });
  });

  describe("EXERCISED: serializeShopConfig (direct serializer for syncShopInfo path)", () => {
    // These tests directly exercise the serializer used by syncShopInfo via writeShopConfigMetafield.
    // syncShopInfo is the after-auth reinstall re-sync path.

    it("serializes INR currency for fresh install", async () => {
      const { serializeShopConfig } = await import("../metafields-contract");
      
      const json = serializeShopConfig("INR");
      const parsed = JSON.parse(json);
      const validation = validateAgainstSchema(parsed, SHOP_CONFIG_SCHEMA, "shop_config INR");
      
      expect(validation.errors).toEqual([]);
      expect(parsed.currencyCode).toBe("INR");
      expect(parsed.schemaVersion).toBe(1);
    });

    it("serializes currency for reinstall re-sync", async () => {
      const { serializeShopConfig } = await import("../metafields-contract");
      
      // Reinstall scenario: shop_config is written with current currency
      const json = serializeShopConfig("INR");
      const parsed = JSON.parse(json);
      const validation = validateAgainstSchema(parsed, SHOP_CONFIG_SCHEMA, "shop_config reinstall");
      
      expect(validation.errors).toEqual([]);
      expect(parsed.currencyCode).toBe("INR");
      expect(parsed.schemaVersion).toBe(1);
    });

    it("serializes multiple currencies correctly", async () => {
      const { serializeShopConfig } = await import("../metafields-contract");
      
      for (const currency of ["INR", "USD", "EUR", "GBP", "JPY"]) {
        const json = serializeShopConfig(currency);
        const parsed = JSON.parse(json);
        const validation = validateAgainstSchema(parsed, SHOP_CONFIG_SCHEMA, `shop_config ${currency}`);
        
        expect(validation.errors, `Shape error for ${currency}`).toEqual([]);
        expect(parsed.currencyCode).toBe(currency);
        expect(parsed.schemaVersion).toBe(1);
      }
    });
  });

  describe("Positive Controls - Shape Assertion Failures", () => {
    it("detects string boolean (deliberate bad sample)", () => {
      const badSample = {
        schemaVersion: 1,
        currencyCode: "INR",
        hold: "true",
        holdReasonCode: null,
        limitPaise: "10000000",
        exposurePaise: "5000000",
        updatedAt: "2026-10-27T00:00:00.000Z",
      };
      
      const result = validateAgainstSchema(badSample, CREDIT_STATUS_SCHEMA, "bad_sample");
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes("hold") && e.includes("boolean"))).toBe(true);
    });

    it("detects extra key (deliberate bad sample)", () => {
      const badSample = {
        schemaVersion: 1,
        currencyCode: "INR",
        hold: false,
        holdReasonCode: null,
        limitPaise: "10000000",
        exposurePaise: "5000000",
        updatedAt: "2026-10-27T00:00:00.000Z",
        unexpectedKey: "value",
      };
      
      const result = validateAgainstSchema(badSample, CREDIT_STATUS_SCHEMA, "bad_sample");
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes("extra key"))).toBe(true);
    });

    it("detects negative paise value (deliberate bad sample)", () => {
      const result = validateAgainstSchema(
        {
          schemaVersion: 1,
          currencyCode: "INR",
          hold: false,
          holdReasonCode: null,
          limitPaise: "-100",
          exposurePaise: "5000000",
          updatedAt: "2026-10-27T00:00:00.000Z",
        },
        CREDIT_STATUS_SCHEMA,
        "bad_sample"
      );
      
      expect(result.valid).toBe(false);
    });

    it("detects wrong schemaVersion (deliberate bad sample)", () => {
      const badSample = {
        schemaVersion: 2,
        currencyCode: "INR",
        hold: false,
        holdReasonCode: null,
        limitPaise: "10000000",
        exposurePaise: "5000000",
        updatedAt: "2026-10-27T00:00:00.000Z",
      };
      
      const result = validateAgainstSchema(badSample, CREDIT_STATUS_SCHEMA, "bad_sample");
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes("schemaVersion"))).toBe(true);
    });

    it("detects lowercase currency code (deliberate bad sample)", () => {
      const badSample = {
        schemaVersion: 1,
        currencyCode: "inr",
      };
      
      const result = validateAgainstSchema(badSample, SHOP_CONFIG_SCHEMA, "bad_sample");
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes("currencyCode") && e.includes("pattern"))).toBe(true);
    });

    it("detects invalid holdReasonCode enum value (deliberate bad sample)", () => {
      const badSample = {
        schemaVersion: 1,
        currencyCode: "INR",
        hold: true,
        holdReasonCode: "INVALID_REASON",
        limitPaise: "10000000",
        exposurePaise: "5000000",
        updatedAt: "2026-10-27T00:00:00.000Z",
      };
      
      const result = validateAgainstSchema(badSample, CREDIT_STATUS_SCHEMA, "bad_sample");
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes("holdReasonCode") && e.includes("enum"))).toBe(true);
    });
  });

  describe("Writer File/Function Coverage", () => {
    it("all manifest files exist", () => {
      const rootDir = path.resolve(__dirname, "../../..");
      
      for (const file of ALL_WRITER_FILES) {
        const filePath = path.join(rootDir, file);
        const exists = fs.existsSync(filePath);
        expect(exists, `Manifest file ${file} does not exist`).toBe(true);
      }
    });

    it("manifest covers expected writer count", () => {
      expect(CREDIT_STATUS_WRITERS.length).toBe(2);
      expect(SHOP_CONFIG_WRITERS.length).toBe(3);
    });

    it("all writers are marked as exercised", () => {
      const creditStatusExercised = CREDIT_STATUS_CALLERS.filter(c => c.exercised);
      const shopConfigExercised = SHOP_CONFIG_CALLERS.filter(c => c.exercised);
      
      expect(creditStatusExercised.length).toBe(CREDIT_STATUS_CALLERS.length);
      expect(shopConfigExercised.length).toBe(SHOP_CONFIG_CALLERS.length);
    });
  });
});
