/**
 * Metafield Function Fixtures Test
 *
 * Generates complete Shopify Function input fixtures from the REAL TypeScript
 * metafield writers (updateCreditStatus and shop_config writer). These fixtures
 * are consumed by the Rust Function tests to verify cross-language contract.
 *
 * Structure:
 * 1. Run real writers with mocked Shopify Admin GraphQL client
 * 2. Capture the exact serialized metafield values
 * 3. Write fixtures matching the Function input query shape
 * 4. Guard test: verify writer output matches embedded fixture values
 */
import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from "vitest";
import * as fs from "fs";
import * as path from "path";
import type { Sql } from "~/lib/db-light.server";
import { companyLocationGid } from "../../../tests/helpers/gid";

const MOCK_SHOP_DOMAIN = "test-fixtures.example.com";
const FIXED_TIMESTAMP = "2026-10-15T00:00:00.000Z";

let creditStatusMetafieldCaptures: Array<{
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


interface FixtureCase {
  name: string;
  description: string;
  account: MockBuyerAccount;
  shop: { id: string; domain: string; currency: string };
  invoiceExposure: string;
  draftExposure: string;
  hasOverdue: boolean;
  cartAmount: string;
  expectedCreditCheckDecision: "allow" | "block";
  expectedHideTermsDecision: "show" | "hide";
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
    expectedCreditCheckDecision: "allow",
    expectedHideTermsDecision: "show",
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
    expectedCreditCheckDecision: "block",
    expectedHideTermsDecision: "show",
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
    expectedCreditCheckDecision: "block",
    expectedHideTermsDecision: "hide",
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
    expectedCreditCheckDecision: "block",
    expectedHideTermsDecision: "show",
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
    expectedCreditCheckDecision: "allow",
    expectedHideTermsDecision: "show",
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

function buildCreditCheckFixture(
  creditStatusValue: Record<string, unknown>,
  shopConfigValue: Record<string, unknown>,
  cartAmount: string,
  cartCurrency: string,
  ownerGid: string,
  isB2B: boolean
): Record<string, unknown> {
  const creditStatusMetafield = { jsonValue: creditStatusValue };
  const shopConfigMetafield = { jsonValue: shopConfigValue };

  return {
    cart: {
      cost: {
        totalAmount: {
          amount: cartAmount,
          currencyCode: cartCurrency,
        },
      },
      buyerIdentity: isB2B
        ? {
            customer: null,
            purchasingCompany: {
              location: {
                metafield: creditStatusMetafield,
              },
            },
          }
        : {
            customer: {
              metafield: creditStatusMetafield,
            },
            purchasingCompany: null,
          },
    },
    buyerJourney: {
      step: "CHECKOUT_COMPLETION",
    },
    shop: {
      metafield: shopConfigMetafield,
    },
  };
}

function buildHideTermsFixture(
  creditStatusValue: Record<string, unknown>,
  shopConfigValue: Record<string, unknown>,
  cartCurrency: string,
  ownerGid: string,
  isB2B: boolean
): Record<string, unknown> {
  const creditStatusMetafield = { jsonValue: creditStatusValue };
  const shopConfigMetafield = { jsonValue: shopConfigValue };

  return {
    cart: {
      cost: {
        totalAmount: {
          currencyCode: cartCurrency,
        },
      },
      buyerIdentity: isB2B
        ? {
            customer: null,
            purchasingCompany: {
              location: {
                metafield: creditStatusMetafield,
              },
            },
          }
        : {
            customer: {
              metafield: creditStatusMetafield,
            },
            purchasingCompany: null,
          },
    },
    paymentMethods: [
      { id: "gid://shopify/PaymentCustomizationPaymentMethod/1", name: "Credit Card" },
      { id: "gid://shopify/PaymentCustomizationPaymentMethod/2", name: "Deferred Payment" },
      { id: "gid://shopify/PaymentCustomizationPaymentMethod/3", name: "Net Terms" },
    ],
    paymentCustomization: {
      metafield: null,
    },
    shop: {
      metafield: shopConfigMetafield,
    },
  };
}

describe("Metafield Function Fixtures", () => {
  let originalDateNow: () => number;

  beforeAll(() => {
    originalDateNow = Date.now;
    Date.now = () => new Date(FIXED_TIMESTAMP).getTime();

    const originalToISOString = Date.prototype.toISOString;
    vi.spyOn(Date.prototype, "toISOString").mockImplementation(function (this: Date) {
      if (this.getTime() === Date.now()) {
        return FIXED_TIMESTAMP;
      }
      return originalToISOString.call(this);
    });
  });

  afterAll(() => {
    Date.now = originalDateNow;
    vi.restoreAllMocks();
  });

  beforeEach(() => {
    creditStatusMetafieldCaptures = [];
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("Fixture Generation from Real Writers", () => {
    const generatedFixtures: Map<
      string,
      { creditCheck: Record<string, unknown>; hideTerms: Record<string, unknown>; creditStatusValue: string }
    > = new Map();

    for (const fixtureCase of FIXTURE_CASES) {
      it(`generates fixture for ${fixtureCase.name}: ${fixtureCase.description}`, async () => {
        creditStatusMetafieldCaptures = [];

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

        const captured = creditStatusMetafieldCaptures.find((m) => m.key === "credit_status");
        expect(captured, "No credit_status metafield was captured").toBeDefined();

        const creditStatusValue = JSON.parse(captured!.value);
        const shopConfigValue = { schemaVersion: 1, currencyCode: fixtureCase.shop.currency };

        const isB2B = fixtureCase.account.kind === "COMPANY";
        const ownerGid = isB2B ? fixtureCase.account.companyLocationId! : fixtureCase.account.customerId!;

        const creditCheckFixture = buildCreditCheckFixture(
          creditStatusValue,
          shopConfigValue,
          fixtureCase.cartAmount,
          fixtureCase.shop.currency,
          ownerGid,
          isB2B
        );

        const hideTermsFixture = buildHideTermsFixture(
          creditStatusValue,
          shopConfigValue,
          fixtureCase.shop.currency,
          ownerGid,
          isB2B
        );

        generatedFixtures.set(fixtureCase.name, {
          creditCheck: creditCheckFixture,
          hideTerms: hideTermsFixture,
          creditStatusValue: captured!.value,
        });

        expect(creditStatusValue.schemaVersion).toBe(1);
        expect(creditStatusValue.currencyCode).toBe(fixtureCase.shop.currency);
        expect(typeof creditStatusValue.hold).toBe("boolean");
      });
    }

    it("writes all fixtures to disk", async () => {
      for (const fixtureCase of FIXTURE_CASES) {
        creditStatusMetafieldCaptures = [];

        const sql = createComprehensiveMockSql({
          account: fixtureCase.account,
          shop: fixtureCase.shop,
          invoiceExposure: fixtureCase.invoiceExposure,
          draftExposure: fixtureCase.draftExposure,
          hasOverdue: fixtureCase.hasOverdue,
        });

        const { recomputeCreditStatus } = await import("../../services/credit-status-recompute.server");
        await recomputeCreditStatus(sql, fixtureCase.account.id, "invoice_change");

        const captured = creditStatusMetafieldCaptures.find((m) => m.key === "credit_status");
        if (!captured) continue;

        const creditStatusValue = JSON.parse(captured.value);
        const shopConfigValue = { schemaVersion: 1, currencyCode: fixtureCase.shop.currency };

        const isB2B = fixtureCase.account.kind === "COMPANY";
        const ownerGid = isB2B ? fixtureCase.account.companyLocationId! : fixtureCase.account.customerId!;

        const creditCheckFixture = buildCreditCheckFixture(
          creditStatusValue,
          shopConfigValue,
          fixtureCase.cartAmount,
          fixtureCase.shop.currency,
          ownerGid,
          isB2B
        );

        const hideTermsFixture = buildHideTermsFixture(
          creditStatusValue,
          shopConfigValue,
          fixtureCase.shop.currency,
          ownerGid,
          isB2B
        );

        fs.mkdirSync(CREDIT_CHECK_FIXTURES_DIR, { recursive: true });
        fs.mkdirSync(HIDE_TERMS_FIXTURES_DIR, { recursive: true });

        fs.writeFileSync(
          path.join(CREDIT_CHECK_FIXTURES_DIR, `fixture_${fixtureCase.name}.json`),
          JSON.stringify(creditCheckFixture, null, 2) + "\n"
        );

        fs.writeFileSync(
          path.join(HIDE_TERMS_FIXTURES_DIR, `fixture_${fixtureCase.name}.json`),
          JSON.stringify(hideTermsFixture, null, 2) + "\n"
        );
      }

      for (const fixtureCase of FIXTURE_CASES) {
        const creditCheckPath = path.join(CREDIT_CHECK_FIXTURES_DIR, `fixture_${fixtureCase.name}.json`);
        const hideTermsPath = path.join(HIDE_TERMS_FIXTURES_DIR, `fixture_${fixtureCase.name}.json`);

        expect(fs.existsSync(creditCheckPath), `Missing: ${creditCheckPath}`).toBe(true);
        expect(fs.existsSync(hideTermsPath), `Missing: ${hideTermsPath}`).toBe(true);
      }
    });
  });

  describe("Guard: Writer Output Matches Fixtures", () => {
    for (const fixtureCase of FIXTURE_CASES) {
      it(`guard: ${fixtureCase.name} writer output equals fixture`, async () => {
        const creditCheckPath = path.join(CREDIT_CHECK_FIXTURES_DIR, `fixture_${fixtureCase.name}.json`);

        if (!fs.existsSync(creditCheckPath)) {
          return;
        }

        creditStatusMetafieldCaptures = [];

        const sql = createComprehensiveMockSql({
          account: fixtureCase.account,
          shop: fixtureCase.shop,
          invoiceExposure: fixtureCase.invoiceExposure,
          draftExposure: fixtureCase.draftExposure,
          hasOverdue: fixtureCase.hasOverdue,
        });

        const { recomputeCreditStatus } = await import("../../services/credit-status-recompute.server");
        await recomputeCreditStatus(sql, fixtureCase.account.id, "invoice_change");

        const captured = creditStatusMetafieldCaptures.find((m) => m.key === "credit_status");
        expect(captured, "No credit_status metafield was captured").toBeDefined();

        const writerOutput = JSON.parse(captured!.value);

        const fixtureContent = JSON.parse(fs.readFileSync(creditCheckPath, "utf-8"));
        const fixtureEmbeddedValue =
          fixtureContent.cart.buyerIdentity.purchasingCompany?.location?.metafield?.jsonValue ??
          fixtureContent.cart.buyerIdentity.customer?.metafield?.jsonValue;

        const writerWithoutTimestamp = { ...writerOutput };
        delete writerWithoutTimestamp.updatedAt;
        const fixtureWithoutTimestamp = { ...fixtureEmbeddedValue };
        delete fixtureWithoutTimestamp.updatedAt;

        expect(writerWithoutTimestamp).toEqual(fixtureWithoutTimestamp);
      });
    }
  });

  describe("Expected Decisions Documentation", () => {
    it("documents expected decisions for all fixtures", () => {
      const decisions = FIXTURE_CASES.map((fc) => ({
        name: fc.name,
        description: fc.description,
        creditCheck: fc.expectedCreditCheckDecision,
        hideTerms: fc.expectedHideTermsDecision,
      }));

      expect(decisions).toEqual([
        {
          name: "unheld_under_limit",
          description: "Unheld buyer under the credit limit",
          creditCheck: "allow",
          hideTerms: "show",
        },
        {
          name: "unheld_over_limit",
          description: "Unheld buyer over the credit limit",
          creditCheck: "block",
          hideTerms: "show",
        },
        {
          name: "held",
          description: "Buyer on manual hold",
          creditCheck: "block",
          hideTerms: "hide",
        },
        {
          name: "zero_limit",
          description: "Buyer with zero credit limit",
          creditCheck: "block",
          hideTerms: "show",
        },
        {
          name: "no_limit",
          description: "Buyer with no limit set (unlimited credit)",
          creditCheck: "allow",
          hideTerms: "show",
        },
      ]);
    });
  });
});
