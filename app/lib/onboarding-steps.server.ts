/**
 * Onboarding Step State Logic (S23)
 *
 * Pure, testable functions for determining onboarding step completion states.
 * Each step reads REAL state from the database or Shopify Admin API - nothing hardcoded.
 *
 * Steps:
 * 1. Default net terms configured
 * 2. First buyer account or tag rule created
 * 3. Checkout validation active (S12)
 * 4. Payment customization registered (S13)
 * 5. Reminder sender configured (email, shown as "coming soon" when RESEND_API_KEY missing)
 */

import type { Sql } from "~/lib/db-light.server";

/**
 * Step status indicating the current state of an onboarding step.
 */
export type StepStatus =
  | "complete"
  | "pending"
  | "attention" // Needs attention (e.g., registration failed)
  | "coming_soon"; // Feature not yet available

/**
 * Individual step state with metadata for display.
 */
export interface OnboardingStep {
  id: string;
  title: string;
  description: string;
  status: StepStatus;
  actionUrl?: string;
  actionLabel?: string;
  helpText?: string;
}

/**
 * Overall onboarding state for a shop.
 */
export interface OnboardingState {
  steps: OnboardingStep[];
  isComplete: boolean;
  completedCount: number;
  totalCount: number;
  dismissedAt: Date | null;
}

/**
 * Validation function info from Shopify Admin API.
 */
export interface ValidationInfo {
  id: string;
  handle: string;
  enabled: boolean;
  title: string;
}

/**
 * Payment customization info from Shopify Admin API.
 */
export interface PaymentCustomizationInfo {
  id: string;
  handle: string;
  enabled: boolean;
  title: string;
}

/**
 * Data needed to compute onboarding step states.
 * All fields are fetched from real sources (DB or Admin API).
 */
export interface OnboardingStepInputs {
  shopId: string;
  defaultTermsDays: number | null;
  buyerAccountCount: number;
  tagRuleCount: number;
  validation: ValidationInfo | null;
  paymentCustomization: PaymentCustomizationInfo | null;
  resendApiKeyConfigured: boolean;
  dismissedAt: Date | null;
}

const VALIDATION_FUNCTION_HANDLE = "credit-check-validation";
const PAYMENT_CUSTOMIZATION_HANDLE = "hide-terms-payment";

/**
 * Compute step 1: Default net terms configured.
 */
export function computeDefaultTermsStep(
  defaultTermsDays: number | null
): OnboardingStep {
  const isComplete = defaultTermsDays !== null && defaultTermsDays > 0;

  return {
    id: "default-terms",
    title: "Set default payment terms",
    description: "Configure the default net terms days for new buyer accounts",
    status: isComplete ? "complete" : "pending",
    actionUrl: "/app/settings",
    actionLabel: isComplete ? "Edit settings" : "Configure terms",
    helpText: isComplete
      ? `Default: Net ${defaultTermsDays} days`
      : "Set a default payment term (e.g., Net 30) for orders without specific terms",
  };
}

/**
 * Compute step 2: First buyer account or tag rule created.
 */
export function computeBuyerSetupStep(
  buyerAccountCount: number,
  tagRuleCount: number
): OnboardingStep {
  const hasAccounts = buyerAccountCount > 0;
  const hasTagRules = tagRuleCount > 0;
  const isComplete = hasAccounts || hasTagRules;

  let helpText: string;
  if (hasAccounts && hasTagRules) {
    helpText = `${buyerAccountCount} buyer account(s) and ${tagRuleCount} tag rule(s) configured`;
  } else if (hasAccounts) {
    helpText = `${buyerAccountCount} buyer account(s) synced from B2B companies`;
  } else if (hasTagRules) {
    helpText = `${tagRuleCount} customer tag rule(s) configured`;
  } else {
    helpText =
      "Sync B2B companies or create tag rules to identify net-terms buyers";
  }

  return {
    id: "buyer-setup",
    title: "Configure buyer accounts",
    description:
      "Set up B2B company sync or create customer tag rules for net-terms eligibility",
    status: isComplete ? "complete" : "pending",
    actionUrl: "/app/buyers",
    actionLabel: isComplete ? "Manage buyers" : "Add buyers",
    helpText,
  };
}

