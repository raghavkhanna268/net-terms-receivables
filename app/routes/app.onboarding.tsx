/**
 * Onboarding Route (S23)
 *
 * Polaris checklist shown to new merchants until setup is complete.
 * Each step reads REAL state from DB and Shopify Admin API.
 * Can be dismissed and re-opened from the help menu.
 */

import type {
  HeadersFunction,
  LoaderFunctionArgs,
  ActionFunctionArgs,
} from "react-router";
import { useLoaderData, useActionData, Form, useNavigation } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { getRequestSql } from "~/lib/request-context.server";
import {
  fetchShopOnboardingData,
  computeOnboardingState,
  dismissOnboarding,
  reopenOnboarding,
  type OnboardingStepInputs,
  type ValidationInfo,
  type PaymentCustomizationInfo,
  type OnboardingStep,
} from "~/lib/onboarding-steps.server";

const VALIDATION_FUNCTION_HANDLE = "credit-check-validation";
const PAYMENT_CUSTOMIZATION_HANDLE = "hide-terms-payment";

interface ValidationNode {
  id: string;
  shopifyFunction: { handle: string };
  title: string;
  enabled: boolean;
}

interface PaymentCustomizationNode {
  id: string;
  shopifyFunction: { handle: string };
  title: string;
  enabled: boolean;
}

const VALIDATIONS_QUERY = `#graphql
  query GetValidations {
    validations(first: 50) {
      edges {
        node {
          id
          shopifyFunction { handle }
          title
          enabled
        }
      }
    }
  }
`;

const PAYMENT_CUSTOMIZATIONS_QUERY = `#graphql
  query GetPaymentCustomizations {
    paymentCustomizations(first: 50) {
      edges {
        node {
          id
          shopifyFunction { handle }
          title
          enabled
        }
      }
    }
  }
`;

async function fetchValidationInfo(
  admin: { graphql: (q: string) => Promise<{ json: () => Promise<unknown> }> }
): Promise<ValidationInfo | null> {
  try {
    const response = await admin.graphql(VALIDATIONS_QUERY);
    const data = (await response.json()) as {
      data?: {
        validations?: { edges: Array<{ node: ValidationNode }> };
      };
    };

    const validation = data.data?.validations?.edges.find(
      (e) => e.node.shopifyFunction.handle === VALIDATION_FUNCTION_HANDLE
    );

    if (!validation) return null;

    return {
      id: validation.node.id,
      handle: validation.node.shopifyFunction.handle,
      enabled: validation.node.enabled,
      title: validation.node.title,
    };
  } catch (error) {
    console.error("[onboarding] Failed to fetch validations:", error);
    return null;
  }
}

async function fetchPaymentCustomizationInfo(
  admin: { graphql: (q: string) => Promise<{ json: () => Promise<unknown> }> }
): Promise<PaymentCustomizationInfo | null> {
  try {
    const response = await admin.graphql(PAYMENT_CUSTOMIZATIONS_QUERY);
    const data = (await response.json()) as {
      data?: {
        paymentCustomizations?: {
          edges: Array<{ node: PaymentCustomizationNode }>;
        };
      };
    };

    const customization = data.data?.paymentCustomizations?.edges.find(
      (e) => e.node.shopifyFunction.handle === PAYMENT_CUSTOMIZATION_HANDLE
    );

    if (!customization) return null;

    return {
      id: customization.node.id,
      handle: customization.node.shopifyFunction.handle,
      enabled: customization.node.enabled,
      title: customization.node.title,
    };
  } catch (error) {
    console.error("[onboarding] Failed to fetch payment customizations:", error);
    return null;
  }
}

export const loader = async ({ request, context }: LoaderFunctionArgs) => {
  const { shopify } = context;
  const { session, admin } = await shopify.authenticate.admin(request);
  const sql = getRequestSql();
  const shopDomain = session.shop;

  const dbData = await fetchShopOnboardingData(sql, shopDomain);

  if (!dbData) {
    return {
      error: "Shop not found",
      state: null,
    };
  }

  const [validation, paymentCustomization] = await Promise.all([
    fetchValidationInfo(admin),
    fetchPaymentCustomizationInfo(admin),
  ]);

  const resendApiKeyConfigured = Boolean(process.env.RESEND_API_KEY);

  const inputs: OnboardingStepInputs = {
    shopId: dbData.shopId,
    defaultTermsDays: dbData.defaultTermsDays,
    buyerAccountCount: dbData.buyerAccountCount,
    tagRuleCount: dbData.tagRuleCount,
    validation,
    paymentCustomization,
    resendApiKeyConfigured,
    dismissedAt: dbData.dismissedAt,
  };

  const state = computeOnboardingState(inputs);

  return {
    error: null,
    state: {
      steps: state.steps,
      isComplete: state.isComplete,
      completedCount: state.completedCount,
      totalCount: state.totalCount,
      dismissedAt: state.dismissedAt?.toISOString() ?? null,
    },
    shopId: dbData.shopId,
  };
};

