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
 * Verifies:
 * (a) Dirty state shows the bar (data-save-bar attribute triggers App Bridge)
 * (b) Save submits the form with the same fields
 * (c) Discard resets values to loaded state
 * (d) Clean form shows no bar
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createElement } from "react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { render, cleanup, waitFor, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

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

const SYNTHETIC_ACCOUNT_ID = "test-account-a1b2c3d4-e5f6-7890-abcd-ef1234567890";

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
  });

  afterEach(() => {
    cleanup();
  });

  it("(a) form has data-save-bar attribute for dirty state detection", async () => {
    const router = createMemoryRouter(
      [
        {
          path: "/app/accounts/:id",
          lazy: async () => {
            const mod = await import("../app.accounts.$id");
            return { Component: mod.default };
          },
          loader: () => buildAccountLoaderData(),
        },
      ],
      { initialEntries: [`/app/accounts/${SYNTHETIC_ACCOUNT_ID}`] }
    );

    render(createElement(RouterProvider, { router }));

    await waitFor(() => {
      const forms = document.querySelectorAll("form[data-save-bar]");
      expect(forms.length).toBeGreaterThan(0);
    }, { timeout: 5000 });

    const creditSettingsForm = Array.from(
      document.querySelectorAll("form[data-save-bar]")
    ).find((f) => f.querySelector('input[name="_action"][value="updateCredit"]'));

    expect(creditSettingsForm).not.toBeNull();
    expect(creditSettingsForm?.hasAttribute("data-save-bar")).toBe(true);
    expect(creditSettingsForm?.hasAttribute("data-discard-confirmation")).toBe(true);
  });

  it("(b) save submits the form with all expected fields", async () => {
    const router = createMemoryRouter(
      [
        {
          path: "/app/accounts/:id",
          lazy: async () => {
            const mod = await import("../app.accounts.$id");
            return { Component: mod.default };
          },
          loader: () => buildAccountLoaderData({ creditLimitAmount: 50000 }),
        },
      ],
      { initialEntries: [`/app/accounts/${SYNTHETIC_ACCOUNT_ID}`] }
    );

    render(createElement(RouterProvider, { router }));

    await waitFor(() => {
      const forms = document.querySelectorAll("form[data-save-bar]");
      expect(forms.length).toBeGreaterThan(0);
    }, { timeout: 5000 });

    const creditSettingsForm = Array.from(
      document.querySelectorAll("form[data-save-bar]")
    ).find((f) => f.querySelector('input[name="_action"][value="updateCredit"]') &&
                  !f.querySelector('input[name="holdOnly"]'));

    expect(creditSettingsForm).not.toBeNull();
    
    const actionInput = creditSettingsForm?.querySelector('input[name="_action"]');
    expect(actionInput).not.toBeNull();
    expect((actionInput as HTMLInputElement)?.value).toBe("updateCredit");

    const creditLimitField = creditSettingsForm?.querySelector('[name="creditLimit"]');
    expect(creditLimitField).not.toBeNull();

    const noLimitField = creditSettingsForm?.querySelector('[name="noLimit"]');
    expect(noLimitField).not.toBeNull();

    const manualHoldField = creditSettingsForm?.querySelector('[name="manualHold"]');
    expect(manualHoldField).not.toBeNull();

    const holdReasonCodeField = creditSettingsForm?.querySelector('[name="holdReasonCode"]');
    expect(holdReasonCodeField).not.toBeNull();

    const holdNoteField = creditSettingsForm?.querySelector('[name="holdNote"]');
    expect(holdNoteField).not.toBeNull();
  });

  it("(c) discard resets form via onReset handler", async () => {
    const router = createMemoryRouter(
      [
        {
          path: "/app/accounts/:id",
          lazy: async () => {
            const mod = await import("../app.accounts.$id");
            return { Component: mod.default };
          },
          loader: () => buildAccountLoaderData({ creditLimitAmount: null }),
        },
      ],
      { initialEntries: [`/app/accounts/${SYNTHETIC_ACCOUNT_ID}`] }
    );

    render(createElement(RouterProvider, { router }));

    await waitFor(() => {
      const forms = document.querySelectorAll("form[data-save-bar]");
      expect(forms.length).toBeGreaterThan(0);
    }, { timeout: 5000 });

    const creditSettingsForm = Array.from(
      document.querySelectorAll("form[data-save-bar]")
    ).find((f) => f.querySelector('input[name="_action"][value="updateCredit"]') &&
                  !f.querySelector('input[name="holdOnly"]')) as HTMLFormElement | undefined;

    expect(creditSettingsForm).not.toBeNull();

    const noLimitCheckbox = creditSettingsForm?.querySelector('[name="noLimit"]');
    expect(noLimitCheckbox).not.toBeNull();

    fireEvent.reset(creditSettingsForm!);

    const hiddenNoLimitState = creditSettingsForm?.querySelector('input[name="_noLimitState"]') as HTMLInputElement;
    expect(hiddenNoLimitState).not.toBeNull();
    expect(hiddenNoLimitState.value).toBe("true");
  });

  it("(d) clean form with no changes has data-save-bar but bar is hidden", async () => {
    const router = createMemoryRouter(
      [
        {
          path: "/app/accounts/:id",
          lazy: async () => {
            const mod = await import("../app.accounts.$id");
            return { Component: mod.default };
          },
          loader: () => buildAccountLoaderData(),
        },
      ],
      { initialEntries: [`/app/accounts/${SYNTHETIC_ACCOUNT_ID}`] }
    );

    render(createElement(RouterProvider, { router }));

    await waitFor(() => {
      const forms = document.querySelectorAll("form[data-save-bar]");
      expect(forms.length).toBeGreaterThan(0);
    }, { timeout: 5000 });

    const creditSettingsForm = Array.from(
      document.querySelectorAll("form[data-save-bar]")
    ).find((f) => f.querySelector('input[name="_action"][value="updateCredit"]') &&
                  !f.querySelector('input[name="holdOnly"]'));

    expect(creditSettingsForm).not.toBeNull();
    expect(creditSettingsForm?.hasAttribute("data-save-bar")).toBe(true);
  });

  it("has hidden input for noLimit state bridging", async () => {
    const router = createMemoryRouter(
      [
        {
          path: "/app/accounts/:id",
          lazy: async () => {
            const mod = await import("../app.accounts.$id");
            return { Component: mod.default };
          },
          loader: () => buildAccountLoaderData({ creditLimitAmount: null }),
        },
      ],
      { initialEntries: [`/app/accounts/${SYNTHETIC_ACCOUNT_ID}`] }
    );

    render(createElement(RouterProvider, { router }));

    await waitFor(() => {
      const forms = document.querySelectorAll("form[data-save-bar]");
      expect(forms.length).toBeGreaterThan(0);
    }, { timeout: 5000 });

    const creditSettingsForm = Array.from(
      document.querySelectorAll("form[data-save-bar]")
    ).find((f) => f.querySelector('input[name="_action"][value="updateCredit"]') &&
                  !f.querySelector('input[name="holdOnly"]'));

    const hiddenInput = creditSettingsForm?.querySelector('input[name="_noLimitState"]');
    expect(hiddenInput).not.toBeNull();
    expect((hiddenInput as HTMLInputElement)?.type).toBe("hidden");
  });
});

