/**
 * Payment reconciliation review queue (S16/S17).
 *
 * Displays unmatched/suggested payment matches for merchant review.
 * Confirm/Reject/Edit allocation actions are POST requests, idempotent and shop-scoped.
 *
 * S16: CONFIRM flow - merchants review suggested matches and confirm/reject them.
 * S17: APPLY flow - confirmed matches are pushed to Shopify (orderMarkAsPaid).
 *      Pushing matches show in "In Progress" tab with Retry action.
 *
 * Polaris web component patterns from #68:
 * - s-table with s-table-header-row directly under s-table
 * - s-stack direction="inline" (no s-inline-stack)
 * - s-button href instead of wrapping Link
 */

import type {
  HeadersFunction,
  LoaderFunctionArgs,
  ActionFunctionArgs,
} from "react-router";
import { useLoaderData, useActionData, useNavigation, Form } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { getRequestSql } from "~/lib/request-context.server";
import { parsePageParam } from "~/lib/parse-page-param";
import {
  getUnmatchedPayments,
  getSuggestedMatches,
  getPaymentWithMatches,
} from "~/lib/matching/queries.server";
import {
  runMatcher,
  confirmMatch,
  rejectMatch,
  MAX_PAYMENTS_PER_REQUEST,
} from "~/services/matcher.server";
import { applyMatch, unmatchMatch, RECONCILE_HUMAN_MESSAGES } from "~/services/apply.server";
import { formatPaiseAmount } from "~/lib/aging";
import { safeLog, toErrorCode } from "~/lib/log.server";
import { recordAccess, getActorFromSessionToken } from "~/services/access-log.server";
import { isCurrencyGateOpen, getEffectiveCurrency } from "~/lib/currency-gate.server";
import { CURRENCY_NOT_SUPPORTED_BANNER_COPY } from "~/lib/shop-currency-copy";
import { accountHref } from "~/lib/account-href";

const PAGE_SIZE = 20;

const GENERIC_ERROR = "An error occurred. Please try again.";

/**
 * Known human-readable error messages that are safe to display to merchants.
 * These are explicit, hand-written messages - not codes or raw error text.
 */
const KNOWN_HUMAN_MESSAGES = new Set([
  "Match not found",
  "Invoice not found",
  "Cannot unmatch: push is in progress",
  "Cannot unmatch: order already marked as paid in Shopify",
  "Cannot unmatch: no applied audit found for this match",
  "Match ID required",
  "Shop not found",
  "Unknown action",
  "Action failed",
  "Failed to load reconciliation data",
  "Failed to confirm match",
  "Failed to reject match",
  "Failed to apply match",
  "Failed to unmatch",
  ...RECONCILE_HUMAN_MESSAGES,
]);

/**
 * Map error codes to human-readable messages for display to merchants.
 * Fail-closed: any string not in the known set maps to the generic message.
 * Known codes match ^(retryable:|permanent:)?[a-z0-9_]+$ and are never shown.
 */
function toHumanError(error: string | null | undefined): string | null {
  if (!error) return null;
  if (KNOWN_HUMAN_MESSAGES.has(error)) return error;
  return GENERIC_ERROR;
}

const VALID_VIEWS = ["suggested", "unmatched", "confirmed", "pushing"] as const;
type ReconcileView = (typeof VALID_VIEWS)[number];

function toSafeView(raw: string): ReconcileView | "other" {
  return VALID_VIEWS.includes(raw as ReconcileView) ? (raw as ReconcileView) : "other";
}

const VALID_INTENTS = ["run_matcher", "confirm", "reject", "apply", "unmatch"] as const;
type ReconcileIntent = (typeof VALID_INTENTS)[number];

function toSafeIntent(raw: string): ReconcileIntent | "other" {
  return VALID_INTENTS.includes(raw as ReconcileIntent) ? (raw as ReconcileIntent) : "other";
}

interface PaymentSummary {
  id: string;
  amountPaise: string;
  narration: string;
  payerText: string | null;
  utr: string | null;
  rail: string | null;
}

interface MatchSummary {
  id: string;
  paymentId: string;
  invoiceId: string;
  invoiceName: string;
  amountPaise: string;
  score: number;
  reasons: unknown;
  state: string;
  buyerName: string;
  buyerAccountId?: string;
}

/**
 * Label map for match reason types.
 * Maps internal reason codes to merchant-friendly labels.
 */
export const MATCH_REASON_LABELS: Record<string, string> = {
  amount_exact: "Exact amount",
  amount_overpayment: "Overpayment",
  amount_partial: "Partial payment",
  invoice_ref: "Invoice/Order ref",
  order_ref: "Invoice/Order ref",
  payer_alias: "Confirmed alias",
  payer_name: "Payer name",
  email_match: "Email match",
  multi_invoice: "Multiple invoices",
};

/**
 * Get a merchant-friendly label for a match reason type.
 * Falls back to a readable version of the code for unknown types.
 */
export function getMatchReasonLabel(type: string): string {
  return MATCH_REASON_LABELS[type] ?? type.replace(/_/g, " ");
}

