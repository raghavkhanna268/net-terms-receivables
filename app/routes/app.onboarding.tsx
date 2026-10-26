/**
 * Onboarding Route (S23)
 *
 * Polaris checklist shown to new merchants until setup is complete.
 * Each step reads REAL state from DB and Shopify Admin API.
 * Can be dismissed and re-opened from the help menu.
 *
 * S23-02: Added app registration status step with retry functionality.
 * S23-04: Added initial sync step with progress and retry.
 */

import type {
  HeadersFunction,
  LoaderFunctionArgs,
  ActionFunctionArgs,
} from "react-router";
import { useLoaderData, useActionData, Form, useNavigation, useRevalidator, useRouteError, isRouteErrorResponse } from "react-router";
import { useEffect, useRef } from "react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { getRequestSql } from "~/lib/request-context.server";
import { getUsageStats, isGatingEnforced } from "~/services/gating.server";
import { buildNewAccountsPausedBannerState, type NewAccountsPausedBannerState } from "~/lib/over-limit-banner";
import { getAppHandle, buildPlanSelectionUrl } from "~/lib/plan-url";
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
import { safeLog, toErrorCode, shopHash } from "~/lib/log.server";
import { ensureValidation } from "~/lib/validation-registration.server";
import { ensurePaymentCustomization } from "~/lib/payment-customization-registration.server";
import { ensureMetafieldDefinitions, getMetafieldDefinitionSpecs } from "~/lib/metafield-definitions.server";
import { METAFIELD } from "~/lib/metafields-contract";
import {
  getInitialSyncState,
  getInitialSyncStateWithRecovery,
  enqueueInitialSync,
  canStartSync as canStartSyncServer,
  type InitialSyncStatus,
  type InitialSyncState,
} from "~/lib/initial-sync.server";
import { isShopCurrencySupported, NO_CURRENCY_SENTINEL } from "~/lib/shop-currency.server";
import { CURRENCY_NOT_SUPPORTED_BANNER_COPY, CURRENCY_FLIP_BLOCKED_BANNER_TEXT, SUPPORT_EMAIL_MAILTO } from "~/lib/shop-currency-copy";
import { isEmailSendingConfigured } from "~/lib/email-sender-config.server";
import { checkAndRecoverCurrency } from "~/services/shop-currency-recovery.server";

/**
 * Client-side version of canStartSync to avoid importing server-only module in client code.
 */
function canStartSync(status: InitialSyncStatus): boolean {
  return status === "not_started" || status === "failed";
}

/**
 * Determine if the Initial Sync section should poll for updates.
 * Only poll when sync is in progress AND currency is supported (INR).
 * This prevents polling forever on a non-INR shop with an open companies op.
 */
export function shouldPollInitialSync(
  status: InitialSyncStatus,
  currencySupported: boolean
): boolean {
  return status === "in_progress" && currencySupported;
}

const VALIDATION_FUNCTION_HANDLE = "credit-check-validation";
const PAYMENT_CUSTOMIZATION_HANDLE = "hide-terms-payment";

/**
 * Admin GraphQL client interface with variables support.
 */
interface AdminGraphqlClient {
  graphql: (
    query: string,
    options?: { variables?: Record<string, unknown> },
  ) => Promise<{ json: () => Promise<unknown> }>;
}

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

/**
 * Registration item status for the onboarding step (S23-02).
 */
export type RegistrationItemStatus = "ok" | "missing" | "error";

/**
 * Individual registration item with status.
 */
export interface RegistrationItem {
  name: string;
  status: RegistrationItemStatus;
  errorCode?: string;
}

/**
 * Overall registration status for the shop.
 */
export interface RegistrationStatus {
  validation: RegistrationItem;
  paymentCustomization: RegistrationItem;
  metafieldDefinitions: RegistrationItem;
}

const retryInFlightShops = new Set<string>();

interface ValidationQueryResult {
  data?: {
    validations?: { edges: Array<{ node: ValidationNode }> };
  };
  errors?: Array<{ message: string }>;
}

