import { describe, it, expect } from "vitest";

/**
 * Tests for webhook-receipts.server.ts
 *
 * These tests focus on the pure functions that don't require database access.
 * Database operations are tested through integration tests.
 */

describe("webhook-receipts.server", () => {
  describe("parseTriggeredAt", () => {
    it("parses valid ISO date from header", async () => {
      const { parseTriggeredAt } = await import("../webhook-receipts.server");
      
      const request = new Request("https://example.com", {
        headers: {
          "X-Shopify-Triggered-At": "2026-10-23T10:30:00Z",
        },
      });
      
      const result = parseTriggeredAt(request);
      
      expect(result).toBeInstanceOf(Date);
      expect(result?.toISOString()).toBe("2026-10-23T10:30:00.000Z");
    });

    it("returns null for missing header", async () => {
      const { parseTriggeredAt } = await import("../webhook-receipts.server");
      
      const request = new Request("https://example.com");
      
      const result = parseTriggeredAt(request);
      
      expect(result).toBeNull();
    });

    it("returns null for invalid date", async () => {
      const { parseTriggeredAt } = await import("../webhook-receipts.server");
      
      const request = new Request("https://example.com", {
        headers: {
          "X-Shopify-Triggered-At": "not-a-date",
        },
      });
      
      const result = parseTriggeredAt(request);
      
      expect(result).toBeNull();
    });
  });
});