/**
 * Label map for match states.
 * Maps internal state values to merchant-friendly labels.
 */
export const MATCH_STATE_LABELS: Record<string, string> = {
  suggested: "Suggested",
  confirmed: "Confirmed",
  pushing: "Applying…",
  pushed: "Recorded in Shopify",
  unmatched: "Not matched",
};

/**
 * Get a merchant-friendly label for a match state.
 * Falls back to Title Case for unknown states.
 */
export function getMatchStateLabel(state: string): string {
  return MATCH_STATE_LABELS[state] ?? state.charAt(0).toUpperCase() + state.slice(1);
}

export const loader = async ({ request, context }: LoaderFunctionArgs) => {
  const { shopify } = context;
  const { session, sessionToken } = await shopify.authenticate.admin(request);
  const sql = getRequestSql();
  const shopDomain = session.shop;

  const url = new URL(request.url);
  const page = parsePageParam(url.searchParams.get("page"));
  const view = url.searchParams.get("view") ?? "suggested";
  const selectedPaymentId = url.searchParams.get("payment") ?? null;

  // Get shop ID
  const [shop] = await sql<{ id: string; currency: string | null }[]>`
    SELECT id, currency FROM "Shop" WHERE domain = ${shopDomain}
  `;

  if (!shop) {
    return {
      shopCurrency: "INR",
      payments: [],
      matches: [],
      selectedPayment: null,
      pagination: { page: 1, pageSize: PAGE_SIZE, totalCount: 0 },
      view,
      error: "Shop not found",
      tabCounts: { suggested: 0, unmatched: 0, confirmed: 0, pushing: 0 },
      notSupported: false,
    };
  }

  // #292: Check currency gate - if not supported, return minimal payload with no amounts
  if (!isCurrencyGateOpen(shop.currency)) {
    return {
      shopCurrency: getEffectiveCurrency(shop.currency),
      payments: [],
      matches: [],
      selectedPayment: null,
      pagination: { page: 1, pageSize: PAGE_SIZE, totalCount: 0 },
      view,
      error: null,
      tabCounts: { suggested: 0, unmatched: 0, confirmed: 0, pushing: 0 },
      notSupported: true,
    };
  }

  let payments: PaymentSummary[] = [];
  let matches: MatchSummary[] = [];
  let selectedPayment: {
    payment: PaymentSummary & { valueDate: string; importFileName: string };
    matches: MatchSummary[];
  } | null = null;
  let totalCount = 0;

  // P3: Get real tab counts from COUNT queries (not page length)
  let tabCounts = { suggested: 0, unmatched: 0, confirmed: 0, pushing: 0 };
  try {
    const [suggestedCount, unmatchedCount, confirmedCount, pushingCount] = await Promise.all([
      sql<{ count: string }[]>`
        SELECT COUNT(*)::text AS count
        FROM "Match"
        WHERE "shopId" = ${shop.id}
          AND state = 'suggested'
      `.then(r => r[0]),
      sql<{ count: string }[]>`
        SELECT COUNT(*)::text AS count
        FROM "Payment"
        WHERE "shopId" = ${shop.id}
          AND status IN ('unmatched', 'partial')
      `.then(r => r[0]),
      sql<{ count: string }[]>`
        SELECT COUNT(*)::text AS count
        FROM "Match"
        WHERE "shopId" = ${shop.id}
          AND state = 'confirmed'
      `.then(r => r[0]),
      sql<{ count: string }[]>`
        SELECT COUNT(*)::text AS count
        FROM "Match"
        WHERE "shopId" = ${shop.id}
          AND state = 'pushing'
      `.then(r => r[0]),
    ]);
    tabCounts = {
      suggested: parseInt(suggestedCount?.count ?? "0", 10),
      unmatched: parseInt(unmatchedCount?.count ?? "0", 10),
      confirmed: parseInt(confirmedCount?.count ?? "0", 10),
      pushing: parseInt(pushingCount?.count ?? "0", 10),
    };
  } catch (err) {
    safeLog("error", "reconcile_tab_counts_error", {
      shopId: shop.id,
      err: toErrorCode(err),
    });
  }

  try {
    if (selectedPaymentId) {
      // Viewing a specific payment's matches
      const paymentData = await getPaymentWithMatches(
        sql,
        shop.id,
        selectedPaymentId
      );

      if (paymentData) {
        selectedPayment = {
          payment: {
            id: paymentData.payment.id,
            amountPaise: paymentData.payment.amountPaise.toString(),
            narration: paymentData.payment.narration,
            payerText: paymentData.payment.payerText,
            utr: paymentData.payment.utr,
            rail: paymentData.payment.rail,
            valueDate: paymentData.payment.valueDate.toISOString(),
            importFileName: paymentData.payment.importFileName,
          },
          matches: paymentData.matches.map((m) => ({
            id: m.id,
            paymentId: selectedPaymentId,
            invoiceId: m.invoiceId,
            invoiceName: m.invoiceName,
            amountPaise: m.amountPaise.toString(),
            score: m.score,
            reasons: m.reasons,
            state: m.state,
            buyerName: m.buyerName,
          })),
        };
      }
    } else if (view === "unmatched") {
      // View unmatched payments
      const result = await getUnmatchedPayments(sql, shop.id, {
        limit: PAGE_SIZE,
        offset: (page - 1) * PAGE_SIZE,
      });

      payments = result.payments.map((p) => ({
        id: p.id,
        amountPaise: p.amountPaise.toString(),
        narration: p.narration,
        payerText: p.payerText,
        utr: p.utr,
        rail: p.rail,
      }));
      totalCount = result.totalCount;
    } else if (view === "confirmed") {
      // S17: View confirmed matches awaiting apply
      const result = await getSuggestedMatches(sql, shop.id, {
        limit: PAGE_SIZE,
        offset: (page - 1) * PAGE_SIZE,
        state: "confirmed",
      });

      matches = result.matches.map((m) => ({
        id: m.id,
        paymentId: m.paymentId,
        invoiceId: m.invoiceId,
        invoiceName: m.invoiceName,
        amountPaise: m.amountPaise.toString(),
        score: m.score,
        reasons: m.reasons,
        state: m.state,
        buyerName: m.buyerName,
        buyerAccountId: m.buyerAccountId,
      }));
      totalCount = result.totalCount;
    } else if (view === "pushing") {
      // S17: View pushing matches (in-flight) with Retry action
      const result = await getSuggestedMatches(sql, shop.id, {
        limit: PAGE_SIZE,
        offset: (page - 1) * PAGE_SIZE,
        state: "pushing",
      });

      matches = result.matches.map((m) => ({
        id: m.id,
        paymentId: m.paymentId,
        invoiceId: m.invoiceId,
        invoiceName: m.invoiceName,
        amountPaise: m.amountPaise.toString(),
        score: m.score,
        reasons: m.reasons,
        state: m.state,
        buyerName: m.buyerName,
        buyerAccountId: m.buyerAccountId,
      }));
      totalCount = result.totalCount;
    } else {
      // View suggested matches (default)
      const result = await getSuggestedMatches(sql, shop.id, {
        limit: PAGE_SIZE,
        offset: (page - 1) * PAGE_SIZE,
        state: "suggested",
      });

      matches = result.matches.map((m) => ({
        id: m.id,
        paymentId: m.paymentId,
        invoiceId: m.invoiceId,
        invoiceName: m.invoiceName,
        amountPaise: m.amountPaise.toString(),
        score: m.score,
        reasons: m.reasons,
        state: m.state,
        buyerName: m.buyerName,
        buyerAccountId: m.buyerAccountId,
      }));
      totalCount = result.totalCount;
    }
  } catch (err) {
    safeLog("error", "reconcile_loader_error", {
      shopId: shop.id,
      stage: toSafeView(view),
      err: toErrorCode(err),
    });
    return {
      shopCurrency: getEffectiveCurrency(shop.currency),
      payments: [],
      matches: [],
      selectedPayment: null,
      pagination: { page, pageSize: PAGE_SIZE, totalCount: 0 },
      view,
      error: "Failed to load reconciliation data",
      tabCounts,
      notSupported: false,
    };
  }

  recordAccess(sql, {
    shopId: shop.id,
    actor: getActorFromSessionToken(sessionToken, session),
    action: "reconcile",
    recordType: "Payment",
    count: totalCount,
  });

  return {
    shopCurrency: getEffectiveCurrency(shop.currency),
    payments,
    matches,
    selectedPayment,
    pagination: { page, pageSize: PAGE_SIZE, totalCount },
    view,
    error: null,
    tabCounts,
    notSupported: false,
  };
};

