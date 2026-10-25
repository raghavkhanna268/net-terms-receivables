import { describe, it, expect } from "vitest";
import {
  sanitizeSyncMessage,
  sanitizeBulkMessage,
  isCoveredSyncTopic,
  isCoveredBulkType,
  isShopNotFoundReason,
} from "../dead-letter-sanitize.server";
import type { SyncMessage, BulkMessage } from "~/lib/pgmq.server";

/**
 * Tests for dead-letter message sanitization (#239 part a).
 *
 * Verifies:
 * 1. Allowlist enforcement: only specified fields pass through
 * 2. PII exclusion: shop, shopDomain, payload, customer fields never included
 * 3. shopHash exclusion: unkeyed hash not included (log.server.ts:426-432)
 * 4. Coverage checks: only covered topics/bulk types are sanitized
 * 5. Reason matching: shop_not_found and permanent:shop_not_found
 */

describe("dead-letter-sanitize", () => {
  describe("isCoveredSyncTopic", () => {
    it("returns true for companies topics", () => {
      expect(isCoveredSyncTopic("COMPANIES_CREATE")).toBe(true);
      expect(isCoveredSyncTopic("COMPANIES_UPDATE")).toBe(true);
      expect(isCoveredSyncTopic("COMPANIES_DELETE")).toBe(true);
    });

    it("returns true for company_locations topics", () => {
      expect(isCoveredSyncTopic("COMPANY_LOCATIONS_CREATE")).toBe(true);
      expect(isCoveredSyncTopic("COMPANY_LOCATIONS_UPDATE")).toBe(true);
      expect(isCoveredSyncTopic("COMPANY_LOCATIONS_DELETE")).toBe(true);
    });

    it("returns true for orders topics", () => {
      expect(isCoveredSyncTopic("ORDERS_CREATE")).toBe(true);
      expect(isCoveredSyncTopic("ORDERS_UPDATED")).toBe(true);
      expect(isCoveredSyncTopic("ORDERS_CANCELLED")).toBe(true);
      expect(isCoveredSyncTopic("ORDERS_PAID")).toBe(true);
    });

    it("returns false for draft_orders topics (no reconcile)", () => {
      expect(isCoveredSyncTopic("DRAFT_ORDERS_CREATE")).toBe(false);
      expect(isCoveredSyncTopic("DRAFT_ORDERS_UPDATE")).toBe(false);
      expect(isCoveredSyncTopic("DRAFT_ORDERS_DELETE")).toBe(false);
    });

    it("returns false for customers topics (no reconcile)", () => {
      expect(isCoveredSyncTopic("CUSTOMERS_CREATE")).toBe(false);
      expect(isCoveredSyncTopic("CUSTOMERS_UPDATE")).toBe(false);
      expect(isCoveredSyncTopic("CUSTOMERS_DELETE")).toBe(false);
    });

    it("returns false for reconcile and other topics", () => {
      expect(isCoveredSyncTopic("RECONCILE_COMPANIES")).toBe(false);
      expect(isCoveredSyncTopic("RECONCILE_ORDERS")).toBe(false);
      expect(isCoveredSyncTopic("UNKNOWN_TOPIC")).toBe(false);
    });
  });

  describe("isCoveredBulkType", () => {
    it("returns true for companies and orders", () => {
      expect(isCoveredBulkType("companies")).toBe(true);
      expect(isCoveredBulkType("orders")).toBe(true);
    });

    it("returns false for customers (no reconcile)", () => {
      expect(isCoveredBulkType("customers")).toBe(false);
    });

    it("returns false for unknown types", () => {
      expect(isCoveredBulkType("unknown")).toBe(false);
    });
  });

  describe("isShopNotFoundReason", () => {
    it("returns true for shop_not_found", () => {
      expect(isShopNotFoundReason("shop_not_found")).toBe(true);
    });

    it("returns true for permanent:shop_not_found", () => {
      expect(isShopNotFoundReason("permanent:shop_not_found")).toBe(true);
    });

    it("returns false for other reasons", () => {
      expect(isShopNotFoundReason("no_handler")).toBe(false);
      expect(isShopNotFoundReason("permanent:no_handler")).toBe(false);
      expect(isShopNotFoundReason("graphql_error")).toBe(false);
      expect(isShopNotFoundReason("timeout")).toBe(false);
    });
  });

  describe("sanitizeSyncMessage", () => {
    const baseSyncMessage: SyncMessage = {
      topic: "ORDERS_CREATE",
      shop: "test-shop.myshopify.com",
      webhookId: "wh-123",
      resourceGid: "gid://shopify/Order/456",
      enqueuedAt: "2026-10-25T10:00:00Z",
    };

    it("returns sanitized message for covered topics", () => {
      const result = sanitizeSyncMessage(baseSyncMessage, "msg-001", 3);

      expect(result).not.toBeNull();
      expect(result!.sanitized).toBe(true);
      expect(result!.reason).toBe("shop_not_found");
      expect(result!.topic).toBe("ORDERS_CREATE");
      expect(result!.originalMsgId).toBe("msg-001");
      expect(result!.webhookId).toBe("wh-123");
      expect(result!.resourceGid).toBe("gid://shopify/Order/456");
      expect(result!.attemptCount).toBe(3);
      expect(result!.enqueuedAt).toBe("2026-10-25T10:00:00Z");
      expect(result!.failedAt).toBeDefined();
    });

    it("returns null for uncovered topics (draft orders)", () => {
      const draftOrderMsg: SyncMessage = {
        ...baseSyncMessage,
        topic: "DRAFT_ORDERS_CREATE",
      };
      const result = sanitizeSyncMessage(draftOrderMsg, "msg-002", 3);
      expect(result).toBeNull();
    });

    it("returns null for uncovered topics (customers)", () => {
      const customerMsg: SyncMessage = {
        ...baseSyncMessage,
        topic: "CUSTOMERS_CREATE",
      };
      const result = sanitizeSyncMessage(customerMsg, "msg-003", 3);
      expect(result).toBeNull();
    });

    it("never includes shop or shopDomain in sanitized output", () => {
      const msgWithShop: SyncMessage = {
        ...baseSyncMessage,
        shop: "test-pii-shop.myshopify.com",
      };
      const result = sanitizeSyncMessage(msgWithShop, "msg-004", 1);

      expect(result).not.toBeNull();
      expect(result).not.toHaveProperty("shop");
      expect(result).not.toHaveProperty("shopDomain");
      expect(JSON.stringify(result)).not.toContain("test-pii-shop");
      expect(JSON.stringify(result)).not.toContain("myshopify.com");
    });

    it("never includes shopHash in sanitized output (unkeyed)", () => {
      const result = sanitizeSyncMessage(baseSyncMessage, "msg-005", 1);

      expect(result).not.toBeNull();
      expect(result).not.toHaveProperty("shopHash");
    });

    it("never includes payload or body fields", () => {
      const msgWithPayload: SyncMessage = {
        ...baseSyncMessage,
      };
      // Simulate extra fields that might be on a message (cast to bypass strict typing)
      (msgWithPayload as Record<string, unknown>).payload = { customer: { email: "test@example.com" } };
      (msgWithPayload as Record<string, unknown>).body = "raw body data";

      const result = sanitizeSyncMessage(msgWithPayload, "msg-006", 1);

      expect(result).not.toBeNull();
      expect(result).not.toHaveProperty("payload");
      expect(result).not.toHaveProperty("body");
      expect(JSON.stringify(result)).not.toContain("email");
      expect(JSON.stringify(result)).not.toContain("example.com");
    });

    it("never includes customer fields", () => {
      const msgWithCustomer: SyncMessage = {
        ...baseSyncMessage,
      };
      // Simulate extra fields
      (msgWithCustomer as Record<string, unknown>).customerId = "cust-123";
      (msgWithCustomer as Record<string, unknown>).customerEmail = "customer@test.com";
      (msgWithCustomer as Record<string, unknown>).customerName = "Test Customer";

      const result = sanitizeSyncMessage(msgWithCustomer, "msg-007", 1);

      expect(result).not.toBeNull();
      expect(result).not.toHaveProperty("customerId");
      expect(result).not.toHaveProperty("customerEmail");
      expect(result).not.toHaveProperty("customerName");
      expect(JSON.stringify(result)).not.toContain("customer@test.com");
    });

    it("drops unknown fields from input", () => {
      const msgWithExtras: SyncMessage = {
        ...baseSyncMessage,
      };
      // Simulate extra fields
      (msgWithExtras as Record<string, unknown>).unknownField = "should be dropped";
      (msgWithExtras as Record<string, unknown>).anotherExtra = 12345;

      const result = sanitizeSyncMessage(msgWithExtras, "msg-008", 1);

      expect(result).not.toBeNull();
      expect(result).not.toHaveProperty("unknownField");
      expect(result).not.toHaveProperty("anotherExtra");
    });

    it.each([
      "COMPANIES_CREATE",
      "COMPANIES_UPDATE",
      "COMPANIES_DELETE",
      "COMPANY_LOCATIONS_CREATE",
      "COMPANY_LOCATIONS_UPDATE",
      "COMPANY_LOCATIONS_DELETE",
      "ORDERS_CREATE",
      "ORDERS_UPDATED",
      "ORDERS_CANCELLED",
      "ORDERS_PAID",
    ] as const)("sanitizes %s topic", (topic) => {
      const msg: SyncMessage = { ...baseSyncMessage, topic };
      const result = sanitizeSyncMessage(msg, "msg-topic", 1);
      expect(result).not.toBeNull();
      expect(result!.topic).toBe(topic);
    });
  });

  describe("sanitizeBulkMessage", () => {
    const baseBulkMessage: BulkMessage = {
      topic: "BULK_OPERATIONS_FINISH",
      shop: "test-bulk-shop.myshopify.com",
      webhookId: "bulk-wh-123",
      bulkOperationId: "gid://shopify/BulkOperation/789",
      bulkType: "companies",
      enqueuedAt: "2026-10-25T11:00:00Z",
    };

    it("returns sanitized message for covered bulk types", () => {
      const result = sanitizeBulkMessage(baseBulkMessage, "bulk-msg-001", 2);

      expect(result).not.toBeNull();
      expect(result!.sanitized).toBe(true);
      expect(result!.reason).toBe("shop_not_found");
      expect(result!.topic).toBe("BULK_OPERATIONS_FINISH");
      expect(result!.originalMsgId).toBe("bulk-msg-001");
      expect(result!.webhookId).toBe("bulk-wh-123");
      expect(result!.bulkOperationId).toBe("gid://shopify/BulkOperation/789");
      expect(result!.bulkType).toBe("companies");
      expect(result!.attemptCount).toBe(2);
    });

    it("returns sanitized message for orders bulk type", () => {
      const ordersBulk: BulkMessage = { ...baseBulkMessage, bulkType: "orders" };
      const result = sanitizeBulkMessage(ordersBulk, "bulk-msg-002", 1);
      expect(result).not.toBeNull();
      expect(result!.bulkType).toBe("orders");
    });

    it("returns null for customers bulk type (no reconcile)", () => {
      const customersBulk: BulkMessage = {
        ...baseBulkMessage,
        bulkType: "customers",
      };
      const result = sanitizeBulkMessage(customersBulk, "bulk-msg-003", 1);
      expect(result).toBeNull();
    });

    it("never includes shop in sanitized output", () => {
      const result = sanitizeBulkMessage(baseBulkMessage, "bulk-msg-004", 1);

      expect(result).not.toBeNull();
      expect(result).not.toHaveProperty("shop");
      expect(JSON.stringify(result)).not.toContain("test-bulk-shop");
      expect(JSON.stringify(result)).not.toContain("myshopify.com");
    });

    it("never includes shopHash in sanitized output (unkeyed)", () => {
      const result = sanitizeBulkMessage(baseBulkMessage, "bulk-msg-005", 1);

      expect(result).not.toBeNull();
      expect(result).not.toHaveProperty("shopHash");
    });
  });

  describe("allowlist completeness", () => {
    it("sanitized sync message has exactly the allowed fields", () => {
      const msg: SyncMessage = {
        topic: "ORDERS_CREATE",
        shop: "test.myshopify.com",
        webhookId: "wh-123",
        resourceGid: "gid://shopify/Order/456",
        enqueuedAt: "2026-10-25T10:00:00Z",
      };
      const result = sanitizeSyncMessage(msg, "msg-001", 3);

      expect(result).not.toBeNull();
      const keys = Object.keys(result!).sort();
      expect(keys).toEqual([
        "attemptCount",
        "enqueuedAt",
        "failedAt",
        "originalMsgId",
        "reason",
        "resourceGid",
        "sanitized",
        "topic",
        "webhookId",
      ]);
    });

    it("sanitized bulk message has exactly the allowed fields", () => {
      const msg: BulkMessage = {
        topic: "BULK_OPERATIONS_FINISH",
        shop: "test.myshopify.com",
        webhookId: "wh-123",
        bulkOperationId: "gid://shopify/BulkOperation/789",
        bulkType: "companies",
        enqueuedAt: "2026-10-25T10:00:00Z",
      };
      const result = sanitizeBulkMessage(msg, "msg-001", 2);

      expect(result).not.toBeNull();
      const keys = Object.keys(result!).sort();
      expect(keys).toEqual([
        "attemptCount",
        "bulkOperationId",
        "bulkType",
        "enqueuedAt",
        "failedAt",
        "originalMsgId",
        "reason",
        "sanitized",
        "topic",
        "webhookId",
      ]);
    });
  });
});
