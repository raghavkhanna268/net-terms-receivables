/**
 * Account page route (S11).
 *
 * Shows buyer account details including:
 * - Buyer info (name, type, terms)
 * - Credit limit and utilization
 * - Outstanding and available credit
 * - Hold status and reason
 * - Recent invoices
 *
 * Includes a credit-limit editor for setting:
 * - Credit limit (integer paise, >= 0 or "no limit")
 * - Manual hold with reason code
 * - Optional hold note
 *
 * Gated accounts (per S21 plan limits) are shown read-only.
 * Uses Polaris web components only.
 */

import { useState, useEffect } from "react";
import type {
  HeadersFunction,
  LoaderFunctionArgs,
  ActionFunctionArgs,
} from "react-router";
import { data } from "react-router";
import { useLoaderData, useActionData, Form, useNavigation } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { getRequestSql } from "~/lib/request-context.server";
import { isAccountActive, isGatingEnforced, getUsageStats } from "~/services/gating.server";
import { recordAccess, getActorFromSessionToken } from "~/services/access-log.server";
import {
  getBuyerOptOutStatus,
  setBuyerOptOut,
  clearBuyerOptOut,
} from "~/services/reminder-optout.server";
import {
  getCreditStatusDisplay,
  getCompanyTotals,
  updateCreditStatus,
  type CreditStatusUpdate,
} from "~/services/credit-status.server";
import { getBuyerInvoices, type BuyerInvoiceRow } from "~/lib/aging-queries.server";
import {
  formatPaiseAmount,
  buildOrderAdminUrl,
} from "~/lib/aging";
import { buildAccountOverLimitBannerState, buildNewAccountsPausedBannerState, type NewAccountsPausedBannerState } from "~/lib/over-limit-banner";
import type { HoldReasonCode } from "~/lib/metafields-contract";
import { getSyncErrorInfo, type SyncErrorInfo } from "~/lib/sync-error-info";
import { safeLog, toErrorCode } from "~/lib/log.server";
import { getAppHandle, buildPlanSelectionUrl } from "~/lib/plan-url";
import { isCurrencyGateOpen, getEffectiveCurrency } from "~/lib/currency-gate.server";
import { CURRENCY_NOT_SUPPORTED_BANNER_COPY } from "~/lib/shop-currency-copy";
import { pluralizeWithCount } from "~/lib/copy-helpers";

const HOLD_REASON_OPTIONS: Array<{ value: HoldReasonCode; label: string }> = [
  { value: "MANUAL_HOLD", label: "Manual hold" },
  { value: "PAYMENT_OVERDUE", label: "Payment overdue" },
  { value: "CREDIT_REVIEW", label: "Credit review required" },
  { value: "NEW_ACCOUNT", label: "New account review" },
  { value: "FRAUD_SUSPECTED", label: "Fraud suspected" },
];

/**
 * Sync state enum for banner display:
 * - pending_retry: syncPending=true, no permanent error, no dead-letter → auto-retries
 * - needs_attention: syncPending=true with permanent error OR dead-lettered → manual action needed
 * - synced: not syncPending → no banner
 */
type SyncState = "pending_retry" | "needs_attention" | "synced";

interface LoaderData {
  notSupported?: boolean;
  shopCurrency?: string;
  account: {
    id: string;
    name: string;
    kind: "COMPANY" | "TAGGED_CUSTOMER";
    companyId: string | null;
    defaultTermsDays: number | null;
    defaultTermsSource: "explicit" | "tag" | null;
    isGated: boolean;
  } | null;
  upgradeUrl: string | null;
  creditStatus: {
    creditLimitAmount: number | null;
    creditLimitPaise: string | null;
    exposurePaise: string;
    draftExposurePaise: string;
    availableCreditPaise: string | null;
    currency: string;
    holdState: "OK" | "NEAR_LIMIT" | "HELD" | "BYPASS";
    manualHold: boolean;
    holdReasonCode: string | null;
    holdNote: string | null;
    isOnHold: boolean;
    holdReasonDisplay: string | null;
    isOverLimit: boolean;
    isOverdue: boolean;
    utilizationPercent: number | null;
    syncPending: boolean;
    syncErrorCode: string | null;
    syncState: SyncState;
    hasDeadLetteredSync: boolean;
    syncErrorInfo: SyncErrorInfo | null;
  } | null;
  companyTotals: {
    locationCount: number;
    locationsOnHold: number;
    totalLimitPaise: string | null;
    totalExposurePaise: string;
    totalAvailablePaise: string | null;
    currency: string;
    hasMixedCurrencies: boolean;
    excludedLocationCount: number;
  } | null;
  invoices: {
    rows: Array<{
      id: string;
      name: string;
      orderId: string | null;
      dueAt: string | null;
      outstandingPaise: string;
      currency: string;
      daysPastDue: number;
    }>;
    totalCount: number;
  };
  gatingEnforced: boolean;
  reminderOptOut: {
    optedOut: boolean;
    optOutAt: string | null;
    optOutSource: "merchant" | "link" | null;
  } | null;
  newAccountsPausedBanner: NewAccountsPausedBannerState;
  error: string | null;
}