export const action = async ({ request, context }: ActionFunctionArgs) => {
  const { shopify } = context;
  const { session } = await shopify.authenticate.admin(request);
  const sql = getRequestSql();
  const shopDomain = session.shop;

  const formData = await request.formData();
  const intent = formData.get("intent") as string;

  // Get shop ID and currency
  const [shop] = await sql<{ id: string; currency: string | null }[]>`
    SELECT id, currency FROM "Shop" WHERE domain = ${shopDomain}
  `;

  if (!shop) {
    return { success: false, intent: null, error: "Shop not found" };
  }

  // #292/G7: Currency guard - refuse all reconcile actions for non-INR or unknown shops
  if (!isCurrencyGateOpen(shop.currency)) {
    return { success: false, intent: null, error: "Currency not supported" };
  }

  const userId = session.onlineAccessInfo?.associatedUser?.id?.toString() ?? "system";

  try {
    switch (intent) {
      case "run_matcher": {
        // Use MAX_PAYMENTS_PER_REQUEST to respect Workers Free 10ms CPU budget
        const result = await runMatcher(sql, shop.id, { limit: MAX_PAYMENTS_PER_REQUEST });
        return {
          success: true,
          intent: "run_matcher",
          message: `Processed ${result.paymentsProcessed} payments, created ${result.matchesCreated} matches (${result.highConfidenceMatches} high confidence)${result.hasMore ? " (more pending)" : ""}`,
        };
      }

      case "confirm": {
        const matchId = formData.get("matchId") as string;
        if (!matchId) {
          return { success: false, intent: "confirm", error: "Match ID required" };
        }
        const result = await confirmMatch(sql, shop.id, matchId, userId);
        // P2.6: Return generic error messages, details logged server-side
        return {
          success: result.success,
          intent: "confirm",
          error: result.success ? null : "Failed to confirm match",
        };
      }

      case "reject": {
        const matchId = formData.get("matchId") as string;
        if (!matchId) {
          return { success: false, intent: "reject", error: "Match ID required" };
        }
        const result = await rejectMatch(sql, shop.id, matchId, userId);
        // P2.6: Return generic error messages, details logged server-side
        return {
          success: result.success,
          intent: "reject",
          error: result.success ? null : "Failed to reject match",
        };
      }

      // S17: Apply confirmed match to reduce invoice outstanding
      // IDOR protection: pass shop.id from authenticated session
      case "apply": {
        const matchId = formData.get("matchId") as string;
        if (!matchId) {
          return { success: false, intent: "apply", error: "Match ID required" };
        }
        const result = await applyMatch(sql, shop.id, matchId, userId);
        return {
          success: result.success,
          intent: "apply",
          error: result.success ? null : toHumanError(result.error) ?? "Failed to apply match",
        };
      }

      // S17: Unmatch a confirmed or pushed match
      // IDOR protection: pass shop.id from authenticated session
      case "unmatch": {
        const matchId = formData.get("matchId") as string;
        if (!matchId) {
          return { success: false, intent: "unmatch", error: "Match ID required" };
        }
        const result = await unmatchMatch(sql, shop.id, matchId, userId);
        return {
          success: result.success,
          intent: "unmatch",
          error: result.success ? null : toHumanError(result.error) ?? "Failed to unmatch",
        };
      }

      default:
        safeLog("warn", "reconcile_unknown_action", {
          shopId: shop.id,
          action: toSafeIntent(intent),
        });
        return { success: false, intent: "unknown", error: "Unknown action" };
    }
  } catch (err) {
    safeLog("error", "reconcile_action_error", {
      shopId: shop.id,
      action: toSafeIntent(intent),
      err: toErrorCode(err),
    });
    return {
      success: false,
      intent: toSafeIntent(intent) as ReconcileIntent | "unknown",
      error: "Action failed",
    };
  }
};

