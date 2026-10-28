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
    it("returns complete when buyer accounts exist", () => {
      const step = computeBuyerSetupStep(5, 0);
      expect(step.status).toBe("complete");
      expect(step.helpText).toContain("5 buyer account(s)");
    });

    it("returns complete when tag rules exist", () => {
      const step = computeBuyerSetupStep(0, 3);
      expect(step.status).toBe("complete");
      expect(step.helpText).toContain("3 customer tag rule(s)");
    });

    it("returns complete when both exist", () => {
      const step = computeBuyerSetupStep(2, 3);
      expect(step.status).toBe("complete");
      expect(step.helpText).toContain("2 buyer account(s)");
      expect(step.helpText).toContain("3 tag rule(s)");
    });

    it("returns pending when neither exists", () => {
      const step = computeBuyerSetupStep(0, 0);
      expect(step.status).toBe("pending");
    });

    it("S23-03: returns actionUrl /app/tag-rules when pending", () => {
      const step = computeBuyerSetupStep(0, 0);
      expect(step.status).toBe("pending");
      expect(step.actionUrl).toBe("/app/tag-rules");
      expect(step.actionLabel).toBe("Create tag rule");
    });

    it("S23-03: does not return actionUrl when complete", () => {
      const step = computeBuyerSetupStep(5, 0);
      expect(step.status).toBe("complete");
      expect(step.actionUrl).toBeUndefined();
      expect(step.actionLabel).toBeUndefined();
    });

    it("S23-03: does not return actionUrl when complete via tag rules", () => {
      const step = computeBuyerSetupStep(0, 2);
      expect(step.status).toBe("complete");
      expect(step.actionUrl).toBeUndefined();
      expect(step.actionLabel).toBeUndefined();
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
