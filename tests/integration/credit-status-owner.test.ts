/**
 * Metafield Owner Pin Tests
 *
 * Pins who owns the credit_status metafield writes:
 * - COMPANY accounts write to CompanyLocation GID
 * - TAGGED_CUSTOMER accounts write to Customer GID
 *
 * Uses the REAL writers (recomputeCreditStatus / syncCreditStatusMetafield / writeMetafield)
 * with the shopify-client.server module mocked.
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

  describe("T3: pins buyer-account resolution for locations without an account", () => {
    // Pins current behaviour; may change in a future version.
    it("order for unmapped location resolves to the single sibling account via company fallback", async () => {
      const testCompanyId = 600001;
      const mappedLocationId = 700001;
      const unmappedLocationId = 700002;
      
      // Exactly one sibling account exists for the company
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
        
        // Direct location lookup returns nothing for the unmapped location
        if (query.includes('FROM "BuyerAccount"') && query.includes('"companyLocationId"')) {
          const locationId = values.find(v => typeof v === 'string' && v.includes('CompanyLocation'));
          if (locationId === companyLocationGid(unmappedLocationId)) {
            return [];
          }
          if (locationId === companyLocationGid(mappedLocationId)) {
            return [siblingAccount];
          }
        }
        
        // Company-level fallback returns the single sibling (deterministic: only one candidate)
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
    });
  });

  describe("T4: pins first-write timing for newly created accounts", () => {
    // Pins current behaviour; may change in a future version.
    it("account sync (creation) produces zero metafield writes; first recompute produces one write with correct owner", async () => {
      creditStatusMetafieldCaptures = [];
      
      const newLocationId = 800001;
      const newCompanyId = 900001;
      const webhookId = `wh-t4-${Date.now()}`;
      
      // Simulate the account that will be created by the sync
      const createdAccount: MockBuyerAccount = {
        id: "acc-new-t4",
        shopId: "shop-test",
        kind: "COMPANY",
        companyId: companyGid(newCompanyId),
        companyLocationId: companyLocationGid(newLocationId),
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
      };
      
      // Mock SQL for the sync path
      let accountCreated = false;
      const syncQueryHandler = async (strings: TemplateStringsArray, ..._values: unknown[]): Promise<unknown[]> => {
        const query = strings.join("?");
        
        // Shop lookup
        if (query.includes('FROM "Shop"') && query.includes("SELECT")) {
          return [{ id: "shop-test", domain: MOCK_SHOP_DOMAIN, currency: "INR" }];
        }
        
        // Webhook processed check
        if (query.includes("webhook_processed") || query.includes("processed_webhooks")) {
          return [];
        }
        
        // BuyerAccount INSERT (the actual creation)
        if (query.includes('INSERT INTO "BuyerAccount"')) {
          accountCreated = true;
          return [{ id: createdAccount.id, upsertAction: "true" }];
        }
        
        // Mark webhook processed
        if (query.includes("INSERT INTO") && (query.includes("webhook") || query.includes("processed"))) {
          return [];
        }
        
        return [];
      };
      
      const syncSql = Object.assign(
        syncQueryHandler,
        {
          json: (v: unknown) => v,
          array: (arr: unknown[]) => arr,
          begin: async <T>(fn: (tx: unknown) => Promise<T>): Promise<T> => {
            const tx = Object.assign(syncQueryHandler, { json: (v: unknown) => v, array: (arr: unknown[]) => arr });
            return fn(tx);
          },
        }
      ) as unknown as Sql;
      
      const mockLocation = {
        id: companyLocationGid(newLocationId),
        name: "Test Location T4",
        company: {
          id: companyGid(newCompanyId),
          name: "Test Company T4",
          mainContact: null,
        },
        billingAddress: { companyName: "Test Company T4" },
        buyerExperienceConfiguration: { paymentTermsTemplate: null },
      };
      
      // Call the real sync path
      const { processCompanyLocationWebhook } = await import("../../app/services/sync/company-location.server");
      
      const syncResult = await processCompanyLocationWebhook(
        syncSql,
        MOCK_SHOP_DOMAIN,
        "COMPANY_LOCATIONS_CREATE",
        mockLocation as never,
        webhookId,
        {}
      );
      
      expect(syncResult.success).toBe(true);
      expect(syncResult.action).toBe("created");
      expect(accountCreated).toBe(true);
      
      // Assert: zero credit_status writes after account creation
      const writesAfterCreation = creditStatusMetafieldCaptures.filter(m => m.key === "credit_status");
      expect(writesAfterCreation.length).toBe(0);
      
      // Now run the first recompute
      const recomputeSql = createMockSql({
        accounts: [createdAccount],
        shop: { id: "shop-test", domain: MOCK_SHOP_DOMAIN, currency: "INR" },
        invoiceExposures: new Map([["acc-new-t4", "0"]]),
        draftExposures: new Map(),
        overdueAccounts: new Set(),
      });
      
      const { recomputeCreditStatus } = await import("../../app/services/credit-status-recompute.server");
      const recomputeResult = await recomputeCreditStatus(recomputeSql, "acc-new-t4", "sync");
      
      expect(recomputeResult.success).toBe(true);
      
      // Assert: exactly one credit_status write after first recompute, with correct owner
      const writesAfterRecompute = creditStatusMetafieldCaptures.filter(
        m => m.key === "credit_status" && m.ownerId === companyLocationGid(newLocationId)
      );
      
      expect(writesAfterRecompute.length).toBe(1);
      expect(writesAfterRecompute[0].ownerId).toBe(companyLocationGid(newLocationId));
      expect(writesAfterRecompute[0].namespace).toBe("$app");
      expect(writesAfterRecompute[0].key).toBe("credit_status");
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
});