function ScoreBadge({ score }: { score: number }) {
  if (score >= 80) {
    return <s-badge tone="success">High ({score})</s-badge>;
  }
  if (score >= 50) {
    return <s-badge tone="warning">Medium ({score})</s-badge>;
  }
  return <s-badge tone="critical">Low ({score})</s-badge>;
}

function RailBadge({ rail }: { rail: string | null }) {
  if (!rail) return <s-text>—</s-text>;

  if (rail === "NEFT") return <s-badge tone="info">{rail}</s-badge>;
  if (rail === "RTGS") return <s-badge tone="success">{rail}</s-badge>;
  if (rail === "IMPS") return <s-badge tone="warning">{rail}</s-badge>;
  return <s-badge>{rail}</s-badge>;
}

function MatchReasons({ reasons }: { reasons: unknown }) {
  if (!Array.isArray(reasons)) return null;

  return (
    <s-stack>
      {reasons.map((reason, idx) => (
        <s-text key={idx}>
          {getMatchReasonLabel(reason.type)} +{reason.points}
        </s-text>
      ))}
    </s-stack>
  );
}

function PaymentDetailView({
  payment,
  matches,
  currency,
  actionsDisabled,
}: {
  payment: { id: string; amountPaise: string; narration: string; payerText: string | null; utr: string | null; rail: string | null; valueDate: string; importFileName: string };
  matches: MatchSummary[];
  currency: string;
  actionsDisabled: boolean;
}) {

  return (
    <s-section heading="Payment Details">
      <s-stack>
        <s-paragraph>
          <s-text type="strong">Amount: </s-text>
          <s-text>{formatPaiseAmount(BigInt(payment.amountPaise), currency)}</s-text>
        </s-paragraph>
        <s-paragraph>
          <s-text type="strong">Value Date: </s-text>
          <s-text>
            {new Date(payment.valueDate).toLocaleDateString("en-IN", {
              timeZone: "UTC",
            })}
          </s-text>
        </s-paragraph>
        <s-paragraph>
          <s-text type="strong">Rail: </s-text>
          <RailBadge rail={payment.rail} />
        </s-paragraph>
        {payment.utr && (
          <s-paragraph>
            <s-text type="strong">UTR: </s-text>
            <s-text>{payment.utr}</s-text>
          </s-paragraph>
        )}
        {payment.payerText && (
          <s-paragraph>
            <s-text type="strong">Payer: </s-text>
            <s-text>{payment.payerText}</s-text>
          </s-paragraph>
        )}
        <s-paragraph>
          <s-text type="strong">Narration: </s-text>
          <s-text>{payment.narration}</s-text>
        </s-paragraph>
        <s-paragraph>
          <s-text type="strong">Import: </s-text>
          <s-text>{payment.importFileName}</s-text>
        </s-paragraph>

        <s-divider />

        <s-paragraph>
          <s-text type="strong">Suggested Matches ({matches.length})</s-text>
        </s-paragraph>

        {matches.length === 0 ? (
          <s-empty-state heading="No matches found">
            <s-text slot="subheading">
              No invoice matches were found for this payment. You can run the
              matcher again after new invoices are created.
            </s-text>
          </s-empty-state>
        ) : (
          <s-table>
            <s-table-header-row>
              <s-table-header listSlot="primary">Invoice</s-table-header>
              <s-table-header listSlot="secondary">Buyer</s-table-header>
              <s-table-header listSlot="labeled" format="currency">Amount</s-table-header>
              <s-table-header listSlot="inline">Score</s-table-header>
              <s-table-header listSlot="labeled">Reasons</s-table-header>
              <s-table-header listSlot="labeled">Actions</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {matches.map((match) => (
                <s-table-row key={match.id}>
                  <s-table-cell>{match.invoiceName}</s-table-cell>
                  <s-table-cell>{match.buyerName}</s-table-cell>
                  <s-table-cell>
                    {formatPaiseAmount(BigInt(match.amountPaise), currency)}
                  </s-table-cell>
                  <s-table-cell>
                    <ScoreBadge score={match.score} />
                  </s-table-cell>
                  <s-table-cell>
                    <MatchReasons reasons={match.reasons} />
                  </s-table-cell>
                  <s-table-cell>
                    {match.state === "suggested" ? (
                      <s-stack direction="inline">
                        <Form method="post">
                          <input type="hidden" name="intent" value="confirm" />
                          <input type="hidden" name="matchId" value={match.id} />
                          <s-button
                            variant="primary"
                            type="submit"
                            disabled={actionsDisabled}
                          >
                            Confirm
                          </s-button>
                        </Form>
                        <Form method="post">
                          <input type="hidden" name="intent" value="reject" />
                          <input type="hidden" name="matchId" value={match.id} />
                          <s-button
                            variant="secondary"
                            tone="critical"
                            type="submit"
                            disabled={actionsDisabled}
                          >
                            Reject
                          </s-button>
                        </Form>
                      </s-stack>
                    ) : (
                      <s-badge
                        tone={match.state === "confirmed" ? "success" : "critical"}
                      >
                        {getMatchStateLabel(match.state)}
                      </s-badge>
                    )}
                  </s-table-cell>
                </s-table-row>
              ))}
            </s-table-body>
          </s-table>
        )}

        <s-button href="/app/reconcile">Back to Queue</s-button>
      </s-stack>
    </s-section>
  );
}

