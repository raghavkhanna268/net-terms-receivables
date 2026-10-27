import { describe, it, expect } from "vitest";
import {
  computePlanStep,
  computeOnboardingState,
  type OnboardingStepInputs,
} from "../onboarding-steps.server";

/**
 * Tests for the "Choose a plan" step in the Setup Guide.
 *
 * The step:
 * - Shows as "complete" when plan status is "active"
 * - Shows as "pending" with action link when plan status is "none" or "error"
 * - Links to the pricing URL with target="_top" when available
 * - Links to /app/plan when pricing URL is not available
 * - Never blocks other steps
 */

const TEST_PRICING_URL = "https://admin.shopify.com/store/test-shop/charges/test-app-handle/pricing_plans";

describe("computePlanStep", () => {
  it("shows complete status when plan is active", () => {
    const step = computePlanStep("active", TEST_PRICING_URL);

    expect(step.id).toBe("choose-plan");
    expect(step.status).toBe("complete");
    expect(step.title).toBe("Choose a plan");
    expect(step.helpText).toBe("Plan selected");
    expect(step.actionUrl).toBeUndefined();
  });

  it("shows pending status with pricing URL and target _top when plan is none", () => {
    const step = computePlanStep("none", TEST_PRICING_URL);

    expect(step.status).toBe("pending");
    expect(step.actionUrl).toBe(TEST_PRICING_URL);
    expect(step.actionTarget).toBe("_top");
    expect(step.actionLabel).toBe("Select plan");
    expect(step.helpText).toBe("Pick a plan to keep using all features.");
  });

  it("shows pending status with pricing URL and target _top when plan is error", () => {
    const step = computePlanStep("error", TEST_PRICING_URL);

    expect(step.status).toBe("pending");
    expect(step.actionUrl).toBe(TEST_PRICING_URL);
    expect(step.actionTarget).toBe("_top");
    expect(step.actionLabel).toBe("Select plan");
  });

  it("links to /app/plan when pricing URL is null (APP_HANDLE not set)", () => {
    const step = computePlanStep("none", null);

    expect(step.status).toBe("pending");
    expect(step.actionUrl).toBe("/app/plan");
    expect(step.actionTarget).toBeUndefined();
    expect(step.actionLabel).toBe("Select plan");
  });

  it("links to /app/plan when pricing URL is undefined", () => {
    const step = computePlanStep("none", undefined);

    expect(step.status).toBe("pending");
    expect(step.actionUrl).toBe("/app/plan");
    expect(step.actionTarget).toBeUndefined();
  });

  it("shows pending status when planStatus is undefined", () => {
    const step = computePlanStep(undefined, TEST_PRICING_URL);

    expect(step.status).toBe("pending");
    expect(step.actionUrl).toBe(TEST_PRICING_URL);
    expect(step.actionTarget).toBe("_top");
  });
});

describe("computeOnboardingState with plan step", () => {
  const baseInputs: OnboardingStepInputs = {
    shopId: "shop-123",
    defaultTermsDays: 30,
    buyerAccountCount: 5,
    tagRuleCount: 2,
    validation: {
      id: "val-1",
      handle: "credit-check-validation",
      enabled: true,
      title: "Credit Check",
    },
    paymentCustomization: {
      id: "pc-1",
      handle: "hide-terms-payment",
      enabled: true,
      title: "Hide Terms",
    },
    emailSendingConfigured: true,
    remindersEnabled: true,
    dismissedAt: null,
    planStatus: "active",
    planSelectionUrl: TEST_PRICING_URL,
  };

  it("includes Choose a plan step as first step", () => {
    const state = computeOnboardingState(baseInputs);

    expect(state.steps[0].id).toBe("choose-plan");
    expect(state.steps[0].title).toBe("Choose a plan");
  });

  it("shows plan step as complete when active", () => {
    const state = computeOnboardingState({
      ...baseInputs,
      planStatus: "active",
    });

    const planStep = state.steps.find((s) => s.id === "choose-plan");
    expect(planStep?.status).toBe("complete");
  });

  it("shows plan step as pending when none", () => {
    const state = computeOnboardingState({
      ...baseInputs,
      planStatus: "none",
    });

    const planStep = state.steps.find((s) => s.id === "choose-plan");
    expect(planStep?.status).toBe("pending");
    expect(planStep?.actionUrl).toBe(TEST_PRICING_URL);
    expect(planStep?.actionTarget).toBe("_top");
  });

  it("shows plan step as pending when error (does not throw)", () => {
    const state = computeOnboardingState({
      ...baseInputs,
      planStatus: "error",
    });

    const planStep = state.steps.find((s) => s.id === "choose-plan");
    expect(planStep?.status).toBe("pending");
    expect(planStep?.actionUrl).toBe(TEST_PRICING_URL);
  });

  it("other steps still render when plan is none", () => {
    const state = computeOnboardingState({
      ...baseInputs,
      planStatus: "none",
    });

    expect(state.steps.length).toBeGreaterThan(1);
    expect(state.steps.some((s) => s.id === "buyer-setup")).toBe(true);
    expect(state.steps.some((s) => s.id === "checkout-validation")).toBe(true);
    expect(state.steps.some((s) => s.id === "payment-customization")).toBe(true);
    expect(state.steps.some((s) => s.id === "reminders")).toBe(true);
  });

  it("plan step does not affect isComplete when other required steps are done", () => {
    const stateWithActivePlan = computeOnboardingState({
      ...baseInputs,
      planStatus: "active",
    });

    const stateWithNoPlan = computeOnboardingState({
      ...baseInputs,
      planStatus: "none",
    });

    expect(stateWithActivePlan.isComplete).toBe(true);
    expect(stateWithNoPlan.isComplete).toBe(false);
  });

  it("plan step with null URL links to /app/plan", () => {
    const state = computeOnboardingState({
      ...baseInputs,
      planStatus: "none",
      planSelectionUrl: null,
    });

    const planStep = state.steps.find((s) => s.id === "choose-plan");
    expect(planStep?.actionUrl).toBe("/app/plan");
    expect(planStep?.actionTarget).toBeUndefined();
  });
});
