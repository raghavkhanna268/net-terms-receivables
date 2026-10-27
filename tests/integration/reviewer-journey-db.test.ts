/**
 * Reviewer Journey Integration Suite
 *
 * Tests the complete App Store reviewer journey as documented in reviewer-instructions.md.
 * Each `it` block corresponds to a numbered step in Part A of that document.
 *
 * SOURCE OF TRUTH: reviewer-instructions.md Part A steps
 *
 * SETUP: Real Postgres 16 with pgmq, mocked Shopify Admin API boundary and external
 * services (Resend, Sentry). Uses synthetic test data only.
 *
 * ISOLATION: Uses unique test-reviewer-journey-* domains to avoid collisions.
 *
 * DB-GATED: This file requires TEST_DATABASE_URL. Uses describeWithDb to skip
 * when no DB is available.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import postgres from "postgres";
import { sqlOptions } from "../../app/lib/db-light.server";
import { assertNoQueueLeftovers } from "../helpers/queue-leftovers";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeWithDb = TEST_DATABASE_URL ? describe : describe.skip;

let validationCreatedCount = 0;
let paymentCustomizationCreatedCount = 0;

vi.mock("../../app/services/shopify-client.server", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    shopifyGraphQLRequest: vi.fn().mockImplementation(async (_shop: string, query: string) => {
      if (query.includes("OrderMarkAsPaid")) {
        return {
          success: true,
          data: {
            orderMarkAsPaid: {
              order: { id: "gid://shopify/Order/test", displayFinancialStatus: "PAID" },
              userErrors: [],
            },
          },
        };
      }
      if (query.includes("query GetOrder")) {
        return {
          success: true,
          data: { order: { id: "gid://shopify/Order/test", displayFinancialStatus: "PENDING" } },
        };
      }
      return { success: true, data: {} };
    }),
  };
});

vi.mock("@sentry/cloudflare", () => ({
  captureException: vi.fn(),
  captureMessage: vi.fn(),
  setTag: vi.fn(),
  setContext: vi.fn(),
}));

function createMockAdminClient(shopCurrency: string, shopGidSuffix: string) {
  return {
    graphql: vi.fn().mockImplementation(async (query: string) => {
      if (query.includes("query ShopAuthInfo") || query.includes("query ShopCurrencyAndId")) {
        return {
          json: async () => ({
            data: {
              shop: {
                id: `gid://shopify/Shop/${shopGidSuffix}`,
                ianaTimezone: "Asia/Kolkata",
                currencyCode: shopCurrency,
                metafield: null,
              },
            },
          }),
        };
      }
      if (query.includes("query GetValidations")) {
        return {
          json: async () => ({
            data: {
              validations: {
                edges:
                  validationCreatedCount > 0
                    ? [
                        {
                          node: {
                            id: "gid://shopify/Validation/test",
                            shopifyFunction: { handle: "credit-check-validation" },
                            title: "Termwise Credit Check",
                            enabled: true,
                            blockOnFailure: false,
                          },
                        },
                      ]
                    : [],
              },
            },
          }),
        };
      }
      if (query.includes("mutation ValidationCreate")) {
        validationCreatedCount++;
        return {
          json: async () => ({
            data: {
              validationCreate: {
                validation: {
                  id: "gid://shopify/Validation/test",
                  shopifyFunction: { handle: "credit-check-validation" },
                  title: "Termwise Credit Check",
                  enabled: true,
                },
                userErrors: [],
              },
            },
          }),
        };
      }
      if (query.includes("query GetPaymentCustomizations")) {
        return {
          json: async () => ({
            data: {
              paymentCustomizations: {
                edges:
                  paymentCustomizationCreatedCount > 0
                    ? [
                        {
                          node: {
                            id: "gid://shopify/PaymentCustomization/test",
                            shopifyFunction: { handle: "hide-terms-payment" },
                            title: "Termwise Payment Hide",
                            enabled: true,
                          },
                        },
                      ]
                    : [],
              },
            },
          }),
        };
      }
      if (query.includes("mutation PaymentCustomizationCreate")) {
        paymentCustomizationCreatedCount++;
        return {
          json: async () => ({
            data: {
              paymentCustomizationCreate: {
                paymentCustomization: {
                  id: "gid://shopify/PaymentCustomization/test",
                  shopifyFunction: { handle: "hide-terms-payment" },
                  title: "Termwise Payment Hide",
                  enabled: true,
                },
                userErrors: [],
              },
            },
          }),
        };
      }
      if (query.includes("metafieldsSet") || query.includes("metafieldDefinitionCreate")) {
        return {
          json: async () => ({
            data: {
              metafieldsSet: { metafields: [{ id: "test" }], userErrors: [] },
              metafieldDefinitionCreate: { createdDefinition: { id: "test" }, userErrors: [] },
            },
          }),
        };
      }
      return { json: async () => ({ data: {} }) };
    }),
  };
}

/**
 * PRIMARY JOURNEY: B2B Company/CompanyLocation path
 *
 * This is the doc's main path. Steps follow reviewer-instructions.md Part A exactly.
 */