function UnmatchedPaymentsView({
  payments,
  currency,
  page,
  totalCount,
  pageSize,
}: {
  payments: PaymentSummary[];
  currency: string;
  page: number;
  totalCount: number;
  pageSize: number;
}) {
  const totalPages = Math.ceil(totalCount / pageSize);

  if (payments.length === 0) {
    return (
      <s-empty-state heading="No unmatched payments">
        <s-text slot="subheading">
          All payments have been matched or are pending review. Import more bank
          statements to see new payments here.
        </s-text>
      </s-empty-state>
    );
  }

  return (
    <s-stack>
      <s-table>
        <s-table-header-row>
          <s-table-header listSlot="labeled" format="currency">Amount</s-table-header>
          <s-table-header listSlot="inline">Rail</s-table-header>
          <s-table-header listSlot="primary">UTR</s-table-header>
          <s-table-header listSlot="labeled">Payer</s-table-header>
          <s-table-header listSlot="secondary">Narration</s-table-header>
          <s-table-header listSlot="labeled">Actions</s-table-header>
        </s-table-header-row>
        <s-table-body>
          {payments.map((payment) => (
            <s-table-row key={payment.id}>
              <s-table-cell>
                {formatPaiseAmount(BigInt(payment.amountPaise), currency)}
              </s-table-cell>
              <s-table-cell>
                <RailBadge rail={payment.rail} />
              </s-table-cell>
              <s-table-cell>{payment.utr ?? "—"}</s-table-cell>
              <s-table-cell>
                {payment.payerText
                  ? payment.payerText.slice(0, 30) +
                    (payment.payerText.length > 30 ? "…" : "")
                  : "—"}
              </s-table-cell>
              <s-table-cell>
                {payment.narration.slice(0, 40) +
                  (payment.narration.length > 40 ? "…" : "")}
              </s-table-cell>
              <s-table-cell>
                <s-link href={`/app/reconcile?payment=${payment.id}`}>
                  View
                </s-link>
              </s-table-cell>
            </s-table-row>
          ))}
        </s-table-body>
      </s-table>

      {totalPages > 1 && (
        <s-stack direction="inline">
          {page > 1 && (
            <s-button href={`/app/reconcile?view=unmatched&page=${page - 1}`}>
              Previous
            </s-button>
          )}
          <s-text>
            Page {page} of {totalPages} ({totalCount} payments)
          </s-text>
          {page < totalPages && (
            <s-button href={`/app/reconcile?view=unmatched&page=${page + 1}`}>
              Next
            </s-button>
          )}
        </s-stack>
      )}
    </s-stack>
  );
}

