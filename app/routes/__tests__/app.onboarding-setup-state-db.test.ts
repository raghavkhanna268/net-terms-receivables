/**
 * #548: Setup state tests for app.onboarding route.
 *
 * Tests verify that when the Shop row is missing (setup in progress):
 * - The loader returns settingUp: true with error: null
 * - The UI renders the StoreSettingUpBanner instead of "Shop not found"
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { LoaderFunctionArgs } from "react-router";

vi.mock("~/lib/request-context.server", () => ({
  getRequestSql: vi.fn(),
}));

vi.mock("@shopify/shopify-app-react-router/server", () => ({
  boundary: { headers: vi.fn(() => ({})), error: vi.fn() },
}));

vi.mock("~/lib/onboarding-steps.server", () => ({
  fetchShopOnboardingData: vi.fn(),
  computeOnboardingState: vi.fn(),
  dismissOnboarding: vi.fn(),
  reopenOnboarding: vi.fn(),
}));

vi.mock("~/services/gating.server", () => ({
  isGatingEnforced: vi.fn().mockReturnValue(false),
  getUsageStats: vi.fn(),
}));

vi.mock("~/lib/log.server", () => ({
  safeLog: vi.fn(),
  toErrorCode: vi.fn((e) => String(e)),
  shopHash: vi.fn().mockResolvedValue("test-hash"),
}));

vi.mock("~/lib/validation-registration.server", () => ({
  ensureValidation: vi.fn(),
}));

vi.mock("~/lib/payment-customization-registration.server", () => ({
  ensurePaymentCustomization: vi.fn(),
}));

vi.mock("~/lib/metafield-definitions.server", () => ({
  ensureMetafieldDefinitions: vi.fn(),
  getMetafieldDefinitionSpecs: vi.fn().mockReturnValue([]),
}));

vi.mock("~/lib/initial-sync.server", () => ({
  getInitialSyncState: vi.fn(),
  getInitialSyncStateWithRecovery: vi.fn().mockResolvedValue({ status: "not_started" }),
  enqueueInitialSync: vi.fn(),
  canStartSync: vi.fn(),
}));

vi.mock("~/services/shop-currency-recovery.server", () => ({
  checkAndRecoverCurrency: vi.fn(),
}));

vi.mock("~/services/reminders.server", () => ({
  getShopReminderSettings: vi.fn().mockResolvedValue(null),
}));

vi.mock("~/lib/email-sender-config.server", () => ({
  isEmailSendingConfigured: vi.fn().mockReturnValue(false),
}));

class MockServerTiming {
  startPhase = vi.fn();
  endPhase = vi.fn();
  time = vi.fn((_: string, fn: () => unknown) => fn());
  logAllPhases = vi.fn();
  toHeaderValue = vi.fn().mockReturnValue(null);
  logPhases = vi.fn();
}

vi.mock("~/lib/server-timing.server", () => ({
  ServerTiming: MockServerTiming,
  mergeServerTimingHeaders: vi.fn(),
  readColdOnce: vi.fn().mockReturnValue(false),
}));

vi.mock("~/lib/plan-url", () => ({
  getAppHandle: vi.fn().mockReturnValue("test-handle"),
  buildPlanSelectionUrl: vi.fn().mockReturnValue("https://example.com/plan"),
}));

const TEST_SHOP_DOMAIN = "test-onboarding-setup.myshopify.com";

describe("#548 setup state on /app/onboarding", () => {
  const mockSession = { shop: TEST_SHOP_DOMAIN };
  const mockAdmin = {
    graphql: vi.fn().mockResolvedValue({
      json: vi.fn().mockResolvedValue({ data: {} }),
    }),
  };
  const mockContext = {
    shopify: {
      authenticate: {
        admin: vi.fn().mockResolvedValue({
          session: mockSession,
          admin: mockAdmin,
        }),
      },
    },
    cloudflare: {
      env: {},
    },
  };

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    mockContext.shopify.authenticate.admin.mockResolvedValue({
      session: mockSession,
      admin: mockAdmin,
    });
  });

  function createLoaderArgs(): LoaderFunctionArgs {
    const url = new URL("https://example.com/app/onboarding");
    return {
      request: new Request(url.toString()),
      context: mockContext as never,
      params: {},
    } as unknown as LoaderFunctionArgs;
  }

  describe("loader", () => {
    it("returns settingUp: true when shop row is missing", async () => {
      const { fetchShopOnboardingData } = await import(
        "~/lib/onboarding-steps.server"
      );
      (fetchShopOnboardingData as ReturnType<typeof vi.fn>).mockResolvedValue(null);

      const { loader } = await import("../app.onboarding");
      const response = await loader(createLoaderArgs());

      const result = (response as { data: Record<string, unknown> }).data;
      expect(result.settingUp).toBe(true);
      expect(result.error).toBeNull();
      expect(result.state).toBeNull();
    });

    it("returns settingUp: false when shop row exists", async () => {
      const { fetchShopOnboardingData, computeOnboardingState } = await import(
        "~/lib/onboarding-steps.server"
      );
      (fetchShopOnboardingData as ReturnType<typeof vi.fn>).mockResolvedValue({
        shopId: "shop-123",
        currency: "INR",
        defaultTermsDays: 30,
        buyerAccountCount: 0,
        tagRuleCount: 0,
        dismissedAt: null,
      });
      (computeOnboardingState as ReturnType<typeof vi.fn>).mockReturnValue({
        steps: [],
        isComplete: false,
        completedCount: 0,
        totalCount: 5,
        dismissedAt: null,
      });

      const { checkAndRecoverCurrency } = await import(
        "~/services/shop-currency-recovery.server"
      );
      (checkAndRecoverCurrency as ReturnType<typeof vi.fn>).mockResolvedValue({
        currency: "INR",
        flipBlocked: false,
      });

      const { loader } = await import("../app.onboarding");
      const response = await loader(createLoaderArgs());

      const result = (response as { data: Record<string, unknown> }).data;
      expect(result.settingUp).toBe(false);
      expect(result.error).toBeNull();
    });
  });
});