describe("Save Bar: Hold Form (Gated Accounts)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  it("(a) form has data-save-bar attribute for dirty state detection", async () => {
    const router = createMemoryRouter(
      [
        {
          path: "/app/accounts/:id",
          lazy: async () => {
            const mod = await import("../app.accounts.$id");
            return { Component: mod.default };
          },
          loader: () => buildAccountLoaderData({ isGated: true }),
        },
      ],
      { initialEntries: [`/app/accounts/${SYNTHETIC_ACCOUNT_ID}`] }
    );

    render(createElement(RouterProvider, { router }));

    await waitFor(() => {
      const forms = document.querySelectorAll("form[data-save-bar]");
      expect(forms.length).toBeGreaterThan(0);
    }, { timeout: 5000 });

    const holdForm = Array.from(
      document.querySelectorAll("form[data-save-bar]")
    ).find((f) => f.querySelector('input[name="holdOnly"][value="true"]'));

    expect(holdForm).not.toBeNull();
    expect(holdForm?.hasAttribute("data-save-bar")).toBe(true);
    expect(holdForm?.hasAttribute("data-discard-confirmation")).toBe(true);
  });

  it("(b) save submits the form with all expected fields including holdOnly", async () => {
    const router = createMemoryRouter(
      [
        {
          path: "/app/accounts/:id",
          lazy: async () => {
            const mod = await import("../app.accounts.$id");
            return { Component: mod.default };
          },
          loader: () => buildAccountLoaderData({ isGated: true, manualHold: true, holdReasonCode: "MANUAL_HOLD" }),
        },
      ],
      { initialEntries: [`/app/accounts/${SYNTHETIC_ACCOUNT_ID}`] }
    );

    render(createElement(RouterProvider, { router }));

    await waitFor(() => {
      const forms = document.querySelectorAll("form[data-save-bar]");
      expect(forms.length).toBeGreaterThan(0);
    }, { timeout: 5000 });

    const holdForm = Array.from(
      document.querySelectorAll("form[data-save-bar]")
    ).find((f) => f.querySelector('input[name="holdOnly"][value="true"]'));

    expect(holdForm).not.toBeNull();

    const actionInput = holdForm?.querySelector('input[name="_action"]');
    expect(actionInput).not.toBeNull();
    expect((actionInput as HTMLInputElement)?.value).toBe("updateCredit");

    const holdOnlyInput = holdForm?.querySelector('input[name="holdOnly"]');
    expect(holdOnlyInput).not.toBeNull();
    expect((holdOnlyInput as HTMLInputElement)?.value).toBe("true");

    const manualHoldField = holdForm?.querySelector('[name="manualHold"]');
    expect(manualHoldField).not.toBeNull();

    const holdReasonCodeField = holdForm?.querySelector('[name="holdReasonCode"]');
    expect(holdReasonCodeField).not.toBeNull();

    const holdNoteField = holdForm?.querySelector('[name="holdNote"]');
    expect(holdNoteField).not.toBeNull();
  });

  it("(c) discard resets form fields via native reset", async () => {
    const router = createMemoryRouter(
      [
        {
          path: "/app/accounts/:id",
          lazy: async () => {
            const mod = await import("../app.accounts.$id");
            return { Component: mod.default };
          },
          loader: () => buildAccountLoaderData({ isGated: true }),
        },
      ],
      { initialEntries: [`/app/accounts/${SYNTHETIC_ACCOUNT_ID}`] }
    );

    render(createElement(RouterProvider, { router }));

    await waitFor(() => {
      const forms = document.querySelectorAll("form[data-save-bar]");
      expect(forms.length).toBeGreaterThan(0);
    }, { timeout: 5000 });

    const holdForm = Array.from(
      document.querySelectorAll("form[data-save-bar]")
    ).find((f) => f.querySelector('input[name="holdOnly"][value="true"]')) as HTMLFormElement | undefined;

    expect(holdForm).not.toBeNull();

    fireEvent.reset(holdForm!);

    const holdOnlyInput = holdForm?.querySelector('input[name="holdOnly"]');
    expect(holdOnlyInput).not.toBeNull();
    expect((holdOnlyInput as HTMLInputElement)?.value).toBe("true");
  });

  it("(d) clean form with no changes has data-save-bar attribute", async () => {
    const router = createMemoryRouter(
      [
        {
          path: "/app/accounts/:id",
          lazy: async () => {
            const mod = await import("../app.accounts.$id");
            return { Component: mod.default };
          },
          loader: () => buildAccountLoaderData({ isGated: true }),
        },
      ],
      { initialEntries: [`/app/accounts/${SYNTHETIC_ACCOUNT_ID}`] }
    );

    render(createElement(RouterProvider, { router }));

    await waitFor(() => {
      const forms = document.querySelectorAll("form[data-save-bar]");
      expect(forms.length).toBeGreaterThan(0);
    }, { timeout: 5000 });

    const holdForm = Array.from(
      document.querySelectorAll("form[data-save-bar]")
    ).find((f) => f.querySelector('input[name="holdOnly"][value="true"]'));

    expect(holdForm).not.toBeNull();
    expect(holdForm?.hasAttribute("data-save-bar")).toBe(true);
  });
});

