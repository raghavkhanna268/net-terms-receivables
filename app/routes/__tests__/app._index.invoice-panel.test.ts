/**
 * Render tests for BuyerInvoiceList (Open Invoices panel).
 *
 * Tests that:
 * - "View account" button renders with correct href in both empty and non-empty states
 * - "Back to Ledger" button is still present
 * - Invoice rows render correctly
 *
 * These tests do NOT require the database.
 */
import { describe, it, expect } from "vitest";
import { renderToString } from "react-dom/server";
import { createElement } from "react";
import type { BuyerInvoiceRow } from "~/lib/aging";

describe("BuyerInvoiceList render tests", () => {
  const TEST_BUYER_ID = "buyer-test-123";
  const TEST_BUYER_NAME = "Test Buyer Corp";
  const CLOSE_URL = "?sortBy=outstanding&sortOrder=desc&page=1";

  describe("empty state (invoices=[])", () => {
    it("renders 'View account' button with href /app/accounts/<id>", async () => {
      const { BuyerInvoiceList } = await import("../app._index");

      const html = renderToString(
        createElement(BuyerInvoiceList, {
          invoices: [],
          buyerName: TEST_BUYER_NAME,
          buyerAccountId: TEST_BUYER_ID,
          onClose: CLOSE_URL,
          shopTimezone: "Asia/Kolkata",
        })
      );

      expect(html).toContain(`href="/app/accounts/${TEST_BUYER_ID}"`);
      expect(html).toContain("View account");
    });

    it("renders 'Back to Ledger' button", async () => {
      const { BuyerInvoiceList } = await import("../app._index");

      const html = renderToString(
        createElement(BuyerInvoiceList, {
          invoices: [],
          buyerName: TEST_BUYER_NAME,
          buyerAccountId: TEST_BUYER_ID,
          onClose: CLOSE_URL,
          shopTimezone: "Asia/Kolkata",
        })
      );

      expect(html).toContain("Back to Ledger");
      expect(html).toContain("sortBy=outstanding");
      expect(html).toContain("sortOrder=desc");
    });

    it("shows empty state heading", async () => {
      const { BuyerInvoiceList } = await import("../app._index");

      const html = renderToString(
        createElement(BuyerInvoiceList, {
          invoices: [],
          buyerName: TEST_BUYER_NAME,
          buyerAccountId: TEST_BUYER_ID,
          onClose: CLOSE_URL,
          shopTimezone: "Asia/Kolkata",
        })
      );

      expect(html).toContain("No open invoices");
      expect(html).toContain("This buyer has no outstanding invoices");
    });
  });

  describe("with invoice rows", () => {
    const mockInvoices: BuyerInvoiceRow[] = [
      {
        id: "inv-1",
        name: "INV-001",
        order_id: "gid://shopify/Order/123",
        due_at: new Date("2026-11-01"),
        outstanding_paise: "1000000",
        currency: "INR",
        days_past_due: -5,
      },
      {
        id: "inv-2",
        name: "INV-002",
        order_id: "gid://shopify/Order/456",
        due_at: new Date("2026-10-20"),
        outstanding_paise: "500000",
        currency: "INR",
        days_past_due: 7,
      },
    ];

    it("renders 'View account' button with href /app/accounts/<id>", async () => {
      const { BuyerInvoiceList } = await import("../app._index");

      const html = renderToString(
        createElement(BuyerInvoiceList, {
          invoices: mockInvoices,
          buyerName: TEST_BUYER_NAME,
          buyerAccountId: TEST_BUYER_ID,
          onClose: CLOSE_URL,
          shopTimezone: "Asia/Kolkata",
        })
      );

      expect(html).toContain(`href="/app/accounts/${TEST_BUYER_ID}"`);
      expect(html).toContain("View account");
    });

    it("renders 'Back to Ledger' button", async () => {
      const { BuyerInvoiceList } = await import("../app._index");

      const html = renderToString(
        createElement(BuyerInvoiceList, {
          invoices: mockInvoices,
          buyerName: TEST_BUYER_NAME,
          buyerAccountId: TEST_BUYER_ID,
          onClose: CLOSE_URL,
          shopTimezone: "Asia/Kolkata",
        })
      );

      expect(html).toContain("Back to Ledger");
      expect(html).toContain("sortBy=outstanding");
      expect(html).toContain("sortOrder=desc");
    });

    it("renders section heading with buyer name", async () => {
      const { BuyerInvoiceList } = await import("../app._index");

      const html = renderToString(
        createElement(BuyerInvoiceList, {
          invoices: mockInvoices,
          buyerName: TEST_BUYER_NAME,
          buyerAccountId: TEST_BUYER_ID,
          onClose: CLOSE_URL,
          shopTimezone: "Asia/Kolkata",
        })
      );

      expect(html).toContain(`Open Invoices for ${TEST_BUYER_NAME}`);
    });

    it("renders invoice rows", async () => {
      const { BuyerInvoiceList } = await import("../app._index");

      const html = renderToString(
        createElement(BuyerInvoiceList, {
          invoices: mockInvoices,
          buyerName: TEST_BUYER_NAME,
          buyerAccountId: TEST_BUYER_ID,
          onClose: CLOSE_URL,
          shopTimezone: "Asia/Kolkata",
        })
      );

      expect(html).toContain("INV-001");
      expect(html).toContain("INV-002");
    });

    it("renders View account button with secondary variant", async () => {
      const { BuyerInvoiceList } = await import("../app._index");

      const html = renderToString(
        createElement(BuyerInvoiceList, {
          invoices: mockInvoices,
          buyerName: TEST_BUYER_NAME,
          buyerAccountId: TEST_BUYER_ID,
          onClose: CLOSE_URL,
          shopTimezone: "Asia/Kolkata",
        })
      );

      expect(html).toContain('variant="secondary"');
      expect(html).toContain("View account");
    });
  });
});
