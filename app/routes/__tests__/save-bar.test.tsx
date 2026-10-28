/**
 * @vitest-environment jsdom
 *
 * Save Bar Tests for BFS 4.1.5 (Contextual Save Bar)
 *
 * Tests the App Bridge contextual save bar integration for:
 * 1. Credit Settings form (app/routes/app.accounts.$id.tsx)
 * 2. Hold form (app/routes/app.accounts.$id.tsx)
 * 3. Tag Rules form (app/routes/app.tag-rules.tsx)
 *
 * With stubbed global shopify.saveBar {show, hide}, verifies:
 * (a) ui-save-bar element is rendered with correct id for dirty state tracking
 * (b) Form contains all expected field names for submission
 * (c) Discard button is present in save bar
 * (d) Clean form renders with save bar (visibility controlled by shopify.saveBar)
 * (e) Explicit submit button renders with correct text
 * (f) Form preserves explicit action attribute
 */

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import { renderToString } from "react-dom/server";
import { createElement, type ReactNode } from "react";

vi.mock("react-router", async () => {
  return {
    useLoaderData: vi.fn(),
    useActionData: vi.fn(() => undefined),
    useNavigation: vi.fn(() => ({ state: "idle", formData: null })),
    useRevalidator: vi.fn(() => ({ state: "idle", revalidate: vi.fn() })),
    data: vi.fn((d) => d),
    Form: ({ children, action, ...props }: { children: ReactNode; action?: string; method?: string }) =>
      createElement("form", { ...props, action }, children),
  };
});

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

vi.mock("~/services/gating.server", () => ({
  isAccountActive: vi.fn(() => true),
  isGatingEnforced: vi.fn(() => false),
  getUsageStats: vi.fn().mockResolvedValue({
    companies: { current: 5, limit: 25 },
    importsThisMonth: { current: 0, limit: -1 },
  }),
}));

vi.mock("~/lib/plan-url", () => ({
  getAppHandle: vi.fn().mockReturnValue("test-handle"),
  buildPlanSelectionUrl: vi.fn().mockReturnValue("https://test.example.com/upgrade"),
}));

vi.mock("~/services/drain/reconcile-handlers.server", () => ({
  enqueueReconcileStage: vi.fn().mockResolvedValue(true),
}));

import { useLoaderData } from "react-router";
import AccountPage from "../app.accounts.$id";
import TagRulesPage from "../app.tag-rules";

const mockUseLoaderData = vi.mocked(useLoaderData);

const SYNTHETIC_ACCOUNT_ID = "test-account-a1b2c3d4-e5f6-7890-abcd-ef1234567890";

interface MockSaveBar {
  show: ReturnType<typeof vi.fn>;
  hide: ReturnType<typeof vi.fn>;
}

let mockSaveBar: MockSaveBar;

beforeAll(() => {
  mockSaveBar = {
    show: vi.fn().mockResolvedValue(undefined),
    hide: vi.fn().mockResolvedValue(undefined),
  };
  (globalThis as unknown as { shopify: { saveBar: MockSaveBar } }).shopify = {
    saveBar: mockSaveBar,
  };
});

afterAll(() => {
  delete (globalThis as unknown as { shopify?: unknown }).shopify;
});

function buildAccountLoaderData(options: {
  isGated?: boolean;
  creditLimitAmount?: number | null;
  manualHold?: boolean;
  holdReasonCode?: string | null;
  holdNote?: string | null;
} = {}) {
  const {
    isGated = false,
    creditLimitAmount = 100000,
    manualHold = false,
    holdReasonCode = null,
    holdNote = null,
  } = options;

  return {
    account: {
      id: SYNTHETIC_ACCOUNT_ID,
      name: "Test Buyer Corp",
      kind: "COMPANY" as const,
      companyId: "company-test-123",
      defaultTermsDays: 30,
      defaultTermsSource: "explicit" as const,
      isGated,
    },
    upgradeUrl: "https://test.example.com/upgrade",
    creditStatus: {
      creditLimitAmount,
      creditLimitPaise: creditLimitAmount !== null ? (creditLimitAmount * 100).toString() : null,
      exposurePaise: "5000000",
      draftExposurePaise: "0",
      availableCreditPaise: "5000000",
      currency: "INR",
      holdState: manualHold ? "HELD" as const : "OK" as const,
      manualHold,
      holdReasonCode,
      holdNote,
      isOnHold: manualHold,
      holdReasonDisplay: manualHold ? "Manual hold" : null,
      isOverLimit: false,
      isOverdue: false,
      utilizationPercent: 50,
      syncPending: false,
      syncErrorCode: null,
      syncState: "synced" as const,
      hasDeadLetteredSync: false,
      syncErrorInfo: null,
    },
    companyTotals: null,
    invoices: { rows: [], totalCount: 0 },
    gatingEnforced: false,
    reminderOptOut: null,
    shopTimezone: "Asia/Kolkata",
    newAccountsPausedBanner: {
      show: false,
      heading: "",
      bodyText: "",
      upgradeUrl: null,
    },
    error: null,
  };
}