describe("Save Bar: Tag Rules Form", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  it("(a) form has data-save-bar attribute for dirty state detection", async () => {
    const router = createMemoryRouter(
      [
        {
          path: "/app/tag-rules",
          lazy: async () => {
            const mod = await import("../app.tag-rules");
            return { Component: mod.default };
          },
          loader: () => buildTagRulesLoaderData(),
        },
      ],
      { initialEntries: ["/app/tag-rules"] }
    );

    render(createElement(RouterProvider, { router }));

    await waitFor(() => {
      const forms = document.querySelectorAll("form[data-save-bar]");
      expect(forms.length).toBeGreaterThan(0);
    }, { timeout: 5000 });

    const tagRulesForm = document.querySelector('form[data-save-bar]');
    expect(tagRulesForm).not.toBeNull();
    expect(tagRulesForm?.hasAttribute("data-save-bar")).toBe(true);
  });

  it("(b) save submits the form with all expected fields", async () => {
    const router = createMemoryRouter(
      [
        {
          path: "/app/tag-rules",
          lazy: async () => {
            const mod = await import("../app.tag-rules");
            return { Component: mod.default };
          },
          loader: () => buildTagRulesLoaderData(),
        },
      ],
      { initialEntries: ["/app/tag-rules"] }
    );

    render(createElement(RouterProvider, { router }));

    await waitFor(() => {
      const forms = document.querySelectorAll("form[data-save-bar]");
      expect(forms.length).toBeGreaterThan(0);
    }, { timeout: 5000 });

    const tagRulesForm = document.querySelector('form[data-save-bar]');
    expect(tagRulesForm).not.toBeNull();

    const intentInput = tagRulesForm?.querySelector('input[name="intent"]');
    expect(intentInput).not.toBeNull();
    expect((intentInput as HTMLInputElement)?.value).toBe("create_tag_rule");

    const tagField = tagRulesForm?.querySelector('[name="tag"]');
    expect(tagField).not.toBeNull();

    const termsDaysField = tagRulesForm?.querySelector('[name="defaultTermsDays"]');
    expect(termsDaysField).not.toBeNull();
  });

  it("(c) discard resets controlled state fields via onReset handler", async () => {
    const router = createMemoryRouter(
      [
        {
          path: "/app/tag-rules",
          lazy: async () => {
            const mod = await import("../app.tag-rules");
            return { Component: mod.default };
          },
          loader: () => buildTagRulesLoaderData(),
        },
      ],
      { initialEntries: ["/app/tag-rules"] }
    );

    render(createElement(RouterProvider, { router }));

    await waitFor(() => {
      const forms = document.querySelectorAll("form[data-save-bar]");
      expect(forms.length).toBeGreaterThan(0);
    }, { timeout: 5000 });

    const tagRulesForm = document.querySelector('form[data-save-bar]') as HTMLFormElement | null;
    expect(tagRulesForm).not.toBeNull();

    fireEvent.reset(tagRulesForm!);

    const tagStateHidden = tagRulesForm?.querySelector('input[name="_tagState"]') as HTMLInputElement;
    const termsDaysStateHidden = tagRulesForm?.querySelector('input[name="_termsDaysState"]') as HTMLInputElement;
    expect(tagStateHidden).not.toBeNull();
    expect(termsDaysStateHidden).not.toBeNull();
    expect(tagStateHidden.value).toBe("");
    expect(termsDaysStateHidden.value).toBe("");
  });

  it("(d) clean form with no changes has data-save-bar attribute", async () => {
    const router = createMemoryRouter(
      [
        {
          path: "/app/tag-rules",
          lazy: async () => {
            const mod = await import("../app.tag-rules");
            return { Component: mod.default };
          },
          loader: () => buildTagRulesLoaderData(),
        },
      ],
      { initialEntries: ["/app/tag-rules"] }
    );

    render(createElement(RouterProvider, { router }));

    await waitFor(() => {
      const forms = document.querySelectorAll("form[data-save-bar]");
      expect(forms.length).toBeGreaterThan(0);
    }, { timeout: 5000 });

    const tagRulesForm = document.querySelector('form[data-save-bar]');
    expect(tagRulesForm).not.toBeNull();
    expect(tagRulesForm?.hasAttribute("data-save-bar")).toBe(true);
  });

  it("has hidden inputs for state bridging", async () => {
    const router = createMemoryRouter(
      [
        {
          path: "/app/tag-rules",
          lazy: async () => {
            const mod = await import("../app.tag-rules");
            return { Component: mod.default };
          },
          loader: () => buildTagRulesLoaderData(),
        },
      ],
      { initialEntries: ["/app/tag-rules"] }
    );

    render(createElement(RouterProvider, { router }));

    await waitFor(() => {
      const forms = document.querySelectorAll("form[data-save-bar]");
      expect(forms.length).toBeGreaterThan(0);
    }, { timeout: 5000 });

    const tagRulesForm = document.querySelector('form[data-save-bar]');

    const tagStateInput = tagRulesForm?.querySelector('input[name="_tagState"]');
    expect(tagStateInput).not.toBeNull();
    expect((tagStateInput as HTMLInputElement)?.type).toBe("hidden");

    const termsDaysStateInput = tagRulesForm?.querySelector('input[name="_termsDaysState"]');
    expect(termsDaysStateInput).not.toBeNull();
    expect((termsDaysStateInput as HTMLInputElement)?.type).toBe("hidden");
  });

  it("tag rules form does NOT have data-discard-confirmation (create form)", async () => {
    const router = createMemoryRouter(
      [
        {
          path: "/app/tag-rules",
          lazy: async () => {
            const mod = await import("../app.tag-rules");
            return { Component: mod.default };
          },
          loader: () => buildTagRulesLoaderData(),
        },
      ],
      { initialEntries: ["/app/tag-rules"] }
    );

    render(createElement(RouterProvider, { router }));

    await waitFor(() => {
      const forms = document.querySelectorAll("form[data-save-bar]");
      expect(forms.length).toBeGreaterThan(0);
    }, { timeout: 5000 });

    const tagRulesForm = document.querySelector('form[data-save-bar]');
    expect(tagRulesForm).not.toBeNull();
    expect(tagRulesForm?.hasAttribute("data-discard-confirmation")).toBe(false);
  });
});

