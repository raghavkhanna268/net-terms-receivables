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
import { useLoaderData, useNavigation, Form } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { getRequestSql } from "~/lib/request-context.server";
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
import { applyMatch, unmatchMatch } from "~/services/apply.server";
import { formatPaiseAmount } from "~/lib/aging";
import { resolvePlan } from "~/services/plan.server";
import { isGatingEnforced } from "~/services/gating.server";
import type { PlanKey } from "~/lib/entitlements";
import { UpgradePrompt } from "~/components/UpgradePrompt";
import { safeLog, toErrorCode } from "~/lib/log.server";

const PAGE_SIZE = 20;

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
}

export const loader = async ({ request, context }: LoaderFunctionArgs) => {
  const { shopify } = context;
  const { session } = await shopify.authenticate.admin(request);
  const sql = getRequestSql();
  const shopDomain = session.shop;

  const url = new URL(request.url);
  const page = Math.max(1, parseInt(url.searchParams.get("page") ?? "1", 10));
  const view = url.searchParams.get("view") ?? "suggested";
  const selectedPaymentId = url.searchParams.get("payment") ?? null;

  // Get shop ID
  const [shop] = await sql<{ id: string; currency: string }[]>`
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
      planKey: "free" as PlanKey,
      gatingEnforced: false,
      storeHandle: shopDomain.replace(".myshopify.com", ""),
      appHandle: process.env.APP_HANDLE ?? "net-terms-receivables",
    };
  }

  const gatingEnforced = isGatingEnforced();
  const storeHandle = shopDomain.replace(".myshopify.com", "");

  let payments: PaymentSummary[] = [];
  let matches: MatchSummary[] = [];
  let selectedPayment: {
    payment: PaymentSummary & { valueDate: string; importFileName: string };
    matches: MatchSummary[];
  } | null = null;
  let totalCount = 0;

  // P3: Get real tab counts from COUNT queries (not page length)
  // Run resolvePlan in parallel with tab counts to avoid extra round trip on cache miss
  let tabCounts = { suggested: 0, unmatched: 0, confirmed: 0, pushing: 0 };
  let planData = { plan: { key: "free" as PlanKey } };
  try {
    const [planResult, suggestedCount, unmatchedCount, confirmedCount, pushingCount] = await Promise.all([
      resolvePlan(sql, shopDomain),
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
    planData = planResult;
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
      shopCurrency: shop.currency,
      payments: [],
      matches: [],
      selectedPayment: null,
      pagination: { page, pageSize: PAGE_SIZE, totalCount: 0 },
      view,
      error: "Failed to load reconciliation data",
      tabCounts,
      planKey: planData.plan.key,
      gatingEnforced,
      storeHandle,
      appHandle: process.env.APP_HANDLE ?? "net-terms-receivables",
    };
  }

  return {
    shopCurrency: shop.currency,
    payments,
    matches,
    selectedPayment,
    pagination: { page, pageSize: PAGE_SIZE, totalCount },
    view,
    error: null,
    tabCounts,
    planKey: planData.plan.key,
    gatingEnforced,
    storeHandle,
    appHandle: process.env.APP_HANDLE ?? "net-terms-receivables",
  };
};

export const action = async ({ request, context }: ActionFunctionArgs) => {
  const { shopify } = context;
  const { session } = await shopify.authenticate.admin(request);
  const sql = getRequestSql();
  const shopDomain = session.shop;

  const formData = await request.formData();
  const intent = formData.get("intent") as string;

  // Get shop ID
  const [shop] = await sql<{ id: string }[]>`
    SELECT id FROM "Shop" WHERE domain = ${shopDomain}
  `;

  if (!shop) {
    return { success: false, error: "Shop not found" };
  }

  const userId = session.onlineAccessInfo?.associatedUser?.id?.toString() ?? "system";

  try {
    switch (intent) {
      case "run_matcher": {
        // Use MAX_PAYMENTS_PER_REQUEST to respect Workers Free 10ms CPU budget
        const result = await runMatcher(sql, shop.id, { limit: MAX_PAYMENTS_PER_REQUEST });
        return {
          success: true,
          message: `Processed ${result.paymentsProcessed} payments, created ${result.matchesCreated} matches (${result.highConfidenceMatches} high confidence)${result.hasMore ? " (more pending)" : ""}`,
        };
      }

      case "confirm": {
        const matchId = formData.get("matchId") as string;
        if (!matchId) {
          return { success: false, error: "Match ID required" };
        }
        const result = await confirmMatch(sql, shop.id, matchId, userId);
        // P2.6: Return generic error messages, details logged server-side
        return {
          success: result.success,
          error: result.success ? null : "Failed to confirm match",
        };
      }

      case "reject": {
        const matchId = formData.get("matchId") as string;
        if (!matchId) {
          return { success: false, error: "Match ID required" };
        }
        const result = await rejectMatch(sql, shop.id, matchId, userId);
        // P2.6: Return generic error messages, details logged server-side
        return {
          success: result.success,
          error: result.success ? null : "Failed to reject match",
        };
      }

      // S17: Apply confirmed match to reduce invoice outstanding
      // IDOR protection: pass shop.id from authenticated session
      case "apply": {
        const matchId = formData.get("matchId") as string;
        if (!matchId) {
          return { success: false, error: "Match ID required" };
        }
        const result = await applyMatch(sql, shop.id, matchId, userId);
        return {
          success: result.success,
          error: result.success ? null : (result.error ?? "Failed to apply match"),
        };
      }

      // S17: Unmatch a confirmed or pushed match
      // IDOR protection: pass shop.id from authenticated session
      case "unmatch": {
        const matchId = formData.get("matchId") as string;
        if (!matchId) {
          return { success: false, error: "Match ID required" };
        }
        const result = await unmatchMatch(sql, shop.id, matchId, userId);
        return {
          success: result.success,
          error: result.success ? null : (result.error ?? "Failed to unmatch"),
        };
      }

      default:
        safeLog("warn", "reconcile_unknown_action", {
          shopId: shop.id,
          action: toSafeIntent(intent),
        });
        return { success: false, error: "Unknown action" };
    }
  } catch (err) {
    safeLog("error", "reconcile_action_error", {
      shopId: shop.id,
      action: toSafeIntent(intent),
      err: toErrorCode(err),
    });
    return {
      success: false,
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
          {reason.type}: +{reason.points} {reason.detail ? `(${reason.detail})` : ""}
        </s-text>
      ))}
    </s-stack>
  );
}

function PaymentDetailView({
  payment,
  matches,
  currency,
}: {
  payment: { id: string; amountPaise: string; narration: string; payerText: string | null; utr: string | null; rail: string | null; valueDate: string; importFileName: string };
  matches: MatchSummary[];
  currency: string;
}) {
  const navigation = useNavigation();
  const isSubmitting = navigation.state === "submitting";

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
              timeZone: "Asia/Kolkata",
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
              matcher again or manually reconcile.
            </s-text>
          </s-empty-state>
        ) : (
          <s-table>
            <s-table-header-row>
              <s-table-header>Invoice</s-table-header>
              <s-table-header>Buyer</s-table-header>
              <s-table-header format="currency">Amount</s-table-header>
              <s-table-header>Score</s-table-header>
              <s-table-header>Reasons</s-table-header>
              <s-table-header>Actions</s-table-header>
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
                            disabled={isSubmitting}
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
                            disabled={isSubmitting}
                          >
                            Reject
                          </s-button>
                        </Form>
                      </s-stack>
                    ) : (
                      <s-badge
                        tone={match.state === "confirmed" ? "success" : "critical"}
                      >
                        {match.state}
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
          <s-table-header format="currency">Amount</s-table-header>
          <s-table-header>Rail</s-table-header>
          <s-table-header>UTR</s-table-header>
          <s-table-header>Payer</s-table-header>
          <s-table-header>Narration</s-table-header>
          <s-table-header>Actions</s-table-header>
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
}: {
  matches: MatchSummary[];
  currency: string;
  page: number;
  totalCount: number;
  pageSize: number;
}) {
  const navigation = useNavigation();
  const isSubmitting = navigation.state === "submitting";
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
          <s-table-header>Invoice</s-table-header>
          <s-table-header>Buyer</s-table-header>
          <s-table-header format="currency">Amount</s-table-header>
          <s-table-header>Score</s-table-header>
          <s-table-header>Actions</s-table-header>
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
                      disabled={isSubmitting}
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
                      disabled={isSubmitting}
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
}: {
  matches: MatchSummary[];
  currency: string;
  page: number;
  totalCount: number;
  pageSize: number;
}) {
  const navigation = useNavigation();
  const isSubmitting = navigation.state === "submitting";
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
          <s-table-header>Invoice</s-table-header>
          <s-table-header>Buyer</s-table-header>
          <s-table-header format="currency">Amount</s-table-header>
          <s-table-header>Actions</s-table-header>
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
                      disabled={isSubmitting}
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
                      disabled={isSubmitting}
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
}: {
  matches: MatchSummary[];
  currency: string;
  page: number;
  totalCount: number;
  pageSize: number;
}) {
  const navigation = useNavigation();
  const isSubmitting = navigation.state === "submitting";
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
          <s-table-header>Invoice</s-table-header>
          <s-table-header>Account</s-table-header>
          <s-table-header>Amount</s-table-header>
          <s-table-header>Actions</s-table-header>
        </s-table-header-row>
        <s-table-body>
          {matches.map((match) => (
            <s-table-row key={match.id}>
              <s-table-cell>
                <s-link href={`/app/invoices/${match.invoiceId}`}>
                  {match.invoiceName}
                </s-link>
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
                    disabled={isSubmitting}
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

export default function ReconcilePage() {
  const {
    shopCurrency,
    payments,
    matches,
    selectedPayment,
    pagination,
    view,
    error,
    tabCounts,
    planKey,
    gatingEnforced,
    storeHandle,
    appHandle,
  } = useLoaderData<typeof loader>();
  const navigation = useNavigation();
  const isSubmitting = navigation.state === "submitting";

  const upgradeUrl = `https://admin.shopify.com/store/${storeHandle}/charges/${appHandle}/pricing_plans`;

  return (
    <s-page heading="Payment Reconciliation">
      {error && (
        <s-section>
          <s-banner tone="critical" heading="Error">
            {error}
          </s-banner>
        </s-section>
      )}

      {/* S21: Upgrade prompt for matching feature (requires Starter+) */}
      {planKey === "free" && (
        <s-section>
          <UpgradePrompt
            currentPlan={planKey}
            feature="matching"
            gatingEnforced={gatingEnforced}
            upgradeUrl={upgradeUrl}
          />
        </s-section>
      )}

      {/* Action bar */}
      <s-section>
        <s-stack direction="inline">
          <Form method="post">
            <input type="hidden" name="intent" value="run_matcher" />
            <s-button variant="primary" type="submit" disabled={isSubmitting}>
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
            <s-text type="strong">Payer name:</s-text> +10 points
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
