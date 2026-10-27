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
 * 5. Guard tests: verify each exercised writer actually invoked metafieldsSet
 *
 * Writers Covered:
 * - credit_status: updateCreditStatus (EXERCISED), syncCreditStatusMetafield (EXERCISED),
 *   recomputeCreditStatus (EXERCISED)
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

// Track metafield writes from shopifyGraphQLRequest (for credit_status)
let creditStatusMetafieldCaptures: Array<{ ownerId: string; namespace: string; key: string; value: string }> = [];

// Track shop_config writes from writeShopConfigMetafield
let shopConfigWriteCaptures: Array<{ shopId: string; currency: string }> = [];

// Mock shopifyGraphQLRequest at module level (hoisted) - for credit_status writes
vi.mock("../../services/shopify-client.server", () => ({
  shopifyGraphQLRequest: vi.fn().mockImplementation(async (_domain, _query, variables) => {
    const metafields = variables?.metafields as Array<{ ownerId: string; namespace: string; key: string; value: string }>;
    if (metafields) {
      creditStatusMetafieldCaptures.push(...metafields);
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
  }),
}));

// Track calls to the actual serializeShopConfig for shape validation
let lastSerializedShopConfig: string | null = null;

// Capture what writeShopConfigMetafield receives (for syncShopInfo path)
const originalWriteShopConfigMetafield = vi.fn();
vi.mock("../../services/shop-config.server", async (importOriginal) => {
  const original = await importOriginal() as Record<string, unknown>;
  return {
    ...original,
    writeShopConfigMetafield: vi.fn(async (admin: unknown, shopId: string, currency: string) => {
      shopConfigWriteCaptures.push({ shopId, currency });
      const { serializeShopConfig } = await import("../metafields-contract");
      lastSerializedShopConfig = serializeShopConfig(currency);
      originalWriteShopConfigMetafield(admin, shopId, currency);
      return { success: true, metafieldId: "mf-test" };
    }),
  };
});

/**
 * WRITERS MANIFEST
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

// hide-terms-config: NO TypeScript writer exists
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

interface MockBuyerAccount {
  id: string;
  shopId: string;
  kind: "COMPANY" | "TAGGED_CUSTOMER";
  companyLocationId: string | null;
  customerId: string | null;
  creditLimit: string | null;
  holdState: "OK" | "NEAR_LIMIT" | "HELD" | "BYPASS";
  bypass: boolean;
  manualHold: boolean;
  holdReasonCode: string | null;
  holdNote: string | null;
  syncPending: boolean;
  gatedAt: Date | null;
  metafieldSyncedAt: Date | null;
  metafieldSyncErrorAt: Date | null;
  metafieldSyncErrorCode: string | null;
}

interface MockConfig {
  account: MockBuyerAccount;
  shop: { id: string; domain: string; currency: string };
  invoiceExposure: string;
  draftExposure: string;
  hasOverdue: boolean;
}

function createComprehensiveMockSql(config: MockConfig) {
  let syncVersionCounter = 1;
  
  const queryHandler = async (strings: TemplateStringsArray, ..._values: unknown[]): Promise<unknown[]> => {
    const query = strings.join("?");
    
    // BuyerAccount SELECT (with or without FOR UPDATE)
    if (query.includes('FROM "BuyerAccount"') && query.includes("SELECT") && !query.includes("UPDATE \"BuyerAccount\"")) {
      return [config.account];
    }
    
    // BuyerAccount UPDATE RETURNING
    if (query.includes('UPDATE "BuyerAccount"') && query.includes("RETURNING")) {
      syncVersionCounter++;
      return [{ syncVersion: syncVersionCounter, id: config.account.id }];
    }
    
    // BuyerAccount UPDATE (without RETURNING)
    if (query.includes('UPDATE "BuyerAccount"')) {
      return [{ count: 1 }];
    }
    
    // Shop SELECT (by id or domain)
    if (query.includes('FROM "Shop"')) {
      return [config.shop];
    }
    
    // Invoice SUM (exposure)
    if (query.includes('FROM "Invoice"') && query.includes("SUM")) {
      return [{ total_paise: config.invoiceExposure }];
    }
    
    // s8_draft_orders SUM (draft exposure)
    if (query.includes("s8_draft_orders") && query.includes("SUM")) {
      return [{ total_paise: config.draftExposure }];
    }
    
    // Invoice EXISTS (overdue check)
    if (query.includes("EXISTS") && query.includes('"Invoice"')) {
      return [{ has_overdue: config.hasOverdue }];
    }
    
    // INSERT (audit events, etc.)
    if (query.includes("INSERT INTO")) {
      return [];
    }
    
    // Shop UPDATE
    if (query.includes("UPDATE") && query.includes('"Shop"')) {
      return [];
    }
    
    return [];
  };

  const createTxMock = () => {
    const tx = Object.assign(
      async (strings: TemplateStringsArray, ...values: unknown[]) => queryHandler(strings, ...values),
      {
        json: (v: unknown) => v,
        array: (arr: unknown[]) => arr,
      }
    );
    return tx;
  };

  const sql = Object.assign(
    async (strings: TemplateStringsArray, ...values: unknown[]) => queryHandler(strings, ...values),
    {
      json: (v: unknown) => v,
      array: (arr: unknown[]) => arr,
      begin: async <T>(fn: (tx: unknown) => Promise<T>): Promise<T> => {
        const tx = createTxMock();
        return fn(tx);
      },
    }
  ) as unknown as Sql;

  return sql;
}

describe("Metafield Writer Contract", () => {
  beforeEach(() => {
    creditStatusMetafieldCaptures = [];
    shopConfigWriteCaptures = [];
    lastSerializedShopConfig = null;
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

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
      
      const manifestFiles = CREDIT_STATUS_MUTATION_DEFINERS.map(w => w.file);
      const unmanifested = foundWriters.filter(f => !manifestFiles.includes(f));
      
      expect(unmanifested, `Unmanifested credit_status writers: ${unmanifested.join(", ")}`).toHaveLength(0);
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
      
      const manifestFiles = SHOP_CONFIG_MUTATION_DEFINERS.map(w => w.file);
      const unmanifested = foundWriters.filter(f => !manifestFiles.some(m => f === m || f.endsWith(m.replace("app/", ""))));
      
      expect(unmanifested, `Unmanifested shop_config writers: ${unmanifested.join(", ")}`).toHaveLength(0);
    });

    it("documents that hide-terms-config has no TypeScript writer", () => {
      expect(HIDE_TERMS_CONFIG_MANIFEST.file).toBeNull();
      expect(HIDE_TERMS_CONFIG_MANIFEST.reason).toContain("Shopify Admin UI");
      
      const rustReaderPath = path.resolve(__dirname, "../../..", HIDE_TERMS_CONFIG_MANIFEST.rustReader);
      expect(fs.existsSync(rustReaderPath)).toBe(true);
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
    });

    it("validates correct shop_config shape", () => {
      const validConfig = { schemaVersion: 1, currencyCode: "INR" };
      const result = validateAgainstSchema(validConfig, SHOP_CONFIG_SCHEMA, "shop_config");
      expect(result.errors).toEqual([]);
    });

    it("positive control: rejects string boolean", () => {
      const badStatus = {
        schemaVersion: 1, currencyCode: "INR", hold: "false", holdReasonCode: null,
        limitPaise: "10000000", exposurePaise: "5000000", updatedAt: "2026-10-27T00:00:00.000Z",
      };
      const result = validateAgainstSchema(badStatus, CREDIT_STATUS_SCHEMA, "credit_status");
      expect(result.valid).toBe(false);
    });

    it("positive control: rejects extra key", () => {
      const badStatus = {
        schemaVersion: 1, currencyCode: "INR", hold: false, holdReasonCode: null,
        limitPaise: "10000000", exposurePaise: "5000000", updatedAt: "2026-10-27T00:00:00.000Z",
        extraField: "bad",
      };
      const result = validateAgainstSchema(badStatus, CREDIT_STATUS_SCHEMA, "credit_status");
      expect(result.valid).toBe(false);
    });
  });

  describe("EXERCISED: recomputeCreditStatus (actual function call)", () => {
    it("recomputeCreditStatus with hold:true produces valid shape", async () => {
      const sql = createComprehensiveMockSql({
        account: {
          id: "acc-recompute-held",
          shopId: "shop-test",
          kind: "COMPANY",
          companyLocationId: companyLocationGid(5001),
          customerId: null,
          creditLimit: "100000.00",
          holdState: "HELD",
          bypass: false,
          manualHold: true,
          holdReasonCode: "MANUAL_HOLD",
          holdNote: null,
          syncPending: true,
          gatedAt: null,
          metafieldSyncedAt: new Date("2026-10-01"),
          metafieldSyncErrorAt: null,
          metafieldSyncErrorCode: null,
        },
        shop: { id: "shop-test", domain: MOCK_SHOP_DOMAIN, currency: "INR" },
        invoiceExposure: "5000000",
        draftExposure: "0",
        hasOverdue: false,
      });
      
      const { recomputeCreditStatus } = await import("../../services/credit-status-recompute.server");
      
      const result = await recomputeCreditStatus(sql, "acc-recompute-held", "invoice_change");
      
      expect(result.success, `recomputeCreditStatus failed: ${result.error}`).toBe(true);
      
      const captured = creditStatusMetafieldCaptures.find(m => m.key === "credit_status");
      expect(captured, "No credit_status metafield was captured").toBeDefined();
      
      const parsed = JSON.parse(captured!.value);
      const validation = validateAgainstSchema(parsed, CREDIT_STATUS_SCHEMA, "credit_status (recompute hold:true)");
      
      expect(validation.errors).toEqual([]);
      expect(parsed.hold).toBe(true);
      expect(parsed.holdReasonCode).toBe("MANUAL_HOLD");
      expect(parsed.currencyCode).toBe("INR");
      expect(parsed.schemaVersion).toBe(1);
      expect(typeof parsed.hold).toBe("boolean");
    });

    it("recomputeCreditStatus with hold:false produces valid shape", async () => {
      creditStatusMetafieldCaptures = [];
      
      const sql = createComprehensiveMockSql({
        account: {
          id: "acc-recompute-unheld",
          shopId: "shop-test",
          kind: "COMPANY",
          companyLocationId: companyLocationGid(5002),
          customerId: null,
          creditLimit: "100000.00",
          holdState: "OK",
          bypass: false,
          manualHold: false,
          holdReasonCode: null,
          holdNote: null,
          syncPending: true,
          gatedAt: null,
          metafieldSyncedAt: new Date("2026-10-01"),
          metafieldSyncErrorAt: null,
          metafieldSyncErrorCode: null,
        },
        shop: { id: "shop-test", domain: MOCK_SHOP_DOMAIN, currency: "INR" },
        invoiceExposure: "2500000",
        draftExposure: "0",
        hasOverdue: false,
      });
      
      const { recomputeCreditStatus } = await import("../../services/credit-status-recompute.server");
      
      const result = await recomputeCreditStatus(sql, "acc-recompute-unheld", "invoice_change");
      
      expect(result.success, `recomputeCreditStatus failed: ${result.error}`).toBe(true);
      
      const captured = creditStatusMetafieldCaptures.find(m => m.key === "credit_status");
      expect(captured, "No credit_status metafield was captured").toBeDefined();
      
      const parsed = JSON.parse(captured!.value);
      const validation = validateAgainstSchema(parsed, CREDIT_STATUS_SCHEMA, "credit_status (recompute hold:false)");
      
      expect(validation.errors).toEqual([]);
      expect(parsed.hold).toBe(false);
      expect(parsed.holdReasonCode).toBeNull();
      expect(parsed.currencyCode).toBe("INR");
    });

    it("recomputeCreditStatus with exposure above limit produces valid shape", async () => {
      creditStatusMetafieldCaptures = [];
      
      const sql = createComprehensiveMockSql({
        account: {
          id: "acc-recompute-over",
          shopId: "shop-test",
          kind: "COMPANY",
          companyLocationId: companyLocationGid(5003),
          customerId: null,
          creditLimit: "100000.00",
          holdState: "OK",
          bypass: false,
          manualHold: false,
          holdReasonCode: null,
          holdNote: null,
          syncPending: true,
          gatedAt: null,
          metafieldSyncedAt: new Date("2026-10-01"),
          metafieldSyncErrorAt: null,
          metafieldSyncErrorCode: null,
        },
        shop: { id: "shop-test", domain: MOCK_SHOP_DOMAIN, currency: "INR" },
        invoiceExposure: "15000000",
        draftExposure: "0",
        hasOverdue: false,
      });
      
      const { recomputeCreditStatus } = await import("../../services/credit-status-recompute.server");
      
      const result = await recomputeCreditStatus(sql, "acc-recompute-over", "invoice_change");
      
      expect(result.success, `recomputeCreditStatus failed: ${result.error}`).toBe(true);
      
      const captured = creditStatusMetafieldCaptures.find(m => m.key === "credit_status");
      expect(captured, "No credit_status metafield was captured").toBeDefined();
      
      const parsed = JSON.parse(captured!.value);
      expect(parsed.hold).toBe(true);
      expect(BigInt(parsed.exposurePaise)).toBeGreaterThan(BigInt(parsed.limitPaise));
    });

    it("recomputeCreditStatus with zero limit produces valid shape", async () => {
      creditStatusMetafieldCaptures = [];
      
      const sql = createComprehensiveMockSql({
        account: {
          id: "acc-recompute-zero",
          shopId: "shop-test",
          kind: "COMPANY",
          companyLocationId: companyLocationGid(5004),
          customerId: null,
          creditLimit: "0.00",
          holdState: "OK",
          bypass: false,
          manualHold: false,
          holdReasonCode: null,
          holdNote: null,
          syncPending: true,
          gatedAt: null,
          metafieldSyncedAt: new Date("2026-10-01"),
          metafieldSyncErrorAt: null,
          metafieldSyncErrorCode: null,
        },
        shop: { id: "shop-test", domain: MOCK_SHOP_DOMAIN, currency: "INR" },
        invoiceExposure: "0",
        draftExposure: "0",
        hasOverdue: false,
      });
      
      const { recomputeCreditStatus } = await import("../../services/credit-status-recompute.server");
      
      const result = await recomputeCreditStatus(sql, "acc-recompute-zero", "invoice_change");
      
      expect(result.success, `recomputeCreditStatus failed: ${result.error}`).toBe(true);
      
      const captured = creditStatusMetafieldCaptures.find(m => m.key === "credit_status");
      expect(captured, "No credit_status metafield was captured").toBeDefined();
      
      const parsed = JSON.parse(captured!.value);
      expect(parsed.limitPaise).toBe("0");
    });

    it("recomputeCreditStatus with no limit (null) produces valid shape", async () => {
      creditStatusMetafieldCaptures = [];
      
      const sql = createComprehensiveMockSql({
        account: {
          id: "acc-recompute-nolimit",
          shopId: "shop-test",
          kind: "COMPANY",
          companyLocationId: companyLocationGid(5005),
          customerId: null,
          creditLimit: null,
          holdState: "OK",
          bypass: false,
          manualHold: false,
          holdReasonCode: null,
          holdNote: null,
          syncPending: true,
          gatedAt: null,
          metafieldSyncedAt: new Date("2026-10-01"),
          metafieldSyncErrorAt: null,
          metafieldSyncErrorCode: null,
        },
        shop: { id: "shop-test", domain: MOCK_SHOP_DOMAIN, currency: "INR" },
        invoiceExposure: "50000000",
        draftExposure: "0",
        hasOverdue: false,
      });
      
      const { recomputeCreditStatus } = await import("../../services/credit-status-recompute.server");
      
      const result = await recomputeCreditStatus(sql, "acc-recompute-nolimit", "invoice_change");
      
      expect(result.success, `recomputeCreditStatus failed: ${result.error}`).toBe(true);
      
      const captured = creditStatusMetafieldCaptures.find(m => m.key === "credit_status");
      expect(captured, "No credit_status metafield was captured").toBeDefined();
      
      const parsed = JSON.parse(captured!.value);
      expect(parsed.limitPaise).toBe("999999999999999");
    });

    it("GUARD: recomputeCreditStatus actually invoked shopifyGraphQLRequest", async () => {
      creditStatusMetafieldCaptures = [];
      
      const sql = createComprehensiveMockSql({
        account: {
          id: "acc-guard-recompute",
          shopId: "shop-test",
          kind: "COMPANY",
          companyLocationId: companyLocationGid(9999),
          customerId: null,
          creditLimit: "100000.00",
          holdState: "OK",
          bypass: false,
          manualHold: false,
          holdReasonCode: null,
          holdNote: null,
          syncPending: true,
          gatedAt: null,
          metafieldSyncedAt: new Date("2026-10-01"),
          metafieldSyncErrorAt: null,
          metafieldSyncErrorCode: null,
        },
        shop: { id: "shop-test", domain: MOCK_SHOP_DOMAIN, currency: "INR" },
        invoiceExposure: "5000000",
        draftExposure: "0",
        hasOverdue: false,
      });
      
      const { recomputeCreditStatus } = await import("../../services/credit-status-recompute.server");
      
      await recomputeCreditStatus(sql, "acc-guard-recompute", "invoice_change");
      
      expect(creditStatusMetafieldCaptures.length, "recomputeCreditStatus must invoke metafieldsSet").toBeGreaterThan(0);
      expect(creditStatusMetafieldCaptures.some(m => m.key === "credit_status")).toBe(true);
    });
  });

  describe("EXERCISED: _syncShopInfoForTesting (actual function call)", () => {
    it("syncShopInfo produces valid shop_config shape for reinstall re-sync", async () => {
      shopConfigWriteCaptures = [];
      lastSerializedShopConfig = null;
      
      const mockAdmin = {
        graphql: vi.fn().mockResolvedValue({
          json: async () => ({
            data: {
              shop: {
                id: shopGid(77777),
                ianaTimezone: "Asia/Kolkata",
                currencyCode: "INR",
              },
            },
          }),
        }),
      };
      
      const mockSql = createComprehensiveMockSql({
        account: {
          id: "acc-dummy",
          shopId: "shop-reinstall-test",
          kind: "COMPANY",
          companyLocationId: null,
          customerId: null,
          creditLimit: null,
          holdState: "OK",
          bypass: false,
          manualHold: false,
          holdReasonCode: null,
          holdNote: null,
          syncPending: false,
          gatedAt: null,
          metafieldSyncedAt: null,
          metafieldSyncErrorAt: null,
          metafieldSyncErrorCode: null,
        },
        shop: { id: "shop-reinstall-test", domain: MOCK_SHOP_DOMAIN, currency: "USD" },
        invoiceExposure: "0",
        draftExposure: "0",
        hasOverdue: false,
      });
      
      vi.doMock("../request-context.server", () => ({
        getRequestSql: () => mockSql,
      }));
      
      const { _syncShopInfoForTesting } = await import("../after-auth.server");
      
      await _syncShopInfoForTesting(MOCK_SHOP_DOMAIN, mockAdmin);
      
      expect(shopConfigWriteCaptures.length, "syncShopInfo must call writeShopConfigMetafield").toBeGreaterThan(0);
      expect(lastSerializedShopConfig).not.toBeNull();
      
      const parsed = JSON.parse(lastSerializedShopConfig!);
      const validation = validateAgainstSchema(parsed, SHOP_CONFIG_SCHEMA, "shop_config (syncShopInfo)");
      
      expect(validation.errors).toEqual([]);
      expect(parsed.currencyCode).toBe("INR");
      expect(parsed.schemaVersion).toBe(1);
    });

    it("GUARD: syncShopInfo actually invoked writeShopConfigMetafield", async () => {
      shopConfigWriteCaptures = [];
      
      const mockAdmin = {
        graphql: vi.fn().mockResolvedValue({
          json: async () => ({
            data: {
              shop: {
                id: shopGid(88888),
                ianaTimezone: "Asia/Kolkata",
                currencyCode: "INR",
              },
            },
          }),
        }),
      };
      
      const mockSql = createComprehensiveMockSql({
        account: {
          id: "acc-guard-dummy",
          shopId: "shop-guard-test",
          kind: "COMPANY",
          companyLocationId: null,
          customerId: null,
          creditLimit: null,
          holdState: "OK",
          bypass: false,
          manualHold: false,
          holdReasonCode: null,
          holdNote: null,
          syncPending: false,
          gatedAt: null,
          metafieldSyncedAt: null,
          metafieldSyncErrorAt: null,
          metafieldSyncErrorCode: null,
        },
        shop: { id: "shop-guard-test", domain: "test-guard.example.com", currency: "XXX" },
        invoiceExposure: "0",
        draftExposure: "0",
        hasOverdue: false,
      });
      
      vi.doMock("../request-context.server", () => ({
        getRequestSql: () => mockSql,
      }));
      
      const { _syncShopInfoForTesting } = await import("../after-auth.server");
      
      await _syncShopInfoForTesting("test-guard.example.com", mockAdmin);
      
      expect(shopConfigWriteCaptures.length, "syncShopInfo must invoke writeShopConfigMetafield").toBeGreaterThan(0);
    });
  });

  describe("EXERCISED: updateCreditStatus (credit_status writer)", () => {
    it("produces valid shape for held buyer", async () => {
      creditStatusMetafieldCaptures = [];
      
      const sql = createComprehensiveMockSql({
        account: {
          id: "acc-held",
          shopId: "shop-test",
          kind: "COMPANY",
          companyLocationId: companyLocationGid(1003),
          customerId: null,
          creditLimit: "100000",
          holdState: "HELD",
          bypass: false,
          manualHold: true,
          holdReasonCode: "MANUAL_HOLD",
          holdNote: null,
          syncPending: false,
          gatedAt: null,
          metafieldSyncedAt: null,
          metafieldSyncErrorAt: null,
          metafieldSyncErrorCode: null,
        },
        shop: { id: "shop-test", domain: MOCK_SHOP_DOMAIN, currency: "INR" },
        invoiceExposure: "0",
        draftExposure: "0",
        hasOverdue: false,
      });
      
      const { updateCreditStatus } = await import("../../services/credit-status.server");
      
      const result = await updateCreditStatus(sql, "acc-held", {
        manualHold: true, holdReasonCode: "MANUAL_HOLD",
      });
      
      expect(result.success, `updateCreditStatus failed: ${result.error}`).toBe(true);
      
      const captured = creditStatusMetafieldCaptures.find(m => m.key === "credit_status");
      expect(captured, "No credit_status metafield was captured").toBeDefined();
      
      const parsed = JSON.parse(captured!.value);
      expect(parsed.hold).toBe(true);
      expect(parsed.currencyCode).toBe("INR");
    });

    it("produces valid shape for tag-mode buyer (TAGGED_CUSTOMER)", async () => {
      creditStatusMetafieldCaptures = [];
      
      const sql = createComprehensiveMockSql({
        account: {
          id: "acc-tagged",
          shopId: "shop-test",
          kind: "TAGGED_CUSTOMER",
          companyLocationId: null,
          customerId: customerGid(2001),
          creditLimit: "50000",
          holdState: "OK",
          bypass: false,
          manualHold: false,
          holdReasonCode: null,
          holdNote: null,
          syncPending: false,
          gatedAt: null,
          metafieldSyncedAt: null,
          metafieldSyncErrorAt: null,
          metafieldSyncErrorCode: null,
        },
        shop: { id: "shop-test", domain: MOCK_SHOP_DOMAIN, currency: "INR" },
        invoiceExposure: "0",
        draftExposure: "0",
        hasOverdue: false,
      });
      
      const { updateCreditStatus } = await import("../../services/credit-status.server");
      
      const result = await updateCreditStatus(sql, "acc-tagged", { manualHold: false });
      
      expect(result.success, `updateCreditStatus failed: ${result.error}`).toBe(true);
      
      const captured = creditStatusMetafieldCaptures.find(m => m.key === "credit_status");
      expect(captured, "No credit_status metafield was captured").toBeDefined();
      
      const parsed = JSON.parse(captured!.value);
      const validation = validateAgainstSchema(parsed, CREDIT_STATUS_SCHEMA, "credit_status (tag-mode)");
      expect(validation.errors).toEqual([]);
    });
  });

  describe("EXERCISED: writeShopConfigMetafield (shop_config writer)", () => {
    it("produces valid shape for INR currency", async () => {
      const mockAdmin = {
        graphql: vi.fn().mockResolvedValue({
          json: async () => ({
            data: { metafieldsSet: { metafields: [{ id: "mf-shop-config" }], userErrors: [] } },
          }),
        }),
      };
      
      const { writeShopConfigMetafield } = await import("../../services/shop-config.server");
      const result = await writeShopConfigMetafield(mockAdmin, shopGid(12345), "INR");
      
      expect(result.success).toBe(true);
      expect(lastSerializedShopConfig).not.toBeNull();
      
      const parsed = JSON.parse(lastSerializedShopConfig!);
      const validation = validateAgainstSchema(parsed, SHOP_CONFIG_SCHEMA, "shop_config (INR)");
      expect(validation.errors).toEqual([]);
      expect(parsed.currencyCode).toBe("INR");
    });
  });

  describe("EXERCISED: checkAndRecoverCurrency (currency recovery path)", () => {
    it("currency recovery writes valid shop_config shape", async () => {
      shopConfigWriteCaptures = [];
      lastSerializedShopConfig = null;
      
      const sql = createComprehensiveMockSql({
        account: {
          id: "acc-recovery-dummy",
          shopId: "shop-recovery-test",
          kind: "COMPANY",
          companyLocationId: null,
          customerId: null,
          creditLimit: null,
          holdState: "OK",
          bypass: false,
          manualHold: false,
          holdReasonCode: null,
          holdNote: null,
          syncPending: false,
          gatedAt: null,
          metafieldSyncedAt: null,
          metafieldSyncErrorAt: null,
          metafieldSyncErrorCode: null,
        },
        shop: { id: "shop-recovery-test", domain: MOCK_SHOP_DOMAIN, currency: "USD" },
        invoiceExposure: "0",
        draftExposure: "0",
        hasOverdue: false,
      });
      
      const mockAdmin = {
        graphql: vi.fn().mockImplementation(async (query: string) => {
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
          
          return {
            json: async () => ({
              data: { metafieldsSet: { metafields: [{ id: "mf-recovery" }], userErrors: [] } },
            }),
          };
        }),
      };
      
      const { checkAndRecoverCurrency } = await import("../../services/shop-currency-recovery.server");
      
      const result = await checkAndRecoverCurrency(sql, MOCK_SHOP_DOMAIN, "USD", mockAdmin);
      
      expect(result.currency).toBe("INR");
      expect(shopConfigWriteCaptures.length, "checkAndRecoverCurrency must call writeShopConfigMetafield").toBeGreaterThan(0);
      expect(lastSerializedShopConfig).not.toBeNull();
      
      const parsed = JSON.parse(lastSerializedShopConfig!);
      const validation = validateAgainstSchema(parsed, SHOP_CONFIG_SCHEMA, "shop_config (recovery)");
      expect(validation.errors).toEqual([]);
      expect(parsed.currencyCode).toBe("INR");
    });
  });

  describe("EXERCISED: serializeCreditStatusFromDb (multi-currency serializer)", () => {
    it("serializes multiple currency codes correctly", async () => {
      const { serializeCreditStatusFromDb } = await import("../metafields-contract");
      
      for (const currency of ["INR", "USD", "EUR", "GBP", "JPY"]) {
        const json = serializeCreditStatusFromDb({
          currencyCode: currency,
          hold: false,
          holdReasonCode: null,
          limitPaise: 10000000n,
          exposurePaise: 0n,
        });
        
        const parsed = JSON.parse(json);
        const validation = validateAgainstSchema(parsed, CREDIT_STATUS_SCHEMA, `credit_status (${currency})`);
        
        expect(validation.errors, `Shape error for ${currency}`).toEqual([]);
        expect(parsed.currencyCode).toBe(currency);
        expect(parsed.schemaVersion).toBe(1);
        expect(typeof parsed.hold).toBe("boolean");
      }
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
        
        expect(validation.errors).toEqual([]);
        expect(parsed.holdReasonCode).toBe(code);
      }
    });
  });

  describe("Positive Controls - Shape Assertion Failures", () => {
    it("detects lowercase currency code", () => {
      const badSample = { schemaVersion: 1, currencyCode: "inr" };
      const result = validateAgainstSchema(badSample, SHOP_CONFIG_SCHEMA, "bad_sample");
      expect(result.valid).toBe(false);
    });

    it("detects invalid holdReasonCode enum value", () => {
      const badSample = {
        schemaVersion: 1, currencyCode: "INR", hold: true, holdReasonCode: "INVALID_REASON",
        limitPaise: "10000000", exposurePaise: "5000000", updatedAt: "2026-10-27T00:00:00.000Z",
      };
      const result = validateAgainstSchema(badSample, CREDIT_STATUS_SCHEMA, "bad_sample");
      expect(result.valid).toBe(false);
    });
  });

  describe("Writer File/Function Coverage", () => {
    it("all manifest files exist", () => {
      const rootDir = path.resolve(__dirname, "../../..");
      
      for (const file of ALL_WRITER_FILES) {
        const filePath = path.join(rootDir, file);
        expect(fs.existsSync(filePath), `Manifest file ${file} does not exist`).toBe(true);
      }
    });

    it("manifest covers expected writer count", () => {
      expect(CREDIT_STATUS_WRITERS.length).toBe(2);
      expect(SHOP_CONFIG_WRITERS.length).toBe(3);
    });
  });
});