interface ActionData {
  ok?: boolean;
  success: boolean;
  error?: string;
  metafieldSyncPending?: boolean;
  action?: "updateCredit" | "updateReminderOptOut";
  upgradeRequired?: boolean;
  code?: string;
}

export const loader = async ({ request, context, params }: LoaderFunctionArgs) => {
  const { shopify } = context;
  const { session, sessionToken } = await shopify.authenticate.admin(request);
  const sql = getRequestSql();
  const shopDomain = session.shop;
  const accountId = params.id;

  const upgradeUrl = (() => {
    const handle = getAppHandle();
    if (handle === null) {
      safeLog("warn", "plan_url_app_handle_missing", {});
      return null;
    }
    return buildPlanSelectionUrl(shopDomain, handle);
  })();

  if (!accountId) {
    return {
      account: null,
      creditStatus: null,
      companyTotals: null,
      invoices: { rows: [], totalCount: 0 },
      gatingEnforced: isGatingEnforced(),
      reminderOptOut: null,
      upgradeUrl,
      newAccountsPausedBanner: {
        show: false,
        heading: "",
        bodyText: "",
        upgradeUrl: null,
      },
      error: "Account ID is required",
    } satisfies LoaderData;
  }

  const [shop] = await sql<{ id: string; currency: string | null }[]>`
    SELECT id, currency FROM "Shop" WHERE domain = ${shopDomain}
  `;

  if (!shop) {
    return {
      account: null,
      creditStatus: null,
      companyTotals: null,
      invoices: { rows: [], totalCount: 0 },
      gatingEnforced: isGatingEnforced(),
      reminderOptOut: null,
      upgradeUrl,
      newAccountsPausedBanner: {
        show: false,
        heading: "",
        bodyText: "",
        upgradeUrl: null,
      },
      error: "Shop not found",
    } satisfies LoaderData;
  }

  // #292: Check currency gate - if not supported, return minimal payload with no amounts
  if (!isCurrencyGateOpen(shop.currency)) {
    return {
      notSupported: true,
      shopCurrency: getEffectiveCurrency(shop.currency),
      account: null,
      creditStatus: null,
      companyTotals: null,
      invoices: { rows: [], totalCount: 0 },
      gatingEnforced: false,
      reminderOptOut: null,
      upgradeUrl,
      newAccountsPausedBanner: {
        show: false,
        heading: "",
        bodyText: "",
        upgradeUrl: null,
      },
      error: null,
    } satisfies LoaderData;
  }

  const [accountRow] = await sql<{
    id: string;
    name: string;
    kind: "COMPANY" | "TAGGED_CUSTOMER";
    companyId: string | null;
    defaultTermsDays: number | null;
    defaultTermsSource: "explicit" | "tag" | null;
    gatedAt: Date | null;
  }[]>`
    SELECT
      id,
      name,
      kind,
      "companyId",
      "defaultTermsDays",
      "defaultTermsSource",
      gated_at AS "gatedAt"
    FROM "BuyerAccount"
    WHERE id = ${accountId} AND "shopId" = ${shop.id}
  `;

  if (!accountRow) {
    return {
      account: null,
      creditStatus: null,
      companyTotals: null,
      invoices: { rows: [], totalCount: 0 },
      gatingEnforced: isGatingEnforced(),
      reminderOptOut: null,
      upgradeUrl,
      newAccountsPausedBanner: {
        show: false,
        heading: "",
        bodyText: "",
        upgradeUrl: null,
      },
      error: "Account not found",
    } satisfies LoaderData;
  }

  const isGated = !isAccountActive(accountRow.gatedAt);

  const account = {
    id: accountRow.id,
    name: accountRow.name,
    kind: accountRow.kind,
    companyId: accountRow.companyId,
    defaultTermsDays: accountRow.defaultTermsDays,
    defaultTermsSource: accountRow.defaultTermsSource,
    isGated,
  };

  const creditStatusDisplay = await getCreditStatusDisplay(sql, accountId);

  let creditStatus: LoaderData["creditStatus"] = null;
  if (creditStatusDisplay) {
    const metafieldSyncedAt = creditStatusDisplay.metafieldSyncedAt;
    const [deadLetterRow] = await sql<{ exists: boolean }[]>`
      SELECT EXISTS (
        SELECT 1 FROM s6_dead_letter
        WHERE original_queue = 's6_sync'
          AND message->>'topic' = 'CREDIT_STATUS_RECOMPUTE'
          AND message->>'buyerAccountId' = ${accountId}
          AND message->>'shop' = ${shopDomain}
          AND dead_lettered_at > COALESCE(${metafieldSyncedAt}, '-infinity'::timestamptz)
      ) AS exists
    `;
    const hasDeadLetteredSync = deadLetterRow?.exists ?? false;

    const syncErrorCode = creditStatusDisplay.syncErrorCode;
    const syncPending = creditStatusDisplay.syncPending;

    let syncState: SyncState = "synced";
    if (syncPending) {
      if (hasDeadLetteredSync || syncErrorCode !== null) {
        syncState = "needs_attention";
      } else {
        syncState = "pending_retry";
      }
    }

    const syncErrorInfo = syncState === "needs_attention"
      ? getSyncErrorInfo(hasDeadLetteredSync && !syncErrorCode ? null : syncErrorCode)
      : null;

    creditStatus = {
      creditLimitAmount: creditStatusDisplay.creditLimitAmount,
      creditLimitPaise: creditStatusDisplay.creditLimitPaise?.toString() ?? null,
      exposurePaise: creditStatusDisplay.exposurePaise.toString(),
      draftExposurePaise: creditStatusDisplay.draftExposurePaise.toString(),
      availableCreditPaise: creditStatusDisplay.availableCreditPaise?.toString() ?? null,
      currency: creditStatusDisplay.currency,
      holdState: creditStatusDisplay.holdState,
      manualHold: creditStatusDisplay.manualHold,
      holdReasonCode: creditStatusDisplay.holdReasonCode,
      holdNote: creditStatusDisplay.holdNote,
      isOnHold: creditStatusDisplay.isOnHold,
      holdReasonDisplay: creditStatusDisplay.holdReasonDisplay,
      isOverLimit: creditStatusDisplay.isOverLimit,
      isOverdue: creditStatusDisplay.isOverdue,
      utilizationPercent: creditStatusDisplay.utilizationPercent,
      syncPending,
      syncErrorCode,
      syncState,
      hasDeadLetteredSync,
      syncErrorInfo,
    };
  }

  const companyTotalsData = accountRow.kind === "COMPANY" && accountRow.companyId
    ? await getCompanyTotals(sql, accountRow.companyId, shop.id)
    : null;

  const companyTotals = companyTotalsData
    ? {
        locationCount: companyTotalsData.locationCount,
        locationsOnHold: companyTotalsData.locationsOnHold,
        totalLimitPaise: companyTotalsData.totalLimitPaise?.toString() ?? null,
        totalExposurePaise: companyTotalsData.totalExposurePaise.toString(),
        totalAvailablePaise: companyTotalsData.totalAvailablePaise?.toString() ?? null,
        currency: companyTotalsData.currency,
        hasMixedCurrencies: companyTotalsData.hasMixedCurrencies,
        excludedLocationCount: companyTotalsData.excludedLocationCount,
      }
    : null;

  const asOf = new Date();
  const invoiceResult = await getBuyerInvoices(sql, shop.id, accountId, asOf, {
    limit: 10,
    offset: 0,
  });

  const invoices = {
    rows: invoiceResult.rows.map((row: BuyerInvoiceRow) => ({
      id: row.id,
      name: row.name,
      orderId: row.order_id,
      dueAt: row.due_at ? row.due_at.toISOString() : null,
      outstandingPaise: row.outstanding_paise,
      currency: row.currency,
      daysPastDue: row.days_past_due,
    })),
    totalCount: invoiceResult.totalCount,
  };

  const optOutStatus = await getBuyerOptOutStatus(sql, shop.id, accountId);
  const reminderOptOut = optOutStatus
    ? {
        optedOut: optOutStatus.optedOut,
        optOutAt: optOutStatus.optOutAt?.toISOString() ?? null,
        optOutSource: optOutStatus.optOutSource,
      }
    : null;

  recordAccess(sql, {
    shopId: shop.id,
    actor: getActorFromSessionToken(sessionToken, session),
    action: "accounts_detail",
    recordType: "BuyerAccount",
    recordId: accountId,
  });

  const gatingEnforced = isGatingEnforced();

  // Only call getUsageStats when gating is enforced (fail-soft on error)
  let newAccountsPausedBanner: NewAccountsPausedBannerState = {
    show: false,
    heading: "",
    bodyText: "",
    upgradeUrl: null,
  };

  if (gatingEnforced) {
    try {
      const usage = await getUsageStats(sql, shop.id);
      newAccountsPausedBanner = buildNewAccountsPausedBannerState(
        usage.companies.current,
        usage.companies.limit,
        gatingEnforced,
        upgradeUrl
      );
    } catch (err) {
      safeLog("warn", "usage_stats_error", { shopId: shop.id, err: toErrorCode(err) });
      // Fail soft: no banner on error
    }
  }

  return {
    account,
    creditStatus,
    companyTotals,
    invoices,
    gatingEnforced,
    reminderOptOut,
    upgradeUrl,
    newAccountsPausedBanner,
    error: null,
  } satisfies LoaderData;
};

