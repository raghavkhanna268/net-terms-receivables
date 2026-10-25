/**
 * Unit tests for unsubscribe route (S18 #232).
 *
 * Tests:
 * - GET doesn't write (safe for link scanners)
 * - POST idempotency
 * - Tampered tokens rejected
 * - Invalid tokens get generic response (no info leakage)
 *
 * Uses mocks for database and token verification.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock dependencies before importing the route
vi.mock("~/services/reminder-unsubscribe-token.server", () => ({
  verifyUnsubscribeToken: vi.fn(),
}));

vi.mock("~/services/reminder-optout.server", () => ({
  setBuyerOptOut: vi.fn(),
  isBuyerOptedOut: vi.fn(),
}));

vi.mock("~/lib/log.server", () => ({
  safeLog: vi.fn(),
}));

vi.mock("postgres", () => {
  const mockEnd = vi.fn();
  const mockSql = vi.fn();
  (mockSql as typeof mockSql & { end: typeof mockEnd }).end = mockEnd;
  return { default: vi.fn(() => mockSql) };
});

vi.mock("~/lib/db-light.server", () => ({
  sqlOptions: {},
}));

import { verifyUnsubscribeToken } from "~/services/reminder-unsubscribe-token.server";
import { setBuyerOptOut, isBuyerOptedOut } from "~/services/reminder-optout.server";
import { safeLog } from "~/lib/log.server";
import { loader, action } from "../unsubscribe";

const mockVerifyUnsubscribeToken = vi.mocked(verifyUnsubscribeToken);
const mockSetBuyerOptOut = vi.mocked(setBuyerOptOut);
const mockIsBuyerOptedOut = vi.mocked(isBuyerOptedOut);
const mockSafeLog = vi.mocked(safeLog);

const TEST_SHOP_ID = "shop-unsub-test";
const TEST_BUYER_ID = "buyer-unsub-test";
const VALID_TOKEN = "valid-test-token";
const INVALID_TOKEN = "invalid-tampered-token";

function createRequest(
  method: "GET" | "POST",
  token: string | null,
  body?: string
) {
  const url = token
    ? `https://example.com/unsubscribe?token=${token}`
    : "https://example.com/unsubscribe";

  const options: RequestInit = { method };
  if (body) {
    options.body = body;
    options.headers = {
      "Content-Type": "application/x-www-form-urlencoded",
    };
  }

  return new Request(url, options);
}

function createLoaderArgs(token: string | null) {
  return {
    request: createRequest("GET", token),
    context: {
      cloudflare: {
        env: { REMINDER_UNSUBSCRIBE_SECRET: "test-secret" },
      },
    },
    params: {},
  } as unknown as Parameters<typeof loader>[0];
}

function createActionArgs(token: string | null, body?: string) {
  return {
    request: createRequest("POST", token, body),
    context: {
      cloudflare: {
        env: { REMINDER_UNSUBSCRIBE_SECRET: "test-secret" },
      },
    },
    params: {},
  } as unknown as Parameters<typeof action>[0];
}

describe("unsubscribe route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsBuyerOptedOut.mockResolvedValue(false);
    mockSetBuyerOptOut.mockResolvedValue(true);
  });

  describe("GET (loader)", () => {
    it("returns valid=false when no token provided", async () => {
      const result = await loader(createLoaderArgs(null));
      expect(result).toEqual({ valid: false, alreadyOptedOut: false });
    });

    it("returns valid=false for invalid/tampered token", async () => {
      mockVerifyUnsubscribeToken.mockReturnValue(null);

      const result = await loader(createLoaderArgs(INVALID_TOKEN));

      expect(result).toEqual({ valid: false, alreadyOptedOut: false });
      expect(mockSafeLog).toHaveBeenCalledWith(
        "warn",
        "unsubscribe_invalid_token",
        { valid: false }
      );
    });

    it("does NOT call setBuyerOptOut (GET never writes)", async () => {
      mockVerifyUnsubscribeToken.mockReturnValue({
        shopId: TEST_SHOP_ID,
        buyerAccountId: TEST_BUYER_ID,
      });
      mockIsBuyerOptedOut.mockResolvedValue(false);

      await loader(createLoaderArgs(VALID_TOKEN));

      expect(mockSetBuyerOptOut).not.toHaveBeenCalled();
    });

    it("returns valid=true, alreadyOptedOut=false for opted-in buyer", async () => {
      mockVerifyUnsubscribeToken.mockReturnValue({
        shopId: TEST_SHOP_ID,
        buyerAccountId: TEST_BUYER_ID,
      });
      mockIsBuyerOptedOut.mockResolvedValue(false);

      const result = await loader(createLoaderArgs(VALID_TOKEN));

      expect(result).toEqual({ valid: true, alreadyOptedOut: false });
      expect(mockIsBuyerOptedOut).toHaveBeenCalledWith(
        expect.anything(),
        TEST_SHOP_ID,
        TEST_BUYER_ID
      );
    });

    it("returns valid=true, alreadyOptedOut=true for opted-out buyer", async () => {
      mockVerifyUnsubscribeToken.mockReturnValue({
        shopId: TEST_SHOP_ID,
        buyerAccountId: TEST_BUYER_ID,
      });
      mockIsBuyerOptedOut.mockResolvedValue(true);

      const result = await loader(createLoaderArgs(VALID_TOKEN));

      expect(result).toEqual({ valid: true, alreadyOptedOut: true });
    });
  });

  describe("POST (action)", () => {
    it("returns missing_token error when no token provided", async () => {
      const result = await action(createActionArgs(null));
      expect(result).toEqual({ success: false, error: "missing_token" });
    });

    it("returns generic success for tampered token (no info leakage)", async () => {
      mockVerifyUnsubscribeToken.mockReturnValue(null);

      const result = await action(
        createActionArgs(INVALID_TOKEN, "List-Unsubscribe=One-Click")
      );

      expect(result).toEqual({ success: true, alreadyOptedOut: true });
      expect(mockSafeLog).toHaveBeenCalledWith(
        "warn",
        "unsubscribe_invalid_token_post",
        { valid: false }
      );
      expect(mockSetBuyerOptOut).not.toHaveBeenCalled();
    });

    it("opts out buyer with source='link' on valid token", async () => {
      mockVerifyUnsubscribeToken.mockReturnValue({
        shopId: TEST_SHOP_ID,
        buyerAccountId: TEST_BUYER_ID,
      });
      mockSetBuyerOptOut.mockResolvedValue(true);

      const result = await action(
        createActionArgs(VALID_TOKEN, "List-Unsubscribe=One-Click")
      );

      expect(result).toEqual({ success: true, alreadyOptedOut: false });
      expect(mockSetBuyerOptOut).toHaveBeenCalledWith(
        expect.anything(),
        TEST_SHOP_ID,
        TEST_BUYER_ID,
        "link"
      );
    });

    it("is idempotent (second POST returns alreadyOptedOut=true)", async () => {
      mockVerifyUnsubscribeToken.mockReturnValue({
        shopId: TEST_SHOP_ID,
        buyerAccountId: TEST_BUYER_ID,
      });
      mockSetBuyerOptOut.mockResolvedValue(false);

      const result = await action(
        createActionArgs(VALID_TOKEN, "List-Unsubscribe=One-Click")
      );

      expect(result).toEqual({ success: true, alreadyOptedOut: true });
    });

    it("logs RFC 8058 one-click when form data present", async () => {
      mockVerifyUnsubscribeToken.mockReturnValue({
        shopId: TEST_SHOP_ID,
        buyerAccountId: TEST_BUYER_ID,
      });
      mockSetBuyerOptOut.mockResolvedValue(true);

      await action(
        createActionArgs(VALID_TOKEN, "List-Unsubscribe=One-Click")
      );

      expect(mockSafeLog).toHaveBeenCalledWith(
        "info",
        "unsubscribe_rfc8058_oneclick",
        { shopId: TEST_SHOP_ID, buyerAccountId: TEST_BUYER_ID }
      );
    });

    it("logs completion with IDs only (no PII)", async () => {
      mockVerifyUnsubscribeToken.mockReturnValue({
        shopId: TEST_SHOP_ID,
        buyerAccountId: TEST_BUYER_ID,
      });
      mockSetBuyerOptOut.mockResolvedValue(true);

      await action(
        createActionArgs(VALID_TOKEN, "List-Unsubscribe=One-Click")
      );

      expect(mockSafeLog).toHaveBeenCalledWith("info", "unsubscribe_completed", {
        shopId: TEST_SHOP_ID,
        buyerAccountId: TEST_BUYER_ID,
        updated: true,
        source: "link",
      });
    });
  });
});