export const action = async ({ request, context }: ActionFunctionArgs) => {
  const { shopify } = context;
  const { session } = await shopify.authenticate.admin(request);
  const sql = getRequestSql();
  const shopDomain = session.shop;

  const formData = await request.formData();
  const actionType = formData.get("_action");

  const [shop] = await sql<{ id: string }[]>`
    SELECT id FROM "Shop" WHERE domain = ${shopDomain}
  `;

  if (!shop) {
    return { success: false, error: "Shop not found" };
  }

  if (actionType === "dismiss") {
    await dismissOnboarding(sql, shop.id);
    return { success: true, action: "dismissed" };
  }

  if (actionType === "reopen") {
    await reopenOnboarding(sql, shop.id);
    return { success: true, action: "reopened" };
  }

  return { success: false, error: "Unknown action" };
};

function StepStatusBadge({ status }: { status: OnboardingStep["status"] }) {
  switch (status) {
    case "complete":
      return <s-badge tone="success">Done</s-badge>;
    case "attention":
      return <s-badge tone="critical">Needs attention</s-badge>;
    case "coming_soon":
      return <s-badge tone="info">Coming soon</s-badge>;
    default:
      return <s-badge>To do</s-badge>;
  }
}

function OnboardingChecklist({
  steps,
  completedCount,
  totalCount,
}: {
  steps: OnboardingStep[];
  completedCount: number;
  totalCount: number;
}) {
  return (
    <s-stack gap="base">
      <s-paragraph>
        <s-text type="strong">
          {completedCount} of {totalCount} steps completed
        </s-text>
      </s-paragraph>

      <s-table>
        <s-table-header-row>
          <s-table-header>Status</s-table-header>
          <s-table-header>Step</s-table-header>
          <s-table-header>Details</s-table-header>
          <s-table-header>Action</s-table-header>
        </s-table-header-row>
        <s-table-body>
          {steps.map((step) => (
            <s-table-row key={step.id}>
              <s-table-cell>
                <StepStatusBadge status={step.status} />
              </s-table-cell>
              <s-table-cell>
                <s-text type="strong">{step.title}</s-text>
              </s-table-cell>
              <s-table-cell>
                <s-text>{step.helpText ?? step.description}</s-text>
              </s-table-cell>
              <s-table-cell>
                {step.actionUrl && step.status !== "coming_soon" && (
                  <s-link href={step.actionUrl}>{step.actionLabel}</s-link>
                )}
              </s-table-cell>
            </s-table-row>
          ))}
        </s-table-body>
      </s-table>
    </s-stack>
  );
}

export default function OnboardingPage() {
  const { error, state } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const isSubmitting = navigation.state === "submitting";

  if (error || !state) {
    return (
      <s-page heading="Setup Guide">
        <s-section>
          <s-banner tone="critical" heading="Error">
            {error ?? "Failed to load onboarding state"}
          </s-banner>
        </s-section>
      </s-page>
    );
  }

  const isDismissed = state.dismissedAt !== null;

  return (
    <s-page heading="Setup Guide">
      {actionData?.success && (
        <s-section>
          <s-banner tone="info" heading="Done">
            {actionData.action === "dismissed"
              ? "Setup guide dismissed. You can reopen it from the help menu."
              : "Setup guide reopened."}
          </s-banner>
        </s-section>
      )}

      {state.isComplete && (
        <s-section>
          <s-banner tone="success" heading="Setup Complete">
            You&apos;ve completed all setup steps. Your store is ready to use Net
            Terms Receivables!
          </s-banner>
        </s-section>
      )}

      <s-section heading="Get Started with Net Terms">
        <s-stack gap="base">
          <s-paragraph>
            Complete these steps to set up net terms management for your store.
            Each step checks your actual configuration - nothing is hardcoded.
          </s-paragraph>

          <OnboardingChecklist
            steps={state.steps}
            completedCount={state.completedCount}
            totalCount={state.totalCount}
          />

          <s-stack direction="inline" gap="base">
            {!isDismissed && !state.isComplete && (
              <Form method="post">
                <input type="hidden" name="_action" value="dismiss" />
                <s-button type="submit" disabled={isSubmitting}>
                  {isSubmitting ? "Dismissing..." : "Dismiss for now"}
                </s-button>
              </Form>
            )}
            {isDismissed && (
              <Form method="post">
                <input type="hidden" name="_action" value="reopen" />
                <s-button type="submit" variant="primary" disabled={isSubmitting}>
                  {isSubmitting ? "Reopening..." : "Continue setup"}
                </s-button>
              </Form>
            )}
            <s-button href="/app">Go to Dashboard</s-button>
          </s-stack>
        </s-stack>
      </s-section>

      <s-section slot="aside" heading="Why complete setup?">
        <s-paragraph>
          Completing all steps ensures your store is fully protected:
        </s-paragraph>
        <s-unordered-list>
          <s-list-item>
            Buyers on credit hold are blocked at checkout
          </s-list-item>
          <s-list-item>
            Credit limits are enforced automatically
          </s-list-item>
          <s-list-item>
            Payment reminders keep buyers informed
          </s-list-item>
        </s-unordered-list>
      </s-section>

      <s-section slot="aside" heading="Need help?">
        <s-paragraph>
          Check our documentation or contact support if you have questions
          about any step.
        </s-paragraph>
        <s-link href="https://docs.example.com/net-terms">
          View documentation
        </s-link>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