function SuggestedMatchesView({
  matches,
  currency,
  page,
  totalCount,
  pageSize,
  actionsDisabled,
}: {
  matches: MatchSummary[];
  currency: string;
  page: number;
  totalCount: number;
  pageSize: number;
  actionsDisabled: boolean;
}) {
  const totalPages = Math.ceil(totalCount / pageSize);

  if (matches.length === 0) {
    return (
      <s-empty-state heading="No pending matches">
        <s-text slot="subheading">
          There are no suggested matches awaiting review. Run the matcher to
          generate new suggestions.
        </s-text>
      </s-empty-state>
    );
  }

  return (
    <s-stack>
      <s-table>
        <s-table-header-row>
          <s-table-header listSlot="primary">Invoice</s-table-header>
          <s-table-header listSlot="secondary">Buyer</s-table-header>
          <s-table-header listSlot="labeled" format="currency">Amount</s-table-header>
          <s-table-header listSlot="inline">Score</s-table-header>
          <s-table-header listSlot="labeled">Actions</s-table-header>
        </s-table-header-row>
        <s-table-body>
          {matches.map((match) => (
            <s-table-row key={match.id}>
              <s-table-cell>{match.invoiceName}</s-table-cell>
              <s-table-cell>{match.buyerName}</s-table-cell>
              <s-table-cell>
                {formatPaiseAmount(BigInt(match.amountPaise), currency)}
              </s-table-cell>
              <s-table-cell>
                <ScoreBadge score={match.score} />
              </s-table-cell>
              <s-table-cell>
                <s-stack direction="inline">
                  <s-link href={`/app/reconcile?payment=${match.paymentId}`}>
                    Details
                  </s-link>
                  <Form method="post" style={{ display: "inline" }}>
                    <input type="hidden" name="intent" value="confirm" />
                    <input type="hidden" name="matchId" value={match.id} />
                    <s-button
                      variant="primary"
                      type="submit"
                      disabled={actionsDisabled}
                    >
                      Confirm
                    </s-button>
                  </Form>
                  <Form method="post" style={{ display: "inline" }}>
                    <input type="hidden" name="intent" value="reject" />
                    <input type="hidden" name="matchId" value={match.id} />
                    <s-button
                      variant="secondary"
                      tone="critical"
                      type="submit"
                      disabled={actionsDisabled}
                    >
                      Reject
                    </s-button>
                  </Form>
                </s-stack>
              </s-table-cell>
            </s-table-row>
          ))}
        </s-table-body>
      </s-table>

      {totalPages > 1 && (
        <s-stack direction="inline">
          {page > 1 && (
            <s-button href={`/app/reconcile?view=suggested&page=${page - 1}`}>
              Previous
            </s-button>
          )}
          <s-text>
            Page {page} of {totalPages} ({totalCount} matches)
          </s-text>
          {page < totalPages && (
            <s-button href={`/app/reconcile?view=suggested&page=${page + 1}`}>
              Next
            </s-button>
          )}
        </s-stack>
      )}
    </s-stack>
  );
}

/**
 * S17: Confirmed matches view with Apply/Unmatch actions.
 */
function ConfirmedMatchesView({
  matches,
  currency,
  page,
  totalCount,
  pageSize,
  actionsDisabled,
}: {
  matches: MatchSummary[];
  currency: string;
  page: number;
  totalCount: number;
  pageSize: number;
  actionsDisabled: boolean;
}) {
  const totalPages = Math.ceil(totalCount / pageSize);

  if (matches.length === 0) {
    return (
      <s-empty-state heading="No confirmed matches">
        <s-text slot="subheading">
          Confirm suggested matches first. Once confirmed, you can apply them
          here to reduce invoice outstanding amounts.
        </s-text>
      </s-empty-state>
    );
  }

  return (
    <s-stack>
      <s-table>
        <s-table-header-row>
          <s-table-header listSlot="primary">Invoice</s-table-header>
          <s-table-header listSlot="secondary">Buyer</s-table-header>
          <s-table-header listSlot="labeled" format="currency">Amount</s-table-header>
          <s-table-header listSlot="labeled">Actions</s-table-header>
        </s-table-header-row>
        <s-table-body>
          {matches.map((match) => (
            <s-table-row key={match.id}>
              <s-table-cell>{match.invoiceName}</s-table-cell>
              <s-table-cell>{match.buyerName}</s-table-cell>
              <s-table-cell>
                {formatPaiseAmount(BigInt(match.amountPaise), currency)}
              </s-table-cell>
              <s-table-cell>
                <s-stack direction="inline">
                  <Form method="post" style={{ display: "inline" }}>
                    <input type="hidden" name="intent" value="apply" />
                    <input type="hidden" name="matchId" value={match.id} />
                    <s-button
                      variant="primary"
                      type="submit"
                      disabled={actionsDisabled}
                    >
                      Apply
                    </s-button>
                  </Form>
                  <Form method="post" style={{ display: "inline" }}>
                    <input type="hidden" name="intent" value="unmatch" />
                    <input type="hidden" name="matchId" value={match.id} />
                    <s-button
                      variant="secondary"
                      tone="critical"
                      type="submit"
                      disabled={actionsDisabled}
                    >
                      Unmatch
                    </s-button>
                  </Form>
                </s-stack>
              </s-table-cell>
            </s-table-row>
          ))}
        </s-table-body>
      </s-table>

      {totalPages > 1 && (
        <s-stack direction="inline">
          {page > 1 && (
            <s-button href={`/app/reconcile?view=confirmed&page=${page - 1}`}>
              Previous
            </s-button>
          )}
          <s-text>
            Page {page} of {totalPages} ({totalCount} matches)
          </s-text>
          {page < totalPages && (
            <s-button href={`/app/reconcile?view=confirmed&page=${page + 1}`}>
              Next
            </s-button>
          )}
        </s-stack>
      )}
    </s-stack>
  );
}