export const action = async ({ request, context, params }: ActionFunctionArgs) => {
  const { shopify } = context;
  const { session } = await shopify.authenticate.admin(request);
  const sql = getRequestSql();
  const shopDomain = session.shop;
  const accountId = params.id;

  if (!accountId) {
    return { success: false, error: "Account ID is required" } satisfies ActionData;
  }

  const [shop] = await sql<{ id: string; currency: string | null }[]>`
    SELECT id, currency FROM "Shop" WHERE domain = ${shopDomain}
  `;

  if (!shop) {
    return { success: false, error: "Shop not found" } satisfies ActionData;
  }

  // #292: Check currency gate - reject all money edits for non-supported shops
  if (!isCurrencyGateOpen(shop.currency)) {
    return { success: false, error: "Currency not supported" } satisfies ActionData;
  }

  const [accountRow] = await sql<{ id: string; gatedAt: Date | null }[]>`
    SELECT id, gated_at AS "gatedAt"
    FROM "BuyerAccount"
    WHERE id = ${accountId} AND "shopId" = ${shop.id}
  `;

  if (!accountRow) {
    return { success: false, error: "Account not found" } satisfies ActionData;
  }

  const formData = await request.formData();
  const action = formData.get("_action");

  if (action === "updateCredit") {
    const creditLimitStr = formData.get("creditLimit") as string | null;
    const noLimit = formData.get("noLimit") === "true";
    const holdOnly = formData.get("holdOnly") === "true";
    const manualHold = formData.get("manualHold") === "true";

    // Hold-only updates work on all plans including gated accounts.
    // Only gate credit-limit and account-details edits.
    const isGated = !isAccountActive(accountRow.gatedAt);
    if (!holdOnly && isGated) {
      return data(
        {
          ok: false,
          success: false,
          upgradeRequired: true,
          code: "plan_limit_account_gated",
          error: "This account was added after you reached your plan limit. Upgrade your plan to manage credit limits for this account.",
        } satisfies ActionData,
        { status: 403 }
      );
    }
    const holdReasonCodeRaw = formData.get("holdReasonCode") as string | null;
    const holdReasonCode = (holdReasonCodeRaw && holdReasonCodeRaw.trim() !== "") 
      ? holdReasonCodeRaw as HoldReasonCode 
      : undefined;
    const holdNote = formData.get("holdNote") as string | null;

    if (holdNote && holdNote.length > 500) {
      return {
        success: false,
        error: "Hold note cannot exceed 500 characters.",
      } satisfies ActionData;
    }

    let creditLimitAmount: number | null | undefined;
    let effectiveNoLimit = noLimit;

    if (holdOnly) {
      // For hold-only updates, preserve the current credit limit state.
      // If account is gated, ensure we don't accidentally modify credit settings
      // by ignoring any submitted credit-limit fields.
      creditLimitAmount = undefined;
      if (isGated) {
        // Force noLimit=false to prevent clearing credit limit via noLimit flag
        effectiveNoLimit = false;
      }
    } else if (noLimit) {
      creditLimitAmount = null;
    } else if (creditLimitStr && creditLimitStr.trim() !== "") {
      const trimmed = creditLimitStr.trim();
      if (!/^\d+(\.\d{1,2})?$/.test(trimmed)) {
        return {
          success: false,
          error: "Invalid credit limit format. Use a number with up to 2 decimal places (e.g., 100000 or 100000.50).",
        } satisfies ActionData;
      }
      const parsed = Number(trimmed);
      if (parsed < 0) {
        return {
          success: false,
          error: "Credit limit must be non-negative.",
        } satisfies ActionData;
      }
      creditLimitAmount = parsed;
    } else {
      return {
        success: false,
        error: "Credit limit cannot be empty. Check 'No credit limit' to allow unlimited credit.",
      } satisfies ActionData;
    }

    const update: CreditStatusUpdate = {
      creditLimitAmount,
      noLimit: effectiveNoLimit,
      manualHold,
      holdReasonCode: manualHold ? (holdReasonCode || "MANUAL_HOLD") : undefined,
      holdNote: holdNote || null,
    };

    const result = await updateCreditStatus(sql, accountId, update);

    if (!result.success && !result.metafieldSyncPending) {
      return {
        success: false,
        error: result.error ?? "Update failed",
      } satisfies ActionData;
    }

    return {
      success: true,
      action: "updateCredit",
      metafieldSyncPending: result.metafieldSyncPending,
      error: result.metafieldSyncPending ? result.error : undefined,
    } satisfies ActionData;
  }

  if (action === "updateReminderOptOut") {
    const enable = formData.get("enable") === "true";

    if (enable) {
      const cleared = await clearBuyerOptOut(sql, shop.id, accountId);

      if (cleared) {
        await sql`
          INSERT INTO "AuditEvent" (id, "shopId", actor, type, data, at)
          VALUES (
            gen_random_uuid(),
            ${shop.id},
            'system',
            'reminder.opt_out_cleared',
            ${sql.json({
              buyerAccountId: accountId,
              source: "merchant",
            })},
            NOW()
          )
        `;
      }

      return { success: true, action: "updateReminderOptOut" } satisfies ActionData;
    } else {
      await setBuyerOptOut(sql, shop.id, accountId, "merchant");
      return { success: true, action: "updateReminderOptOut" } satisfies ActionData;
    }
  }

  return { success: false, error: "Unknown action" } satisfies ActionData;
};