/**
 * Compute step 3: Checkout validation active (S12).
 */
export function computeValidationStep(
  validation: ValidationInfo | null
): OnboardingStep {
  const exists = validation !== null;
  const isEnabled = validation?.enabled ?? false;
  const hasCorrectHandle = validation?.handle === VALIDATION_FUNCTION_HANDLE;

  let status: StepStatus;
  let helpText: string;
  let actionLabel: string;

  if (exists && isEnabled && hasCorrectHandle) {
    status = "complete";
    helpText = "Checkout validation is active and protecting your store";
    actionLabel = "View in Shopify";
  } else if (exists && !isEnabled) {
    status = "attention";
    helpText =
      "Validation function exists but is disabled. Enable it in checkout settings.";
    actionLabel = "Enable validation";
  } else if (!exists) {
    status = "attention";
    helpText =
      "Checkout validation not registered. This may indicate a setup issue.";
    actionLabel = "Retry setup";
  } else {
    status = "pending";
    helpText = "Checkout protection is being configured";
    actionLabel = "Check status";
  }

  return {
    id: "checkout-validation",
    title: "Enable checkout protection",
    description:
      "Block checkout for buyers on credit hold or over their limit",
    status,
    actionUrl: "shopify://admin/settings/checkout",
    actionLabel,
    helpText,
  };
}

/**
 * Compute step 4: Payment customization registered (S13).
 */
export function computePaymentCustomizationStep(
  customization: PaymentCustomizationInfo | null
): OnboardingStep {
  const exists = customization !== null;
  const isEnabled = customization?.enabled ?? false;
  const hasCorrectHandle = customization?.handle === PAYMENT_CUSTOMIZATION_HANDLE;

  let status: StepStatus;
  let helpText: string;
  let actionLabel: string;

  if (exists && isEnabled && hasCorrectHandle) {
    status = "complete";
    helpText = "Payment customization is active";
    actionLabel = "View in Shopify";
  } else if (exists && !isEnabled) {
    status = "attention";
    helpText =
      "Payment customization exists but is disabled. Enable it in payment settings.";
    actionLabel = "Enable customization";
  } else if (!exists) {
    status = "attention";
    helpText =
      "Payment customization not registered. This may indicate a setup issue.";
    actionLabel = "Retry setup";
  } else {
    status = "pending";
    helpText = "Payment customization is being configured";
    actionLabel = "Check status";
  }

  return {
    id: "payment-customization",
    title: "Configure payment options",
    description:
      "Hide or show payment methods based on buyer account status",
    status,
    actionUrl: "shopify://admin/settings/payments",
    actionLabel,
    helpText,
  };
}

/**
 * Compute step 5: Reminder sender configured.
 * Shows as "coming soon" when RESEND_API_KEY is not configured.
 */
export function computeReminderStep(
  resendApiKeyConfigured: boolean
): OnboardingStep {
  if (!resendApiKeyConfigured) {
    return {
      id: "reminders",
      title: "Email reminders",
      description: "Send automated payment reminder emails to buyers",
      status: "coming_soon",
      helpText: "Email reminders will be available when email sending is configured",
    };
  }

  return {
    id: "reminders",
    title: "Configure payment reminders",
    description: "Set up automated reminder emails for upcoming and overdue invoices",
    status: "complete",
    actionUrl: "/app/settings/reminders",
    actionLabel: "Configure reminders",
    helpText: "Email sender is configured and ready",
  };
}

/**
 * Compute the full onboarding state from inputs.
 * This is a pure function - all data fetching happens elsewhere.
 */