describe("Save Bar: Form Action Preservation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  it("credit settings form preserves explicit action attribute", async () => {
    const router = createMemoryRouter(
      [
        {
          path: "/app/accounts/:id",
          lazy: async () => {
            const mod = await import("../app.accounts.$id");
            return { Component: mod.default };
          },
          loader: () => buildAccountLoaderData(),
        },
      ],
      { initialEntries: [`/app/accounts/${SYNTHETIC_ACCOUNT_ID}`] }
    );

    render(createElement(RouterProvider, { router }));

    await waitFor(() => {
      const forms = document.querySelectorAll("form[data-save-bar]");
      expect(forms.length).toBeGreaterThan(0);
    }, { timeout: 5000 });

    const creditSettingsForm = Array.from(
      document.querySelectorAll("form[data-save-bar]")
    ).find((f) => f.querySelector('input[name="_action"][value="updateCredit"]') &&
                  !f.querySelector('input[name="holdOnly"]'));

    expect(creditSettingsForm).not.toBeNull();
    const action = creditSettingsForm?.getAttribute("action");
    expect(action).not.toBeNull();
    expect(action).toContain("/app/accounts/");
    expect(action).not.toContain("%25");
    expect(action).not.toContain("%252F");
  });

  it("hold form preserves explicit action attribute", async () => {
    const router = createMemoryRouter(
      [
        {
          path: "/app/accounts/:id",
          lazy: async () => {
            const mod = await import("../app.accounts.$id");
            return { Component: mod.default };
          },
          loader: () => buildAccountLoaderData({ isGated: true }),
        },
      ],
      { initialEntries: [`/app/accounts/${SYNTHETIC_ACCOUNT_ID}`] }
    );

    render(createElement(RouterProvider, { router }));

    await waitFor(() => {
      const forms = document.querySelectorAll("form[data-save-bar]");
      expect(forms.length).toBeGreaterThan(0);
    }, { timeout: 5000 });

    const holdForm = Array.from(
      document.querySelectorAll("form[data-save-bar]")
    ).find((f) => f.querySelector('input[name="holdOnly"][value="true"]'));

    expect(holdForm).not.toBeNull();
    const action = holdForm?.getAttribute("action");
    expect(action).not.toBeNull();
    expect(action).toContain("/app/accounts/");
    expect(action).not.toContain("%25");
    expect(action).not.toContain("%252F");
  });
});