function InvoiceTable({
  invoices,
  currency,
}: {
  invoices: LoaderData["invoices"]["rows"];
  currency: string;
}) {
  if (invoices.length === 0) {
    return (
      <s-empty-state heading="No open invoices">
        <s-text slot="subheading">
          This buyer has no outstanding invoices.
        </s-text>
      </s-empty-state>
    );
  }

  return (
    <s-table>
      <s-table-header-row>
        <s-table-header listSlot="primary">Invoice</s-table-header>
        <s-table-header listSlot="labeled">Due Date</s-table-header>
        <s-table-header listSlot="labeled" format="currency">Outstanding</s-table-header>
        <s-table-header listSlot="inline">Status</s-table-header>
        <s-table-header listSlot="labeled">Order</s-table-header>
      </s-table-header-row>
      <s-table-body>
        {invoices.map((inv) => {
          const outstanding = BigInt(inv.outstandingPaise);
          const orderUrl = buildOrderAdminUrl(inv.orderId);

          return (
            <s-table-row key={inv.id}>
              <s-table-cell>{inv.name}</s-table-cell>
              <s-table-cell>
                {inv.dueAt
                  ? new Date(inv.dueAt).toLocaleDateString("en-IN", {
                      timeZone: "Asia/Kolkata",
                    })
                  : "—"}
              </s-table-cell>
              <s-table-cell>
                {formatPaiseAmount(outstanding, inv.currency || currency)}
              </s-table-cell>
              <s-table-cell>
                {inv.daysPastDue > 0 ? (
                  <s-badge tone="critical">{pluralizeWithCount(inv.daysPastDue, "day")} overdue</s-badge>
                ) : inv.daysPastDue === 0 ? (
                  <s-badge tone="warning">Due today</s-badge>
                ) : (
                  <s-badge>{pluralizeWithCount(Math.abs(inv.daysPastDue), "day")} left</s-badge>
                )}
              </s-table-cell>
              <s-table-cell>
                {orderUrl ? (
                  <s-link href={orderUrl}>View</s-link>
                ) : (
                  "—"
                )}
              </s-table-cell>
            </s-table-row>
          );
        })}
      </s-table-body>
    </s-table>
  );
}

