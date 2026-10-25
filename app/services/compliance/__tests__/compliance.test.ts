import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Sql } from "~/lib/db-light.server";

const mockSqlResult = Object.assign([], { count: 0 });

// Create a mockTx that will be used inside sql.begin()
const mockTx = vi.fn().mockResolvedValue(mockSqlResult);

const mockSql = Object.assign(
  vi.fn().mockResolvedValue(mockSqlResult),
  {
    json: vi.fn((v) => JSON.stringify(v)),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    begin: vi.fn(async (callback: (tx: any) => Promise<unknown>) => {
      return callback(mockTx);
    }),
  }
) as unknown as Sql & ReturnType<typeof vi.fn> & { begin: ReturnType<typeof vi.fn> };

vi.mock("~/lib/db-light.server", () => ({
  getRequestSql: vi.fn(() => mockSql),
}));

import {
  deleteShop,
  purgePgmqMessages,
  redactCustomer,
  generateCustomerDataExport,
  persistDataRequest,
  purgeExpiredDataRequests,
  sendDataRequestNotification,
  minimiseInactiveCustomerPii,
  minimiseCustomerPiiIfInactive,
  markShopUninstalled,
  markDataRequestDownloaded,
} from "../compliance.server";

const mockFetch = vi.fn();

const originalFetch = globalThis.fetch;