async function fetchValidationInfo(
  admin: AdminGraphqlClient
): Promise<{ info: ValidationInfo | null; error: string | null }> {
  try {
    const response = await admin.graphql(`#graphql
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
    `);
    const data = (await response.json()) as ValidationQueryResult;

    if (data.errors?.length) {
      const errCode = toErrorCode({ message: data.errors[0].message });
      safeLog("error", "onboarding.fetch_validations_failed", { err: errCode });
      return { info: null, error: errCode };
    }

    const validation = data.data?.validations?.edges.find(
      (e) => e.node.shopifyFunction.handle === VALIDATION_FUNCTION_HANDLE
    );

    if (!validation) return { info: null, error: null };

    return {
      info: {
        id: validation.node.id,
        handle: validation.node.shopifyFunction.handle,
        enabled: validation.node.enabled,
        title: validation.node.title,
      },
      error: null,
    };
  } catch (error) {
    const errCode = toErrorCode(error);
    safeLog("error", "onboarding.fetch_validations_failed", { err: errCode });
    return { info: null, error: errCode };
  }
}

interface PaymentCustomizationQueryResult {
  data?: {
    paymentCustomizations?: {
      edges: Array<{ node: PaymentCustomizationNode }>;
    };
  };
  errors?: Array<{ message: string }>;
}

async function fetchPaymentCustomizationInfo(
  admin: AdminGraphqlClient
): Promise<{ info: PaymentCustomizationInfo | null; error: string | null }> {
  try {
    const response = await admin.graphql(`#graphql
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
    `);
    const data = (await response.json()) as PaymentCustomizationQueryResult;

    if (data.errors?.length) {
      const errCode = toErrorCode({ message: data.errors[0].message });
      safeLog("error", "onboarding.fetch_payment_customizations_failed", { err: errCode });
      return { info: null, error: errCode };
    }

    const customization = data.data?.paymentCustomizations?.edges.find(
      (e) => e.node.shopifyFunction.handle === PAYMENT_CUSTOMIZATION_HANDLE
    );

    if (!customization) return { info: null, error: null };

    return {
      info: {
        id: customization.node.id,
        handle: customization.node.shopifyFunction.handle,
        enabled: customization.node.enabled,
        title: customization.node.title,
      },
      error: null,
    };
  } catch (error) {
    const errCode = toErrorCode(error);
    safeLog("error", "onboarding.fetch_payment_customizations_failed", { err: errCode });
    return { info: null, error: errCode };
  }
}

interface MetafieldDefinitionNode {
  id: string;
  namespace: string;
  key: string;
  ownerType: string;
}

interface MetafieldDefinitionsQueryResult {
  data?: {
    metafieldDefinitions?: {
      edges: Array<{ node: MetafieldDefinitionNode }>;
    };
  };
  errors?: Array<{ message: string }>;
}

const METAFIELD_DEFINITIONS_QUERY = `#graphql
  query GetMetafieldDefinitions($ownerType: MetafieldOwnerType!, $namespace: String!) {
    metafieldDefinitions(first: 50, ownerType: $ownerType, namespace: $namespace) {
      edges {
        node {
          id
          namespace
          key
          ownerType
        }
      }
    }
  }
`;

/**
 * Check metafield definitions status by querying existing definitions.
 * Returns "ok" if all expected definitions exist, "missing" if any are missing.
 */
async function checkMetafieldDefinitionsStatus(
  admin: AdminGraphqlClient
): Promise<{ status: RegistrationItemStatus; errorCode?: string }> {
  try {
    const specs = getMetafieldDefinitionSpecs();
    const expectedOwnerTypes = specs[0]?.ownerTypes ?? ["COMPANY_LOCATION", "CUSTOMER"];

    const foundTypes = new Set<string>();

    for (const ownerType of expectedOwnerTypes) {
      const response = await admin.graphql(METAFIELD_DEFINITIONS_QUERY, {
        variables: { ownerType, namespace: METAFIELD.namespace },
      });

      const data = (await response.json()) as MetafieldDefinitionsQueryResult;

      if (data.errors?.length) {
        return { status: "error", errorCode: toErrorCode({ message: data.errors[0].message }) };
      }

      const hasCreditStatus = data.data?.metafieldDefinitions?.edges.some(
        (e) => e.node.key === METAFIELD.key
      );

      if (hasCreditStatus) {
        foundTypes.add(ownerType);
      }
    }

    if (foundTypes.size === expectedOwnerTypes.length) {
      return { status: "ok" };
    }

    return { status: "missing" };
  } catch (error) {
    safeLog("error", "onboarding.check_metafield_definitions_failed", { err: toErrorCode(error) });
    return { status: "error", errorCode: toErrorCode(error) };
  }
}