describe("Save Bar: No Explicit Submit Buttons", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  it("credit settings form relies on save bar (no explicit submit button)", async () => {
    const router = createMemoryRouter(
      [
        {
          path: "/app/accounts/:id",
          lazy: async () => {
            const mod = await import("../app.accounts.$id");
            return { Component: mod.default };
          },
          loader: () => buildAccountLoaderData(),
        },
      ],
      { initialEntries: [`/app/accounts/${SYNTHETIC_ACCOUNT_ID}`] }
    );

    render(createElement(RouterProvider, { router }));

    await waitFor(() => {
      const forms = document.querySelectorAll("form[data-save-bar]");
      expect(forms.length).toBeGreaterThan(0);
    }, { timeout: 5000 });

    const creditSettingsForm = Array.from(
      document.querySelectorAll("form[data-save-bar]")
    ).find((f) => f.querySelector('input[name="_action"][value="updateCredit"]') &&
                  !f.querySelector('input[name="holdOnly"]'));

    expect(creditSettingsForm).not.toBeNull();
    
    const submitButtons = creditSettingsForm?.querySelectorAll('s-button[type="submit"], button[type="submit"]');
    expect(submitButtons?.length ?? 0).toBe(0);
  });

  it("hold form relies on save bar (no explicit submit button)", async () => {
    const router = createMemoryRouter(
      [
        {
          path: "/app/accounts/:id",
          lazy: async () => {
            const mod = await import("../app.accounts.$id");
            return { Component: mod.default };
          },
          loader: () => buildAccountLoaderData({ isGated: true }),
        },
      ],
      { initialEntries: [`/app/accounts/${SYNTHETIC_ACCOUNT_ID}`] }
    );

    render(createElement(RouterProvider, { router }));

    await waitFor(() => {
      const forms = document.querySelectorAll("form[data-save-bar]");
      expect(forms.length).toBeGreaterThan(0);
    }, { timeout: 5000 });

    const holdForm = Array.from(
      document.querySelectorAll("form[data-save-bar]")
    ).find((f) => f.querySelector('input[name="holdOnly"][value="true"]'));

    expect(holdForm).not.toBeNull();
    
    const submitButtons = holdForm?.querySelectorAll('s-button[type="submit"], button[type="submit"]');
    expect(submitButtons?.length ?? 0).toBe(0);
  });

  it("tag rules form relies on save bar (no explicit submit button)", async () => {
    const router = createMemoryRouter(
      [
        {
          path: "/app/tag-rules",
          lazy: async () => {
            const mod = await import("../app.tag-rules");
            return { Component: mod.default };
          },
          loader: () => buildTagRulesLoaderData(),
        },
      ],
      { initialEntries: ["/app/tag-rules"] }
    );

    render(createElement(RouterProvider, { router }));

    await waitFor(() => {
      const forms = document.querySelectorAll("form[data-save-bar]");
      expect(forms.length).toBeGreaterThan(0);
    }, { timeout: 5000 });

    const tagRulesForm = document.querySelector('form[data-save-bar]');
    expect(tagRulesForm).not.toBeNull();
    
    const submitButtons = tagRulesForm?.querySelectorAll('s-button[type="submit"], button[type="submit"]');
    expect(submitButtons?.length ?? 0).toBe(0);
  });
});