export function computeOnboardingState(
  inputs: OnboardingStepInputs
): OnboardingState {
  const steps: OnboardingStep[] = [
    computeDefaultTermsStep(inputs.defaultTermsDays),
    computeBuyerSetupStep(inputs.buyerAccountCount, inputs.tagRuleCount),
    computeValidationStep(inputs.validation),
    computePaymentCustomizationStep(inputs.paymentCustomization),
    computeReminderStep(inputs.resendApiKeyConfigured),
  ];

  const completedCount = steps.filter(
    (s) => s.status === "complete" || s.status === "coming_soon"
  ).length;
  const totalCount = steps.length;

  const requiredSteps = steps.filter((s) => s.status !== "coming_soon");
  const requiredComplete = requiredSteps.every((s) => s.status === "complete");

  return {
    steps,
    isComplete: requiredComplete,
    completedCount,
    totalCount,
    dismissedAt: inputs.dismissedAt,
  };
}

/**
 * Check if onboarding should be shown to the user.
 * Returns false if setup is complete or user has dismissed.
 */
export function shouldShowOnboarding(state: OnboardingState): boolean {
  if (state.isComplete) return false;
  if (state.dismissedAt !== null) return false;
  return true;
}

/**
 * Fetch shop onboarding data from the database.
 * Returns null if the shop doesn't exist.
 */
export async function fetchShopOnboardingData(
  sql: Sql,
  shopDomain: string
): Promise<{
  shopId: string;
  defaultTermsDays: number | null;
  buyerAccountCount: number;
  tagRuleCount: number;
  dismissedAt: Date | null;
} | null> {
  const [shop] = await sql<
    {
      id: string;
      defaultTermsDays: number | null;
    }[]
  >`
    SELECT id, "defaultTermsDays"
    FROM "Shop"
    WHERE domain = ${shopDomain}
  `;

  if (!shop) return null;

  const [accountCount] = await sql<{ count: string }[]>`
    SELECT COUNT(*)::text as count
    FROM "BuyerAccount"
    WHERE "shopId" = ${shop.id}
  `;

  const [tagRuleCount] = await sql<{ count: string }[]>`
    SELECT COUNT(*)::text as count
    FROM "AccountSource"
    WHERE "shopId" = ${shop.id}
  `;

  const [onboarding] = await sql<{ dismissed_at: Date | null }[]>`
    SELECT dismissed_at
    FROM shop_onboarding
    WHERE shop_id = ${shop.id}
  `.catch(() => [{ dismissed_at: null }]);

  return {
    shopId: shop.id,
    defaultTermsDays: shop.defaultTermsDays,
    buyerAccountCount: parseInt(accountCount?.count ?? "0", 10),
    tagRuleCount: parseInt(tagRuleCount?.count ?? "0", 10),
    dismissedAt: onboarding?.dismissed_at ?? null,
  };
}

/**
 * Dismiss onboarding for a shop.
 */
export async function dismissOnboarding(
  sql: Sql,
  shopId: string
): Promise<void> {
  await sql`
    INSERT INTO shop_onboarding (shop_id, dismissed_at)
    VALUES (${shopId}, NOW())
    ON CONFLICT (shop_id)
    DO UPDATE SET dismissed_at = NOW()
  `;
}

/**
 * Re-open (un-dismiss) onboarding for a shop.
 */
export async function reopenOnboarding(
  sql: Sql,
  shopId: string
): Promise<void> {
  await sql`
    UPDATE shop_onboarding
    SET dismissed_at = NULL
    WHERE shop_id = ${shopId}
  `;
}

/**
 * Mark onboarding as complete for a shop.
 */
export async function markOnboardingComplete(
  sql: Sql,
  shopId: string
): Promise<void> {
  await sql`
    INSERT INTO shop_onboarding (shop_id, completed_at)
    VALUES (${shopId}, NOW())
    ON CONFLICT (shop_id)
    DO UPDATE SET completed_at = NOW()
  `;
}
