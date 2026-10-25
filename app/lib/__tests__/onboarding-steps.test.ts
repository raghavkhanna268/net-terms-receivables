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
        title: "Net Terms Credit Check",
      };
      const step = computeValidationStep(validation);
      expect(step.status).toBe("complete");
    });

    it("returns attention when validation exists but is disabled", () => {
      const validation: ValidationInfo = {
        id: "gid://shopify/Validation/123",
        handle: "credit-check-validation",
        enabled: false,
        title: "Net Terms Credit Check",
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
  });

  describe("computePaymentCustomizationStep", () => {
    it("returns complete when customization exists and is enabled", () => {
      const customization: PaymentCustomizationInfo = {
        id: "gid://shopify/PaymentCustomization/123",
        handle: "hide-terms-payment",
        enabled: true,
        title: "Net Terms Payment Hide",
      };
      const step = computePaymentCustomizationStep(customization);
      expect(step.status).toBe("complete");
    });

    it("returns attention when customization exists but is disabled", () => {
      const customization: PaymentCustomizationInfo = {
        id: "gid://shopify/PaymentCustomization/123",
        handle: "hide-terms-payment",
        enabled: false,
        title: "Net Terms Payment Hide",
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
  });

  describe("computeReminderStep", () => {
    it("returns coming_soon when RESEND_API_KEY is not configured", () => {
      const step = computeReminderStep(false);
      expect(step.status).toBe("coming_soon");
      expect(step.helpText).toContain("will be available");
    });

    it("returns complete when RESEND_API_KEY is configured", () => {
      const step = computeReminderStep(true);
      expect(step.status).toBe("complete");
      expect(step.helpText).toContain("configured and ready");
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
      resendApiKeyConfigured: false,
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
          title: "Net Terms Credit Check",
        },
        paymentCustomization: {
          id: "gid://shopify/PaymentCustomization/123",
          handle: "hide-terms-payment",
          enabled: true,
          title: "Net Terms Payment Hide",
        },
        resendApiKeyConfigured: false, // coming_soon doesn't block completion
      };

      const state = computeOnboardingState(inputs);
      expect(state.isComplete).toBe(true);
    });

    it("counts coming_soon as completed for progress", () => {
      const inputs: OnboardingStepInputs = {
        ...baseInputs,
        resendApiKeyConfigured: false,
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

  describe("shouldShowOnboarding", () => {
    it("returns false when setup is complete", () => {
      const state = {
        steps: [],
        isComplete: true,
        completedCount: 5,
        totalCount: 5,
        dismissedAt: null,
      };
      expect(shouldShowOnboarding(state)).toBe(false);
    });

    it("returns false when dismissed", () => {
      const state = {
        steps: [],
        isComplete: false,
        completedCount: 2,
        totalCount: 5,
        dismissedAt: new Date(),
      };
      expect(shouldShowOnboarding(state)).toBe(false);
    });

    it("returns true when incomplete and not dismissed", () => {
      const state = {
        steps: [],
        isComplete: false,
        completedCount: 2,
        totalCount: 5,
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
          title: "Net Terms Credit Check",
        },
        paymentCustomization: {
          id: "gid://shopify/PaymentCustomization/123",
          handle: "hide-terms-payment",
          enabled: true,
          title: "Net Terms Payment Hide",
        },
        resendApiKeyConfigured: true,
        dismissedAt: null,
      };

      const state = computeOnboardingState(inputs);
      const ids = state.steps.map((s) => s.id);
      const uniqueIds = [...new Set(ids)];
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
        resendApiKeyConfigured: false,
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