describe("compliance.server", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.clearAllMocks();
    mockSql.mockResolvedValue(mockSqlResult);
    mockTx.mockResolvedValue(mockSqlResult);
    globalThis.fetch = mockFetch;
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    process.env = originalEnv;
  });

  describe("deleteShop", () => {
    it("deletes shop and all non-FK-linked tables in a transaction", async () => {
      // All queries run inside sql.begin() using mockTx
      // 1. DELETE s10b_order_refetch_null
      mockTx.mockResolvedValueOnce(Object.assign([], { count: 5 }));
      // 2. DELETE s6_bulk_operations
      mockTx.mockResolvedValueOnce(Object.assign([], { count: 2 }));
      // 3. DELETE order_outstanding_missing
      mockTx.mockResolvedValueOnce(Object.assign([], { count: 3 }));
      // 4. DELETE s10b_customer_pii_fallback
      mockTx.mockResolvedValueOnce(Object.assign([], { count: 1 }));
      // 5. DELETE pgmq.q_s6_sync
      mockTx.mockResolvedValueOnce(Object.assign([], { count: 6 }));
      // 6. DELETE pgmq.q_s6_bulk
      mockTx.mockResolvedValueOnce(Object.assign([], { count: 7 }));
      // 7. DELETE pgmq.a_s6_sync
      mockTx.mockResolvedValueOnce(Object.assign([], { count: 8 }));
      // 8. DELETE pgmq.a_s6_bulk
      mockTx.mockResolvedValueOnce(Object.assign([], { count: 9 }));
      // 9. DELETE s6_dead_letter
      mockTx.mockResolvedValueOnce(Object.assign([], { count: 4 }));
      // 10. DELETE Shop
      mockTx.mockResolvedValueOnce([{ id: "shop-123" }]);

      const result = await deleteShop(mockSql, "test-shop.myshopify.com");

      expect(result).toEqual({
        deleted: true,
        shopId: "shop-123",
        refetchNullPurged: 5,
        bulkOperationsPurged: 2,
        orderGapPurged: 3,
        piiFallbackPurged: 1,
        pgmqSyncQueuePurged: 6,
        pgmqBulkQueuePurged: 7,
        pgmqSyncArchivePurged: 8,
        pgmqBulkArchivePurged: 9,
        deadLetterPurged: 4,
      });
      expect(mockSql.begin).toHaveBeenCalledTimes(1);
    });

    it("returns deleted=false when shop not found", async () => {
      // All queries run inside sql.begin() using mockTx
      // 1. DELETE s10b_order_refetch_null (may have rows even if shop doesn't exist)
      mockTx.mockResolvedValueOnce(Object.assign([], { count: 0 }));
      // 2. DELETE s6_bulk_operations
      mockTx.mockResolvedValueOnce(Object.assign([], { count: 0 }));
      // 3. DELETE order_outstanding_missing
      mockTx.mockResolvedValueOnce(Object.assign([], { count: 0 }));
      // 4. DELETE s10b_customer_pii_fallback
      mockTx.mockResolvedValueOnce(Object.assign([], { count: 0 }));
      // 5. DELETE pgmq.q_s6_sync
      mockTx.mockResolvedValueOnce(Object.assign([], { count: 0 }));
      // 6. DELETE pgmq.q_s6_bulk
      mockTx.mockResolvedValueOnce(Object.assign([], { count: 0 }));
      // 7. DELETE pgmq.a_s6_sync
      mockTx.mockResolvedValueOnce(Object.assign([], { count: 0 }));
      // 8. DELETE pgmq.a_s6_bulk
      mockTx.mockResolvedValueOnce(Object.assign([], { count: 0 }));
      // 9. DELETE s6_dead_letter
      mockTx.mockResolvedValueOnce(Object.assign([], { count: 0 }));
      // 10. DELETE Shop (no rows)
      mockTx.mockResolvedValueOnce([]);

      const result = await deleteShop(mockSql, "nonexistent.myshopify.com");

      expect(result).toEqual({
        deleted: false,
        shopId: null,
        refetchNullPurged: 0,
        bulkOperationsPurged: 0,
        orderGapPurged: 0,
        piiFallbackPurged: 0,
        pgmqSyncQueuePurged: 0,
        pgmqBulkQueuePurged: 0,
        pgmqSyncArchivePurged: 0,
        pgmqBulkArchivePurged: 0,
        deadLetterPurged: 0,
      });
    });
  });

  describe("purgePgmqMessages", () => {
    it("returns that deleteShop now handles pgmq deletion", async () => {
      const result = await purgePgmqMessages(mockSql, "test-shop.myshopify.com");

      expect(result.purged).toBe(false);
      expect(result.reason).toContain("deleteShop() now removes the shop's queue and archive messages");
    });
  });

  describe("redactCustomer", () => {
    it("deletes s8_tagged_customers, s8_draft_orders, s22_data_requests, and PayerAlias", async () => {
      // Transaction operations use mockTx
      // 1. DELETE s8_tagged_customers
      mockTx.mockResolvedValueOnce(Object.assign([], { count: 1 }));
      // 2. DELETE s8_draft_orders
      mockTx.mockResolvedValueOnce(Object.assign([], { count: 2 }));
      // 3. DELETE s22_data_requests
      mockTx.mockResolvedValueOnce(Object.assign([], { count: 1 }));
      // 4. SELECT buyerAccount
      mockTx.mockResolvedValueOnce([{ id: "ba-1" }]);
      // 5. UPDATE Payment (via Match→Invoice→BuyerAccount) - now before alias delete
      mockTx.mockResolvedValueOnce(Object.assign([], { count: 3 }));
      // 6. DELETE PayerAlias
      mockTx.mockResolvedValueOnce(Object.assign([], { count: 2 }));
      // 7. UPDATE BuyerAccount
      mockTx.mockResolvedValueOnce(Object.assign([], { count: 1 }));

      const result = await redactCustomer(
        mockSql,
        "shop-123",
        "gid://shopify/Customer/456"
      );

      expect(result.taggedCustomersDeleted).toBe(1);
      expect(result.draftOrdersDeleted).toBe(2);
      expect(result.dataRequestsDeleted).toBe(1);
      expect(result.payerAliasesDeleted).toBe(2);
      expect(result.buyerAccountAnonymized).toBe(true);
      expect(result.paymentsRedacted).toBe(3);
    });

    it("redacts payments and deletes PayerAlias via Match→Invoice→BuyerAccount", async () => {
      // Transaction operations use mockTx
      // 1. DELETE s8_tagged_customers
      mockTx.mockResolvedValueOnce(Object.assign([], { count: 1 }));
      // 2. DELETE s8_draft_orders
      mockTx.mockResolvedValueOnce(Object.assign([], { count: 0 }));
      // 3. DELETE s22_data_requests
      mockTx.mockResolvedValueOnce(Object.assign([], { count: 0 }));
      // 4. SELECT buyerAccount
      mockTx.mockResolvedValueOnce([{ id: "ba-1" }]);
      // 5. UPDATE Payment (via Match→Invoice→BuyerAccount) - now before alias delete
      mockTx.mockResolvedValueOnce(Object.assign([], { count: 2 }));
      // 6. DELETE PayerAlias
      mockTx.mockResolvedValueOnce(Object.assign([], { count: 3 }));
      // 7. UPDATE BuyerAccount
      mockTx.mockResolvedValueOnce(Object.assign([], { count: 1 }));

      const result = await redactCustomer(
        mockSql,
        "shop-123",
        "gid://shopify/Customer/789"
      );

      expect(result.payerAliasesDeleted).toBe(3);
      expect(result.buyerAccountAnonymized).toBe(true);
      expect(result.paymentsRedacted).toBe(2);
    });

    it("handles customer with no data gracefully", async () => {
      // Transaction operations use mockTx
      // 1. DELETE s8_tagged_customers
      mockTx.mockResolvedValueOnce(Object.assign([], { count: 0 }));
      // 2. DELETE s8_draft_orders
      mockTx.mockResolvedValueOnce(Object.assign([], { count: 0 }));
      // 3. DELETE s22_data_requests
      mockTx.mockResolvedValueOnce(Object.assign([], { count: 0 }));
      // 4. SELECT buyerAccount (not found)
      mockTx.mockResolvedValueOnce([]);

      const result = await redactCustomer(
        mockSql,
        "shop-123",
        "gid://shopify/Customer/unknown"
      );

      expect(result.taggedCustomersDeleted).toBe(0);
      expect(result.draftOrdersDeleted).toBe(0);
      expect(result.dataRequestsDeleted).toBe(0);
      expect(result.payerAliasesDeleted).toBe(0);
      expect(result.buyerAccountAnonymized).toBe(false);
      expect(result.paymentsRedacted).toBe(0);
    });

    it("deletes data requests for the customer", async () => {
      // Transaction operations use mockTx
      // 1. DELETE s8_tagged_customers
      mockTx.mockResolvedValueOnce(Object.assign([], { count: 0 }));
      // 2. DELETE s8_draft_orders
      mockTx.mockResolvedValueOnce(Object.assign([], { count: 0 }));
      // 3. DELETE s22_data_requests - 3 requests exist
      mockTx.mockResolvedValueOnce(Object.assign([], { count: 3 }));
      // 4. SELECT buyerAccount (not found)
      mockTx.mockResolvedValueOnce([]);

      const result = await redactCustomer(
        mockSql,
        "shop-123",
        "gid://shopify/Customer/456"
      );

      expect(result.dataRequestsDeleted).toBe(3);
      expect(result.payerAliasesDeleted).toBe(0);
    });

    it("runs all operations in a single transaction", async () => {
      // Setup: customer has data to redact
      mockTx.mockResolvedValueOnce(Object.assign([], { count: 1 })); // tagged_customers
      mockTx.mockResolvedValueOnce(Object.assign([], { count: 1 })); // draft_orders
      mockTx.mockResolvedValueOnce(Object.assign([], { count: 1 })); // data_requests
      mockTx.mockResolvedValueOnce([{ id: "ba-1" }]); // buyerAccount
      mockTx.mockResolvedValueOnce(Object.assign([], { count: 1 })); // payments
      mockTx.mockResolvedValueOnce(Object.assign([], { count: 1 })); // aliases
      mockTx.mockResolvedValueOnce(Object.assign([], { count: 1 })); // buyerAccount update

      await redactCustomer(mockSql, "shop-123", "gid://shopify/Customer/456");

      // Verify sql.begin was called (ensures transaction wrapper)
      expect(mockSql.begin).toHaveBeenCalledTimes(1);
    });
  });

  describe("generateCustomerDataExport", () => {
    it("generates export for known customer with data including payment matches", async () => {
      // 1. SELECT s8_tagged_customers
      mockSql.mockResolvedValueOnce([{
        tags: ["net-terms"],
        tag_active: true,
        email: "test@example.com",
        display_name: "Test Customer",
        created_at: new Date("2026-01-01"),
      }]);
      // 2. SELECT s8_draft_orders
      mockSql.mockResolvedValueOnce([{
        id: "do-1",
        name: "#D1",
        total: "100.00",
        status: "open",
        created_at: new Date("2026-01-15"),
      }]);
      // 3. SELECT BuyerAccount
      mockSql.mockResolvedValueOnce([{
        id: "ba-1",
        name: "Test Customer",
        kind: "TAGGED_CUSTOMER",
        creditLimit: "1000.00",
        defaultTermsDays: 30,
        holdState: "OK",
      }]);
      // 4. SELECT Invoice
      mockSql.mockResolvedValueOnce([{
        id: "inv-1",
        name: "#1001",
        total: "500.00",
        outstanding: "250.00",
        status: "open",
        issuedAt: new Date("2026-01-10"),
        dueAt: new Date("2026-02-10"),
      }]);
      // 5. SELECT Match (payment matches)
      mockSql.mockResolvedValueOnce([{
        id: "match-1",
        invoiceId: "inv-1",
        amount: "250.00",
        state: "confirmed",
        confirmedAt: new Date("2026-01-20"),
        createdAt: new Date("2026-01-18"),
      }]);

      const result = await generateCustomerDataExport(
        mockSql,
        "shop-123",
        "gid://shopify/Customer/456",
        "req-789"
      );

      expect(result.customerGid).toBe("gid://shopify/Customer/456");
      expect(result.requestId).toBe("req-789");
      expect(result.data.taggedCustomer).toBeTruthy();
      expect(result.data.taggedCustomer?.tagActive).toBe(true);
      expect(result.data.draftOrders).toHaveLength(1);
      expect(result.data.buyerAccount).toBeTruthy();
      expect(result.data.invoices).toHaveLength(1);
      expect(result.data.paymentMatches).toHaveLength(1);
      expect(result.data.paymentMatches[0]).toEqual({
        id: "match-1",
        invoiceId: "inv-1",
        amount: "250.00",
        state: "confirmed",
        confirmedAt: "2026-01-20T00:00:00.000Z",
        createdAt: "2026-01-18T00:00:00.000Z",
      });
    });

    it("generates empty export for unknown customer", async () => {
      // 1. SELECT s8_tagged_customers (not found)
      mockSql.mockResolvedValueOnce([]);
      // 2. SELECT s8_draft_orders (no buyer account, so empty)
      mockSql.mockResolvedValueOnce([]);
      // 3. SELECT BuyerAccount (not found)
      mockSql.mockResolvedValueOnce([]);
      // Note: Invoice and Match queries are skipped when no buyerAccount

      const result = await generateCustomerDataExport(
        mockSql,
        "shop-123",
        "gid://shopify/Customer/unknown",
        "req-empty"
      );

      expect(result.customerGid).toBe("gid://shopify/Customer/unknown");
      expect(result.requestId).toBe("req-empty");
      expect(result.data.taggedCustomer).toBeNull();
      expect(result.data.draftOrders).toHaveLength(0);
      expect(result.data.buyerAccount).toBeNull();
      expect(result.data.invoices).toHaveLength(0);
      expect(result.data.paymentMatches).toHaveLength(0);
    });

    it("drops phone and address from DB row even if present (PCD Level 1 compliance)", async () => {
      // Feed mock data that DOES include phone and address fields.
      // The export mapping must drop them because they're not in the interface.
      // Per Shopify Protected Customer Data docs, we only export Level 1 data.
      //
      // See: https://shopify.dev/docs/apps/launch/protected-customer-data

      // 1. SELECT s8_tagged_customers - include phone/address in mock row
      mockSql.mockResolvedValueOnce([{
        tags: ["wholesale"],
        tag_active: true,
        email: "customer@example.com",
        display_name: "Wholesale Customer",
        created_at: new Date("2026-01-01"),
        // These fields are NOT in the schema but we simulate them being returned
        // to prove the export mapping drops them
        phone: "+1-555-123-4567",
        address: "123 Main St, City, ST 12345",
      }]);
      // 2. SELECT s8_draft_orders
      mockSql.mockResolvedValueOnce([]);
      // 3. SELECT BuyerAccount - include address fields in mock
      mockSql.mockResolvedValueOnce([{
        id: "ba-1",
        name: "Wholesale Customer",
        kind: "TAGGED_CUSTOMER",
        creditLimit: null,
        defaultTermsDays: 30,
        holdState: "OK",
        // Simulate extra fields that might leak through
        billingAddress: "456 Billing Ave",
        shippingAddress: "789 Shipping Rd",
      }]);
      // 4. SELECT Invoice
      mockSql.mockResolvedValueOnce([]);
      // 5. SELECT Match
      mockSql.mockResolvedValueOnce([]);

      const result = await generateCustomerDataExport(
        mockSql,
        "shop-123",
        "gid://shopify/Customer/789",
        "req-pii-check"
      );

      // Verify the export structure excludes phone/address
      const exportJson = JSON.stringify(result);
      expect(exportJson).not.toContain("phone");
      expect(exportJson).not.toContain("Phone");
      expect(exportJson).not.toContain("+1-555");
      expect(exportJson).not.toContain("address");
      expect(exportJson).not.toContain("Address");
      expect(exportJson).not.toContain("123 Main St");
      expect(exportJson).not.toContain("billingAddress");
      expect(exportJson).not.toContain("shippingAddress");

      // Verify the export mapping explicitly picks only allowed fields
      expect(result.data.taggedCustomer).toEqual({
        tags: ["wholesale"],
        tagActive: true,
        email: "customer@example.com",
        displayName: "Wholesale Customer",
        createdAt: "2026-01-01T00:00:00.000Z",
      });
      expect(result.data.buyerAccount).toEqual({
        id: "ba-1",
        name: "Wholesale Customer",
        kind: "TAGGED_CUSTOMER",
        creditLimit: null,
        defaultTermsDays: 30,
        holdState: "OK",
      });
    });

    it("drops payerText and narration from Match rows even if present", async () => {
      // Feed mock data that DOES include payerText/narration in Match rows.
      // The export mapping must drop them because they contain bank statement PII.

      // 1. SELECT s8_tagged_customers
      mockSql.mockResolvedValueOnce([{
        tags: ["net-terms"],
        tag_active: true,
        email: null,
        display_name: null,
        created_at: new Date("2026-01-01"),
      }]);
      // 2. SELECT s8_draft_orders
      mockSql.mockResolvedValueOnce([]);
      // 3. SELECT BuyerAccount
      mockSql.mockResolvedValueOnce([{
        id: "ba-1",
        name: "Account Name",
        kind: "TAGGED_CUSTOMER",
        creditLimit: null,
        defaultTermsDays: 30,
        holdState: "OK",
      }]);
      // 4. SELECT Invoice
      mockSql.mockResolvedValueOnce([{
        id: "inv-1",
        name: "#1001",
        total: "1000.00",
        outstanding: "0.00",
        status: "paid",
        issuedAt: new Date("2026-01-10"),
        dueAt: new Date("2026-02-10"),
      }]);
      // 5. SELECT Match - include payerText/narration in mock to prove they're dropped
      mockSql.mockResolvedValueOnce([{
        id: "match-1",
        invoiceId: "inv-1",
        amount: "1000.00",
        state: "confirmed",
        confirmedAt: new Date("2026-01-15"),
        createdAt: new Date("2026-01-14"),
        // Simulate these fields being returned even though the SELECT doesn't request them
        payerText: "ACME CORP PAYMENT",
        narration: "NEFT-UTR123456789-ACME CORP-INV1001 PAYMENT",
      }]);

      const result = await generateCustomerDataExport(
        mockSql,
        "shop-123",
        "gid://shopify/Customer/456",
        "req-payment-pii"
      );

      const exportJson = JSON.stringify(result);

      // Payment PII fields must NOT be present in export
      expect(exportJson).not.toContain("payerText");
      expect(exportJson).not.toContain("narration");
      expect(exportJson).not.toContain("ACME CORP");
      expect(exportJson).not.toContain("UTR123456789");

      // Verify the export mapping explicitly picks only allowed fields
      expect(result.data.paymentMatches).toHaveLength(1);
      expect(result.data.paymentMatches[0]).toEqual({
        id: "match-1",
        invoiceId: "inv-1",
        amount: "1000.00",
        state: "confirmed",
        confirmedAt: "2026-01-15T00:00:00.000Z",
        createdAt: "2026-01-14T00:00:00.000Z",
      });
    });

    it("Match query SQL does not select payerText or narration", async () => {
      // Verify the SQL query itself doesn't request PII columns.
      // This is a belt-and-suspenders check on top of the mapping test.

      // Setup: provide minimal mocks to get to the Match query
      mockSql.mockResolvedValueOnce([{
        tags: [],
        tag_active: true,
        email: null,
        display_name: null,
        created_at: new Date(),
      }]);
      mockSql.mockResolvedValueOnce([]);
      mockSql.mockResolvedValueOnce([{
        id: "ba-1",
        name: "Test",
        kind: "TAGGED_CUSTOMER",
        creditLimit: null,
        defaultTermsDays: 30,
        holdState: "OK",
      }]);
      mockSql.mockResolvedValueOnce([]);
      mockSql.mockResolvedValueOnce([]);

      await generateCustomerDataExport(
        mockSql,
        "shop-123",
        "gid://shopify/Customer/456",
        "req-sql-check"
      );

      // The 5th call is the Match query
      expect(mockSql).toHaveBeenCalledTimes(5);
      const matchQueryCall = mockSql.mock.calls[4];
      
      // The template literal is passed as an array of strings
      // Convert to string to check what columns are selected
      const queryTemplateStrings = matchQueryCall[0] as string[];
      const queryText = queryTemplateStrings.join(" ");

      // Verify payerText and narration are NOT in the SELECT clause
      expect(queryText).not.toContain("payerText");
      expect(queryText).not.toContain("narration");
      expect(queryText).not.toContain('"Payment"');

      // Verify the query DOES select expected fields
      expect(queryText).toContain("m.id");
      expect(queryText).toContain('m."invoiceId"');
      expect(queryText).toContain("m.amount");
      expect(queryText).toContain("m.state");
    });
  });

  describe("persistDataRequest", () => {
    it("creates new data request record", async () => {
      mockSql.mockResolvedValueOnce([]);
      mockSql.mockResolvedValueOnce([{ id: "dr-123" }]);

      const exportData = {
        customerGid: "gid://shopify/Customer/456",
        requestId: "req-789",
        requestedAt: new Date().toISOString(),
        data: { taggedCustomer: null, draftOrders: [], buyerAccount: null, invoices: [], paymentMatches: [] },
      };

      const result = await persistDataRequest(
        mockSql,
        "shop-123",
        "gid://shopify/Customer/456",
        "req-789",
        exportData
      );

      expect(result.id).toBe("dr-123");
      expect(result.alreadyExists).toBe(false);
    });

    it("returns existing record on duplicate request_id", async () => {
      mockSql.mockResolvedValueOnce([{ id: "dr-existing" }]);

      const exportData = {
        customerGid: "gid://shopify/Customer/456",
        requestId: "req-duplicate",
        requestedAt: new Date().toISOString(),
        data: { taggedCustomer: null, draftOrders: [], buyerAccount: null, invoices: [], paymentMatches: [] },
      };

      const result = await persistDataRequest(
        mockSql,
        "shop-123",
        "gid://shopify/Customer/456",
        "req-duplicate",
        exportData
      );

      expect(result.id).toBe("dr-existing");
      expect(result.alreadyExists).toBe(true);
    });
  });

  describe("purgeExpiredDataRequests", () => {
    it("deletes expired data requests for a shop", async () => {
      mockSql.mockResolvedValueOnce(Object.assign([], { count: 5 }));

      const result = await purgeExpiredDataRequests(mockSql, "shop-123");

      expect(result).toBe(5);
      expect(mockSql).toHaveBeenCalled();
    });

    it("returns 0 when no expired requests", async () => {
      mockSql.mockResolvedValueOnce(Object.assign([], { count: 0 }));

      const result = await purgeExpiredDataRequests(mockSql, "shop-123");

      expect(result).toBe(0);
    });
  });

  describe("minimiseInactiveCustomerPii", () => {
    it("nulls PII for inactive customers with no open invoices", async () => {
      mockSql.mockResolvedValueOnce(Object.assign([], { count: 3 }));

      const result = await minimiseInactiveCustomerPii(mockSql, "shop-123");

      expect(result).toBe(3);
    });

    it("returns 0 when no customers to minimise", async () => {
      mockSql.mockResolvedValueOnce(Object.assign([], { count: 0 }));

      const result = await minimiseInactiveCustomerPii(mockSql, "shop-123");

      expect(result).toBe(0);
    });
  });

  describe("minimiseCustomerPiiIfInactive", () => {
    it("nulls PII for specific inactive customer with no open invoices", async () => {
      mockSql.mockResolvedValueOnce(Object.assign([], { count: 1 }));

      const result = await minimiseCustomerPiiIfInactive(
        mockSql,
        "shop-123",
        "gid://shopify/Customer/456"
      );

      expect(result).toBe(true);
    });

    it("returns false when customer has open invoices", async () => {
      mockSql.mockResolvedValueOnce(Object.assign([], { count: 0 }));

      const result = await minimiseCustomerPiiIfInactive(
        mockSql,
        "shop-123",
        "gid://shopify/Customer/456"
      );

      expect(result).toBe(false);
    });
  });

  describe("markShopUninstalled", () => {
    it("marks shop as uninstalled and returns true", async () => {
      mockSql.mockResolvedValueOnce(Object.assign([], { count: 1 }));

      const result = await markShopUninstalled(mockSql, "test-shop.myshopify.com");

      expect(result).toBe(true);
    });

    it("returns false when shop not found", async () => {
      mockSql.mockResolvedValueOnce(Object.assign([], { count: 0 }));

      const result = await markShopUninstalled(mockSql, "test-unknown-shop.myshopify.com");

      expect(result).toBe(false);
    });
  });

  describe("sendDataRequestNotification", () => {
    it("skips email when RESEND_API_KEY is not set and logs correctly", async () => {
      delete process.env.RESEND_API_KEY;
      const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

      const result = await sendDataRequestNotification(
        "test-shop.myshopify.com",
        "owner@shop.com",
        "req-123"
      );

      expect(result.sent).toBe(false);
      expect(result.skippedReason).toBe("no_api_key");
      expect(consoleSpy).toHaveBeenCalled();
      const logCalls = consoleSpy.mock.calls.map((c) => c[0]);
      const skipLog = logCalls.find((c: string) =>
        typeof c === "string" && c.includes('"event":"data_request_email_skipped"')
      );
      expect(skipLog).toBeDefined();
      // Must NOT contain shop domain (redaction rule)
      expect(skipLog).not.toContain("myshopify.com");
      // Must contain shopHash and requestId
      expect(skipLog).toContain('"shopHash"');
      expect(skipLog).toContain('"requestId":"req-123"');
      expect(mockFetch).not.toHaveBeenCalled();
      consoleSpy.mockRestore();
    });

    it("skips email when RESEND_FROM is not set", async () => {
      process.env.RESEND_API_KEY = "re_test_key";
      delete process.env.RESEND_FROM;
      const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

      const result = await sendDataRequestNotification(
        "test-shop.myshopify.com",
        "owner@shop.com",
        "req-123"
      );

      expect(result.sent).toBe(false);
      expect(result.skippedReason).toBe("no_sender");
      expect(mockFetch).not.toHaveBeenCalled();
      consoleSpy.mockRestore();
    });

    it("sends email with NO customer PII in request body", async () => {
      process.env.RESEND_API_KEY = "re_test_key";
      process.env.RESEND_FROM = "noreply@example.com";

      // Mock Resend API call
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ id: "email-123" }),
      });

      const result = await sendDataRequestNotification(
        "test-shop.myshopify.com",
        "owner@shop.com",
        "req-123"
      );

      expect(result.sent).toBe(true);
      expect(mockFetch).toHaveBeenCalledTimes(1);

      // Verify the Resend API call
      const resendCall = mockFetch.mock.calls[0];
      expect(resendCall[0]).toBe("https://api.resend.com/emails");

      const requestBody = JSON.parse(resendCall[1].body);

      // Verify NO customer PII in the email
      expect(requestBody.html).not.toContain("gid://shopify/Customer");
      expect(requestBody.html).not.toContain("customer@");
      expect(requestBody.html).not.toContain("displayName");
      expect(requestBody.html).not.toContain("tags");
      expect(requestBody.text).not.toContain("gid://shopify/Customer");
      expect(requestBody.text).not.toContain("customer@");

      // Verify the download link IS present
      expect(requestBody.html).toContain("admin.shopify.com/store/test-shop/apps");
      expect(requestBody.html).toContain("data-requests");
      expect(requestBody.text).toContain("admin.shopify.com/store/test-shop/apps");
    });

    it("returns error when Resend API fails but does not throw", async () => {
      process.env.RESEND_API_KEY = "re_test_key";
      process.env.RESEND_FROM = "noreply@example.com";
      const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

      // Mock Resend API failure
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: async () => "Internal Server Error",
      });

      const result = await sendDataRequestNotification(
        "test-shop.myshopify.com",
        "owner@shop.com",
        "req-123"
      );

      expect(result.sent).toBe(false);
      expect(result.error).toBe("resend_api_error_500");
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining("data_request_email_failed")
      );
      consoleSpy.mockRestore();
    });

    it("handles fetch network errors gracefully", async () => {
      process.env.RESEND_API_KEY = "re_test_key";
      process.env.RESEND_FROM = "noreply@example.com";
      const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

      // Mock network error
      mockFetch.mockRejectedValueOnce(new Error("Network error"));

      const result = await sendDataRequestNotification(
        "test-shop.myshopify.com",
        "owner@shop.com",
        "req-123"
      );

      expect(result.sent).toBe(false);
      // Error code is returned, not raw message (per security rule)
      expect(result.error).toBe("error");
      consoleSpy.mockRestore();
    });
  });

  describe("markDataRequestDownloaded", () => {
    it("updates the status to downloaded", async () => {
      mockSql.mockResolvedValueOnce(Object.assign([], { count: 1 }));

      await markDataRequestDownloaded(mockSql, "shop-123", "req-456");

      expect(mockSql).toHaveBeenCalled();
    });
  });
});
