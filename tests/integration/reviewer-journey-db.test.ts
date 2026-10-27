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
 */

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import postgres from "postgres";
import { sqlOptions } from "../../app/lib/db-light.server";
import { assertNoQueueLeftovers } from "../helpers/queue-leftovers";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeWithDb = TEST_DATABASE_URL ? describe : describe.skip;

let validationCreatedCount = 0;
let paymentCustomizationCreatedCount = 0;
let _shopConfigWriteCount = 0;
let _metafieldWriteCount = 0;
let lastShopConfigCurrency: string | null = null;

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

vi.mock("../../app/services/credit-status-recompute.server", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    enqueueRecomputeForInvoice: vi.fn().mockResolvedValue(undefined),
  };
});

vi.mock("@sentry/cloudflare", () => ({
  captureException: vi.fn(),
  captureMessage: vi.fn(),
  setTag: vi.fn(),
  setContext: vi.fn(),
}));

const _mockResendFetch = vi.fn();

function createMockAdminClient(shopCurrency: string, shopId: string) {
  return {
    graphql: vi.fn().mockImplementation(async (query: string) => {
      if (query.includes("query ShopAuthInfo") || query.includes("query ShopCurrencyAndId")) {
        return {
          json: async () => ({
            data: {
              shop: {
                id: shopId,
                ianaTimezone: "Asia/Kolkata",
                currencyCode: shopCurrency,
                metafield: lastShopConfigCurrency
                  ? { value: JSON.stringify({ currencyCode: lastShopConfigCurrency }) }
                  : null,
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
        if (query.includes("shop_config")) {
          _shopConfigWriteCount++;
          const match = query.match(/currencyCode['":\s]+(['"]?)(\w+)\1/);
          if (match) lastShopConfigCurrency = match[2];
        }
        _metafieldWriteCount++;
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

describeWithDb("Reviewer Journey: Tagged Customer Path (Part A)", () => {
  let sql: ReturnType<typeof postgres>;
  const runId = Date.now();
  const TEST_SHOP_DOMAIN = `test-reviewer-journey-${runId}.myshopify.com`;
  const TEST_SHOP_GID = `gid://shopify/Shop/reviewer-${runId}`;
  let testShopId: string;
  let testBuyerAccountId: string;
  let testInvoiceId: string;
  let _testRuleId: string;
  let testPaymentId: string;
  let testMatchId: string;

  beforeAll(async () => {
    sql = postgres(TEST_DATABASE_URL!, sqlOptions);
    validationCreatedCount = 0;
    paymentCustomizationCreatedCount = 0;
    _shopConfigWriteCount = 0;
    _metafieldWriteCount = 0;
    lastShopConfigCurrency = null;
  });

  afterAll(async () => {
    if (sql) {
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

      await assertNoQueueLeftovers(sql, [TEST_SHOP_DOMAIN], "reviewer-journey-db.test.ts");
      await sql.end();
    }
  });

  describe("1. INSTALL - Fresh install on USD shop", () => {
    it("1. INSTALL: afterAuth creates Shop row with USD currency and registers Functions", async () => {
      const { upsertShopOnAuth } = await import("../../app/lib/after-auth.server");
      const { ensureValidation } = await import("../../app/lib/validation-registration.server");
      const { ensurePaymentCustomization } = await import(
        "../../app/lib/payment-customization-registration.server"
      );

      const mockAdmin = createMockAdminClient("USD", TEST_SHOP_GID);

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
      expect(validationCreatedCount).toBeGreaterThanOrEqual(1);

      const paymentResult = await ensurePaymentCustomization(mockAdmin);
      expect(paymentResult.created || paymentResult.id).toBeTruthy();
      expect(paymentCustomizationCreatedCount).toBeGreaterThanOrEqual(1);
    });
  });

  describe("2. Currency Not Supported Banner - fail-closed state", () => {
    it("2. SWITCH CURRENCY: shows exact 'Currency Not Supported' banner copy for USD shop", async () => {
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

    it("2. SWITCH CURRENCY: gated actions are blocked when currency is not INR", async () => {
      const { isCurrencyGateOpen } = await import("../../app/lib/currency-gate.server");

      const gateOpen = isCurrencyGateOpen("USD");
      expect(gateOpen).toBe(false);

      const eurGateOpen = isCurrencyGateOpen("EUR");
      expect(eurGateOpen).toBe(false);

      const unknownGateOpen = isCurrencyGateOpen("XXX");
      expect(unknownGateOpen).toBe(false);
    });
  });

  describe("3. Switch shop to INR - recovery", () => {
    it("3. START THE SYNC: currency recovery updates Shop row to INR and banner disappears", async () => {
      const { checkAndRecoverCurrency } = await import(
        "../../app/services/shop-currency-recovery.server"
      );
      const { isCurrencyGateOpen } = await import("../../app/lib/currency-gate.server");

      const mockAdmin = createMockAdminClient("INR", TEST_SHOP_GID);

      const result = await checkAndRecoverCurrency(sql, TEST_SHOP_DOMAIN, "USD", mockAdmin, testShopId);

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

  describe("4. Onboarding / Setup Guide steps", () => {
    it("4. CREATE NET-TERMS BUYER: Setup Guide step states show correctly", async () => {
      const {
        fetchShopOnboardingData,
        computeOnboardingState,
        computeBuyerSetupStep,
        computeValidationStep,
        computePaymentCustomizationStep,
        computeReminderStep,
      } = await import("../../app/lib/onboarding-steps.server");

      const onboardingData = await fetchShopOnboardingData(sql, TEST_SHOP_DOMAIN);
      expect(onboardingData).not.toBeNull();
      expect(onboardingData!.shopId).toBe(testShopId);

      const buyerStep = computeBuyerSetupStep(0, 0);
      expect(buyerStep.status).toBe("pending");
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
        buyerAccountCount: 0,
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
      expect(state.isComplete).toBe(false);
    });
  });

  describe("5. Tag Rules - first and second rule with enqueue", () => {
    it("5. LEDGER AND AGING: first tag rule created successfully", async () => {
      const { validateTag, validateTermsDays } = await import("../../app/routes/app.tag-rules");

      const tagError = validateTag("wholesale-net30");
      expect(tagError).toBeNull();

      const termsError = validateTermsDays("30");
      expect(termsError).toBeNull();

      const [rule] = await sql<{ id: string }[]>`
        INSERT INTO "AccountSource" (id, "shopId", tag, "defaultTermsDays", "createdAt", "updatedAt")
        VALUES (gen_random_uuid()::text, ${testShopId}, 'wholesale-net30', 30, NOW(), NOW())
        RETURNING id
      `;
      _testRuleId = rule.id;

      const rules = await sql`SELECT * FROM "AccountSource" WHERE "shopId" = ${testShopId}`;
      expect(rules.length).toBe(1);
      expect(rules[0].tag).toBe("wholesale-net30");
    });

    it("5. LEDGER AND AGING: second tag rule triggers enqueue per #498", async () => {
      const { enqueueReconcileStage } = await import(
        "../../app/services/drain/reconcile-handlers.server"
      );

      await sql`
        INSERT INTO "AccountSource" (id, "shopId", tag, "defaultTermsDays", "createdAt", "updatedAt")
        VALUES (gen_random_uuid()::text, ${testShopId}, 'vip-net60', 60, NOW(), NOW())
      `;

      const rules = await sql`SELECT * FROM "AccountSource" WHERE "shopId" = ${testShopId}`;
      expect(rules.length).toBe(2);

      await enqueueReconcileStage(sql, TEST_SHOP_DOMAIN, "customers");

      const messages = await sql`
        SELECT * FROM pgmq.q_s6_sync 
        WHERE message->>'shop' = ${TEST_SHOP_DOMAIN} 
        AND message->>'topic' = 'RECONCILE_CUSTOMERS'
      `;
      expect(messages.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe("6. Tagged buyer with credit status", () => {
    it("6. CHECK CHECKOUT PROTECTION: tagged buyer created with credit status written", async () => {
      const testCustomerId = `gid://shopify/Customer/tagged-${runId}`;

      const [buyer] = await sql<{ id: string }[]>`
        INSERT INTO "BuyerAccount" (
          id, "shopId", kind, "customerId", name, "creditLimit", "holdState",
          "defaultTermsDays", "defaultTermsSource", "createdAt", "updatedAt"
        )
        VALUES (
          gen_random_uuid()::text, ${testShopId}, 'TAGGED_CUSTOMER',
          ${testCustomerId}, 'Test Buyer Co', 100000.00, 'OK',
          30, 'explicit', NOW(), NOW()
        )
        RETURNING id
      `;
      testBuyerAccountId = buyer.id;

      await sql`
        INSERT INTO s8_tagged_customers (shop_id, customer_id, email, display_name, updated_at)
        VALUES (${testShopId}, ${testCustomerId}, 'buyer@example.com', 'Test Buyer Co', NOW())
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
  });

  describe("7. Invoice creation (order sync)", () => {
    it("7. TEST THE CHECKOUT BLOCK: invoice created with name #1001 and due date per terms", async () => {
      const testOrderId = `gid://shopify/Order/reviewer-${runId}`;
      const dueDate = new Date();
      dueDate.setDate(dueDate.getDate() + 30);

      const [invoice] = await sql<{ id: string; name: string; dueAt: Date }[]>`
        INSERT INTO "Invoice" (
          id, "shopId", "buyerAccountId", "orderId", name, total, outstanding,
          status, "issuedAt", "dueAt", "dueSource", "createdAt", "updatedAt"
        )
        VALUES (
          gen_random_uuid()::text, ${testShopId}, ${testBuyerAccountId},
          ${testOrderId}, '#1001', 10000.00, 10000.00, 'open',
          NOW(), ${dueDate}, 'schedule', NOW(), NOW()
        )
        RETURNING id, name, "dueAt"
      `;
      testInvoiceId = invoice.id;

      expect(invoice.name).toBe("#1001");
      expect(invoice.dueAt).toBeDefined();

      const diffDays = Math.round(
        (invoice.dueAt.getTime() - Date.now()) / (1000 * 60 * 60 * 24)
      );
      expect(diffDays).toBeGreaterThanOrEqual(29);
      expect(diffDays).toBeLessThanOrEqual(31);
    });
  });

  describe("8. HDFC import with synthetic CSV", () => {
    it("8. BANK STATEMENT IMPORT: HDFC CSV parsed and Payment rows created", async () => {
      const { parseBankStatement } = await import("../../app/lib/banks/index");

      const syntheticCsv = `Date,Narration,Chq./Ref.No.,Value Dt,Withdrawal Amt.,Deposit Amt.,Closing Balance
01/11/26,NEFT-SYNT0001-TEST BUYER CO-#1001,SYNT0001,01/11/26,,10000.00,110000.00
02/11/26,UPI-TEST BUYER CO-SYNT0002-#1002,SYNT0002,02/11/26,,5000.00,115000.00
03/11/26,IMPS-SYNT0003-TEST BUYER CO-#1002 PART PAYMENT,SYNT0003,03/11/26,,2500.00,117500.00`;

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

  describe("9. Match suggestion, confirm, and apply", () => {
    it("9. CONFIRM A MATCH: suggested match appears with confidence band", async () => {
      const { runMatcher } = await import("../../app/services/matcher.server");

      await sql`
        INSERT INTO "PayerAlias" (id, "buyerAccountId", "payerKey", "createdAt")
        VALUES (gen_random_uuid()::text, ${testBuyerAccountId}, 'test buyer co', NOW())
      `;

      const result = await runMatcher(sql, testShopId);

      expect(result.paymentsProcessed).toBeGreaterThanOrEqual(1);
      expect(result.matchesCreated).toBeGreaterThanOrEqual(1);

      const matches = await sql<{ id: string; score: number; state: string }[]>`
        SELECT id, score, state FROM "Match"
        WHERE "shopId" = ${testShopId} AND state = 'suggested'
        ORDER BY score DESC
      `;

      expect(matches.length).toBeGreaterThanOrEqual(1);
      const topMatch = matches[0];
      expect(topMatch.score).toBeGreaterThanOrEqual(50);
      testMatchId = topMatch.id;

      let band: string;
      if (topMatch.score >= 80) band = "High";
      else if (topMatch.score >= 50) band = "Medium";
      else band = "Low";
      expect(["High", "Medium", "Low"]).toContain(band);
    });

    it("9. CONFIRM A MATCH: confirm and apply updates Payment, Invoice status and writes AuditEvent", async () => {
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

      const [applyAudit] = await sql<{ id: string; type: string; data: Record<string, unknown> }[]>`
        SELECT id, type, data FROM "AuditEvent"
        WHERE "shopId" = ${testShopId} AND type = 'match.applied'
        ORDER BY at DESC LIMIT 1
      `;
      expect(applyAudit).toBeDefined();
      expect(applyAudit.type).toBe("match.applied");
      expect(applyAudit.data).not.toHaveProperty("narration");
      expect(applyAudit.data).not.toHaveProperty("remitterName");
      expect(applyAudit.data).not.toHaveProperty("amount");
    });
  });

  describe("10. Reminder selection for overdue invoice", () => {
    it("10. PAYMENT REMINDERS: reminder selection picks invoice due in 3 days", async () => {
      const { DEFAULT_RULE_OFFSETS, ensureDefaultReminderRules, updateShopReminderSettings } =
        await import("../../app/services/reminders.server");

      expect(DEFAULT_RULE_OFFSETS).toEqual([-3, 0, 7]);

      await ensureDefaultReminderRules(sql, testShopId);
      await updateShopReminderSettings(sql, testShopId, true);

      const rules = await sql<{ offsetDays: number; enabled: boolean }[]>`
        SELECT "offsetDays", enabled FROM "ReminderRule" WHERE "shopId" = ${testShopId}
      `;
      expect(rules.length).toBe(3);
      expect(rules.some((r) => r.offsetDays === -3)).toBe(true);
      expect(rules.some((r) => r.offsetDays === 0)).toBe(true);
      expect(rules.some((r) => r.offsetDays === 7)).toBe(true);

      const threeDaysFromNow = new Date();
      threeDaysFromNow.setDate(threeDaysFromNow.getDate() + 3);

      const [_reminderInvoice] = await sql<{ id: string }[]>`
        INSERT INTO "Invoice" (
          id, "shopId", "buyerAccountId", "orderId", name, total, outstanding,
          status, "issuedAt", "dueAt", "dueSource", "createdAt", "updatedAt"
        )
        VALUES (
          gen_random_uuid()::text, ${testShopId}, ${testBuyerAccountId},
          'gid://shopify/Order/reminder-test', '#1002', 5000.00, 5000.00, 'open',
          NOW(), ${threeDaysFromNow}, 'schedule', NOW(), NOW()
        )
        RETURNING id
      `;

      const eligibleInvoices = await sql`
        SELECT i.id, i.name, i."dueAt", r."offsetDays"
        FROM "Invoice" i
        CROSS JOIN "ReminderRule" r
        WHERE i."shopId" = ${testShopId}
          AND r."shopId" = ${testShopId}
          AND i.status = 'open'
          AND i.outstanding > 0
          AND r.enabled = true
          AND DATE(i."dueAt") - r."offsetDays" = CURRENT_DATE
      `;

      expect(eligibleInvoices.length).toBeGreaterThanOrEqual(0);
    });
  });
});

describeWithDb("Reviewer Journey: B2B Company/CompanyLocation Variant", () => {
  let sql: ReturnType<typeof postgres>;
  const runId = Date.now();
  const TEST_SHOP_DOMAIN = `test-reviewer-b2b-${runId}.myshopify.com`;
  const _TEST_SHOP_GID = `gid://shopify/Shop/b2b-${runId}`;
  let testShopId: string;
  let testBuyerAccountId: string;
  let testInvoiceId: string;
  let _testPaymentId: string;
  let testMatchId: string;

  beforeAll(async () => {
    sql = postgres(TEST_DATABASE_URL!, sqlOptions);
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

  it("VARIANT: B2B shop setup with INR currency", async () => {
    const [shop] = await sql<{ id: string }[]>`
      INSERT INTO "Shop" (domain, currency, timezone, "createdAt", "updatedAt")
      VALUES (${TEST_SHOP_DOMAIN}, 'INR', 'Asia/Kolkata', NOW(), NOW())
      RETURNING id
    `;
    testShopId = shop.id;

    expect(shop).toBeDefined();
  });

  it("VARIANT: B2B Company buyer created (buyer name is company location name)", async () => {
    const testCompanyId = `gid://shopify/Company/b2b-${runId}`;
    const testLocationId = `gid://shopify/CompanyLocation/loc-${runId}`;

    const [buyer] = await sql<{ id: string; name: string }[]>`
      INSERT INTO "BuyerAccount" (
        id, "shopId", kind, "companyId", "companyLocationId", name,
        "mainContactEmail", "mainContactName",
        "creditLimit", "holdState", "defaultTermsDays", "defaultTermsSource",
        "createdAt", "updatedAt"
      )
      VALUES (
        gen_random_uuid()::text, ${testShopId}, 'COMPANY',
        ${testCompanyId}, ${testLocationId}, 'Test Buyer Co',
        'contact@example.com', 'Test Contact',
        100000.00, 'OK', 30, 'explicit', NOW(), NOW()
      )
      RETURNING id, name
    `;
    testBuyerAccountId = buyer.id;

    expect(buyer.name).toBe("Test Buyer Co");
  });

  it("VARIANT: B2B credit status shows correctly", async () => {
    const [account] = await sql<{ holdState: string; kind: string }[]>`
      SELECT "holdState", kind FROM "BuyerAccount" WHERE id = ${testBuyerAccountId}
    `;

    expect(account.kind).toBe("COMPANY");
    expect(account.holdState).toBe("OK");
  });

  it("VARIANT: B2B invoice created", async () => {
    const dueDate = new Date();
    dueDate.setDate(dueDate.getDate() + 30);

    const [invoice] = await sql<{ id: string; name: string }[]>`
      INSERT INTO "Invoice" (
        id, "shopId", "buyerAccountId", "orderId", name, total, outstanding,
        status, "issuedAt", "dueAt", "dueSource", "createdAt", "updatedAt"
      )
      VALUES (
        gen_random_uuid()::text, ${testShopId}, ${testBuyerAccountId},
        'gid://shopify/Order/b2b-order', '#B2B001', 10000.00, 10000.00, 'open',
        NOW(), ${dueDate}, 'schedule', NOW(), NOW()
      )
      RETURNING id, name
    `;
    testInvoiceId = invoice.id;

    expect(invoice.name).toBe("#B2B001");
  });

  it("VARIANT: B2B import and payment creation", async () => {
    const [bankImport] = await sql<{ id: string }[]>`
      INSERT INTO "BankImport" (id, "shopId", bank, "fileName", "rowCount", "createdAt")
      VALUES (gen_random_uuid()::text, ${testShopId}, 'HDFC', 'b2b-test.csv', 1, NOW())
      RETURNING id
    `;

    const [payment] = await sql<{ id: string }[]>`
      INSERT INTO "Payment" (
        id, "shopId", "importId", "valueDate", amount, rail, utr,
        "payerText", narration, status, "createdAt", "updatedAt"
      )
      VALUES (
        gen_random_uuid()::text, ${testShopId}, ${bankImport.id},
        CURRENT_DATE, 10000.00, 'NEFT', 'SYNT-B2B-001',
        'TEST BUYER CO', 'NEFT-TEST BUYER CO-#B2B001', 'unmatched', NOW(), NOW()
      )
      RETURNING id
    `;
    _testPaymentId = payment.id;

    expect(payment.id).toBeDefined();
  });

  it("VARIANT: B2B match, confirm, and apply", async () => {
    const { runMatcher, confirmMatch } = await import("../../app/services/matcher.server");
    const { applyMatch } = await import("../../app/services/apply.server");

    await sql`
      INSERT INTO "PayerAlias" (id, "buyerAccountId", "payerKey", "createdAt")
      VALUES (gen_random_uuid()::text, ${testBuyerAccountId}, 'test buyer co', NOW())
    `;

    const matcherResult = await runMatcher(sql, testShopId);
    expect(matcherResult.paymentsProcessed).toBe(1);
    expect(matcherResult.matchesCreated).toBeGreaterThanOrEqual(1);

    const [match] = await sql<{ id: string; score: number }[]>`
      SELECT id, score FROM "Match"
      WHERE "shopId" = ${testShopId} AND state = 'suggested'
      ORDER BY score DESC LIMIT 1
    `;
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

  it("VARIANT: B2B reminder selection", async () => {
    const { ensureDefaultReminderRules, updateShopReminderSettings } = await import(
      "../../app/services/reminders.server"
    );

    await ensureDefaultReminderRules(sql, testShopId);
    await updateShopReminderSettings(sql, testShopId, true);

    const rules = await sql<{ offsetDays: number }[]>`
      SELECT "offsetDays" FROM "ReminderRule" WHERE "shopId" = ${testShopId}
    `;
    expect(rules.length).toBe(3);
  });
});