function buildTagRulesLoaderData() {
  return {
    storeMode: "tag_based" as const,
    tagRules: [],
    shopId: "shop-test-123",
    shopTimezone: "Asia/Kolkata",
    error: null,
    finishingSetup: false,
    notSupported: false,
    storeSetupStatus: "supported" as const,
    newAccountsPausedBanner: {
      show: false,
      heading: "",
      bodyText: "",
      upgradeUrl: null,
    },
  };
}

describe("Save Bar: Credit Settings Form", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSaveBar.show.mockClear();
    mockSaveBar.hide.mockClear();
  });

  it("(a) renders ui-save-bar with correct id for dirty state tracking", () => {
    mockUseLoaderData.mockReturnValue(buildAccountLoaderData({ creditLimitAmount: 50000 }));

    const html = renderToString(createElement(AccountPage));

    expect(html).toContain("ui-save-bar");
    expect(html).toContain('id="credit-settings-save-bar"');
    expect(html).toContain("Save");
    expect(html).toContain("Discard");
  });

  it("(b) form contains all expected field names for submission", () => {
    mockUseLoaderData.mockReturnValue(buildAccountLoaderData({ creditLimitAmount: 50000 }));

    const html = renderToString(createElement(AccountPage));

    expect(html).toContain('name="_action"');
    expect(html).toContain('value="updateCredit"');
    expect(html).toContain('name="creditLimit"');
    expect(html).toContain('name="noLimit"');
    expect(html).toContain('name="manualHold"');
    expect(html).toContain('name="holdReasonCode"');
    expect(html).toContain('name="holdNote"');
  });

  it("(c) discard button is present in save bar", () => {
    mockUseLoaderData.mockReturnValue(buildAccountLoaderData({ creditLimitAmount: 50000 }));

    const html = renderToString(createElement(AccountPage));

    expect(html).toContain("ui-save-bar");
    expect(html).toContain(">Discard<");
  });

  it("(d) clean form renders with save bar (bar visibility controlled by shopify.saveBar)", () => {
    mockUseLoaderData.mockReturnValue(buildAccountLoaderData());

    const html = renderToString(createElement(AccountPage));

    expect(html).toContain("ui-save-bar");
    expect(html).toContain("credit-settings-save-bar");
  });

  it("explicit submit button renders with correct text", () => {
    mockUseLoaderData.mockReturnValue(buildAccountLoaderData());

    const html = renderToString(createElement(AccountPage));

    expect(html).toContain("Save Credit Settings");
    expect(html).toContain('type="submit"');
  });

  it("form preserves explicit action attribute", () => {
    mockUseLoaderData.mockReturnValue(buildAccountLoaderData());

    const html = renderToString(createElement(AccountPage));

    expect(html).toContain(`action="/app/accounts/${SYNTHETIC_ACCOUNT_ID}"`);
    expect(html).not.toContain("%25");
    expect(html).not.toContain("%252F");
  });
});