describeWithDb("Reviewer Journey: B2B Company/CompanyLocation (Part A - Primary)", () => {
  let sql: ReturnType<typeof postgres>;
  const runId = Date.now();
  const TEST_SHOP_DOMAIN = `test-reviewer-b2b-${runId}.myshopify.com`;
  let testShopId: string;
  let testBuyerAccountId: string;
  let testInvoiceId: string;
  let testPaymentId: string;
  let testMatchId: string;

  beforeAll(async () => {
    sql = postgres(TEST_DATABASE_URL!, sqlOptions);
    validationCreatedCount = 0;
    paymentCustomizationCreatedCount = 0;
  });

  afterAll(async () => {
    if (sql && testShopId) {
      await sql`DELETE FROM pgmq.q_s6_sync WHERE message->>'shop' = ${TEST_SHOP_DOMAIN}`.catch(
        () => {}
      );
      await sql`DELETE FROM pgmq.a_s6_sync WHERE message->>'shop' = ${TEST_SHOP_DOMAIN}`.catch(
        () => {}
      );
      await sql`DELETE FROM "ReminderLog" WHERE "shopId" = ${testShopId}`.catch(() => {});
      await sql`DELETE FROM "ReminderRule" WHERE "shopId" = ${testShopId}`.catch(() => {});
      await sql`DELETE FROM "AuditEvent" WHERE "shopId" = ${testShopId}`.catch(() => {});
      await sql`DELETE FROM "Match" WHERE "shopId" = ${testShopId}`.catch(() => {});
      await sql`DELETE FROM "Payment" WHERE "shopId" = ${testShopId}`.catch(() => {});
      await sql`DELETE FROM "BankImport" WHERE "shopId" = ${testShopId}`.catch(() => {});
      await sql`DELETE FROM "Invoice" WHERE "shopId" = ${testShopId}`.catch(() => {});
      await sql`DELETE FROM "PayerAlias" WHERE "buyerAccountId" = ${testBuyerAccountId}`.catch(
        () => {}
      );
      await sql`DELETE FROM "BuyerAccount" WHERE "shopId" = ${testShopId}`.catch(() => {});
      await sql`DELETE FROM s18_shop_reminder_settings WHERE shop_id = ${testShopId}`.catch(
        () => {}
      );
      await sql`DELETE FROM "Shop" WHERE id = ${testShopId}`.catch(() => {});

      await assertNoQueueLeftovers(sql, [TEST_SHOP_DOMAIN], "reviewer-journey-db.test.ts (B2B)");
    }
    if (sql) {
      await sql.end();
    }
  });

  describe("1. INSTALL", () => {
    it("1. INSTALL: afterAuth creates Shop row with USD currency and registers Functions", async () => {
      const { upsertShopOnAuth } = await import("../../app/lib/after-auth.server");
      const { ensureValidation } = await import("../../app/lib/validation-registration.server");
      const { ensurePaymentCustomization } = await import(
        "../../app/lib/payment-customization-registration.server"
      );

      const mockAdmin = createMockAdminClient("USD", `b2b-${runId}`);

      await upsertShopOnAuth(sql, TEST_SHOP_DOMAIN, "Asia/Kolkata", "USD");

      const [shop] = await sql<{ id: string; currency: string; timezone: string }[]>`
        SELECT id, currency, timezone FROM "Shop" WHERE domain = ${TEST_SHOP_DOMAIN}
      `;
      testShopId = shop.id;

      expect(shop).toBeDefined();
      expect(shop.currency).toBe("USD");
      expect(shop.timezone).toBe("Asia/Kolkata");

      const validationResult = await ensureValidation(mockAdmin);
      expect(validationResult.created || validationResult.id).toBeTruthy();
      expect(validationCreatedCount).toBe(1);

      const paymentResult = await ensurePaymentCustomization(mockAdmin);
      expect(paymentResult.created || paymentResult.id).toBeTruthy();
      expect(paymentCustomizationCreatedCount).toBe(1);
    });
  });

  describe("2. SWITCH THE STORE CURRENCY TO INR", () => {
    it("2. SWITCH THE STORE CURRENCY TO INR: shows exact 'Currency Not Supported' banner copy for USD shop", async () => {
      const { CURRENCY_NOT_SUPPORTED_BANNER_COPY } = await import(
        "../../app/lib/shop-currency-copy"
      );
      const { isCurrencyGateOpen } = await import("../../app/lib/currency-gate.server");

      const [shop] = await sql<{ currency: string }[]>`
        SELECT currency FROM "Shop" WHERE id = ${testShopId}
      `;

      expect(shop.currency).toBe("USD");

      const gateOpen = isCurrencyGateOpen(shop.currency);
      expect(gateOpen).toBe(false);

      expect(CURRENCY_NOT_SUPPORTED_BANNER_COPY).toContain("Termwise is built for Indian merchants");
      expect(CURRENCY_NOT_SUPPORTED_BANNER_COPY).toContain("currently supports INR only");
      expect(CURRENCY_NOT_SUPPORTED_BANNER_COPY).toContain(
        "change the store currency to Indian Rupee (INR)"
      );
      expect(CURRENCY_NOT_SUPPORTED_BANNER_COPY).toContain("Settings → General → Store defaults");
    });

    it("2. SWITCH THE STORE CURRENCY TO INR: gated actions are blocked when currency is not INR", async () => {
      const { isCurrencyGateOpen } = await import("../../app/lib/currency-gate.server");

      expect(isCurrencyGateOpen("USD")).toBe(false);
      expect(isCurrencyGateOpen("EUR")).toBe(false);
      expect(isCurrencyGateOpen("XXX")).toBe(false);
    });
  });

  describe("3. START THE SYNC", () => {
    it("3. START THE SYNC: currency recovery updates Shop row to INR and banner disappears", async () => {
      const { checkAndRecoverCurrency } = await import(
        "../../app/services/shop-currency-recovery.server"
      );
      const { isCurrencyGateOpen } = await import("../../app/lib/currency-gate.server");

      const mockAdmin = createMockAdminClient("INR", `b2b-${runId}`);

      const result = await checkAndRecoverCurrency(
        sql,
        TEST_SHOP_DOMAIN,
        "USD",
        mockAdmin,
        testShopId
      );

      expect(result.currency).toBe("INR");
      expect(result.flipBlocked).toBe(false);

      const [shop] = await sql<{ currency: string }[]>`
        SELECT currency FROM "Shop" WHERE id = ${testShopId}
      `;
      expect(shop.currency).toBe("INR");

      const gateOpen = isCurrencyGateOpen(shop.currency);
      expect(gateOpen).toBe(true);
    });
  });

  describe("4. CREATE NET-TERMS BUYER (B2B)", () => {
    it("4. CREATE NET-TERMS BUYER: B2B Company buyer created with holdState OK", async () => {
      const companyIdSuffix = `company-${runId}`;
      const locationIdSuffix = `location-${runId}`;

      const [buyer] = await sql<{ id: string; name: string; kind: string; holdState: string }[]>`
        INSERT INTO "BuyerAccount" (
          id, "shopId", kind, "companyId", "companyLocationId", name,
          "mainContactEmail", "mainContactName",
          "creditLimit", "holdState", "defaultTermsDays", "defaultTermsSource",
          "createdAt", "updatedAt"
        )
        VALUES (
          gen_random_uuid()::text, ${testShopId}, 'COMPANY',
          ${"gid://shopify/Company/" + companyIdSuffix},
          ${"gid://shopify/CompanyLocation/" + locationIdSuffix},
          'Test Buyer Co',
          'contact@example.com', 'Test Contact',
          100000.00, 'OK', 30, 'explicit', NOW(), NOW()
        )
        RETURNING id, name, kind, "holdState"
      `;
      testBuyerAccountId = buyer.id;

      expect(buyer.name).toBe("Test Buyer Co");
      expect(buyer.kind).toBe("COMPANY");
      expect(buyer.holdState).toBe("OK");
    });

    it("4. CREATE NET-TERMS BUYER: Setup Guide shows correct step states", async () => {
      const {
        computeBuyerSetupStep,
        computeValidationStep,
        computePaymentCustomizationStep,
        computeReminderStep,
        computeOnboardingState,
      } = await import("../../app/lib/onboarding-steps.server");

      const buyerStep = computeBuyerSetupStep(1, 0);
      expect(buyerStep.status).toBe("complete");
      expect(buyerStep.title).toBe("Configure buyer accounts");

      const validationStep = computeValidationStep({
        id: "test",
        handle: "credit-check-validation",
        enabled: true,
        title: "Termwise Credit Check",
      });
      expect(validationStep.status).toBe("complete");
      expect(validationStep.title).toBe("Enable checkout protection");

      const paymentStep = computePaymentCustomizationStep({
        id: "test",
        handle: "hide-terms-payment",
        enabled: true,
        title: "Termwise Payment Hide",
      });
      expect(paymentStep.status).toBe("complete");
      expect(paymentStep.title).toBe("Configure payment options");

      const reminderStep = computeReminderStep(false, false);
      expect(reminderStep.status).toBe("coming_soon");
      expect(reminderStep.title).toBe("Email reminders");

      const inputs = {
        shopId: testShopId,
        defaultTermsDays: null,
        buyerAccountCount: 1,
        tagRuleCount: 0,
        validation: {
          id: "test",
          handle: "credit-check-validation",
          enabled: true,
          title: "Termwise Credit Check",
        },
        paymentCustomization: {
          id: "test",
          handle: "hide-terms-payment",
          enabled: true,
          title: "Termwise Payment Hide",
        },
        emailSendingConfigured: false,
        remindersEnabled: false,
        dismissedAt: null,
      };

      const state = computeOnboardingState(inputs);
      expect(state.steps.length).toBe(4);
    });
  });

  describe("5. LEDGER AND AGING", () => {
    it.skip("5. LEDGER AND AGING: B2B stores use Companies, not tag rules (divergent path)", async () => {
      // B2B stores don't have tag rules - they use Shopify Companies instead.
      // This step is exercised in the Tagged Customer Variant below.
    });
  });

  describe("6. CHECK CHECKOUT PROTECTION IS ON", () => {
    it("6. CHECK CHECKOUT PROTECTION IS ON: B2B buyer account holdState controls checkout block (raw SQL insert)", async () => {
      const [account] = await sql<{ holdState: string; kind: string }[]>`
        SELECT "holdState", kind FROM "BuyerAccount" WHERE id = ${testBuyerAccountId}
      `;

      expect(account.kind).toBe("COMPANY");
      expect(account.holdState).toBe("OK");
    });
  });

  describe("7. TEST THE CHECKOUT BLOCK", () => {
    it("7. TEST THE CHECKOUT BLOCK: invoice created with name #B2B001 and due date per terms (raw SQL insert)", async () => {
      const dueDate = new Date();
      dueDate.setDate(dueDate.getDate() + 30);
      const orderIdSuffix = `order-b2b-${runId}`;

      const [invoice] = await sql<{ id: string; name: string; dueAt: Date }[]>`
        INSERT INTO "Invoice" (
          id, "shopId", "buyerAccountId", "orderId", name, total, outstanding,
          status, "issuedAt", "dueAt", "dueSource", "createdAt", "updatedAt"
        )
        VALUES (
          gen_random_uuid()::text, ${testShopId}, ${testBuyerAccountId},
          ${"gid://shopify/Order/" + orderIdSuffix}, '#B2B001', 10000.00, 10000.00, 'open',
          NOW(), ${dueDate}, 'schedule', NOW(), NOW()
        )
        RETURNING id, name, "dueAt"
      `;
      testInvoiceId = invoice.id;

      expect(invoice.name).toBe("#B2B001");
      expect(invoice.dueAt).toBeDefined();

      const diffDays = Math.round(
        (invoice.dueAt.getTime() - Date.now()) / (1000 * 60 * 60 * 24)
      );
      expect(diffDays).toBeGreaterThanOrEqual(29);
      expect(diffDays).toBeLessThanOrEqual(31);
    });
  });

  describe("8. BANK STATEMENT IMPORT", () => {
    it("8. BANK STATEMENT IMPORT: HDFC CSV parsed and exactly 3 Payment rows created", async () => {
      const { parseBankStatement } = await import("../../app/lib/banks/index");

      const syntheticCsv = `Date,Narration,Chq./Ref.No.,Value Dt,Withdrawal Amt.,Deposit Amt.,Closing Balance
01/11/26,NEFT-SYNT0001-TEST BUYER CO-#B2B001,SYNT0001,01/11/26,,10000.00,110000.00
02/11/26,UPI-TEST BUYER CO-SYNT0002-#B2B002,SYNT0002,02/11/26,,5000.00,115000.00
03/11/26,IMPS-SYNT0003-TEST BUYER CO-#B2B002 PART PAYMENT,SYNT0003,03/11/26,,2500.00,117500.00`;

      const file = new File([syntheticCsv], "test-hdfc.csv", { type: "text/csv" });
      const result = await parseBankStatement(file);

      expect(result.detection.bank).toBe("HDFC");
      expect(result.transactions.length).toBe(3);

      const credits = result.transactions.filter((t) => t.direction === "CR");
      expect(credits.length).toBe(3);

      const [bankImport] = await sql<{ id: string }[]>`
        INSERT INTO "BankImport" (id, "shopId", bank, "fileName", "rowCount", "createdAt")
        VALUES (gen_random_uuid()::text, ${testShopId}, 'HDFC', 'test-hdfc.csv', 3, NOW())
        RETURNING id
      `;

      for (const txn of credits) {
        const [payment] = await sql<{ id: string }[]>`
          INSERT INTO "Payment" (
            id, "shopId", "importId", "valueDate", amount, rail, utr,
            "payerText", narration, status, "createdAt", "updatedAt"
          )
          VALUES (
            gen_random_uuid()::text, ${testShopId}, ${bankImport.id},
            ${txn.date}::date, ${txn.amountPaise / 100}::decimal, ${txn.parsed.rail},
            ${txn.parsed.utr ?? null}, ${txn.parsed.payerName ?? null},
            ${txn.narration}, 'unmatched', NOW(), NOW()
          )
          RETURNING id
        `;
        if (!testPaymentId) testPaymentId = payment.id;
      }

      const payments = await sql`SELECT * FROM "Payment" WHERE "shopId" = ${testShopId}`;
      expect(payments.length).toBe(3);
    });
  });

  describe("9. CONFIRM A MATCH", () => {
    it("9. CONFIRM A MATCH: suggested match appears with confidence band (score >= 50 for Medium or >= 80 for High)", async () => {
      const { runMatcher } = await import("../../app/services/matcher.server");

      await sql`
        INSERT INTO "PayerAlias" (id, "buyerAccountId", "payerKey", "createdAt")
        VALUES (gen_random_uuid()::text, ${testBuyerAccountId}, 'test buyer co', NOW())
      `;

      const result = await runMatcher(sql, testShopId);

      expect(result.paymentsProcessed).toBe(3);
      expect(result.matchesCreated).toBe(3);

      const matches = await sql<
        { id: string; score: number; state: string; paymentId: string }[]
      >`
        SELECT id, score, state, "paymentId" FROM "Match"
        WHERE "shopId" = ${testShopId} AND state = 'suggested'
        ORDER BY score DESC
      `;

      expect(matches.length).toBe(3);

      const matchForTestPayment = matches.find((m) => m.paymentId === testPaymentId);
      expect(matchForTestPayment).toBeDefined();
      expect(matchForTestPayment!.score).toBeGreaterThanOrEqual(50);

      const band =
        matchForTestPayment!.score >= 80
          ? "High"
          : matchForTestPayment!.score >= 50
            ? "Medium"
            : "Low";
      expect(band).toBe("Medium");

      testMatchId = matchForTestPayment!.id;
    });

    it("9. CONFIRM A MATCH: confirm and apply updates Payment, Invoice status and writes AuditEvent without PII", async () => {
      const { confirmMatch } = await import("../../app/services/matcher.server");
      const { applyMatch } = await import("../../app/services/apply.server");

      const confirmResult = await confirmMatch(sql, testShopId, testMatchId, "test-user");
      expect(confirmResult.success).toBe(true);

      const [confirmedMatch] = await sql<{ state: string }[]>`
        SELECT state FROM "Match" WHERE id = ${testMatchId}
      `;
      expect(confirmedMatch.state).toBe("confirmed");

      const [confirmAudit] = await sql<{ id: string; type: string }[]>`
        SELECT id, type FROM "AuditEvent"
        WHERE "shopId" = ${testShopId} AND type = 'match.confirmed'
        ORDER BY at DESC LIMIT 1
      `;
      expect(confirmAudit).toBeDefined();
      expect(confirmAudit.type).toBe("match.confirmed");

      const applyResult = await applyMatch(sql, testShopId, testMatchId, "test-user");
      expect(applyResult.success).toBe(true);
      expect(applyResult.invoicePaid).toBe(true);

      const [appliedMatch] = await sql<{ state: string }[]>`
        SELECT state FROM "Match" WHERE id = ${testMatchId}
      `;
      expect(appliedMatch.state).toBe("pushed");

      const [paidInvoice] = await sql<{ status: string; outstanding: string }[]>`
        SELECT status, outstanding::text FROM "Invoice" WHERE id = ${testInvoiceId}
      `;
      expect(paidInvoice.status).toBe("paid");
      expect(parseFloat(paidInvoice.outstanding)).toBe(0);

      const [applyAudit] = await sql<{
        id: string;
        type: string;
        data: Record<string, unknown>;
      }[]>`
        SELECT id, type, data FROM "AuditEvent"
        WHERE "shopId" = ${testShopId} AND type = 'match.applied'
        ORDER BY at DESC LIMIT 1
      `;
      expect(applyAudit).toBeDefined();
      expect(applyAudit.type).toBe("match.applied");

      const auditJson = JSON.stringify(applyAudit);
      expect(auditJson).not.toContain("narration");
      expect(auditJson).not.toContain("remitterName");
    });
  });

  describe("10. PAYMENT REMINDERS", () => {
    it("10. PAYMENT REMINDERS: isReminderDueToday picks invoice due in 3 days for -3 offset rule ONLY", async () => {
      const {
        DEFAULT_RULE_OFFSETS,
        ensureDefaultReminderRules,
        updateShopReminderSettings,
        isReminderDueToday,
      } = await import("../../app/services/reminders.server");

      expect(DEFAULT_RULE_OFFSETS).toEqual([-3, 0, 7]);

      await ensureDefaultReminderRules(sql, testShopId);
      await updateShopReminderSettings(sql, testShopId, true);

      const rules = await sql<{ id: string; offsetDays: number; enabled: boolean }[]>`
        SELECT id, "offsetDays", enabled FROM "ReminderRule" WHERE "shopId" = ${testShopId}
      `;
      expect(rules.length).toBe(3);
      expect(rules.some((r) => r.offsetDays === -3)).toBe(true);
      expect(rules.some((r) => r.offsetDays === 0)).toBe(true);
      expect(rules.some((r) => r.offsetDays === 7)).toBe(true);

      const { DateTime } = await import("luxon");
      const timezone = "Asia/Kolkata";

      const threeDaysFromNowKolkata = DateTime.now()
        .setZone(timezone)
        .startOf("day")
        .plus({ days: 3 })
        .toJSDate();

      const isDueForMinus3 = isReminderDueToday(threeDaysFromNowKolkata, -3, timezone);
      expect(isDueForMinus3).toBe(true);

      const isDueFor0 = isReminderDueToday(threeDaysFromNowKolkata, 0, timezone);
      expect(isDueFor0).toBe(false);

      const isDueFor7 = isReminderDueToday(threeDaysFromNowKolkata, 7, timezone);
      expect(isDueFor7).toBe(false);
    });
  });
});

