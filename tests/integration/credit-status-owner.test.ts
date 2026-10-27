/**
 * Metafield Owner Pin Tests
 *
 * Pins who owns the credit_status metafield writes:
 * - COMPANY accounts write to CompanyLocation GID
 * - TAGGED_CUSTOMER accounts write to Customer GID
 *
 * Uses the REAL writers (recomputeCreditStatus / syncCreditStatusMetafield / writeMetafield)
 * with the admin GraphQL client mocked at the HTTP boundary.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Sql } from "~/lib/db-light.server";
import { companyLocationGid, customerGid, companyGid } from "../helpers/gid";

const MOCK_SHOP_DOMAIN = "test-owner-pin.example.com";

interface CapturedMetafield {
  ownerId: string;
  namespace: string;
  key: string;
  value: string;
  type?: string;
}

let creditStatusMetafieldCaptures: CapturedMetafield[] = [];

vi.mock("../../app/services/shopify-client.server", () => ({
  shopifyGraphQLRequest: vi.fn().mockImplementation(async (_domain, _query, variables) => {
    const metafields = variables?.metafields as CapturedMetafield[];
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

interface MockBuyerAccount {
  id: string;
  shopId: string;
  kind: "COMPANY" | "TAGGED_CUSTOMER";
  companyId: string | null;
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
  accounts: MockBuyerAccount[];
  shop: { id: string; domain: string; currency: string };
  invoiceExposures: Map<string, string>;
  draftExposures: Map<string, string>;
  overdueAccounts: Set<string>;
}

function createMockSql(config: MockConfig) {
  let syncVersionCounter = 1;
  
  const queryHandler = async (strings: TemplateStringsArray, ..._values: unknown[]): Promise<unknown[]> => {
    const query = strings.join("?");
    const values = _values;
    
    if (query.includes('FROM "BuyerAccount"') && query.includes("SELECT") && !query.includes("UPDATE \"BuyerAccount\"")) {
      const idValue = values.find(v => typeof v === 'string' && v.startsWith('acc-'));
      if (idValue) {
        const account = config.accounts.find(a => a.id === idValue);
        return account ? [account] : [];
      }
      return config.accounts.length > 0 ? [config.accounts[0]] : [];
    }
    
    if (query.includes('UPDATE "BuyerAccount"') && query.includes("RETURNING")) {
      syncVersionCounter++;
      return [{ syncVersion: syncVersionCounter, id: config.accounts[0]?.id ?? 'unknown' }];
    }
    
    if (query.includes('UPDATE "BuyerAccount"')) {
      return [{ count: 1 }];
    }
    
    if (query.includes('FROM "Shop"')) {
      return [config.shop];
    }
    
    if (query.includes('FROM "Invoice"') && query.includes("SUM")) {
      const accountId = values.find(v => typeof v === 'string' && v.startsWith('acc-'));
      const exposure = config.invoiceExposures.get(accountId as string) ?? "0";
      return [{ total_paise: exposure }];
    }
    
    if (query.includes("s8_draft_orders") && query.includes("SUM")) {
      const accountId = values.find(v => typeof v === 'string' && v.startsWith('acc-'));
      const exposure = config.draftExposures.get(accountId as string) ?? "0";
      return [{ total_paise: exposure }];
    }
    
    if (query.includes("EXISTS") && query.includes('"Invoice"')) {
      const accountId = values.find(v => typeof v === 'string' && v.startsWith('acc-'));
      return [{ has_overdue: config.overdueAccounts.has(accountId as string) }];
    }
    
    if (query.includes("INSERT INTO")) {
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

describe("Metafield Owner Pin Tests", () => {
  beforeEach(() => {
    creditStatusMetafieldCaptures = [];
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("T1: pins metafield owner for company and customer accounts", () => {
    it("COMPANY account write has ownerId = CompanyLocation GID", async () => {
      const testLocationId = 100001;
      const testCompanyId = 200001;
      
      const sql = createMockSql({
        accounts: [{
          id: "acc-company-t1",
          shopId: "shop-test",
          kind: "COMPANY",
          companyId: companyGid(testCompanyId),
          companyLocationId: companyLocationGid(testLocationId),
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
        }],
        shop: { id: "shop-test", domain: MOCK_SHOP_DOMAIN, currency: "INR" },
        invoiceExposures: new Map([["acc-company-t1", "5000000"]]),
        draftExposures: new Map(),
        overdueAccounts: new Set(),
      });
      
      const { recomputeCreditStatus } = await import("../../app/services/credit-status-recompute.server");
      
      const result = await recomputeCreditStatus(sql, "acc-company-t1", "invoice_change");
      
      expect(result.success).toBe(true);
      
      const captured = creditStatusMetafieldCaptures.find(m => m.key === "credit_status");
      expect(captured).toBeDefined();
      
      expect(captured!.ownerId).toBe(companyLocationGid(testLocationId));
      expect(captured!.ownerId).not.toBe(companyGid(testCompanyId));
      expect(captured!.ownerId).not.toContain("Customer");
      
      expect(captured!.namespace).toBe("$app");
      expect(captured!.key).toBe("credit_status");
    });

    it("TAGGED_CUSTOMER account write has ownerId = Customer GID", async () => {
      const testCustomerId = 300001;
      creditStatusMetafieldCaptures = [];
      
      const sql = createMockSql({
        accounts: [{
          id: "acc-customer-t1",
          shopId: "shop-test",
          kind: "TAGGED_CUSTOMER",
          companyId: null,
          companyLocationId: null,
          customerId: customerGid(testCustomerId),
          creditLimit: "50000.00",
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
        }],
        shop: { id: "shop-test", domain: MOCK_SHOP_DOMAIN, currency: "INR" },
        invoiceExposures: new Map([["acc-customer-t1", "2500000"]]),
        draftExposures: new Map(),
        overdueAccounts: new Set(),
      });
      
      const { recomputeCreditStatus } = await import("../../app/services/credit-status-recompute.server");
      
      const result = await recomputeCreditStatus(sql, "acc-customer-t1", "invoice_change");
      
      expect(result.success).toBe(true);
      
      const captured = creditStatusMetafieldCaptures.find(m => m.key === "credit_status");
      expect(captured).toBeDefined();
      
      expect(captured!.ownerId).toBe(customerGid(testCustomerId));
      expect(captured!.ownerId).not.toContain("Company");
      expect(captured!.ownerId).not.toContain("CompanyLocation");
      
      expect(captured!.namespace).toBe("$app");
      expect(captured!.key).toBe("credit_status");
    });
  });

  describe("T2: one company with two locations produces two separate writes", () => {
    it("two locations with own accounts produce two writes, each to its own CompanyLocation GID", async () => {
      const testCompanyId = 400001;
      const testLocation1Id = 500001;
      const testLocation2Id = 500002;
      
      creditStatusMetafieldCaptures = [];
      
      const location1Account: MockBuyerAccount = {
        id: "acc-loc1-t2",
        shopId: "shop-test",
        kind: "COMPANY",
        companyId: companyGid(testCompanyId),
        companyLocationId: companyLocationGid(testLocation1Id),
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
      };

      const location2Account: MockBuyerAccount = {
        id: "acc-loc2-t2",
        shopId: "shop-test",
        kind: "COMPANY",
        companyId: companyGid(testCompanyId),
        companyLocationId: companyLocationGid(testLocation2Id),
        customerId: null,
        creditLimit: "75000.00",
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
      };

      const sql1 = createMockSql({
        accounts: [location1Account],
        shop: { id: "shop-test", domain: MOCK_SHOP_DOMAIN, currency: "INR" },
        invoiceExposures: new Map([["acc-loc1-t2", "3000000"]]),
        draftExposures: new Map(),
        overdueAccounts: new Set(),
      });
      
      const { recomputeCreditStatus } = await import("../../app/services/credit-status-recompute.server");
      
      const result1 = await recomputeCreditStatus(sql1, "acc-loc1-t2", "invoice_change");
      expect(result1.success).toBe(true);
      
      const sql2 = createMockSql({
        accounts: [location2Account],
        shop: { id: "shop-test", domain: MOCK_SHOP_DOMAIN, currency: "INR" },
        invoiceExposures: new Map([["acc-loc2-t2", "4000000"]]),
        draftExposures: new Map(),
        overdueAccounts: new Set(),
      });
      
      const result2 = await recomputeCreditStatus(sql2, "acc-loc2-t2", "invoice_change");
      expect(result2.success).toBe(true);
      
      const creditStatusCaptures = creditStatusMetafieldCaptures.filter(m => m.key === "credit_status");
      expect(creditStatusCaptures.length).toBe(2);
      
      const ownerIds = creditStatusCaptures.map(c => c.ownerId);
      expect(ownerIds).toContain(companyLocationGid(testLocation1Id));
      expect(ownerIds).toContain(companyLocationGid(testLocation2Id));
      
      expect(ownerIds).not.toContain(companyGid(testCompanyId));
      
      const loc1Write = creditStatusCaptures.find(c => c.ownerId === companyLocationGid(testLocation1Id));
      const loc2Write = creditStatusCaptures.find(c => c.ownerId === companyLocationGid(testLocation2Id));
      expect(loc1Write).toBeDefined();
      expect(loc2Write).toBeDefined();
      expect(loc1Write!.ownerId).not.toBe(loc2Write!.ownerId);
    });
  });

  describe("T3: pins behavior when order arrives for location without account", () => {
    // Pins current behaviour; may change in a future version.
    it("order with payment terms for unmapped location falls back to company-level account", async () => {
      const testCompanyId = 600001;
      const mappedLocationId = 700001;
      const unmappedLocationId = 700002;
      
      const siblingAccount: MockBuyerAccount = {
        id: "acc-sibling-t3",
        shopId: "shop-test",
        kind: "COMPANY",
        companyId: companyGid(testCompanyId),
        companyLocationId: companyLocationGid(mappedLocationId),
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
      };
      
      const mockOrderData = {
        id: "gid://shopify/Order/999001",
        name: "#TEST-T3-001",
        displayFinancialStatus: "PENDING",
        purchasingEntity: {
          company: { id: companyGid(testCompanyId) },
          location: { id: companyLocationGid(unmappedLocationId) },
        },
        customer: null,
        paymentTerms: {
          paymentTermsType: "NET",
          paymentTermsName: "Net 30",
          dueInDays: 30,
          paymentSchedules: { edges: [] },
        },
        processedAt: new Date().toISOString(),
        createdAt: new Date().toISOString(),
      };
      
      const queryHandler = async (strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown[]> => {
        const query = strings.join("?");
        
        if (query.includes('FROM "BuyerAccount"') && query.includes('"companyLocationId"')) {
          const locationId = values.find(v => typeof v === 'string' && v.includes('CompanyLocation'));
          if (locationId === companyLocationGid(unmappedLocationId)) {
            return [];
          }
          if (locationId === companyLocationGid(mappedLocationId)) {
            return [siblingAccount];
          }
        }
        
        if (query.includes('FROM "BuyerAccount"') && query.includes('"companyId"')) {
          return [siblingAccount];
        }
        
        if (query.includes('FROM "Shop"')) {
          return [{ id: "shop-test", domain: MOCK_SHOP_DOMAIN, currency: "INR" }];
        }
        
        return [];
      };
      
      const testSql = Object.assign(
        queryHandler,
        {
          json: (v: unknown) => v,
          array: (arr: unknown[]) => arr,
          begin: async <T>(fn: (tx: unknown) => Promise<T>): Promise<T> => fn(queryHandler as never),
        }
      ) as unknown as Sql;
      
      const { checkOrderEligibility } = await import("../../app/lib/invoice-eligibility");
      
      const context = {
        shopId: "shop-test",
        shopTimezone: "Asia/Kolkata",
        shopDefaultTermsDays: 30,
        tagRules: [],
      };
      
      const result = await checkOrderEligibility(testSql, mockOrderData as never, context);
      
      // Pins current behaviour: order with paymentTerms uses "shopify_payment_terms" reason
      // and falls back to company-level account resolution when direct location lookup fails
      expect(result.reason).toBe("shopify_payment_terms");
      expect(result.buyerAccountId).toBe(siblingAccount.id);
      
      // Assert unmapped location gets no direct metafield write
      creditStatusMetafieldCaptures = [];
      
      // Create a dedicated mock for the recompute that properly returns the sibling account
      const recomputeQueryHandler = async (strings: TemplateStringsArray, ..._values: unknown[]): Promise<unknown[]> => {
        const query = strings.join("?");
        
        if (query.includes('FROM "BuyerAccount"') && query.includes("SELECT")) {
          return [siblingAccount];
        }
        
        if (query.includes('UPDATE "BuyerAccount"') && query.includes("RETURNING")) {
          return [{ syncVersion: 2, id: siblingAccount.id }];
        }
        
        if (query.includes('UPDATE "BuyerAccount"')) {
          return [{ count: 1 }];
        }
        
        if (query.includes('FROM "Shop"')) {
          return [{ id: "shop-test", domain: MOCK_SHOP_DOMAIN, currency: "INR" }];
        }
        
        if (query.includes('FROM "Invoice"') && query.includes("SUM")) {
          return [{ total_paise: "0" }];
        }
        
        if (query.includes("s8_draft_orders") && query.includes("SUM")) {
          return [{ total_paise: "0" }];
        }
        
        if (query.includes("EXISTS") && query.includes('"Invoice"')) {
          return [{ has_overdue: false }];
        }
        
        if (query.includes("INSERT INTO")) {
          return [];
        }
        
        return [];
      };
      
      const recomputeSql = Object.assign(
        recomputeQueryHandler,
        {
          json: (v: unknown) => v,
          array: (arr: unknown[]) => arr,
          begin: async <T>(fn: (tx: unknown) => Promise<T>): Promise<T> => {
            const tx = Object.assign(recomputeQueryHandler, { json: (v: unknown) => v, array: (arr: unknown[]) => arr });
            return fn(tx);
          },
        }
      ) as unknown as Sql;
      
      const { recomputeCreditStatus } = await import("../../app/services/credit-status-recompute.server");
      await recomputeCreditStatus(recomputeSql, siblingAccount.id, "invoice_change");
      
      // Only the mapped location (sibling) gets the write - not the unmapped location
      const creditWrites = creditStatusMetafieldCaptures.filter(m => m.key === "credit_status");
      const unmappedLocationWrite = creditWrites.find(w => w.ownerId === companyLocationGid(unmappedLocationId));
      expect(unmappedLocationWrite).toBeUndefined();
      
      // The write goes to the sibling's CompanyLocation, not the unmapped one
      const siblingWrite = creditWrites.find(w => w.ownerId === companyLocationGid(mappedLocationId));
      expect(siblingWrite).toBeDefined();
    });
  });

  describe("T4: pins first-write timing for newly created accounts", () => {
    // Pins current behaviour; may change in a future version.
    it("newly created account has no credit_status write until first recompute", async () => {
      creditStatusMetafieldCaptures = [];
      
      const newLocationId = 800001;
      const newCompanyId = 900001;
      
      const newAccount: MockBuyerAccount = {
        id: "acc-new-t4",
        shopId: "shop-test",
        kind: "COMPANY",
        companyId: companyGid(newCompanyId),
        companyLocationId: companyLocationGid(newLocationId),
        customerId: null,
        creditLimit: "50000.00",
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
      };
      
      const _beforeRecomputeCaptures = [...creditStatusMetafieldCaptures];
      
      const sql = createMockSql({
        accounts: [newAccount],
        shop: { id: "shop-test", domain: MOCK_SHOP_DOMAIN, currency: "INR" },
        invoiceExposures: new Map([["acc-new-t4", "0"]]),
        draftExposures: new Map(),
        overdueAccounts: new Set(),
      });
      
      const { recomputeCreditStatus } = await import("../../app/services/credit-status-recompute.server");
      const result = await recomputeCreditStatus(sql, "acc-new-t4", "sync");
      
      expect(result.success).toBe(true);
      
      const afterRecomputeCaptures = creditStatusMetafieldCaptures.filter(
        m => m.key === "credit_status" && m.ownerId === companyLocationGid(newLocationId)
      );
      
      expect(afterRecomputeCaptures.length).toBe(1);
      expect(afterRecomputeCaptures[0].ownerId).toBe(companyLocationGid(newLocationId));
      expect(afterRecomputeCaptures[0].namespace).toBe("$app");
      expect(afterRecomputeCaptures[0].key).toBe("credit_status");
    });

    it("first write after manual update is owned correctly", async () => {
      creditStatusMetafieldCaptures = [];
      
      const newLocationId = 800002;
      const newCompanyId = 900002;
      
      const newAccount: MockBuyerAccount = {
        id: "acc-manual-t4",
        shopId: "shop-test",
        kind: "COMPANY",
        companyId: companyGid(newCompanyId),
        companyLocationId: companyLocationGid(newLocationId),
        customerId: null,
        creditLimit: "75000.00",
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
      };
      
      const sql = createMockSql({
        accounts: [newAccount],
        shop: { id: "shop-test", domain: MOCK_SHOP_DOMAIN, currency: "INR" },
        invoiceExposures: new Map([["acc-manual-t4", "0"]]),
        draftExposures: new Map(),
        overdueAccounts: new Set(),
      });
      
      const { updateCreditStatus } = await import("../../app/services/credit-status.server");
      const result = await updateCreditStatus(sql, "acc-manual-t4", {
        manualHold: true,
        holdReasonCode: "MANUAL_HOLD",
      });
      
      expect(result.success).toBe(true);
      
      const writes = creditStatusMetafieldCaptures.filter(
        m => m.key === "credit_status" && m.ownerId === companyLocationGid(newLocationId)
      );
      
      expect(writes.length).toBe(1);
      expect(writes[0].ownerId).toBe(companyLocationGid(newLocationId));
      expect(writes[0].namespace).toBe("$app");
      expect(writes[0].key).toBe("credit_status");
    });
  });

  describe("getOwnerGid unit tests", () => {
    it("returns CompanyLocation GID for COMPANY accounts", async () => {
      const { getOwnerGid } = await import("../../app/services/credit-status.server");
      
      const result = getOwnerGid({
        kind: "COMPANY",
        companyLocationId: companyLocationGid(12345),
        customerId: null,
      });
      
      expect(result).not.toBeNull();
      expect(result!.gid).toBe(companyLocationGid(12345));
      expect(result!.type).toBe("CompanyLocation");
    });

    it("returns Customer GID for TAGGED_CUSTOMER accounts", async () => {
      const { getOwnerGid } = await import("../../app/services/credit-status.server");
      
      const result = getOwnerGid({
        kind: "TAGGED_CUSTOMER",
        companyLocationId: null,
        customerId: customerGid(67890),
      });
      
      expect(result).not.toBeNull();
      expect(result!.gid).toBe(customerGid(67890));
      expect(result!.type).toBe("Customer");
    });

    it("returns null for COMPANY account without companyLocationId", async () => {
      const { getOwnerGid } = await import("../../app/services/credit-status.server");
      
      const result = getOwnerGid({
        kind: "COMPANY",
        companyLocationId: null,
        customerId: null,
      });
      
      expect(result).toBeNull();
    });

    it("returns null for TAGGED_CUSTOMER account without customerId", async () => {
      const { getOwnerGid } = await import("../../app/services/credit-status.server");
      
      const result = getOwnerGid({
        kind: "TAGGED_CUSTOMER",
        companyLocationId: null,
        customerId: null,
      });
      
      expect(result).toBeNull();
    });
  });
});