export default function AccountPage() {
  const loaderData = useLoaderData<typeof loader>();
  const { account, creditStatus, companyTotals, invoices, gatingEnforced, reminderOptOut, upgradeUrl, newAccountsPausedBanner, error } = loaderData;
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const isSubmitting = navigation.state === "submitting";
  const isReminderSubmitting = isSubmitting && navigation.formData?.get("_action") === "updateReminderOptOut";

  const serverNoLimit = creditStatus?.creditLimitAmount === null;
  const [noLimitChecked, setNoLimitChecked] = useState(serverNoLimit);

  useEffect(() => {
    setNoLimitChecked(serverNoLimit);
  }, [serverNoLimit]);

  // #292: When currency not supported, show only the banner
  if (loaderData.notSupported) {
    return (
      <s-page heading="Account">
        <s-link href="/app" slot="breadcrumb-actions">Back to Dashboard</s-link>
        <s-section>
          <s-banner tone="critical" heading="Currency Not Supported">
            {CURRENCY_NOT_SUPPORTED_BANNER_COPY}
          </s-banner>
        </s-section>
      </s-page>
    );
  }

  if (error || !account) {
    return (
      <s-page heading="Account">
        <s-section>
          <s-banner tone="critical" heading="Error">
            {error ?? "Account not found"}
          </s-banner>
        </s-section>
      </s-page>
    );
  }

  const currency = creditStatus?.currency ?? "INR";

  return (
    <s-page heading={account.name}>
      <s-link href="/app" slot="breadcrumb-actions">Back to Dashboard</s-link>

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

      {actionData?.success && actionData.action === "updateCredit" && (
        <s-section>
          <s-banner
            tone={actionData.metafieldSyncPending ? "warning" : "info"}
            heading={actionData.metafieldSyncPending ? "Partially saved" : "Saved"}
          >
            {actionData.metafieldSyncPending
              ? "Credit settings saved. Changes will apply at checkout once the sync to Shopify finishes. We keep retrying automatically."
              : "Credit settings saved successfully."}
          </s-banner>
        </s-section>
      )}

      {actionData?.success && actionData.action === "updateReminderOptOut" && (
        <s-section>
          <s-banner tone="info" heading="Payment reminder settings updated">
            The buyer&apos;s payment reminder preference has been saved.
          </s-banner>
        </s-section>
      )}

      {actionData && !actionData.success && actionData.error && (
        <s-section>
          <s-banner tone="critical" heading="Error">
            {actionData.error}
          </s-banner>
        </s-section>
      )}

      {(() => {
        const bannerState = buildAccountOverLimitBannerState(account.isGated, gatingEnforced);
        return bannerState.show && (
          <s-section>
            <s-banner tone="warning" heading={bannerState.heading}>
              <s-stack>
                <s-text>
                  {bannerState.bodyText}
                  {bannerState.enforcementNote && ` ${bannerState.enforcementNote}`}
                </s-text>
                {upgradeUrl && (
                  <s-button href={upgradeUrl} target="_top" variant="secondary">
                    Upgrade
                  </s-button>
                )}
              </s-stack>
            </s-banner>
          </s-section>
        );
      })()}

      <s-section heading="Account Details">
        <s-stack>
          <s-paragraph>
            <s-text type="strong">Type: </s-text>
            <s-text>
              {account.kind === "COMPANY" ? "B2B Company" : "Tagged Customer"}
            </s-text>
          </s-paragraph>
          {account.defaultTermsDays !== null && (
            <s-paragraph>
              <s-text type="strong">Default Terms: </s-text>
              <s-text>
                Net {account.defaultTermsDays} days
                {account.defaultTermsSource === "tag" && " (from tag rule)"}
              </s-text>
            </s-paragraph>
          )}
        </s-stack>
      </s-section>

      {creditStatus && (
        <s-section heading="Credit Status">
          {creditStatus.syncState === "needs_attention" && creditStatus.syncErrorInfo && (
            <s-banner tone="critical" heading="Sync Requires Attention">
              {creditStatus.syncErrorInfo.message}
            </s-banner>
          )}
          {creditStatus.syncState === "pending_retry" && (
            <s-banner tone="warning" heading="Sync Pending">
              Your changes are still syncing to Shopify and will be retried automatically.
            </s-banner>
          )}
          <s-stack>
            <s-paragraph>
              <s-text type="strong">Credit Limit: </s-text>
              <s-text>
                {creditStatus.creditLimitPaise !== null
                  ? formatPaiseAmount(BigInt(creditStatus.creditLimitPaise), currency)
                  : "No limit"}
              </s-text>
            </s-paragraph>
            <s-paragraph>
              <s-text type="strong">Outstanding: </s-text>
              <s-text>
                {formatPaiseAmount(BigInt(creditStatus.exposurePaise), currency)}
              </s-text>
              {BigInt(creditStatus.draftExposurePaise) > 0n && (
                <s-text>
                  {" "}(includes {formatPaiseAmount(BigInt(creditStatus.draftExposurePaise), currency)} pending)
                </s-text>
              )}
            </s-paragraph>
            {creditStatus.availableCreditPaise !== null && (
              <s-paragraph>
                <s-text type="strong">Available Credit: </s-text>
                <s-text
                  tone={BigInt(creditStatus.availableCreditPaise) < 0n ? "critical" : undefined}
                >
                  {formatPaiseAmount(BigInt(creditStatus.availableCreditPaise), currency)}
                </s-text>
              </s-paragraph>
            )}
            {creditStatus.utilizationPercent !== null && (
              <s-paragraph>
                <s-text type="strong">Utilization: </s-text>
                <s-text
                  tone={creditStatus.utilizationPercent >= 100 ? "critical" : creditStatus.utilizationPercent >= 80 ? "warning" : undefined}
                >
                  {creditStatus.utilizationPercent}%
                </s-text>
              </s-paragraph>
            )}
            <s-paragraph>
              <s-text type="strong">Hold Status: </s-text>
              {creditStatus.isOnHold ? (
                <s-badge tone="critical">
                  On Hold{creditStatus.holdReasonDisplay ? ` - ${creditStatus.holdReasonDisplay}` : ""}
                </s-badge>
              ) : creditStatus.holdState === "NEAR_LIMIT" ? (
                <s-badge tone="warning">Near Limit</s-badge>
              ) : creditStatus.holdState === "BYPASS" ? (
                <s-badge tone="info">Credit check paused</s-badge>
              ) : (
                <s-badge>OK</s-badge>
              )}
            </s-paragraph>
          </s-stack>
        </s-section>
      )}

      {companyTotals && companyTotals.locationCount > 1 && (
        <s-section heading="Company Totals (All Locations)">
          {companyTotals.hasMixedCurrencies && (
            <s-banner tone="warning" heading="Mixed Currencies">
              Some locations use different currencies and are excluded from these totals.
              {companyTotals.excludedLocationCount > 0 && (
                <s-text> ({pluralizeWithCount(companyTotals.excludedLocationCount, "location")} excluded)</s-text>
              )}
            </s-banner>
          )}
          <s-stack>
            <s-paragraph>
              <s-text type="strong">Locations: </s-text>
              <s-text>{companyTotals.locationCount}</s-text>
            </s-paragraph>
            <s-paragraph>
              <s-text type="strong">Total Credit Limit: </s-text>
              <s-text>
                {companyTotals.totalLimitPaise !== null
                  ? formatPaiseAmount(BigInt(companyTotals.totalLimitPaise), companyTotals.currency)
                  : "No limit (at least one location has no limit)"}
              </s-text>
            </s-paragraph>
            <s-paragraph>
              <s-text type="strong">Total Outstanding: </s-text>
              <s-text>
                {formatPaiseAmount(BigInt(companyTotals.totalExposurePaise), companyTotals.currency)}
              </s-text>
            </s-paragraph>
            {companyTotals.totalAvailablePaise !== null && (
              <s-paragraph>
                <s-text type="strong">Total Available: </s-text>
                <s-text
                  tone={BigInt(companyTotals.totalAvailablePaise) < 0n ? "critical" : undefined}
                >
                  {formatPaiseAmount(BigInt(companyTotals.totalAvailablePaise), companyTotals.currency)}
                </s-text>
              </s-paragraph>
            )}
            <s-paragraph>
              <s-text type="strong">Locations on Hold: </s-text>
              {companyTotals.locationsOnHold > 0 ? (
                <s-badge tone="critical">{companyTotals.locationsOnHold}</s-badge>
              ) : (
                <s-text>0</s-text>
              )}
            </s-paragraph>
          </s-stack>
        </s-section>
      )}

      {!account.isGated && (
        <s-section heading="Edit Credit Settings">
          <Form method="post">
            <input type="hidden" name="_action" value="updateCredit" />
            <s-stack gap="base">
              <s-grid gridTemplateColumns="1fr auto" gap="base" alignItems="end">
                <s-money-field
                  label="Credit Limit"
                  name="creditLimit"
                  min={0}
                  placeholder="e.g., 100000"
                  value={noLimitChecked ? "" : (creditStatus?.creditLimitAmount?.toString() ?? "")}
                  disabled={noLimitChecked}
                ></s-money-field>
                <s-text>{currency}</s-text>
              </s-grid>

              <s-checkbox
                label="No credit limit"
                name="noLimit"
                value="true"
                checked={noLimitChecked}
                onChange={(e: Event) => {
                  const target = e.currentTarget as HTMLInputElement | null;
                  setNoLimitChecked(target?.checked ?? !noLimitChecked);
                }}
              ></s-checkbox>

              <s-checkbox
                label="Place manual hold on this account"
                name="manualHold"
                value="true"
                checked={creditStatus?.manualHold ?? false}
              ></s-checkbox>

              <s-select 
                label="Hold Reason (if held)" 
                name="holdReasonCode" 
                placeholder="Select reason..."
                value={creditStatus?.holdReasonCode ?? ""}
              >
                {HOLD_REASON_OPTIONS.map((opt) => (
                  <s-option key={opt.value ?? "null"} value={opt.value ?? ""}>
                    {opt.label}
                  </s-option>
                ))}
              </s-select>

              <s-text-field
                label="Hold Note (optional)"
                name="holdNote"
                placeholder="Internal note about the hold"
                value={creditStatus?.holdNote ?? ""}
              ></s-text-field>

              <s-button type="submit" variant="primary" disabled={isSubmitting}>
                {isSubmitting ? "Saving..." : "Save Credit Settings"}
              </s-button>
            </s-stack>
          </Form>
        </s-section>
      )}

      {account.isGated && (
        <s-section heading="Credit Settings">
          <s-stack gap="base">
            <s-paragraph>
              <s-text type="strong">Current Credit Limit: </s-text>
              <s-text>
                {creditStatus?.creditLimitAmount !== null && creditStatus?.creditLimitAmount !== undefined
                  ? `${creditStatus.creditLimitAmount.toLocaleString()} ${currency}`
                  : "No limit"}
              </s-text>
            </s-paragraph>
            <s-banner tone="info" heading="Upgrade to edit credit settings">
              <s-stack>
                <s-text>
                  Credit limit and account detail editing requires an upgrade. Holds still
                  work on all plans.
                </s-text>
                {upgradeUrl && (
                  <s-button href={upgradeUrl} target="_top" variant="secondary">
                    Upgrade
                  </s-button>
                )}
              </s-stack>
            </s-banner>
            <Form method="post">
              <input type="hidden" name="_action" value="updateCredit" />
              <input type="hidden" name="holdOnly" value="true" />
              <s-stack gap="base">
                <s-checkbox
                  label="Place manual hold on this account"
                  name="manualHold"
                  value="true"
                  checked={creditStatus?.manualHold ?? false}
                ></s-checkbox>

                <s-select 
                  label="Hold Reason (if held)" 
                  name="holdReasonCode" 
                  placeholder="Select reason..."
                  value={creditStatus?.holdReasonCode ?? ""}
                >
                  {HOLD_REASON_OPTIONS.map((opt) => (
                    <s-option key={opt.value ?? "null"} value={opt.value ?? ""}>
                      {opt.label}
                    </s-option>
                  ))}
                </s-select>

                <s-text-field
                  label="Hold Note (optional)"
                  name="holdNote"
                  placeholder="Internal note about the hold"
                  value={creditStatus?.holdNote ?? ""}
                ></s-text-field>

                <s-button type="submit" variant="primary" disabled={isSubmitting}>
                  {isSubmitting ? "Saving..." : "Save Hold Settings"}
                </s-button>
              </s-stack>
            </Form>
          </s-stack>
        </s-section>
      )}

      {reminderOptOut && (
        <s-section heading="Payment Reminders">
          <Form method="post">
            <input type="hidden" name="_action" value="updateReminderOptOut" />
            <input type="hidden" name="enable" value={reminderOptOut.optedOut ? "true" : "false"} />
            <s-stack gap="base">
              <s-paragraph>
                <s-text>
                  Payment reminder emails help buyers stay on top of upcoming and overdue invoices.
                </s-text>
              </s-paragraph>
              <s-paragraph>
                <s-text type="strong">Current status: </s-text>
                {reminderOptOut.optedOut ? (
                  <s-badge tone="warning">Opted out</s-badge>
                ) : (
                  <s-badge>Receiving reminders</s-badge>
                )}
              </s-paragraph>
              {reminderOptOut.optedOut && reminderOptOut.optOutAt && (
                <s-paragraph>
                  Opted out on {new Date(reminderOptOut.optOutAt).toLocaleDateString("en-IN", {
                    timeZone: "Asia/Kolkata",
                  })}
                  {reminderOptOut.optOutSource === "link" && " via email unsubscribe link"}
                  {reminderOptOut.optOutSource === "merchant" && " by merchant"}
                </s-paragraph>
              )}
              <s-button
                type="submit"
                variant={reminderOptOut.optedOut ? "primary" : "secondary"}
                disabled={isReminderSubmitting}
              >
                {isReminderSubmitting
                  ? "Saving..."
                  : reminderOptOut.optedOut
                    ? "Re-enable reminders"
                    : "Disable reminders"}
              </s-button>
              {reminderOptOut.optedOut && (
                <s-paragraph>
                  Turning reminders back on won&apos;t resend reminders that were skipped. The
                  next scheduled reminder will be sent as usual.
                </s-paragraph>
              )}
            </s-stack>
          </Form>
        </s-section>
      )}

      <s-section heading="Recent Invoices">
        <InvoiceTable invoices={invoices.rows} currency={currency} />
        {invoices.totalCount > 10 && (
          <s-paragraph>
            <s-text>
              Showing 10 of {invoices.totalCount} invoices.
            </s-text>
          </s-paragraph>
        )}
      </s-section>

      <s-section slot="aside" heading="About Credit Status">
        <s-paragraph>
          The credit status controls whether this buyer can complete checkout with net terms.
        </s-paragraph>
        <s-unordered-list>
          <s-list-item>
            <s-text type="strong">Credit Limit</s-text>: Maximum outstanding amount allowed
          </s-list-item>
          <s-list-item>
            <s-text type="strong">Outstanding</s-text>: Unpaid invoices plus pending draft orders
          </s-list-item>
          <s-list-item>
            <s-text type="strong">Hold</s-text>: When active, blocks checkout regardless of limit
          </s-list-item>
        </s-unordered-list>
        <s-paragraph>
          Changes apply at checkout once they sync to Shopify.
        </s-paragraph>
      </s-section>

      <s-section slot="aside" heading="Hold Reasons">
        <s-unordered-list>
          {HOLD_REASON_OPTIONS.map((opt) => (
            <s-list-item key={opt.value ?? "null"}>
              <s-text type="strong">{opt.label}</s-text>
            </s-list-item>
          ))}
        </s-unordered-list>
      </s-section>

      <s-section slot="aside" heading="Payment Reminders">
        <s-paragraph>
          Buyers can opt out of payment reminder emails via the unsubscribe link in each reminder.
        </s-paragraph>
        <s-paragraph>
          Only merchants can re-enable reminders for an opted-out buyer.
        </s-paragraph>
        <s-paragraph>
          Turning reminders back on does not resend skipped reminders. The next scheduled reminder sends normally.
        </s-paragraph>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
