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
import { useLoaderData, useActionData, Form, useNavigation } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { getRequestSql } from "~/lib/request-context.server";
import { isAccountActive } from "~/services/gating.server";
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
import type { HoldReasonCode } from "~/lib/metafields-contract";
import { getSyncErrorInfo, type SyncErrorInfo } from "~/lib/sync-error-info";

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
  account: {
    id: string;
    name: string;
    kind: "COMPANY" | "TAGGED_CUSTOMER";
    companyId: string | null;
    defaultTermsDays: number | null;
    defaultTermsSource: "explicit" | "tag" | null;
    isGated: boolean;
  } | null;
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
  error: string | null;
}

interface ActionData {
  success: boolean;
  error?: string;
  metafieldSyncPending?: boolean;
}

export const loader = async ({ request, context, params }: LoaderFunctionArgs) => {
  const { shopify } = context;
  const { session } = await shopify.authenticate.admin(request);
  const sql = getRequestSql();
  const shopDomain = session.shop;
  const accountId = params.id;

  if (!accountId) {
    return {
      account: null,
      creditStatus: null,
      companyTotals: null,
      invoices: { rows: [], totalCount: 0 },
      error: "Account ID is required",
    } satisfies LoaderData;
  }

  const [shop] = await sql<{ id: string }[]>`
    SELECT id FROM "Shop" WHERE domain = ${shopDomain}
  `;

  if (!shop) {
    return {
      account: null,
      creditStatus: null,
      companyTotals: null,
      invoices: { rows: [], totalCount: 0 },
      error: "Shop not found",
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

  return {
    account,
    creditStatus,
    companyTotals,
    invoices,
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

  const [shop] = await sql<{ id: string }[]>`
    SELECT id FROM "Shop" WHERE domain = ${shopDomain}
  `;

  if (!shop) {
    return { success: false, error: "Shop not found" } satisfies ActionData;
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
      return { success: false, error: "Cannot edit gated accounts" } satisfies ActionData;
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
      metafieldSyncPending: result.metafieldSyncPending,
      error: result.metafieldSyncPending ? result.error : undefined,
    } satisfies ActionData;
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
        <s-table-header>Invoice</s-table-header>
        <s-table-header>Due Date</s-table-header>
        <s-table-header format="currency">Outstanding</s-table-header>
        <s-table-header>Status</s-table-header>
        <s-table-header>Order</s-table-header>
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
                  <s-badge tone="critical">{inv.daysPastDue} days overdue</s-badge>
                ) : inv.daysPastDue === 0 ? (
                  <s-badge tone="warning">Due today</s-badge>
                ) : (
                  <s-badge>{Math.abs(inv.daysPastDue)} days left</s-badge>
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
  const { account, creditStatus, companyTotals, invoices, error } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const isSubmitting = navigation.state === "submitting";

  const serverNoLimit = creditStatus?.creditLimitAmount === null;
  const [noLimitChecked, setNoLimitChecked] = useState(serverNoLimit);

  useEffect(() => {
    setNoLimitChecked(serverNoLimit);
  }, [serverNoLimit]);

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
      <s-link href="/" slot="breadcrumb-actions">Back to Dashboard</s-link>

      {actionData?.success && (
        <s-section>
          <s-banner
            tone={actionData.metafieldSyncPending ? "warning" : "info"}
            heading={actionData.metafieldSyncPending ? "Partially saved" : "Saved"}
          >
            {actionData.metafieldSyncPending
              ? "Credit settings saved but Shopify sync is pending. The validation function may not reflect changes immediately."
              : "Credit settings saved successfully."}
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

      {account.isGated && (
        <s-section>
          <s-banner tone="warning" heading="Credit limit and account details are read-only on your current plan">
            Holds still work. Upgrade to edit credit settings.
          </s-banner>
        </s-section>
      )}

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
              Shopify metafield sync is pending. Changes will be retried automatically.
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
                <s-badge tone="info">Bypass Active</s-badge>
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
                <s-text> ({companyTotals.excludedLocationCount} location(s) excluded)</s-text>
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
              Credit limit and account detail editing is only available on paid plans.
              Holds still work on all plans.
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
            <s-text type="strong">Outstanding</s-text>: Current unpaid invoices + pending draft orders
          </s-list-item>
          <s-list-item>
            <s-text type="strong">Hold</s-text>: When active, blocks checkout regardless of limit
          </s-list-item>
        </s-unordered-list>
        <s-paragraph>
          Changes sync to Shopify and affect the checkout validation function immediately.
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
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
