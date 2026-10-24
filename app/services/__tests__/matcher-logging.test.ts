/**
 * M4: Logging tests for matcher.server.ts
 *
 * Verifies that safeLog output contains no PII:
 * - No shop domains (myshopify.com)
 * - No emails
 * - No UTRs
 * - No amounts
 *
 * Per QA: Uses REAL safeLog, spies on console.error, parses emitted JSON,
 * and asserts no sensitive data leaks while verifying expected safe keys.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const SENSITIVE_DOMAIN = "pii-test-shop.myshopify.com";
const SENSITIVE_EMAIL = "buyer@pii-test.example.com";
const SENSITIVE_UTR = "UTIB987654321098";
const SENSITIVE_AMOUNT = "99500";

describe("Matcher Logging: No PII in log output (M4)", () => {
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.resetModules();
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    consoleErrorSpy?.mockRestore();
  });

  function parseErrorLogs(): Array<{ event: string; [key: string]: unknown }> {
    const parsed: Array<{ event: string; [key: string]: unknown }> = [];
    for (const call of consoleErrorSpy.mock.calls) {
      const arg = call[0];
      if (typeof arg === "string" && arg.startsWith("{")) {
        try {
          parsed.push(JSON.parse(arg));
        } catch {
          // Not JSON, skip
        }
      }
    }
    return parsed;
  }

  function assertNoSensitiveDataInLogs(logs: Array<Record<string, unknown>>) {
    for (const log of logs) {
      const serialized = JSON.stringify(log);
      expect(serialized).not.toContain("myshopify.com");
      expect(serialized).not.toContain(SENSITIVE_EMAIL);
      expect(serialized).not.toContain(SENSITIVE_UTR);
      expect(serialized).not.toContain(SENSITIVE_AMOUNT);
    }
  }

  function assertNoSensitiveDataInRawCalls(spy: ReturnType<typeof vi.spyOn>) {
    for (const call of spy.mock.calls) {
      const raw = String(call[0]);
      expect(raw).not.toContain("myshopify.com");
      expect(raw).not.toContain(SENSITIVE_EMAIL);
      expect(raw).not.toContain(SENSITIVE_UTR);
      expect(raw).not.toContain(SENSITIVE_AMOUNT);
    }
  }

  it("runMatcher error in payment processing logs no domain, email, UTR, or amount", async () => {
    vi.doMock("~/lib/db-light.server", () => ({ sqlOptions: {} }));

    vi.doMock("~/lib/matching/queries.server", () => ({
      getUnmatchedPayments: vi.fn().mockResolvedValue({
        payments: [{
          id: "pmt-test-err",
          amountPaise: BigInt(SENSITIVE_AMOUNT),
          narration: `From ${SENSITIVE_EMAIL}`,
          payerText: SENSITIVE_DOMAIN,
          utr: SENSITIVE_UTR,
          rail: "NEFT",
        }],
      }),
      getBuyersWithAliases: vi.fn().mockResolvedValue([{
        id: "buyer-1",
        name: "Test Buyer",
        companyName: "Test Co",
        aliases: [],
        invoiceIds: [],
      }]),
      deleteSuggestedMatchesForPayment: vi.fn().mockRejectedValue(
        new Error(`DB error for ${SENSITIVE_DOMAIN} with email ${SENSITIVE_EMAIL}`)
      ),
      getRejectedPairs: vi.fn().mockResolvedValue([]),
      getOpenInvoicesInAmountWindow: vi.fn().mockResolvedValue([]),
      getOpenInvoicesForBuyer: vi.fn().mockResolvedValue([]),
      createMatch: vi.fn().mockResolvedValue(undefined),
      updatePaymentStatus: vi.fn().mockResolvedValue(undefined),
      findBuyerByAlias: vi.fn().mockResolvedValue(null),
      upsertPayerAlias: vi.fn().mockResolvedValue(undefined),
      createRejectedMatch: vi.fn().mockResolvedValue(undefined),
    }));

    vi.doMock("~/lib/matching/score", () => ({
      scoreMultiInvoiceMatch: vi.fn().mockReturnValue(null),
      CONFIDENCE_THRESHOLD: 80,
      MAX_INVOICES_FOR_SUBSET_SUM: 10,
    }));

    vi.doMock("~/lib/matching/normalize", () => ({
      normalizeNarrationForLookup: vi.fn().mockReturnValue("normalized"),
      findBestBuyerMatch: vi.fn().mockReturnValue(null),
    }));

    const { runMatcher } = await import("../matcher.server");
    const mockSql = vi.fn() as unknown as Parameters<typeof runMatcher>[0];

    const result = await runMatcher(mockSql, "shop-123", { limit: 1 });

    expect(result.errors).toBe(1);
    
    const logs = parseErrorLogs();
    assertNoSensitiveDataInLogs(logs);
    assertNoSensitiveDataInRawCalls(consoleErrorSpy);

    const matcherLogs = logs.filter(l => l.event === "matcher_payment_processing_failed");
    expect(matcherLogs.length).toBe(1);

    const log = matcherLogs[0];
    expect(Object.keys(log).sort()).toEqual(["err", "event", "paymentId"]);
    expect(log.paymentId).toBe("pmt-test-err");
    expect(typeof log.err).toBe("string");
  });

  it("confirmMatch error logs no domain, email, UTR, or amount", async () => {
    vi.doMock("~/lib/db-light.server", () => ({ sqlOptions: {} }));
    vi.doMock("~/lib/matching/queries.server", () => ({}));
    vi.doMock("~/lib/matching/score", () => ({ CONFIDENCE_THRESHOLD: 80, MAX_INVOICES_FOR_SUBSET_SUM: 10 }));
    vi.doMock("~/lib/matching/normalize", () => ({}));

    const { confirmMatch } = await import("../matcher.server");

    const mockSql = Object.assign(
      vi.fn(),
      {
        begin: vi.fn().mockRejectedValue(
          new Error(`Transaction failed: email=${SENSITIVE_EMAIL}, amount=${SENSITIVE_AMOUNT}`)
        ),
      }
    ) as unknown as Parameters<typeof confirmMatch>[0];

    const result = await confirmMatch(mockSql, "shop-123", "match-123", "user-1");

    expect(result.success).toBe(false);
    
    const logs = parseErrorLogs();
    assertNoSensitiveDataInLogs(logs);
    assertNoSensitiveDataInRawCalls(consoleErrorSpy);

    const confirmLogs = logs.filter(l => l.event === "matcher_confirm_failed");
    expect(confirmLogs.length).toBe(1);

    const log = confirmLogs[0];
    expect(Object.keys(log).sort()).toEqual(["err", "event", "matchId"]);
    expect(log.matchId).toBe("match-123");
    expect(typeof log.err).toBe("string");
  });

  it("rejectMatch error logs no domain, email, UTR, or amount", async () => {
    vi.doMock("~/lib/db-light.server", () => ({ sqlOptions: {} }));
    vi.doMock("~/lib/matching/queries.server", () => ({}));
    vi.doMock("~/lib/matching/score", () => ({ CONFIDENCE_THRESHOLD: 80, MAX_INVOICES_FOR_SUBSET_SUM: 10 }));
    vi.doMock("~/lib/matching/normalize", () => ({}));

    const { rejectMatch } = await import("../matcher.server");

    const mockSql = Object.assign(
      vi.fn(),
      {
        begin: vi.fn().mockRejectedValue(
          new Error(`Rejection failed: UTR=${SENSITIVE_UTR}`)
        ),
      }
    ) as unknown as Parameters<typeof rejectMatch>[0];

    const result = await rejectMatch(mockSql, "shop-123", "match-123", "user-1");

    expect(result.success).toBe(false);
    
    const logs = parseErrorLogs();
    assertNoSensitiveDataInLogs(logs);
    assertNoSensitiveDataInRawCalls(consoleErrorSpy);

    const rejectLogs = logs.filter(l => l.event === "matcher_reject_failed");
    expect(rejectLogs.length).toBe(1);

    const log = rejectLogs[0];
    expect(Object.keys(log).sort()).toEqual(["err", "event", "matchId"]);
    expect(log.matchId).toBe("match-123");
    expect(typeof log.err).toBe("string");
  });

  it("updateMatchAllocation error logs no domain, email, UTR, or amount", async () => {
    vi.doMock("~/lib/db-light.server", () => ({ sqlOptions: {} }));
    vi.doMock("~/lib/matching/queries.server", () => ({}));
    vi.doMock("~/lib/matching/score", () => ({ CONFIDENCE_THRESHOLD: 80, MAX_INVOICES_FOR_SUBSET_SUM: 10 }));
    vi.doMock("~/lib/matching/normalize", () => ({}));

    const { updateMatchAllocation } = await import("../matcher.server");

    const mockSql = Object.assign(
      vi.fn(),
      {
        begin: vi.fn().mockRejectedValue(
          new Error(`Update failed: amount=${SENSITIVE_AMOUNT} paise`)
        ),
      }
    ) as unknown as Parameters<typeof updateMatchAllocation>[0];

    const result = await updateMatchAllocation(mockSql, "shop-123", "match-123", BigInt(50000));

    expect(result.success).toBe(false);
    
    const logs = parseErrorLogs();
    assertNoSensitiveDataInLogs(logs);
    assertNoSensitiveDataInRawCalls(consoleErrorSpy);

    const updateLogs = logs.filter(l => l.event === "matcher_update_allocation_failed");
    expect(updateLogs.length).toBe(1);

    const log = updateLogs[0];
    expect(Object.keys(log).sort()).toEqual(["err", "event", "matchId"]);
    expect(log.matchId).toBe("match-123");
    expect(typeof log.err).toBe("string");
  });
});