/**
 * S17: Pushing matches view - shows in-flight matches with Retry action.
 * These are matches where TX1 succeeded but TX2 hasn't finalized yet.
 */
function PushingMatchesView({
  matches,
  currency,
  page,
  totalCount,
  pageSize,
  actionsDisabled,
}: {
  matches: MatchSummary[];
  currency: string;
  page: number;
  totalCount: number;
  pageSize: number;
  actionsDisabled: boolean;
}) {
  const totalPages = Math.ceil(totalCount / pageSize);

  if (matches.length === 0) {
    return (
      <s-empty-state heading="No in-progress matches">
        <s-text slot="subheading">
          There are no matches currently being applied. Check back later if you
          see matches stuck in progress.
        </s-text>
      </s-empty-state>
    );
  }

  return (
    <s-stack>
      <s-banner tone="warning" heading="Matches in progress">
        These matches started applying but have not completed. Stale matches
        (older than 5 minutes) can be retried using the Retry action below.
      </s-banner>

      <s-table>
        <s-table-header-row>
          <s-table-header listSlot="primary">Invoice</s-table-header>
          <s-table-header listSlot="secondary">Account</s-table-header>
          <s-table-header listSlot="labeled">Amount</s-table-header>
          <s-table-header listSlot="labeled">Actions</s-table-header>
        </s-table-header-row>
        <s-table-body>
          {matches.map((match) => (
            <s-table-row key={match.id}>
              <s-table-cell>
                {match.buyerAccountId ? (
                  <s-link href={accountHref(match.buyerAccountId)}>
                    {match.invoiceName}
                  </s-link>
                ) : (
                  <s-text>{match.invoiceName}</s-text>
                )}
              </s-table-cell>
              <s-table-cell>{match.buyerName}</s-table-cell>
              <s-table-cell>
                {formatPaiseAmount(BigInt(match.amountPaise), currency)}
              </s-table-cell>
              <s-table-cell>
                <Form method="post" style={{ display: "inline" }}>
                  <input type="hidden" name="intent" value="apply" />
                  <input type="hidden" name="matchId" value={match.id} />
                  <s-button
                    variant="primary"
                    type="submit"
                    disabled={actionsDisabled}
                  >
                    Retry
                  </s-button>
                </Form>
              </s-table-cell>
            </s-table-row>
          ))}
        </s-table-body>
      </s-table>

      {totalPages > 1 && (
        <s-stack direction="inline">
          {page > 1 && (
            <s-button href={`/app/reconcile?view=pushing&page=${page - 1}`}>
              Previous
            </s-button>
          )}
          <s-text>
            Page {page} of {totalPages} ({totalCount} matches)
          </s-text>
          {page < totalPages && (
            <s-button href={`/app/reconcile?view=pushing&page=${page + 1}`}>
              Next
            </s-button>
          )}
        </s-stack>
      )}
    </s-stack>
  );
}

const ACTION_SUCCESS_MESSAGES: Record<string, string> = {
  confirm: "Match confirmed.",
  reject: "Match rejected.",
  apply: "Payment applied to the invoice.",
  unmatch: "Match removed.",
};

