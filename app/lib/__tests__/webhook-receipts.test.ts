import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * Tests for webhook-receipts.server.ts
 *
 * These tests focus on the pure functions that don't require database access.
 * Database operations are tested through integration tests.
 */

describe("webhook-receipts.server", () => {
  describe("parseTriggeredAt", () => {
    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-10-26T12:00:00Z"));
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("parses valid ISO date with Z timezone", async () => {
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

    it("parses valid ISO date with +offset timezone", async () => {
      const { parseTriggeredAt } = await import("../webhook-receipts.server");

      const request = new Request("https://example.com", {
        headers: {
          "X-Shopify-Triggered-At": "2026-10-23T16:00:00+05:30",
        },
      });

      const result = parseTriggeredAt(request);

      expect(result).toBeInstanceOf(Date);
      expect(result?.toISOString()).toBe("2026-10-23T10:30:00.000Z");
    });

    it("parses valid ISO date with -offset timezone", async () => {
      const { parseTriggeredAt } = await import("../webhook-receipts.server");

      const request = new Request("https://example.com", {
        headers: {
          "X-Shopify-Triggered-At": "2026-10-23T05:30:00-05:00",
        },
      });

      const result = parseTriggeredAt(request);

      expect(result).toBeInstanceOf(Date);
      expect(result?.toISOString()).toBe("2026-10-23T10:30:00.000Z");
    });

    it("parses valid ISO date with milliseconds", async () => {
      const { parseTriggeredAt } = await import("../webhook-receipts.server");

      const request = new Request("https://example.com", {
        headers: {
          "X-Shopify-Triggered-At": "2026-10-23T10:30:00.123Z",
        },
      });

      const result = parseTriggeredAt(request);

      expect(result).toBeInstanceOf(Date);
      expect(result?.toISOString()).toBe("2026-10-23T10:30:00.123Z");
    });

    it("returns null for missing header", async () => {
      const { parseTriggeredAt } = await import("../webhook-receipts.server");

      const request = new Request("https://example.com");

      const result = parseTriggeredAt(request);

      expect(result).toBeNull();
    });

    it("returns null for invalid date string", async () => {
      const { parseTriggeredAt } = await import("../webhook-receipts.server");

      const request = new Request("https://example.com", {
        headers: {
          "X-Shopify-Triggered-At": "not-a-date",
        },
      });

      const result = parseTriggeredAt(request);

      expect(result).toBeNull();
    });

    // REVERT NOTE: This test FAILS if strict ISO-8601 validation is reverted.
    it("returns null for lenient value '1' (deletes shop)", async () => {
      const { parseTriggeredAt } = await import("../webhook-receipts.server");

      const request = new Request("https://example.com", {
        headers: {
          "X-Shopify-Triggered-At": "1",
        },
      });

      const result = parseTriggeredAt(request);

      expect(result).toBeNull();
    });

    // REVERT NOTE: This test FAILS if strict ISO-8601 validation is reverted.
    it("returns null for ISO date without timezone (deletes shop)", async () => {
      const { parseTriggeredAt } = await import("../webhook-receipts.server");

      const request = new Request("https://example.com", {
        headers: {
          "X-Shopify-Triggered-At": "2026-10-23T10:30:00",
        },
      });

      const result = parseTriggeredAt(request);

      expect(result).toBeNull();
    });

    // REVERT NOTE: This test FAILS if strict ISO-8601 validation is reverted.
    it("returns null for lenient date format like 'Oct 25 2026' (deletes shop)", async () => {
      const { parseTriggeredAt } = await import("../webhook-receipts.server");

      const request = new Request("https://example.com", {
        headers: {
          "X-Shopify-Triggered-At": "Oct 25 2026",
        },
      });

      const result = parseTriggeredAt(request);

      expect(result).toBeNull();
    });

    // REVERT NOTE: This test FAILS if future-date rejection is reverted.
    it("returns null for date more than 5 minutes in the future (deletes shop)", async () => {
      const { parseTriggeredAt } = await import("../webhook-receipts.server");

      const request = new Request("https://example.com", {
        headers: {
          "X-Shopify-Triggered-At": "2026-10-26T12:10:00Z",
        },
      });

      const result = parseTriggeredAt(request);

      expect(result).toBeNull();
    });

    it("accepts date up to 5 minutes in the future", async () => {
      const { parseTriggeredAt } = await import("../webhook-receipts.server");

      const request = new Request("https://example.com", {
        headers: {
          "X-Shopify-Triggered-At": "2026-10-26T12:04:00Z",
        },
      });

      const result = parseTriggeredAt(request);

      expect(result).toBeInstanceOf(Date);
    });

    // REVERT NOTE: This test FAILS if ancient-date rejection is reverted.
    it("returns null for date older than 30 days (deletes shop)", async () => {
      const { parseTriggeredAt } = await import("../webhook-receipts.server");

      const request = new Request("https://example.com", {
        headers: {
          "X-Shopify-Triggered-At": "2026-09-20T12:00:00Z",
        },
      });

      const result = parseTriggeredAt(request);

      expect(result).toBeNull();
    });

    it("accepts date up to 30 days old", async () => {
      const { parseTriggeredAt } = await import("../webhook-receipts.server");

      const request = new Request("https://example.com", {
        headers: {
          "X-Shopify-Triggered-At": "2026-09-27T12:00:00Z",
        },
      });

      const result = parseTriggeredAt(request);

      expect(result).toBeInstanceOf(Date);
    });
  });
});
