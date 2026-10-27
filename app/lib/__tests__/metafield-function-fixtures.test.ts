/**
 * Metafield Function Fixtures Guard Tests
 *
 * Guards the contract between TypeScript metafield writers (updateCreditStatus,
 * shop_config) and Rust Shopify Functions. Verifies that committed fixture files
 * match the exact output of the real writers.
 *
 * To regenerate fixtures:
 *   npm run gen:function-fixtures
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from "vitest";
import * as fs from "fs";
import * as path from "path";
import type { Sql } from "~/lib/db-light.server";
import { companyLocationGid } from "../../../tests/helpers/gid";

const MOCK_SHOP_DOMAIN = "test-fixtures.example.com";
const MOCK_SHOP_GID = "gid://shopify/Shop/12345";
const FIXED_TIMESTAMP = "2026-10-15T00:00:00.000Z";

let creditStatusMetafieldCaptures: Array<{
  ownerId: string;
  namespace: string;
  key: string;
  value: string;
  type?: string;
}> = [];

let shopConfigMetafieldCaptures: Array<{
  ownerId: string;
  namespace: string;
  key: string;
  value: string;
  type?: string;
}> = [];

vi.mock("../../services/shopify-client.server", () => ({
  shopifyGraphQLRequest: vi.fn().mockImplementation(async (_domain, _query, variables) => {
    const metafields = variables?.metafields as Array<{
      ownerId: string;
      namespace: string;
      key: string;
      value: string;
      type?: string;
    }>;
    if (metafields) {
      creditStatusMetafieldCaptures.push(...metafields);
    }
    return {
      success: true,
      data: {
        metafieldsSet: {
          metafields:
            metafields?.map((m, i) => ({ id: `mf-${i}`, namespace: m.namespace, key: m.key })) ?? [],
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

  const queryHandler = async (
    strings: TemplateStringsArray,
    ..._values: unknown[]
  ): Promise<unknown[]> => {
    const query = strings.join("?");

    if (
      query.includes('FROM "BuyerAccount"') &&
      query.includes("SELECT") &&
      !query.includes('UPDATE "BuyerAccount"')
    ) {
      return [config.account];
    }

    if (query.includes('UPDATE "BuyerAccount"') && query.includes("RETURNING")) {
      syncVersionCounter++;
      return [{ syncVersion: syncVersionCounter, id: config.account.id }];
    }

    if (query.includes('UPDATE "BuyerAccount"')) {
      return [{ count: 1 }];
    }

    if (query.includes('FROM "Shop"')) {
      return [config.shop];
    }

    if (query.includes('FROM "Invoice"') && query.includes("SUM")) {
      return [{ total_paise: config.invoiceExposure }];
    }

    if (query.includes("s8_draft_orders") && query.includes("SUM")) {
      return [{ total_paise: config.draftExposure }];
    }

    if (query.includes("EXISTS") && query.includes('"Invoice"')) {
      return [{ has_overdue: config.hasOverdue }];
    }

    if (query.includes("INSERT INTO")) {
      return [];
    }

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

function createMockAdminClient() {
  return {
    graphql: vi.fn().mockImplementation(async (_query: string, opts?: { variables?: Record<string, unknown> }) => {
      const metafields = opts?.variables?.metafields as Array<{
        ownerId: string;
        namespace: string;
        key: string;
        value: string;
        type?: string;
      }>;
      if (metafields) {
        shopConfigMetafieldCaptures.push(...metafields);
      }
      return {
        json: async () => ({
          data: {
            metafieldsSet: {
              metafields: metafields?.map((m, i) => ({ id: `mf-shop-${i}` })) ?? [],
              userErrors: [],
            },
          },
        }),
      };
    }),
  };
}


interface FixtureCase {
  name: string;
  description: string;
  account: MockBuyerAccount;
  shop: { id: string; domain: string; currency: string };
  invoiceExposure: string;
  draftExposure: string;
  hasOverdue: boolean;
  cartAmount: string;
}

const FIXTURE_CASES: FixtureCase[] = [
  {
    name: "unheld_under_limit",
    description: "Unheld buyer under the credit limit",
    account: {
      id: "acc-unheld-under",
      shopId: "shop-test",
      kind: "COMPANY",
      companyLocationId: companyLocationGid(1),
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
    cartAmount: "1000.00",
  },
  {
    name: "unheld_over_limit",
    description: "Unheld buyer over the credit limit",
    account: {
      id: "acc-unheld-over",
      shopId: "shop-test",
      kind: "COMPANY",
      companyLocationId: companyLocationGid(2),
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
    invoiceExposure: "9500000",
    draftExposure: "0",
    hasOverdue: false,
    cartAmount: "10000.00",
  },
  {
    name: "held",
    description: "Buyer on manual hold",
    account: {
      id: "acc-held",
      shopId: "shop-test",
      kind: "COMPANY",
      companyLocationId: companyLocationGid(3),
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
    invoiceExposure: "0",
    draftExposure: "0",
    hasOverdue: false,
    cartAmount: "100.00",
  },
  {
    name: "zero_limit",
    description: "Buyer with zero credit limit",
    account: {
      id: "acc-zero-limit",
      shopId: "shop-test",
      kind: "COMPANY",
      companyLocationId: companyLocationGid(4),
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
    cartAmount: "100.00",
  },
  {
    name: "no_limit",
    description: "Buyer with no limit set (unlimited credit)",
    account: {
      id: "acc-no-limit",
      shopId: "shop-test",
      kind: "COMPANY",
      companyLocationId: companyLocationGid(5),
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
    cartAmount: "100000.00",
  },
];

const CREDIT_CHECK_FIXTURES_DIR = path.resolve(
  __dirname,
  "../../../extensions/credit-check-validation/tests/fixtures"
);
const HIDE_TERMS_FIXTURES_DIR = path.resolve(
  __dirname,
  "../../../extensions/hide-terms-payment/tests/fixtures"
);

describe("Metafield Function Fixtures Guard", () => {
  beforeAll(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(FIXED_TIMESTAMP));
  });

  afterAll(() => {
    vi.useRealTimers();
  });

  beforeEach(() => {
    creditStatusMetafieldCaptures = [];
    shopConfigMetafieldCaptures = [];
    vi.clearAllMocks();
  });

  describe("credit-check-validation fixtures", () => {
    for (const fixtureCase of FIXTURE_CASES) {
      it(`guard: ${fixtureCase.name} credit_status and shop_config match fixture`, async () => {
        const fixturePath = path.join(CREDIT_CHECK_FIXTURES_DIR, `fixture_${fixtureCase.name}.json`);
        expect(fs.existsSync(fixturePath), `Fixture file missing: ${fixturePath}`).toBe(true);

        creditStatusMetafieldCaptures = [];
        shopConfigMetafieldCaptures = [];

        const sql = createComprehensiveMockSql({
          account: fixtureCase.account,
          shop: fixtureCase.shop,
          invoiceExposure: fixtureCase.invoiceExposure,
          draftExposure: fixtureCase.draftExposure,
          hasOverdue: fixtureCase.hasOverdue,
        });

        const { recomputeCreditStatus } = await import("../../services/credit-status-recompute.server");
        const result = await recomputeCreditStatus(sql, fixtureCase.account.id, "invoice_change");
        expect(result.success, `recomputeCreditStatus failed: ${result.error}`).toBe(true);

        const creditStatusCapture = creditStatusMetafieldCaptures.find((m) => m.key === "credit_status");
        expect(creditStatusCapture, "No credit_status metafield was captured").toBeDefined();

        const writerCreditStatusOutput = JSON.parse(creditStatusCapture!.value);

        const mockAdmin = createMockAdminClient();
        const { writeShopConfigMetafield } = await import("../../services/shop-config.server");
        const shopConfigResult = await writeShopConfigMetafield(mockAdmin, MOCK_SHOP_GID, fixtureCase.shop.currency);
        expect(shopConfigResult.success, "writeShopConfigMetafield failed").toBe(true);

        const shopConfigCapture = shopConfigMetafieldCaptures.find((m) => m.key === "shop_config");
        expect(shopConfigCapture, "No shop_config metafield was captured").toBeDefined();

        const writerShopConfigOutput = JSON.parse(shopConfigCapture!.value);

        const fixtureContent = JSON.parse(fs.readFileSync(fixturePath, "utf-8"));

        const fixtureEmbeddedCreditStatus =
          fixtureContent.cart.buyerIdentity.purchasingCompany?.location?.metafield?.jsonValue ??
          fixtureContent.cart.buyerIdentity.customer?.metafield?.jsonValue;

        const fixtureEmbeddedShopConfig = fixtureContent.shop?.metafield?.jsonValue;

        expect(writerCreditStatusOutput).toEqual(fixtureEmbeddedCreditStatus);
        expect(writerShopConfigOutput).toEqual(fixtureEmbeddedShopConfig);
      });
    }
  });

  describe("hide-terms-payment fixtures", () => {
    for (const fixtureCase of FIXTURE_CASES) {
      it(`guard: ${fixtureCase.name} credit_status, shop_config match and hide-terms-config absent`, async () => {
        const fixturePath = path.join(HIDE_TERMS_FIXTURES_DIR, `fixture_${fixtureCase.name}.json`);
        expect(fs.existsSync(fixturePath), `Fixture file missing: ${fixturePath}`).toBe(true);

        creditStatusMetafieldCaptures = [];
        shopConfigMetafieldCaptures = [];

        const sql = createComprehensiveMockSql({
          account: fixtureCase.account,
          shop: fixtureCase.shop,
          invoiceExposure: fixtureCase.invoiceExposure,
          draftExposure: fixtureCase.draftExposure,
          hasOverdue: fixtureCase.hasOverdue,
        });

        const { recomputeCreditStatus } = await import("../../services/credit-status-recompute.server");
        const result = await recomputeCreditStatus(sql, fixtureCase.account.id, "invoice_change");
        expect(result.success, `recomputeCreditStatus failed: ${result.error}`).toBe(true);

        const creditStatusCapture = creditStatusMetafieldCaptures.find((m) => m.key === "credit_status");
        expect(creditStatusCapture, "No credit_status metafield was captured").toBeDefined();

        const writerCreditStatusOutput = JSON.parse(creditStatusCapture!.value);

        const mockAdmin = createMockAdminClient();
        const { writeShopConfigMetafield } = await import("../../services/shop-config.server");
        const shopConfigResult = await writeShopConfigMetafield(mockAdmin, MOCK_SHOP_GID, fixtureCase.shop.currency);
        expect(shopConfigResult.success, "writeShopConfigMetafield failed").toBe(true);

        const shopConfigCapture = shopConfigMetafieldCaptures.find((m) => m.key === "shop_config");
        expect(shopConfigCapture, "No shop_config metafield was captured").toBeDefined();

        const writerShopConfigOutput = JSON.parse(shopConfigCapture!.value);

        const fixtureContent = JSON.parse(fs.readFileSync(fixturePath, "utf-8"));

        const fixtureEmbeddedCreditStatus =
          fixtureContent.cart.buyerIdentity.purchasingCompany?.location?.metafield?.jsonValue ??
          fixtureContent.cart.buyerIdentity.customer?.metafield?.jsonValue;

        const fixtureEmbeddedShopConfig = fixtureContent.shop?.metafield?.jsonValue;

        expect(writerCreditStatusOutput).toEqual(fixtureEmbeddedCreditStatus);
        expect(writerShopConfigOutput).toEqual(fixtureEmbeddedShopConfig);

        expect(
          fixtureContent.paymentCustomization?.metafield,
          "hide-terms-config metafield must be absent (null) - no TS writer exists"
        ).toBeNull();
      });
    }
  });
});