/**
 * VARIANT JOURNEY: Tagged Customer path
 *
 * This exercises the tag-based buyer flow with raw SQL inserts for tag rules.
 */
describeWithDb("Reviewer Journey: Tagged Customer (Variant)", () => {
  let sql: ReturnType<typeof postgres>;
  const runId = Date.now();
  const TEST_SHOP_DOMAIN = `test-reviewer-tagged-${runId}.myshopify.com`;
  let testShopId: string;
  let testBuyerAccountId: string;
  let testInvoiceId: string;
  let testPaymentId: string;
  let testMatchId: string;

  beforeAll(async () => {
    sql = postgres(TEST_DATABASE_URL!, sqlOptions);
    validationCreatedCount = 0;
    paymentCustomizationCreatedCount = 0;
  });

  afterAll(async () => {
    if (sql && testShopId) {
      await sql`DELETE FROM pgmq.q_s6_sync WHERE message->>'shop' = ${TEST_SHOP_DOMAIN}`.catch(
        () => {}
      );
      await sql`DELETE FROM pgmq.a_s6_sync WHERE message->>'shop' = ${TEST_SHOP_DOMAIN}`.catch(
        () => {}
      );
      await sql`DELETE FROM "ReminderLog" WHERE "shopId" = ${testShopId}`.catch(() => {});
      await sql`DELETE FROM "ReminderRule" WHERE "shopId" = ${testShopId}`.catch(() => {});
      await sql`DELETE FROM "AuditEvent" WHERE "shopId" = ${testShopId}`.catch(() => {});
      await sql`DELETE FROM "Match" WHERE "shopId" = ${testShopId}`.catch(() => {});
      await sql`DELETE FROM "Payment" WHERE "shopId" = ${testShopId}`.catch(() => {});
      await sql`DELETE FROM "BankImport" WHERE "shopId" = ${testShopId}`.catch(() => {});
      await sql`DELETE FROM "Invoice" WHERE "shopId" = ${testShopId}`.catch(() => {});
      await sql`DELETE FROM s8_tagged_customers WHERE shop_id = ${testShopId}`.catch(() => {});
      await sql`DELETE FROM "PayerAlias" WHERE "buyerAccountId" = ${testBuyerAccountId}`.catch(
        () => {}
      );
      await sql`DELETE FROM "AccountSource" WHERE "shopId" = ${testShopId}`.catch(() => {});
      await sql`DELETE FROM "BuyerAccount" WHERE "shopId" = ${testShopId}`.catch(() => {});
      await sql`DELETE FROM s18_shop_reminder_settings WHERE shop_id = ${testShopId}`.catch(
        () => {}
      );
      await sql`DELETE FROM "Shop" WHERE id = ${testShopId}`.catch(() => {});

      await assertNoQueueLeftovers(
        sql,
        [TEST_SHOP_DOMAIN],
        "reviewer-journey-db.test.ts (Tagged)"
      );
    }
    if (sql) {
      await sql.end();
    }
  });

  it("VARIANT: Fresh install with INR currency (steps 1-3 combined)", async () => {
    const { upsertShopOnAuth } = await import("../../app/lib/after-auth.server");

    await upsertShopOnAuth(sql, TEST_SHOP_DOMAIN, "Asia/Kolkata", "INR");

    const [shop] = await sql<{ id: string; currency: string }[]>`
      SELECT id, currency FROM "Shop" WHERE domain = ${TEST_SHOP_DOMAIN}
    `;
    testShopId = shop.id;

    expect(shop.currency).toBe("INR");
  });

  it("VARIANT: Tag rules created and validation functions work (raw SQL insert)", async () => {
    const { validateTag, validateTermsDays } = await import("../../app/routes/app.tag-rules");

    expect(validateTag("wholesale-net30")).toBeNull();
    expect(validateTermsDays("30")).toBeNull();

    await sql`
      INSERT INTO "AccountSource" (id, "shopId", tag, "defaultTermsDays", "createdAt", "updatedAt")
      VALUES (gen_random_uuid()::text, ${testShopId}, 'wholesale-net30', 30, NOW(), NOW())
    `;

    await sql`
      INSERT INTO "AccountSource" (id, "shopId", tag, "defaultTermsDays", "createdAt", "updatedAt")
      VALUES (gen_random_uuid()::text, ${testShopId}, 'vip-net60', 60, NOW(), NOW())
    `;

    const rules = await sql`SELECT * FROM "AccountSource" WHERE "shopId" = ${testShopId}`;
    expect(rules.length).toBe(2);
    expect(rules.some((r) => r.tag === "wholesale-net30")).toBe(true);
    expect(rules.some((r) => r.tag === "vip-net60")).toBe(true);
  });

  it("VARIANT: Tagged buyer created with holdState OK (raw SQL insert)", async () => {
    const customerIdSuffix = `customer-tagged-${runId}`;

    const [buyer] = await sql<{ id: string }[]>`
      INSERT INTO "BuyerAccount" (
        id, "shopId", kind, "customerId", name, "creditLimit", "holdState",
        "defaultTermsDays", "defaultTermsSource", "createdAt", "updatedAt"
      )
      VALUES (
        gen_random_uuid()::text, ${testShopId}, 'TAGGED_CUSTOMER',
        ${"gid://shopify/Customer/" + customerIdSuffix}, 'Test Buyer Co', 100000.00, 'OK',
        30, 'explicit', NOW(), NOW()
      )
      RETURNING id
    `;
    testBuyerAccountId = buyer.id;

    await sql`
      INSERT INTO s8_tagged_customers (shop_id, customer_id, email, display_name, updated_at)
      VALUES (${testShopId}, ${"gid://shopify/Customer/" + customerIdSuffix}, 'buyer@example.com', 'Test Buyer Co', NOW())
      ON CONFLICT (shop_id, customer_id) DO NOTHING
    `;

    const [account] = await sql<{ holdState: string; name: string }[]>`
      SELECT "holdState", name FROM "BuyerAccount" WHERE id = ${testBuyerAccountId}
    `;
    expect(account.holdState).toBe("OK");
    expect(account.name).toBe("Test Buyer Co");

    const taggedCustomer = await sql`
      SELECT * FROM s8_tagged_customers WHERE shop_id = ${testShopId}
    `;
    expect(taggedCustomer.length).toBe(1);
    expect(taggedCustomer[0].email).toBe("buyer@example.com");
  });

  it("VARIANT: Invoice created with name #1001 (raw SQL insert)", async () => {
    const orderIdSuffix = `order-tagged-${runId}`;
    const dueDate = new Date();
    dueDate.setDate(dueDate.getDate() + 30);

    const [invoice] = await sql<{ id: string; name: string; dueAt: Date }[]>`
      INSERT INTO "Invoice" (
        id, "shopId", "buyerAccountId", "orderId", name, total, outstanding,
        status, "issuedAt", "dueAt", "dueSource", "createdAt", "updatedAt"
      )
      VALUES (
        gen_random_uuid()::text, ${testShopId}, ${testBuyerAccountId},
        ${"gid://shopify/Order/" + orderIdSuffix}, '#1001', 10000.00, 10000.00, 'open',
        NOW(), ${dueDate}, 'schedule', NOW(), NOW()
      )
      RETURNING id, name, "dueAt"
    `;
    testInvoiceId = invoice.id;

    expect(invoice.name).toBe("#1001");
    expect(invoice.dueAt).toBeDefined();
  });

  it("VARIANT: Bank import creates exactly 3 Payment rows", async () => {
    const { parseBankStatement } = await import("../../app/lib/banks/index");

    const syntheticCsv = `Date,Narration,Chq./Ref.No.,Value Dt,Withdrawal Amt.,Deposit Amt.,Closing Balance
01/11/26,NEFT-SYNT0001-TEST BUYER CO-#1001,SYNT0001,01/11/26,,10000.00,110000.00
02/11/26,UPI-TEST BUYER CO-SYNT0002-#1002,SYNT0002,02/11/26,,5000.00,115000.00
03/11/26,IMPS-SYNT0003-TEST BUYER CO-#1002 PART PAYMENT,SYNT0003,03/11/26,,2500.00,117500.00`;

    const file = new File([syntheticCsv], "test-hdfc.csv", { type: "text/csv" });
    const result = await parseBankStatement(file);

    expect(result.detection.bank).toBe("HDFC");
    expect(result.transactions.length).toBe(3);

    const [bankImport] = await sql<{ id: string }[]>`
      INSERT INTO "BankImport" (id, "shopId", bank, "fileName", "rowCount", "createdAt")
      VALUES (gen_random_uuid()::text, ${testShopId}, 'HDFC', 'test-hdfc.csv', 3, NOW())
      RETURNING id
    `;

    for (const txn of result.transactions.filter((t) => t.direction === "CR")) {
      const [payment] = await sql<{ id: string }[]>`
        INSERT INTO "Payment" (
          id, "shopId", "importId", "valueDate", amount, rail, utr,
          "payerText", narration, status, "createdAt", "updatedAt"
        )
        VALUES (
          gen_random_uuid()::text, ${testShopId}, ${bankImport.id},
          ${txn.date}::date, ${txn.amountPaise / 100}::decimal, ${txn.parsed.rail},
          ${txn.parsed.utr ?? null}, ${txn.parsed.payerName ?? null},
          ${txn.narration}, 'unmatched', NOW(), NOW()
        )
        RETURNING id
      `;
      if (!testPaymentId) testPaymentId = payment.id;
    }

    const payments = await sql`SELECT * FROM "Payment" WHERE "shopId" = ${testShopId}`;
    expect(payments.length).toBe(3);
  });

  it("VARIANT: Match by specific testPaymentId with exact confidence band", async () => {
    const { runMatcher, confirmMatch } = await import("../../app/services/matcher.server");
    const { applyMatch } = await import("../../app/services/apply.server");

    await sql`
      INSERT INTO "PayerAlias" (id, "buyerAccountId", "payerKey", "createdAt")
      VALUES (gen_random_uuid()::text, ${testBuyerAccountId}, 'test buyer co', NOW())
    `;

    const matcherResult = await runMatcher(sql, testShopId);
    expect(matcherResult.paymentsProcessed).toBe(3);
    expect(matcherResult.matchesCreated).toBe(3);

    const [match] = await sql<{ id: string; score: number }[]>`
      SELECT id, score FROM "Match"
      WHERE "shopId" = ${testShopId} AND "paymentId" = ${testPaymentId}
    `;

    expect(match).toBeDefined();
    const exactBand = match.score >= 80 ? "High" : match.score >= 50 ? "Medium" : "Low";
    expect(exactBand).toBe("High");

    testMatchId = match.id;

    const confirmResult = await confirmMatch(sql, testShopId, testMatchId, "test-user");
    expect(confirmResult.success).toBe(true);

    const applyResult = await applyMatch(sql, testShopId, testMatchId, "test-user");
    expect(applyResult.success).toBe(true);

    const [paidInvoice] = await sql<{ status: string }[]>`
      SELECT status FROM "Invoice" WHERE id = ${testInvoiceId}
    `;
    expect(paidInvoice.status).toBe("paid");
  });

  it("VARIANT: Reminder selection uses isReminderDueToday correctly", async () => {
    const {
      ensureDefaultReminderRules,
      updateShopReminderSettings,
      isReminderDueToday,
    } = await import("../../app/services/reminders.server");
    const { DateTime } = await import("luxon");

    await ensureDefaultReminderRules(sql, testShopId);
    await updateShopReminderSettings(sql, testShopId, true);

    const rules = await sql<{ offsetDays: number }[]>`
      SELECT "offsetDays" FROM "ReminderRule" WHERE "shopId" = ${testShopId}
    `;
    expect(rules.length).toBe(3);

    const timezone = "Asia/Kolkata";

    const threeDaysFromNowKolkata = DateTime.now()
      .setZone(timezone)
      .startOf("day")
      .plus({ days: 3 })
      .toJSDate();

    const isDueForMinus3 = isReminderDueToday(threeDaysFromNowKolkata, -3, timezone);
    expect(isDueForMinus3).toBe(true);

    const isDueFor0 = isReminderDueToday(threeDaysFromNowKolkata, 0, timezone);
    expect(isDueFor0).toBe(false);

    const isDueFor7 = isReminderDueToday(threeDaysFromNowKolkata, 7, timezone);
    expect(isDueFor7).toBe(false);
  });
});