describe("Save Bar: Hold Form (Gated Accounts)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSaveBar.show.mockClear();
    mockSaveBar.hide.mockClear();
  });

  it("(a) renders ui-save-bar with correct id for dirty state tracking", () => {
    mockUseLoaderData.mockReturnValue(buildAccountLoaderData({ isGated: true }));

    const html = renderToString(createElement(AccountPage));

    expect(html).toContain("ui-save-bar");
    expect(html).toContain('id="hold-settings-save-bar"');
  });

  it("(b) form contains all expected field names including holdOnly", () => {
    mockUseLoaderData.mockReturnValue(buildAccountLoaderData({ isGated: true }));

    const html = renderToString(createElement(AccountPage));

    expect(html).toContain('name="_action"');
    expect(html).toContain('name="holdOnly"');
    expect(html).toContain('value="true"');
    expect(html).toContain('name="manualHold"');
    expect(html).toContain('name="holdReasonCode"');
    expect(html).toContain('name="holdNote"');
  });

  it("(c) discard button is present in save bar", () => {
    mockUseLoaderData.mockReturnValue(buildAccountLoaderData({ isGated: true }));

    const html = renderToString(createElement(AccountPage));

    expect(html).toContain("ui-save-bar");
    expect(html).toContain(">Discard<");
  });

  it("(d) clean form renders with save bar", () => {
    mockUseLoaderData.mockReturnValue(buildAccountLoaderData({ isGated: true }));

    const html = renderToString(createElement(AccountPage));

    expect(html).toContain("ui-save-bar");
    expect(html).toContain("hold-settings-save-bar");
  });

  it("explicit submit button renders with correct text", () => {
    mockUseLoaderData.mockReturnValue(buildAccountLoaderData({ isGated: true }));

    const html = renderToString(createElement(AccountPage));

    expect(html).toContain("Save Hold Settings");
    expect(html).toContain('type="submit"');
  });

  it("form preserves explicit action attribute", () => {
    mockUseLoaderData.mockReturnValue(buildAccountLoaderData({ isGated: true }));

    const html = renderToString(createElement(AccountPage));

    expect(html).toContain(`action="/app/accounts/${SYNTHETIC_ACCOUNT_ID}"`);
  });
});

describe("Save Bar: Tag Rules Form", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSaveBar.show.mockClear();
    mockSaveBar.hide.mockClear();
  });

  it("(a) renders ui-save-bar with correct id for dirty state tracking", () => {
    mockUseLoaderData.mockReturnValue(buildTagRulesLoaderData());

    const html = renderToString(createElement(TagRulesPage));

    expect(html).toContain("ui-save-bar");
    expect(html).toContain('id="tag-rule-save-bar"');
  });

  it("(b) form contains all expected field names for submission", () => {
    mockUseLoaderData.mockReturnValue(buildTagRulesLoaderData());

    const html = renderToString(createElement(TagRulesPage));

    expect(html).toContain('name="intent"');
    expect(html).toContain('value="create_tag_rule"');
    expect(html).toContain('name="tag"');
    expect(html).toContain('name="defaultTermsDays"');
  });

  it("(c) discard button is present in save bar", () => {
    mockUseLoaderData.mockReturnValue(buildTagRulesLoaderData());

    const html = renderToString(createElement(TagRulesPage));

    expect(html).toContain("ui-save-bar");
    expect(html).toContain(">Discard<");
  });

  it("(d) clean form renders with save bar", () => {
    mockUseLoaderData.mockReturnValue(buildTagRulesLoaderData());

    const html = renderToString(createElement(TagRulesPage));

    expect(html).toContain("ui-save-bar");
    expect(html).toContain("tag-rule-save-bar");
  });

  it("explicit submit button renders with correct text", () => {
    mockUseLoaderData.mockReturnValue(buildTagRulesLoaderData());

    const html = renderToString(createElement(TagRulesPage));

    expect(html).toContain("Create Tag Rule");
    expect(html).toContain('type="submit"');
  });
});

describe("Save Bar: shopify.saveBar guard for SSR", () => {
  it("does not throw when shopify is undefined during SSR", () => {
    const originalShopify = (globalThis as { shopify?: unknown }).shopify;
    delete (globalThis as { shopify?: unknown }).shopify;

    mockUseLoaderData.mockReturnValue(buildAccountLoaderData());

    expect(() => renderToString(createElement(AccountPage))).not.toThrow();

    (globalThis as { shopify?: unknown }).shopify = originalShopify;
  });
});

describe("Save Bar: Dirty State Tracking Implementation", () => {
  it("credit settings tracks creditLimit, noLimit, manualHold, holdReasonCode, holdNote", () => {
    mockUseLoaderData.mockReturnValue(
      buildAccountLoaderData({
        creditLimitAmount: 50000,
        manualHold: true,
        holdReasonCode: "MANUAL_HOLD",
        holdNote: "Test note",
      })
    );

    const html = renderToString(createElement(AccountPage));

    expect(html).toContain('value="50000"');
    expect(html).toContain("MANUAL_HOLD");
    expect(html).toContain("Test note");
  });

  it("tag rules tracks tag and defaultTermsDays with initial empty values", () => {
    mockUseLoaderData.mockReturnValue(buildTagRulesLoaderData());

    const html = renderToString(createElement(TagRulesPage));

    expect(html).toContain('name="tag"');
    expect(html).toContain('name="defaultTermsDays"');
  });
});