export default function ReconcilePage() {
  const loaderData = useLoaderData<typeof loader>();
  const {
    shopCurrency,
    payments,
    matches,
    selectedPayment,
    pagination,
    view,
    error,
    tabCounts,
  } = loaderData;
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const isSubmitting = navigation.state === "submitting";
  const actionsDisabled = isSubmitting;

  // #292: When currency not supported, show only the banner
  if ("notSupported" in loaderData && loaderData.notSupported) {
    return (
      <s-page heading="Payment Reconciliation">
        <s-section>
          <s-banner tone="critical" heading="Currency Not Supported">
            {CURRENCY_NOT_SUPPORTED_BANNER_COPY}
          </s-banner>
        </s-section>
      </s-page>
    );
  }

  return (
    <s-page heading="Payment Reconciliation">
      {error && (
        <s-section>
          <s-banner tone="critical" heading="Error">
            {error}
          </s-banner>
        </s-section>
      )}

      {actionData && (
        <s-section>
          {actionData.success ? (
            <s-banner tone="success">
              {actionData.message ?? (actionData.intent && ACTION_SUCCESS_MESSAGES[actionData.intent]) ?? "Action completed."}
            </s-banner>
          ) : (
            <s-banner tone="critical">
              {actionData.error ?? "Something went wrong. Please try again."}
            </s-banner>
          )}
        </s-section>
      )}

      {/* Action bar */}
      <s-section>
        <s-stack direction="inline">
          <Form method="post">
            <input type="hidden" name="intent" value="run_matcher" />
            <s-button variant="primary" type="submit" disabled={actionsDisabled}>
              {isSubmitting ? "Running…" : "Run Matcher"}
            </s-button>
          </Form>
          <s-button
            href="/app/reconcile?view=suggested"
            variant={view === "suggested" ? "primary" : "secondary"}
          >
            Suggested ({tabCounts.suggested})
          </s-button>
          <s-button
            href="/app/reconcile?view=unmatched"
            variant={view === "unmatched" ? "primary" : "secondary"}
          >
            Unmatched ({tabCounts.unmatched})
          </s-button>
          <s-button
            href="/app/reconcile?view=confirmed"
            variant={view === "confirmed" ? "primary" : "secondary"}
          >
            Confirmed ({tabCounts.confirmed})
          </s-button>
          {tabCounts.pushing > 0 && (
            <s-button
              href="/app/reconcile?view=pushing"
              variant={view === "pushing" ? "primary" : "secondary"}
            >
              In progress ({tabCounts.pushing})
            </s-button>
          )}
        </s-stack>
      </s-section>

      {/* Content based on selected view */}
      {selectedPayment ? (
        <PaymentDetailView
          payment={selectedPayment.payment}
          matches={selectedPayment.matches}
          currency={shopCurrency}
          actionsDisabled={actionsDisabled}
        />
      ) : view === "unmatched" ? (
        <s-section heading="Unmatched Payments">
          <UnmatchedPaymentsView
            payments={payments}
            currency={shopCurrency}
            page={pagination.page}
            totalCount={pagination.totalCount}
            pageSize={pagination.pageSize}
          />
        </s-section>
      ) : view === "confirmed" ? (
        <s-section heading="Confirmed Matches">
          <ConfirmedMatchesView
            matches={matches}
            currency={shopCurrency}
            page={pagination.page}
            totalCount={pagination.totalCount}
            pageSize={pagination.pageSize}
            actionsDisabled={actionsDisabled}
          />
        </s-section>
      ) : view === "pushing" ? (
        <s-section heading="In progress">
          <PushingMatchesView
            matches={matches}
            currency={shopCurrency}
            page={pagination.page}
            totalCount={pagination.totalCount}
            pageSize={pagination.pageSize}
            actionsDisabled={actionsDisabled}
          />
        </s-section>
      ) : (
        <s-section heading="Suggested Matches">
          <SuggestedMatchesView
            matches={matches}
            currency={shopCurrency}
            page={pagination.page}
            totalCount={pagination.totalCount}
            pageSize={pagination.pageSize}
            actionsDisabled={actionsDisabled}
          />
        </s-section>
      )}

      <s-section slot="aside" heading="About Reconciliation">
        <s-paragraph>
          This page helps you match bank payments to customer invoices.
        </s-paragraph>
        <s-unordered-list>
          <s-list-item>
            <s-text type="strong">Run Matcher:</s-text> Automatically find
            potential matches for unmatched payments
          </s-list-item>
          <s-list-item>
            <s-text type="strong">Confirm:</s-text> Mark a suggested match as
            correct
          </s-list-item>
          <s-list-item>
            <s-text type="strong">Reject:</s-text> Mark a suggested match as
            incorrect
          </s-list-item>
        </s-unordered-list>
        <s-paragraph>
          Use Apply on confirmed matches to reduce invoice outstanding and mark
          orders as paid in Shopify.
        </s-paragraph>
      </s-section>

      <s-section slot="aside" heading="Match Scoring">
        <s-paragraph>Match confidence is scored 0-100:</s-paragraph>
        <s-unordered-list>
          <s-list-item>
            <s-text type="strong">Invoice/Order ref:</s-text> +30 points
          </s-list-item>
          <s-list-item>
            <s-text type="strong">Exact amount:</s-text> +20 points
          </s-list-item>
          <s-list-item>
            <s-text type="strong">Partial/overpayment:</s-text> +10 points
          </s-list-item>
          <s-list-item>
            <s-text type="strong">Confirmed alias:</s-text> +30 points
          </s-list-item>
          <s-list-item>
            <s-text type="strong">Payer name:</s-text> +8 points
          </s-list-item>
          <s-list-item>
            <s-text type="strong">Email match:</s-text> +6 points
          </s-list-item>
        </s-unordered-list>
        <s-paragraph>
          Scores of 80+ are high confidence. Lower scores need more careful
          review.
        </s-paragraph>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};

export { RouteErrorBoundary as ErrorBoundary } from "~/components/RouteErrorBoundary";