/**
 * Compute registration status from fetched data.
 */
function computeRegistrationStatus(
  validation: ValidationInfo | null,
  validationError: string | null,
  paymentCustomization: PaymentCustomizationInfo | null,
  paymentCustomizationError: string | null,
  metafieldStatus: { status: RegistrationItemStatus; errorCode?: string }
): RegistrationStatus {
  return {
    validation: {
      name: "Validation Function",
      status: validationError ? "error" : validation ? "ok" : "missing",
      errorCode: validationError ?? undefined,
    },
    paymentCustomization: {
      name: "Payment Customization",
      status: paymentCustomizationError ? "error" : paymentCustomization ? "ok" : "missing",
      errorCode: paymentCustomizationError ?? undefined,
    },
    metafieldDefinitions: {
      name: "Metafield Definitions",
      status: metafieldStatus.status,
      errorCode: metafieldStatus.errorCode,
    },
  };
}

/**
 * Check if any registration item needs retry.
 */
export function needsRetry(status: RegistrationStatus): boolean {
  return (
    status.validation.status !== "ok" ||
    status.paymentCustomization.status !== "ok" ||
    status.metafieldDefinitions.status !== "ok"
  );
}

/**
 * Check if all registrations are complete.
 */
export function isRegistrationComplete(status: RegistrationStatus): boolean {
  return (
    status.validation.status === "ok" &&
    status.paymentCustomization.status === "ok" &&
    status.metafieldDefinitions.status === "ok"
  );
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
      registrationStatus: null,
      initialSyncState: null,
      newAccountsPausedBanner: {
        show: false,
        heading: "",
        bodyText: "",
        upgradeUrl: null,
      } as NewAccountsPausedBannerState,
    };
  }

  // #292 G1: Read stored currency, then recover if needed (same as /app)
  // Pass dbData.shopId to avoid re-querying the shop row in checkAndRecoverCurrency
  const [shopCurrencyResult] = await sql<{ currency: string | null }[]>`
    SELECT currency FROM "Shop" WHERE domain = ${shopDomain}
  `;
  const storedCurrency = shopCurrencyResult?.currency ?? NO_CURRENCY_SENTINEL;
  // Defensive: handle null/undefined result with fail-closed defaults
  const currencyResult = await checkAndRecoverCurrency(
    sql,
    shopDomain,
    storedCurrency,
    admin,
    dbData.shopId,
  );
  const shopCurrency = currencyResult?.currency ?? NO_CURRENCY_SENTINEL;
  const currencyFlipBlocked = currencyResult?.flipBlocked ?? false;
  const currencySupported = isShopCurrencySupported(shopCurrency);

  const [validationResult, paymentCustomizationResult, metafieldStatus, syncState] = await Promise.all([
    fetchValidationInfo(admin),
    fetchPaymentCustomizationInfo(admin),
    checkMetafieldDefinitionsStatus(admin),
    getInitialSyncStateWithRecovery(sql, shopDomain),
  ]);

  const validation = validationResult.info;
  const validationError = validationResult.error;
  const paymentCustomization = paymentCustomizationResult.info;
  const paymentCustomizationError = paymentCustomizationResult.error;

  const emailSendingConfigured = isEmailSendingConfigured();

  const inputs: OnboardingStepInputs = {
    shopId: dbData.shopId,
    defaultTermsDays: dbData.defaultTermsDays,
    buyerAccountCount: dbData.buyerAccountCount,
    tagRuleCount: dbData.tagRuleCount,
    validation,
    paymentCustomization,
    emailSendingConfigured,
    dismissedAt: dbData.dismissedAt,
  };

  const state = computeOnboardingState(inputs);

  const registrationStatus = computeRegistrationStatus(
    validation,
    validationError,
    paymentCustomization,
    paymentCustomizationError,
    metafieldStatus
  );

  const gatingEnforced = isGatingEnforced();
  let newAccountsPausedBanner: NewAccountsPausedBannerState = {
    show: false,
    heading: "",
    bodyText: "",
    upgradeUrl: null,
  };

  if (gatingEnforced) {
    try {
      const usage = await getUsageStats(sql, dbData.shopId);
      const upgradeUrl = (() => {
        const handle = getAppHandle();
        if (handle === null) return null;
        return buildPlanSelectionUrl(shopDomain, handle);
      })();
      newAccountsPausedBanner = buildNewAccountsPausedBannerState(
        usage.companies.current,
        usage.companies.limit,
        gatingEnforced,
        upgradeUrl
      );
    } catch (err) {
      safeLog("warn", "usage_stats_error", { shopHash: await shopHash(shopDomain), err: toErrorCode(err) });
      // Fail soft: no banner on error
    }
  }

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
    registrationStatus,
    initialSyncState: syncState,
    newAccountsPausedBanner,
    currencySupported,
    currencyFlipBlocked,
  };
};

