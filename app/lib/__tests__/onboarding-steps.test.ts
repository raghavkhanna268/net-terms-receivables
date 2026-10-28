import { describe, it, expect } from "vitest";
import {
  computeDefaultTermsStep,
  computeBuyerSetupStep,
  computeValidationStep,
  computePaymentCustomizationStep,
  computeReminderStep,
  computeOnboardingState,
  shouldShowOnboarding,
  type OnboardingStepInputs,
  type ValidationInfo,
  type PaymentCustomizationInfo,
  type BuyerAccountCounts,
} from "../onboarding-steps.server";

describe("onboarding-steps", () => {
  describe("computeDefaultTermsStep", () => {
    it("returns complete when defaultTermsDays is set", () => {
      const step = computeDefaultTermsStep(30);
      expect(step.status).toBe("complete");
      expect(step.helpText).toContain("Net 30 days");
    });

    it("returns pending when defaultTermsDays is null", () => {
      const step = computeDefaultTermsStep(null);
      expect(step.status).toBe("pending");
    });

    it("returns pending when defaultTermsDays is 0", () => {
      const step = computeDefaultTermsStep(0);
      expect(step.status).toBe("pending");
    });

    it("returns pending when defaultTermsDays is negative", () => {
      const step = computeDefaultTermsStep(-5);
      expect(step.status).toBe("pending");
    });
  });

  describe("computeBuyerSetupStep", () => {
    describe("company accounts only, C == L", () => {
      it("singular: 1 B2B company synced", () => {
        const counts: BuyerAccountCounts = { locationCount: 1, companyCount: 1, taggedCustomerCount: 0 };
        const step = computeBuyerSetupStep(1, 0, counts);
        expect(step.status).toBe("complete");
        expect(step.helpText).toBe("1 B2B company synced");
      });

      it("plural: 2 B2B companies synced", () => {
        const counts: BuyerAccountCounts = { locationCount: 2, companyCount: 2, taggedCustomerCount: 0 };
        const step = computeBuyerSetupStep(2, 0, counts);
        expect(step.status).toBe("complete");
        expect(step.helpText).toBe("2 B2B companies synced");
      });
    });

    describe("company accounts only, C != L", () => {
      it("singular company, plural locations: 1 B2B company synced (3 locations, one buyer account each)", () => {
        const counts: BuyerAccountCounts = { locationCount: 3, companyCount: 1, taggedCustomerCount: 0 };
        const step = computeBuyerSetupStep(3, 0, counts);
        expect(step.status).toBe("complete");
        expect(step.helpText).toBe("1 B2B company synced (3 locations, one buyer account each)");
      });

      it("plural companies, plural locations: 2 B2B companies synced (5 locations, one buyer account each)", () => {
        const counts: BuyerAccountCounts = { locationCount: 5, companyCount: 2, taggedCustomerCount: 0 };
        const step = computeBuyerSetupStep(5, 0, counts);
        expect(step.status).toBe("complete");
        expect(step.helpText).toBe("2 B2B companies synced (5 locations, one buyer account each)");
      });

      it("singular location (edge case): 2 B2B companies synced (1 location, one buyer account each)", () => {
        const counts: BuyerAccountCounts = { locationCount: 1, companyCount: 2, taggedCustomerCount: 0 };
        const step = computeBuyerSetupStep(1, 0, counts);
        expect(step.status).toBe("complete");
        expect(step.helpText).toBe("2 B2B companies synced (1 location, one buyer account each)");
      });
    });

    describe("tagged customers only", () => {
      it("singular with rules: 1 tagged customer synced from 2 tag rules", () => {
        const counts: BuyerAccountCounts = { locationCount: 0, companyCount: 0, taggedCustomerCount: 1 };
        const step = computeBuyerSetupStep(1, 2, counts);
        expect(step.status).toBe("complete");
        expect(step.helpText).toBe("1 tagged customer synced from 2 tag rules");
      });

      it("plural with singular rule: 3 tagged customers synced from 1 tag rule", () => {
        const counts: BuyerAccountCounts = { locationCount: 0, companyCount: 0, taggedCustomerCount: 3 };
        const step = computeBuyerSetupStep(3, 1, counts);
        expect(step.status).toBe("complete");
        expect(step.helpText).toBe("3 tagged customers synced from 1 tag rule");
      });

      it("without rules (R == 0): 2 tagged customers synced", () => {
        const counts: BuyerAccountCounts = { locationCount: 0, companyCount: 0, taggedCustomerCount: 2 };
        const step = computeBuyerSetupStep(2, 0, counts);
        expect(step.status).toBe("complete");
        expect(step.helpText).toBe("2 tagged customers synced");
      });

      it("singular without rules: 1 tagged customer synced", () => {
        const counts: BuyerAccountCounts = { locationCount: 0, companyCount: 0, taggedCustomerCount: 1 };
        const step = computeBuyerSetupStep(1, 0, counts);
        expect(step.status).toBe("complete");
        expect(step.helpText).toBe("1 tagged customer synced");
      });
    });

    describe("both companies and tagged customers", () => {
      it("singular company, singular location, singular customer: 1 B2B company (1 location) and 1 tagged customer synced", () => {
        const counts: BuyerAccountCounts = { locationCount: 1, companyCount: 1, taggedCustomerCount: 1 };
        const step = computeBuyerSetupStep(2, 0, counts);
        expect(step.status).toBe("complete");
        expect(step.helpText).toBe("1 B2B company (1 location) and 1 tagged customer synced");
      });

      it("plural companies, plural locations, plural customers: 2 B2B companies (5 locations) and 3 tagged customers synced", () => {
        const counts: BuyerAccountCounts = { locationCount: 5, companyCount: 2, taggedCustomerCount: 3 };
        const step = computeBuyerSetupStep(8, 0, counts);
        expect(step.status).toBe("complete");
        expect(step.helpText).toBe("2 B2B companies (5 locations) and 3 tagged customers synced");
      });
    });

    describe("rules but no accounts", () => {
      it("singular rule: 1 customer tag rule configured", () => {
        const counts: BuyerAccountCounts = { locationCount: 0, companyCount: 0, taggedCustomerCount: 0 };
        const step = computeBuyerSetupStep(0, 1, counts);
        expect(step.status).toBe("complete");
        expect(step.helpText).toBe("1 customer tag rule configured");
      });

      it("plural rules: 3 customer tag rules configured", () => {
        const counts: BuyerAccountCounts = { locationCount: 0, companyCount: 0, taggedCustomerCount: 0 };
        const step = computeBuyerSetupStep(0, 3, counts);
        expect(step.status).toBe("complete");
        expect(step.helpText).toBe("3 customer tag rules configured");
      });
    });

    describe("empty state", () => {
      it("sync done and empty: shows empty-state copy", () => {
        const counts: BuyerAccountCounts = { locationCount: 0, companyCount: 0, taggedCustomerCount: 0 };
        const step = computeBuyerSetupStep(0, 0, counts, "done");
        expect(step.status).toBe("pending");
        expect(step.helpText).toBe(
          "No company locations or tag rules found yet. Add a location to a B2B company in Shopify, or create a tag rule."
        );
      });

      it("sync not done: shows default pending copy", () => {
        const counts: BuyerAccountCounts = { locationCount: 0, companyCount: 0, taggedCustomerCount: 0 };
        const step = computeBuyerSetupStep(0, 0, counts, "not_started");
        expect(step.status).toBe("pending");
        expect(step.helpText).toBe(
          "Sync B2B companies or create tag rules to identify net-terms buyers"
        );
      });

      it("sync in_progress: shows default pending copy", () => {
        const counts: BuyerAccountCounts = { locationCount: 0, companyCount: 0, taggedCustomerCount: 0 };
        const step = computeBuyerSetupStep(0, 0, counts, "in_progress");
        expect(step.status).toBe("pending");
        expect(step.helpText).toBe(
          "Sync B2B companies or create tag rules to identify net-terms buyers"
        );
      });

      it("sync failed: shows default pending copy", () => {
        const counts: BuyerAccountCounts = { locationCount: 0, companyCount: 0, taggedCustomerCount: 0 };
        const step = computeBuyerSetupStep(0, 0, counts, "failed");
        expect(step.status).toBe("pending");
        expect(step.helpText).toBe(
          "Sync B2B companies or create tag rules to identify net-terms buyers"
        );
      });

      it("no sync status (undefined): shows default pending copy", () => {
        const counts: BuyerAccountCounts = { locationCount: 0, companyCount: 0, taggedCustomerCount: 0 };
        const step = computeBuyerSetupStep(0, 0, counts, undefined);
        expect(step.status).toBe("pending");
        expect(step.helpText).toBe(
          "Sync B2B companies or create tag rules to identify net-terms buyers"
        );
      });
    });

    describe("completion rule", () => {
      it("complete when L + T > 0", () => {
        const counts: BuyerAccountCounts = { locationCount: 1, companyCount: 1, taggedCustomerCount: 0 };
        const step = computeBuyerSetupStep(1, 0, counts);
        expect(step.status).toBe("complete");
      });

      it("complete when R > 0", () => {
        const counts: BuyerAccountCounts = { locationCount: 0, companyCount: 0, taggedCustomerCount: 0 };
        const step = computeBuyerSetupStep(0, 1, counts);
        expect(step.status).toBe("complete");
      });

      it("pending when L == 0 AND T == 0 AND R == 0", () => {
        const counts: BuyerAccountCounts = { locationCount: 0, companyCount: 0, taggedCustomerCount: 0 };
        const step = computeBuyerSetupStep(0, 0, counts);
        expect(step.status).toBe("pending");
      });
    });

    describe("S23-03: action URLs", () => {
      it("returns actionUrl /app/tag-rules when pending", () => {
        const counts: BuyerAccountCounts = { locationCount: 0, companyCount: 0, taggedCustomerCount: 0 };
        const step = computeBuyerSetupStep(0, 0, counts);
        expect(step.status).toBe("pending");
        expect(step.actionUrl).toBe("/app/tag-rules");
        expect(step.actionLabel).toBe("Create tag rule");
      });

      it("does not return actionUrl when complete via companies", () => {
        const counts: BuyerAccountCounts = { locationCount: 5, companyCount: 5, taggedCustomerCount: 0 };
        const step = computeBuyerSetupStep(5, 0, counts);
        expect(step.status).toBe("complete");
        expect(step.actionUrl).toBeUndefined();
        expect(step.actionLabel).toBeUndefined();
      });

      it("does not return actionUrl when complete via tag rules", () => {
        const counts: BuyerAccountCounts = { locationCount: 0, companyCount: 0, taggedCustomerCount: 0 };
        const step = computeBuyerSetupStep(0, 2, counts);
        expect(step.status).toBe("complete");
        expect(step.actionUrl).toBeUndefined();
        expect(step.actionLabel).toBeUndefined();
      });
    });

    describe("backward compatibility (no buyerCounts)", () => {
      it("falls back to buyerAccountCount when buyerCounts is undefined", () => {
        const step = computeBuyerSetupStep(5, 0);
        expect(step.status).toBe("complete");
        expect(step.helpText).toBe("5 B2B companies synced");
      });

      it("falls back to pending copy when neither exists", () => {
        const step = computeBuyerSetupStep(0, 0);
        expect(step.status).toBe("pending");
        expect(step.helpText).toBe(
          "Sync B2B companies or create tag rules to identify net-terms buyers"
        );
      });
    });
  });

  describe("computeValidationStep", () => {
    it("returns complete when validation exists and is enabled", () => {
      const validation: ValidationInfo = {
        id: "gid://shopify/Validation/123",
        handle: "credit-check-validation",
        enabled: true,
        title: "Termwise Credit Check",
      };
      const step = computeValidationStep(validation);
      expect(step.status).toBe("complete");
    });

    it("returns attention when validation exists but is disabled", () => {
      const validation: ValidationInfo = {
        id: "gid://shopify/Validation/123",
        handle: "credit-check-validation",
        enabled: false,
        title: "Termwise Credit Check",
      };
      const step = computeValidationStep(validation);
      expect(step.status).toBe("attention");
      expect(step.helpText).toContain("disabled");
    });

    it("returns attention when validation does not exist", () => {
      const step = computeValidationStep(null);
      expect(step.status).toBe("attention");
      expect(step.helpText).toContain("not registered");
    });

    it("returns pending when validation has wrong handle", () => {
      const validation: ValidationInfo = {
        id: "gid://shopify/Validation/123",
        handle: "wrong-handle",
        enabled: true,
        title: "Wrong Validation",
      };
      const step = computeValidationStep(validation);
      expect(step.status).toBe("pending");
    });

    it("sets actionTarget _top when complete with admin URL", () => {
      const validation: ValidationInfo = {
        id: "gid://shopify/Validation/123",
        handle: "credit-check-validation",
        enabled: true,
        title: "Termwise Credit Check",
      };
      const step = computeValidationStep(validation);
      expect(step.actionUrl).toBe("shopify://admin/settings/checkout");
      expect(step.actionTarget).toBe("_top");
    });

    it("sets actionTarget _top when attention with admin URL", () => {
      const validation: ValidationInfo = {
        id: "gid://shopify/Validation/123",
        handle: "credit-check-validation",
        enabled: false,
        title: "Termwise Credit Check",
      };
      const step = computeValidationStep(validation);
      expect(step.actionUrl).toBe("shopify://admin/settings/checkout");
      expect(step.actionTarget).toBe("_top");
    });

    it("does not set actionTarget when no actionUrl", () => {
      const step = computeValidationStep(null);
      expect(step.actionUrl).toBeUndefined();
      expect(step.actionTarget).toBeUndefined();
    });
  });

  describe("computePaymentCustomizationStep", () => {
    it("returns complete when customization exists and is enabled", () => {
      const customization: PaymentCustomizationInfo = {
        id: "gid://shopify/PaymentCustomization/123",
        handle: "hide-terms-payment",
        enabled: true,
        title: "Termwise Payment Hide",
      };
      const step = computePaymentCustomizationStep(customization);
      expect(step.status).toBe("complete");
    });

    it("returns attention when customization exists but is disabled", () => {
      const customization: PaymentCustomizationInfo = {
        id: "gid://shopify/PaymentCustomization/123",
        handle: "hide-terms-payment",
        enabled: false,
        title: "Termwise Payment Hide",
      };
      const step = computePaymentCustomizationStep(customization);
      expect(step.status).toBe("attention");
      expect(step.helpText).toContain("disabled");
    });

    it("returns attention when customization does not exist", () => {
      const step = computePaymentCustomizationStep(null);
      expect(step.status).toBe("attention");
      expect(step.helpText).toContain("not registered");
    });

    it("sets actionTarget _top when complete with admin URL", () => {
      const customization: PaymentCustomizationInfo = {
        id: "gid://shopify/PaymentCustomization/123",
        handle: "hide-terms-payment",
        enabled: true,
        title: "Termwise Payment Hide",
      };
      const step = computePaymentCustomizationStep(customization);
      expect(step.actionUrl).toBe("shopify://admin/settings/payments");
      expect(step.actionTarget).toBe("_top");
    });

    it("sets actionTarget _top when attention with admin URL", () => {
      const customization: PaymentCustomizationInfo = {
        id: "gid://shopify/PaymentCustomization/123",
        handle: "hide-terms-payment",
        enabled: false,
        title: "Termwise Payment Hide",
      };
      const step = computePaymentCustomizationStep(customization);
      expect(step.actionUrl).toBe("shopify://admin/settings/payments");
      expect(step.actionTarget).toBe("_top");
    });

    it("does not set actionTarget when no actionUrl", () => {
      const step = computePaymentCustomizationStep(null);
      expect(step.actionUrl).toBeUndefined();
      expect(step.actionTarget).toBeUndefined();
    });
  });

  describe("computeReminderStep", () => {
    it("returns coming_soon when email sending is not configured", () => {
      const step = computeReminderStep(false, false);
      expect(step.status).toBe("coming_soon");
      expect(step.helpText).toContain("will be available");
    });

    it("returns coming_soon when sending not configured even if reminders enabled", () => {
      const step = computeReminderStep(false, true);
      expect(step.status).toBe("coming_soon");
      expect(step.helpText).toContain("will be available");
    });

    it("returns pending when sending configured but reminders disabled", () => {
      const step = computeReminderStep(true, false);
      expect(step.status).toBe("pending");
      expect(step.helpText).toContain("Email sending is ready");
      expect(step.actionUrl).toBe("/app/settings/reminders");
      expect(step.actionLabel).toBe("Enable reminders");
    });

    it("returns complete when both sending configured AND reminders enabled", () => {
      const step = computeReminderStep(true, true);
      expect(step.status).toBe("complete");
      expect(step.helpText).toContain("configured and ready");
    });
  });

  describe("computeReminderStep with isEmailSendingConfigured", () => {
    it("step is not-ready when only API key is set (sender missing)", async () => {
      const { isEmailSendingConfigured } = await import("../email-sender-config.server");
      const configured = isEmailSendingConfigured({
        RESEND_API_KEY: "re_fake_key_for_test_only_12345",
        RESEND_FROM: undefined,
      });
      const step = computeReminderStep(configured, true);
      expect(step.status).toBe("coming_soon");
    });

    it("step is not-ready when only sender is set (API key missing)", async () => {
      const { isEmailSendingConfigured } = await import("../email-sender-config.server");
      const configured = isEmailSendingConfigured({
        RESEND_API_KEY: undefined,
        RESEND_FROM: "noreply@example.com",
      });
      const step = computeReminderStep(configured, true);
      expect(step.status).toBe("coming_soon");
    });

    it("step is ready when both API key and sender are set and reminders enabled", async () => {
      const { isEmailSendingConfigured } = await import("../email-sender-config.server");
      const configured = isEmailSendingConfigured({
        RESEND_API_KEY: "re_fake_key_for_test_only_12345",
        RESEND_FROM: "noreply@example.com",
      });
      const step = computeReminderStep(configured, true);
      expect(step.status).toBe("complete");
    });
  });

  describe("computeOnboardingState", () => {
    const baseInputs: OnboardingStepInputs = {
      shopId: "shop-123",
      defaultTermsDays: null,
      buyerAccountCount: 0,
      tagRuleCount: 0,
      validation: null,
      paymentCustomization: null,
      emailSendingConfigured: false,
      remindersEnabled: false,
      dismissedAt: null,
    };

    it("returns incomplete state when no steps are done", () => {
      const state = computeOnboardingState(baseInputs);
      expect(state.isComplete).toBe(false);
      expect(state.steps).toHaveLength(5);
    });

    it("returns complete state when all required steps are done", () => {
      const inputs: OnboardingStepInputs = {
        ...baseInputs,
        defaultTermsDays: 30,
        buyerAccountCount: 5,
        validation: {
          id: "gid://shopify/Validation/123",
          handle: "credit-check-validation",
          enabled: true,
          title: "Termwise Credit Check",
        },
        paymentCustomization: {
          id: "gid://shopify/PaymentCustomization/123",
          handle: "hide-terms-payment",
          enabled: true,
          title: "Termwise Payment Hide",
        },
        emailSendingConfigured: false, // coming_soon doesn't block completion
        remindersEnabled: false,
        planStatus: "active",
        planSelectionUrl: "https://example.com/pricing",
      };

      const state = computeOnboardingState(inputs);
      expect(state.isComplete).toBe(true);
    });

    it("counts coming_soon as completed for progress", () => {
      const inputs: OnboardingStepInputs = {
        ...baseInputs,
        emailSendingConfigured: false,
      };

      const state = computeOnboardingState(inputs);
      const reminderStep = state.steps.find((s) => s.id === "reminders");
      expect(reminderStep?.status).toBe("coming_soon");
      expect(state.completedCount).toBeGreaterThanOrEqual(1);
    });

    it("preserves dismissedAt from inputs", () => {
      const dismissedDate = new Date("2026-10-24T10:00:00Z");
      const inputs: OnboardingStepInputs = {
        ...baseInputs,
        dismissedAt: dismissedDate,
      };

      const state = computeOnboardingState(inputs);
      expect(state.dismissedAt).toEqual(dismissedDate);
    });
  });

  describe("v1 step list pinning", () => {
    const freshShopInputs: OnboardingStepInputs = {
      shopId: "shop-fresh",
      defaultTermsDays: null,
      buyerAccountCount: 0,
      tagRuleCount: 0,
      validation: null,
      paymentCustomization: null,
      emailSendingConfigured: false,
      remindersEnabled: false,
      dismissedAt: null,
    };

    it("v1 step list contains exactly 5 steps in order: choose-plan, buyer-setup, checkout-validation, payment-customization, reminders", () => {
      const state = computeOnboardingState(freshShopInputs);
      const stepIds = state.steps.map((s) => s.id);
      expect(stepIds).toEqual([
        "choose-plan",
        "buyer-setup",
        "checkout-validation",
        "payment-customization",
        "reminders",
      ]);
    });

    it("fresh shop yields 1 of 5 completed (reminders is coming_soon)", () => {
      const state = computeOnboardingState(freshShopInputs);
      expect(state.completedCount).toBe(1);
      expect(state.totalCount).toBe(5);
    });

    it("defaultTermsDays being set does not change the step list or count", () => {
      const inputsWithTerms: OnboardingStepInputs = {
        ...freshShopInputs,
        defaultTermsDays: 30,
      };
      const state = computeOnboardingState(inputsWithTerms);
      const stepIds = state.steps.map((s) => s.id);
      expect(stepIds).toEqual([
        "choose-plan",
        "buyer-setup",
        "checkout-validation",
        "payment-customization",
        "reminders",
      ]);
      expect(state.completedCount).toBe(1);
      expect(state.totalCount).toBe(5);
    });

    it("defaultTermsDays being unset does not change the step list or count", () => {
      const inputsWithoutTerms: OnboardingStepInputs = {
        ...freshShopInputs,
        defaultTermsDays: null,
      };
      const state = computeOnboardingState(inputsWithoutTerms);
      const stepIds = state.steps.map((s) => s.id);
      expect(stepIds).toEqual([
        "choose-plan",
        "buyer-setup",
        "checkout-validation",
        "payment-customization",
        "reminders",
      ]);
      expect(state.completedCount).toBe(1);
      expect(state.totalCount).toBe(5);
    });
  });

  describe("shouldShowOnboarding", () => {
    it("returns false when setup is complete", () => {
      const state = {
        steps: [],
        isComplete: true,
        completedCount: 4,
        totalCount: 4,
        dismissedAt: null,
      };
      expect(shouldShowOnboarding(state)).toBe(false);
    });

    it("returns false when dismissed", () => {
      const state = {
        steps: [],
        isComplete: false,
        completedCount: 2,
        totalCount: 4,
        dismissedAt: new Date(),
      };
      expect(shouldShowOnboarding(state)).toBe(false);
    });

    it("returns true when incomplete and not dismissed", () => {
      const state = {
        steps: [],
        isComplete: false,
        completedCount: 2,
        totalCount: 4,
        dismissedAt: null,
      };
      expect(shouldShowOnboarding(state)).toBe(true);
    });
  });

  describe("step IDs are unique", () => {
    it("all steps have unique IDs", () => {
      const inputs: OnboardingStepInputs = {
        shopId: "shop-123",
        defaultTermsDays: 30,
        buyerAccountCount: 5,
        tagRuleCount: 2,
        validation: {
          id: "gid://shopify/Validation/123",
          handle: "credit-check-validation",
          enabled: true,
          title: "Termwise Credit Check",
        },
        paymentCustomization: {
          id: "gid://shopify/PaymentCustomization/123",
          handle: "hide-terms-payment",
          enabled: true,
          title: "Termwise Payment Hide",
        },
        emailSendingConfigured: true,
        remindersEnabled: true,
        dismissedAt: null,
        planStatus: "active",
        planSelectionUrl: "https://example.com/pricing",
      };

      const state = computeOnboardingState(inputs);
      const ids = state.steps.map((s) => s.id);
      const uniqueIds = [...new Set(ids)];
      expect(uniqueIds).toHaveLength(5);
      expect(uniqueIds).toHaveLength(ids.length);
    });
  });

  describe("step fields are always present", () => {
    it("all steps have required fields", () => {
      const inputs: OnboardingStepInputs = {
        shopId: "shop-123",
        defaultTermsDays: null,
        buyerAccountCount: 0,
        tagRuleCount: 0,
        validation: null,
        paymentCustomization: null,
        emailSendingConfigured: false,
        remindersEnabled: false,
        dismissedAt: null,
      };

      const state = computeOnboardingState(inputs);
      
      for (const step of state.steps) {
        expect(step.id).toBeTruthy();
        expect(step.title).toBeTruthy();
        expect(step.description).toBeTruthy();
        expect(["complete", "pending", "attention", "coming_soon"]).toContain(
          step.status
        );
      }
    });
  });
});
