/**
 * Reviewer journey test for ledger-to-account-page link.
 *
 * Tests the end-to-end flow:
 * 1. Ledger row name href is /app/accounts/<id>
 * 2. Account page loader returns the account for that id
 * 3. Edit Credit Settings control is present (loader returns account.isGated=false)
 * 4. Manual hold control toggles hold on and off via action
 *
 * Uses real database via TEST_DATABASE_URL (repo's describeWithDb pattern).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import postgres from "postgres";
import { sqlOptions } from "~/lib/db-light.server";
import { renderToString } from "react-dom/server";
import { createElement, type ReactNode } from "react";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeWithDb = TEST_DATABASE_URL ? describe : describe.skip;

vi.mock("@shopify/shopify-app-react-router/server", () => ({
  boundary: { headers: vi.fn(() => ({})) },
  ApiVersion: { October26: "2026-10" },
}));

vi.mock("@sentry/cloudflare", () => ({
  captureException: vi.fn(),
  captureMessage: vi.fn(),
  setUser: vi.fn(),
  setContext: vi.fn(),
}));

vi.mock("~/lib/recompute-enqueue.server", () => ({
  enqueueCreditStatusRecompute: vi.fn().mockResolvedValue(true),
}));

vi.mock("react-router", async () => {
  return {
    useLoaderData: vi.fn(),
    useActionData: vi.fn(() => undefined),
    useNavigation: vi.fn(() => ({ state: "idle", formData: null })),
    data: vi.fn((d) => d),
    Form: ({ children, ...props }: { children: ReactNode; method?: string }) =>
      createElement("form", props, children),
  };
});

import { useLoaderData } from "react-router";
const mockUseLoaderData = vi.mocked(useLoaderData);

function extractLoaderResult<T>(result: unknown): T {
  if (
    typeof result === "object" &&
    result !== null &&
    "type" in result &&
    (result as { type: string }).type === "DataWithResponseInit" &&
    "data" in result
  ) {
    return (result as { data: T }).data;
  }
  return result as T;
}

function extractActionResult<T>(result: unknown): T {
  if (
    typeof result === "object" &&
    result !== null &&
    "type" in result &&
    (result as { type: string }).type === "DataWithResponseInit" &&
    "data" in result
  ) {
    return (result as { data: T }).data;
  }
  return result as T;
}

describeWithDb("Ledger-to-Account journey (DB)", () => {
  let sql: ReturnType<typeof postgres>;
  const TEST_SUFFIX = Date.now().toString(36) + "-ledger-acct";

  const SHOP_ID = `shop-${TEST_SUFFIX}`;
  const SHOP_DOMAIN = `test-${TEST_SUFFIX}.myshopify.com`;
  const BUYER_ID = `buyer-${TEST_SUFFIX}`;
  const BUYER_NAME = "Test Journey Buyer Corp";
  const INVOICE_ID = `inv-${TEST_SUFFIX}`;

  function createMockContext(shopDomain: string) {
    return {
      shopify: {
        authenticate: {
          admin: vi.fn().mockResolvedValue({
            session: { shop: shopDomain, accessToken: "test-token" },
            sessionToken: { sub: "12345" },
            admin: { graphql: vi.fn() },
            redirect: (url: string) => new Response(null, { status: 302, headers: { Location: url } }),
          }),
        },
      },
      cloudflare: {
        env: { RESEND_API_KEY: undefined, RESEND_FROM: undefined },
        ctx: { waitUntil: vi.fn() },
      },
    };
  }

  function createLoaderArgs(urlPath: string, params: Record<string, string> = {}) {
    const url = new URL(`https://example.com${urlPath}`);
    return {
      request: new Request(url),
      context: createMockContext(SHOP_DOMAIN),
      params,
      url,
      pattern: urlPath.replace(/\/[^/]+$/, "/:id"),
    } as unknown;
  }

  function createActionArgs(
    urlPath: string,
    formData: Record<string, string>,
    params: Record<string, string> = {}
  ) {
    const url = new URL(`https://example.com${urlPath}`);
    const body = new FormData();
    for (const [key, value] of Object.entries(formData)) {
      body.append(key, value);
    }
    return {
      request: new Request(url, { method: "POST", body }),
      context: createMockContext(SHOP_DOMAIN),
      params,
      url,
      pattern: urlPath.replace(/\/[^/]+$/, "/:id"),
    } as unknown;
  }

  beforeAll(async () => {
    sql = postgres(TEST_DATABASE_URL!, sqlOptions);

    await sql`
      INSERT INTO "Shop" (id, domain, currency, timezone, "createdAt", "updatedAt", onboarding_dismissed_at)
      VALUES (${SHOP_ID}, ${SHOP_DOMAIN}, 'INR', 'Asia/Kolkata', NOW(), NOW(), NOW())
    `;

    await sql`
      INSERT INTO "BuyerAccount" (
        id, "shopId", kind, "companyId", "companyLocationId", name,
        "creditLimit", "holdState", bypass, "syncPending",
        "reminderOptOutAt", "reminderOptOutSource",
        "createdAt", "updatedAt"
      )
      VALUES (
        ${BUYER_ID}, ${SHOP_ID}, 'COMPANY', ${"co-" + TEST_SUFFIX}, ${"loc-" + TEST_SUFFIX}, ${BUYER_NAME},
        50000.00, 'OK', false, false, NULL, NULL, NOW(), NOW()
      )
    `;

    await sql`
      INSERT INTO "Invoice" (
        id, "shopId", "buyerAccountId", name, "orderId",
        total, outstanding, "issuedAt", "dueAt", "createdAt", "updatedAt"
      )
      VALUES (
        ${INVOICE_ID}, ${SHOP_ID}, ${BUYER_ID}, 'INV-001', ${"order-" + TEST_SUFFIX},
        10000.00, 10000.00, NOW(), NOW() + interval '30 days', NOW(), NOW()
      )
    `;
  });

  afterAll(async () => {
    await sql`DELETE FROM "Invoice" WHERE id = ${INVOICE_ID}`;
    await sql`DELETE FROM "BuyerAccount" WHERE id = ${BUYER_ID}`;
    await sql`DELETE FROM "Shop" WHERE id = ${SHOP_ID}`;
    await sql.end();
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("1. Ledger row name links to /app/accounts/<id>", () => {
    it("BuyerLedgerTable renders name with href /app/accounts/<buyer_account_id>", async () => {
      const { BuyerLedgerTable } = await import("../app._index");

      const ledgerRows = [
        {
          buyer_account_id: BUYER_ID,
          buyer_name: BUYER_NAME,
          currency: "INR",
          outstanding_paise: "1000000000",
          overdue_paise: "0",
          credit_limit_paise: "5000000000",
          oldest_overdue_days: null,
          hold_state: "OK" as const,
          is_gated: false,
        },
      ];

      const html = renderToString(
        createElement(BuyerLedgerTable, {
          rows: ledgerRows,
          sortBy: "outstanding",
          sortOrder: "desc",
          page: 1,
          totalCount: 1,
          pageSize: 20,
          onlyOverLimit: false,
          onNextPage: "?page=2",
          onPreviousPage: "",
          gatingEnforced: false,
        })
      );

      expect(html).toContain(`href="/app/accounts/${BUYER_ID}"`);
      expect(html).toContain(BUYER_NAME);
    });

    it("Outstanding amount links to ?buyer= to open the Open Invoices panel", async () => {
      const { BuyerLedgerTable } = await import("../app._index");

      const ledgerRows = [
        {
          buyer_account_id: BUYER_ID,
          buyer_name: BUYER_NAME,
          currency: "INR",
          outstanding_paise: "1000000000",
          overdue_paise: "0",
          credit_limit_paise: "5000000000",
          oldest_overdue_days: null,
          hold_state: "OK" as const,
          is_gated: false,
        },
      ];

      const html = renderToString(
        createElement(BuyerLedgerTable, {
          rows: ledgerRows,
          sortBy: "outstanding",
          sortOrder: "desc",
          page: 1,
          totalCount: 1,
          pageSize: 20,
          onlyOverLimit: false,
          onNextPage: "?page=2",
          onPreviousPage: "",
          gatingEnforced: false,
        })
      );

      expect(html).toContain(`href="?buyer=${BUYER_ID}`);
      expect(html).toContain("₹1,00,00,000.00");
    });
  });

  describe("2. Account page loader returns the account", () => {
    it("loader returns account with correct id and name", async () => {
      const { loader } = await import("../app.accounts.$id");

      const result = await loader(createLoaderArgs(`/app/accounts/${BUYER_ID}`, { id: BUYER_ID }) as never);
      const data = extractLoaderResult<{
        account: { id: string; name: string; isGated: boolean } | null;
        error: string | null;
      }>(result);

      expect(data.error).toBeNull();
      expect(data.account).not.toBeNull();
      expect(data.account?.id).toBe(BUYER_ID);
      expect(data.account?.name).toBe(BUYER_NAME);
    });
  });

  describe("3. Edit Credit Settings control is present", () => {
    it("account.isGated=false means Edit Credit Settings section renders", async () => {
      const { loader } = await import("../app.accounts.$id");

      const result = await loader(createLoaderArgs(`/app/accounts/${BUYER_ID}`, { id: BUYER_ID }) as never);
      const data = extractLoaderResult<{
        account: { id: string; name: string; isGated: boolean } | null;
        creditStatus: { manualHold: boolean } | null;
      }>(result);

      expect(data.account?.isGated).toBe(false);

      mockUseLoaderData.mockReturnValue({
        account: data.account,
        creditStatus: data.creditStatus,
        companyTotals: null,
        invoices: { rows: [], totalCount: 0 },
        gatingEnforced: false,
        reminderOptOut: null,
        upgradeUrl: "https://example.com/upgrade",
        newAccountsPausedBanner: { show: false, heading: "", bodyText: "", upgradeUrl: null },
        error: null,
      });

      const AccountPage = (await import("../app.accounts.$id")).default;
      const html = renderToString(createElement(AccountPage));

      expect(html).toContain("Edit Credit Settings");
      expect(html).toContain("Save Credit Settings");
    });
  });

  describe("4. Manual hold control toggles hold on and off", () => {
    it("manual hold checkbox is present with label 'Place manual hold on this account'", async () => {
      const { loader } = await import("../app.accounts.$id");

      const result = await loader(createLoaderArgs(`/app/accounts/${BUYER_ID}`, { id: BUYER_ID }) as never);
      const data = extractLoaderResult<{
        account: { id: string; name: string; isGated: boolean } | null;
        creditStatus: { manualHold: boolean } | null;
      }>(result);

      mockUseLoaderData.mockReturnValue({
        account: data.account,
        creditStatus: data.creditStatus,
        companyTotals: null,
        invoices: { rows: [], totalCount: 0 },
        gatingEnforced: false,
        reminderOptOut: null,
        upgradeUrl: "https://example.com/upgrade",
        newAccountsPausedBanner: { show: false, heading: "", bodyText: "", upgradeUrl: null },
        error: null,
      });

      const AccountPage = (await import("../app.accounts.$id")).default;
      const html = renderToString(createElement(AccountPage));

      expect(html).toContain("Place manual hold on this account");
    });

    it("action toggles manualHold ON", async () => {
      const { action } = await import("../app.accounts.$id");

      const result = await action(
        createActionArgs(
          `/app/accounts/${BUYER_ID}`,
          {
            _action: "updateCredit",
            creditLimit: "50000",
            manualHold: "true",
            holdReasonCode: "MANUAL_HOLD",
          },
          { id: BUYER_ID }
        ) as never
      );

      const data = extractActionResult<{ success: boolean; error?: string }>(result);
      expect(data.success).toBe(true);

      const [row] = await sql<{ holdState: string; manualHold: boolean }[]>`
        SELECT "holdState", "manualHold" FROM "BuyerAccount" WHERE id = ${BUYER_ID}
      `;
      expect(row.manualHold).toBe(true);
      expect(row.holdState).toBe("HELD");
    });

    it("action toggles manualHold OFF", async () => {
      const { action } = await import("../app.accounts.$id");

      const result = await action(
        createActionArgs(
          `/app/accounts/${BUYER_ID}`,
          {
            _action: "updateCredit",
            creditLimit: "50000",
            manualHold: "",
          },
          { id: BUYER_ID }
        ) as never
      );

      const data = extractActionResult<{ success: boolean; error?: string }>(result);
      expect(data.success).toBe(true);

      const [row] = await sql<{ holdState: string; manualHold: boolean }[]>`
        SELECT "holdState", "manualHold" FROM "BuyerAccount" WHERE id = ${BUYER_ID}
      `;
      expect(row.manualHold).toBe(false);
      expect(row.holdState).toBe("OK");
    });
  });

});