export const action = async ({ request, context }: ActionFunctionArgs) => {
  const { shopify } = context;
  const { session, admin } = await shopify.authenticate.admin(request);
  const sql = getRequestSql();
  const shopDomain = session.shop;

  const contentType = request.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    return Response.json(
      { success: false, error: "JSON requests not supported" },
      { status: 400 }
    );
  }

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

  if (actionType === "retry_registration") {
    if (retryInFlightShops.has(shop.id)) {
      return { success: false, error: "Retry already in progress", action: "retry_registration" };
    }

    retryInFlightShops.add(shop.id);
    const hash = await shopHash(shopDomain);

    try {
      const [validationResult, paymentCustomizationResult, metafieldStatus] = await Promise.all([
        fetchValidationInfo(admin),
        fetchPaymentCustomizationInfo(admin),
        checkMetafieldDefinitionsStatus(admin),
      ]);

      const currentStatus = computeRegistrationStatus(
        validationResult.info,
        validationResult.error,
        paymentCustomizationResult.info,
        paymentCustomizationResult.error,
        metafieldStatus
      );

      const results: {
        validation: RegistrationItem;
        paymentCustomization: RegistrationItem;
        metafieldDefinitions: RegistrationItem;
      } = {
        validation: { name: "Validation Function", status: currentStatus.validation.status },
        paymentCustomization: { name: "Payment Customization", status: currentStatus.paymentCustomization.status },
        metafieldDefinitions: { name: "Metafield Definitions", status: currentStatus.metafieldDefinitions.status },
      };

      if (currentStatus.validation.status !== "ok") {
        try {
          await ensureValidation(admin);
          results.validation = { name: "Validation Function", status: "ok" };
          safeLog("info", "onboarding.retry_validation_success", { shopHash: hash });
        } catch (e) {
          results.validation = {
            name: "Validation Function",
            status: "error",
            errorCode: toErrorCode(e),
          };
          safeLog("error", "onboarding.retry_validation_failed", { shopHash: hash, err: toErrorCode(e) });
        }
      }

      if (currentStatus.paymentCustomization.status !== "ok") {
        try {
          await ensurePaymentCustomization(admin);
          results.paymentCustomization = { name: "Payment Customization", status: "ok" };
          safeLog("info", "onboarding.retry_payment_customization_success", { shopHash: hash });
        } catch (e) {
          results.paymentCustomization = {
            name: "Payment Customization",
            status: "error",
            errorCode: toErrorCode(e),
          };
          safeLog("error", "onboarding.retry_payment_customization_failed", { shopHash: hash, err: toErrorCode(e) });
        }
      }

      if (currentStatus.metafieldDefinitions.status !== "ok") {
        try {
          await ensureMetafieldDefinitions(admin);
          results.metafieldDefinitions = { name: "Metafield Definitions", status: "ok" };
          safeLog("info", "onboarding.retry_metafield_definitions_success", { shopHash: hash });
        } catch (e) {
          results.metafieldDefinitions = {
            name: "Metafield Definitions",
            status: "error",
            errorCode: toErrorCode(e),
          };
          safeLog("error", "onboarding.retry_metafield_definitions_failed", { shopHash: hash, err: toErrorCode(e) });
        }
      }

      const allOk = results.validation.status === "ok" &&
        results.paymentCustomization.status === "ok" &&
        results.metafieldDefinitions.status === "ok";

      safeLog("info", "onboarding.retry_registration_complete", {
        shopHash: hash,
        success: allOk,
      });

      return {
        success: allOk,
        action: "retry_registration",
        registrationStatus: results,
      };
    } finally {
      retryInFlightShops.delete(shop.id);
    }
  }

  if (actionType === "start_sync") {
    // #292 G1: Recover currency first, then check if supported
    // Pass shop.id to avoid re-querying the shop row in checkAndRecoverCurrency
    // Defensive: handle null/undefined result with fail-closed defaults
    const [shopCurrencyResult] = await sql<{ currency: string | null }[]>`
      SELECT currency FROM "Shop" WHERE domain = ${shopDomain}
    `;
    const storedCurrency = shopCurrencyResult?.currency ?? NO_CURRENCY_SENTINEL;
    const currencyResult = await checkAndRecoverCurrency(
      sql,
      shopDomain,
      storedCurrency,
      admin,
      shop.id,
    );
    if (!isShopCurrencySupported(currencyResult?.currency ?? NO_CURRENCY_SENTINEL)) {
      return {
        success: false,
        error: "Sync not available for non-INR stores",
        action: "start_sync",
      };
    }

    const syncState = await getInitialSyncState(sql, shopDomain);

    if (!canStartSyncServer(syncState.status)) {
      return {
        success: false,
        error: "Sync already in progress or complete",
        action: "start_sync",
      };
    }

    const hash = await shopHash(shopDomain);
    const result = await enqueueInitialSync(sql, shopDomain);

    if (!result.enqueued) {
      safeLog("info", "onboarding.initial_sync_skip", {
        shopHash: hash,
        reason: result.reason,
      });
      return {
        success: false,
        error: `Sync ${result.reason?.replace("_", " ")}`,
        action: "start_sync",
      };
    }

    return {
      success: true,
      action: "start_sync",
    };
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

function RegistrationItemBadge({ status }: { status: RegistrationItemStatus }) {
  switch (status) {
    case "ok":
      return <s-badge tone="success">OK</s-badge>;
    case "missing":
      return <s-badge tone="warning">Missing</s-badge>;
    case "error":
      return <s-badge tone="critical">Error</s-badge>;
  }
}

function RegistrationStatusSection({
  status,
  isRetrying,
}: {
  status: RegistrationStatus;
  isRetrying: boolean;
}) {
  const allOk = isRegistrationComplete(status);
  const items = [status.validation, status.paymentCustomization, status.metafieldDefinitions];

  return (
    <s-stack gap="base">
      <s-stack direction="inline" gap="base">
        <s-text type="strong">Status</s-text>
        {allOk ? (
          <s-badge tone="success">Complete</s-badge>
        ) : (
          <s-badge tone="warning">Incomplete</s-badge>
        )}
      </s-stack>

      <s-paragraph>
        Status of app registrations required for checkout protection and credit tracking.
      </s-paragraph>

      <s-table>
        <s-table-header-row>
          <s-table-header listSlot="primary">Item</s-table-header>
          <s-table-header listSlot="inline">Status</s-table-header>
        </s-table-header-row>
        <s-table-body>
          {items.map((item) => (
            <s-table-row key={item.name}>
              <s-table-cell>
                <s-text>{item.name}</s-text>
              </s-table-cell>
              <s-table-cell>
                <RegistrationItemBadge status={item.status} />
              </s-table-cell>
            </s-table-row>
          ))}
        </s-table-body>
      </s-table>

      {!allOk && (
        <Form method="post">
          <input type="hidden" name="_action" value="retry_registration" />
          <s-button type="submit" disabled={isRetrying}>
            {isRetrying ? "Retrying..." : "Retry"}
          </s-button>
        </Form>
      )}
    </s-stack>
  );
}

function SyncStatusBadge({ status }: { status: InitialSyncStatus }) {
  switch (status) {
    case "done":
      return <s-badge tone="success">Complete</s-badge>;
    case "in_progress":
      return <s-badge tone="info">In progress</s-badge>;
    case "failed":
      return <s-badge tone="critical">Failed</s-badge>;
    default:
      return <s-badge>Not started</s-badge>;
  }
}

function InitialSyncSection({
  syncState,
  isStarting,
  currencySupported,
}: {
  syncState: InitialSyncState;
  isStarting: boolean;
  currencySupported: boolean;
}) {
  const canStart = canStartSync(syncState.status);
  const buttonLabel = syncState.status === "failed" ? "Retry" : "Start sync";

  if (!currencySupported) {
    return (
      <s-stack gap="base">
        <s-paragraph>
          Initial sync is available once the store currency is INR.
        </s-paragraph>
      </s-stack>
    );
  }

  return (
    <s-stack gap="base">
      <s-stack direction="inline" gap="base">
        <s-text type="strong">Status</s-text>
        <SyncStatusBadge status={syncState.status} />
      </s-stack>

      <s-paragraph>
        {syncState.status === "not_started" &&
          "Sync your B2B companies, tagged customers, and orders to import existing buyer accounts and invoices."}
        {syncState.status === "in_progress" &&
          "Syncing B2B companies, tagged customers, and orders. This may take a few minutes."}
        {syncState.status === "done" &&
          "B2B companies, tagged customers, and orders have been synced."}
        {syncState.status === "failed" &&
          "Sync failed. You can retry to attempt the sync again."}
      </s-paragraph>

      {canStart && (
        <Form method="post">
          <input type="hidden" name="_action" value="start_sync" />
          <s-button type="submit" disabled={isStarting}>
            {isStarting ? "Starting..." : buttonLabel}
          </s-button>
        </Form>
      )}
    </s-stack>
  );
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
          <s-table-header listSlot="inline">Status</s-table-header>
          <s-table-header listSlot="primary">Step</s-table-header>
          <s-table-header listSlot="secondary">Details</s-table-header>
          <s-table-header listSlot="labeled">Action</s-table-header>
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

const POLL_INTERVAL_MS = 5000;

export default function OnboardingPage() {
  const { error, state, registrationStatus, initialSyncState, newAccountsPausedBanner, currencySupported, currencyFlipBlocked } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const revalidator = useRevalidator();
  const isSubmitting = navigation.state === "submitting";
  const pollIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const isRetrying = isSubmitting && navigation.formData?.get("_action") === "retry_registration";
  const isStartingSync = isSubmitting && navigation.formData?.get("_action") === "start_sync";
  const isDismissing = isSubmitting && navigation.formData?.get("_action") === "dismiss";
  const isReopening = isSubmitting && navigation.formData?.get("_action") === "reopen";

  const currentRegistrationStatus: RegistrationStatus | null =
    actionData?.action === "retry_registration" && actionData.registrationStatus
      ? (actionData.registrationStatus as RegistrationStatus)
      : registrationStatus;

  const loaderSyncStatus: InitialSyncStatus = initialSyncState?.status ?? "not_started";
  const currentSyncState: InitialSyncState = { status: loaderSyncStatus };

  useEffect(() => {
    const shouldPoll = shouldPollInitialSync(loaderSyncStatus, currencySupported ?? false);
    if (shouldPoll) {
      if (!pollIntervalRef.current) {
        pollIntervalRef.current = setInterval(() => {
          if (revalidator.state === "idle") {
            revalidator.revalidate();
          }
        }, POLL_INTERVAL_MS);
      }
    } else {
      if (pollIntervalRef.current) {
        clearInterval(pollIntervalRef.current);
        pollIntervalRef.current = null;
      }
    }

    return () => {
      if (pollIntervalRef.current) {
        clearInterval(pollIntervalRef.current);
        pollIntervalRef.current = null;
      }
    };
  }, [loaderSyncStatus, revalidator, currencySupported]);

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
      {/* #292: Currency Flip Blocked Banner (non-INR→INR with existing data) */}
      {currencyFlipBlocked && (
        <s-section>
          <s-banner tone="critical" heading="Currency Conversion Not Available">
            {CURRENCY_FLIP_BLOCKED_BANNER_TEXT}{" "}
            Please <s-link href={SUPPORT_EMAIL_MAILTO}>contact support</s-link> for assistance.
          </s-banner>
        </s-section>
      )}

      {/* #292: Currency Not Supported Banner (non-INR shop without blocked flip) */}
      {!currencySupported && !currencyFlipBlocked && (
        <s-section>
          <s-banner tone="critical" heading="Currency Not Supported">
            {CURRENCY_NOT_SUPPORTED_BANNER_COPY}
          </s-banner>
        </s-section>
      )}

      {/* T4: New accounts paused banner */}
      {newAccountsPausedBanner.show && (
        <s-section>
          <s-banner tone="warning" heading={newAccountsPausedBanner.heading}>
            {newAccountsPausedBanner.bodyText}
            {newAccountsPausedBanner.upgradeUrl && (
              <>
                {" "}
                <a href={newAccountsPausedBanner.upgradeUrl} target="_top">
                  Upgrade your plan
                </a>
              </>
            )}
          </s-banner>
        </s-section>
      )}

      {actionData?.success && actionData.action === "retry_registration" && (
        <s-section>
          <s-banner tone="success" heading="Retry Complete">
            Registration retry completed.
          </s-banner>
        </s-section>
      )}

      {actionData?.success === false && actionData.action === "retry_registration" && (
        <s-section>
          <s-banner tone="warning" heading="Retry Incomplete">
            Some registrations could not be completed. Check the status below.
          </s-banner>
        </s-section>
      )}

      {actionData?.success && actionData.action === "start_sync" && (
        <s-section>
          <s-banner tone="success" heading="Sync Started">
            Initial sync has been started. Status will update automatically.
          </s-banner>
        </s-section>
      )}

      {actionData?.success === false && actionData.action === "start_sync" && (
        <s-section>
          <s-banner tone="warning" heading="Sync Not Started">
            {actionData.error ?? "Sync could not be started."}
          </s-banner>
        </s-section>
      )}

      {actionData?.success && actionData.action !== "retry_registration" && actionData.action !== "start_sync" && (
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
            You&apos;ve completed all setup steps. Your store is ready to use
            Termwise!
          </s-banner>
        </s-section>
      )}

      <s-section heading="Get Started with Termwise">
        <s-stack gap="base">
          <s-paragraph>
            Complete these steps to set up net terms management for your store.
            Each step reflects your store&apos;s actual settings.
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
                <s-button type="submit" disabled={isDismissing}>
                  {isDismissing ? "Dismissing..." : "Dismiss for now"}
                </s-button>
              </Form>
            )}
            {isDismissed && (
              <Form method="post">
                <input type="hidden" name="_action" value="reopen" />
                <s-button type="submit" variant="primary" disabled={isReopening}>
                  {isReopening ? "Reopening..." : "Continue setup"}
                </s-button>
              </Form>
            )}
            <s-button href="/app?skipOnboarding=true">Go to Dashboard</s-button>
          </s-stack>
        </s-stack>
      </s-section>

      <s-section heading="Initial Sync">
        <InitialSyncSection
          syncState={currentSyncState}
          isStarting={isStartingSync}
          currencySupported={currencySupported ?? false}
        />
      </s-section>

      {currentRegistrationStatus && (
        <s-section heading="App Registration &amp; Metafield Definitions">
          <RegistrationStatusSection
            status={currentRegistrationStatus}
            isRetrying={isRetrying}
          />
        </s-section>
      )}

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
          <s-link href={SUPPORT_EMAIL_MAILTO}>Contact support</s-link> for setup
          assistance and troubleshooting.
        </s-paragraph>
      </s-section>
    </s-page>
  );
}

export function ErrorBoundary() {
  const error = useRouteError();

  if (isRouteErrorResponse(error) && error.status !== 404) {
    return boundary.error(error);
  }

  let heading = "Something went wrong";
  let message = "An unexpected error occurred while loading the setup guide.";

  if (isRouteErrorResponse(error)) {
    heading = `Error ${error.status}`;
    if (error.status === 404) {
      message = "The page you're looking for doesn't exist.";
    }
  } else if (error instanceof Error && import.meta.env.DEV) {
    message = error.message;
  }

  return (
    <s-page heading="Setup Guide">
      <s-section>
        <s-banner tone="critical" heading={heading}>
          <s-paragraph>{message}</s-paragraph>
          <s-stack direction="inline" gap="base">
            <s-button onClick={() => window.location.reload()}>
              Try again
            </s-button>
            <s-button href="/app" variant="tertiary">
              Go to dashboard
            </s-button>
          </s-stack>
        </s-banner>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
