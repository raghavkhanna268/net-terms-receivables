import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData, data, Await, useRevalidator } from "react-router";
import { Suspense } from "react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { getRequestSql } from "~/lib/request-context.server";
import { resolvePlan, type ResolvedPlan } from "~/services/plan.server";
import { getUsageStats, isGatingEnforced } from "~/services/gating.server";
import { resolvePlanKey, type PlanKey } from "~/lib/entitlements";
import { PlanBanner, PLAN_DISPLAY_NAMES } from "~/components/UpgradePrompt";
import {
  getShopAgingTotals,
  getBuyerLedger,
  getBuyerInvoices,
} from "~/lib/aging-queries.server";
import {
  formatPaiseAmount,
  buildOrderAdminUrl,
  AGING_BUCKET_KEYS,
  type SerializableAgingTotals,
  type AgingBucketKey,
  type BuyerLedgerRow,
  type BuyerInvoiceRow,
} from "~/lib/aging";
import type { Sql } from "~/lib/db-light.server";
import { safeLog, toErrorCode } from "~/lib/log.server";
import { buildOverLimitBannerState, buildNewAccountsPausedBannerState } from "~/lib/over-limit-banner";
import { NO_CURRENCY_SENTINEL } from "~/lib/shop-currency.server";
import { CURRENCY_NOT_SUPPORTED_BANNER_COPY, CURRENCY_FLIP_BLOCKED_BANNER_TEXT, SUPPORT_EMAIL_MAILTO } from "~/lib/shop-currency-copy";
import { isCurrencyGateOpen, getEffectiveCurrency } from "~/lib/currency-gate.server";
import { ServerTiming, mergeServerTimingHeaders, readColdOnce } from "~/lib/server-timing.server";
import { getAppHandle, buildPlanSelectionUrl } from "~/lib/plan-url";
import { recordAccess, getActorFromSessionToken } from "~/services/access-log.server";
import { checkAndRecoverCurrency } from "~/services/shop-currency-recovery.server";

const PAGE_SIZE = 20;

/**
 * Get the count of over-limit (gated) accounts with open outstanding invoices.
 * Counts the same set that getOverLimitBuyerLedger lists.
 * Exported for testing.
 */
export async function getOverLimitCount(
  sql: Sql,
  shopId: string
): Promise<number> {
  const [result] = await sql<{ count: string }[]>`
    SELECT COUNT(DISTINCT i."buyerAccountId")::text AS count
    FROM "Invoice" i
    JOIN "BuyerAccount" ba ON ba.id = i."buyerAccountId"
    WHERE i."shopId" = ${shopId}
      AND i.status = 'open'
      AND i.outstanding > 0
      AND ba.gated_at IS NOT NULL
  `;
  return parseInt(result?.count ?? "0", 10);
}

/**
 * Get buyer ledger filtered to only over-limit (gated) accounts.
 * Mirrors getBuyerLedger SQL but adds AND ba.gated_at IS NOT NULL.
 * Exported for testing.
 */
export async function getOverLimitBuyerLedger(
  sql: Sql,
  shopId: string,
  asOf: Date,
  options: {
    limit: number;
    offset: number;
    sortBy: "outstanding" | "overdue" | "name";
    sortOrder: "asc" | "desc";
  }
): Promise<{ rows: BuyerLedgerRow[]; totalCount: number }> {
  const { limit, offset, sortBy, sortOrder } = options;

  const baseFilteredQuery = (orderClause: ReturnType<typeof sql>) => sql<BuyerLedgerRow[]>`
    WITH buyer_invoices AS (
      SELECT
        i."buyerAccountId",
        s.currency,
        (ROUND(i.outstanding * 100))::bigint AS outstanding_paise,
        CASE
          WHEN i."dueAt" IS NULL THEN 0
          ELSE EXTRACT(DAY FROM (
            DATE_TRUNC('day', ${asOf}::timestamptz AT TIME ZONE s.timezone) -
            DATE_TRUNC('day', i."dueAt" AT TIME ZONE s.timezone)
          ))::int
        END AS days_past_due
      FROM "Invoice" i
      JOIN "Shop" s ON s.id = i."shopId"
      JOIN "BuyerAccount" ba ON ba.id = i."buyerAccountId"
      WHERE i."shopId" = ${shopId}
        AND i.status = 'open'
        AND i.outstanding > 0
        AND ba.gated_at IS NOT NULL
    ),
    buyer_totals AS (
      SELECT
        "buyerAccountId",
        currency,
        SUM(outstanding_paise) AS outstanding_paise,
        COALESCE(SUM(outstanding_paise) FILTER (WHERE days_past_due > 0), 0) AS overdue_paise,
        MAX(days_past_due) FILTER (WHERE days_past_due > 0) AS oldest_overdue_days
      FROM buyer_invoices
      GROUP BY "buyerAccountId", currency
    )
    SELECT
      ba.id AS buyer_account_id,
      ba.name AS buyer_name,
      CASE WHEN ba."creditLimit" IS NULL THEN NULL ELSE (ROUND(ba."creditLimit" * 100))::text END AS credit_limit_paise,
      ba."holdState" AS hold_state,
      bt.currency,
      bt.outstanding_paise::text AS outstanding_paise,
      bt.overdue_paise::text AS overdue_paise,
      bt.oldest_overdue_days,
      ba.gated_at IS NOT NULL AS is_gated
    FROM buyer_totals bt
    JOIN "BuyerAccount" ba ON ba.id = bt."buyerAccountId"
    ${orderClause}
    LIMIT ${limit}
    OFFSET ${offset}
  `;

  let rows: BuyerLedgerRow[];
  if (sortBy === "name") {
    rows = sortOrder === "asc"
      ? await baseFilteredQuery(sql`ORDER BY ba.name ASC, bt.outstanding_paise DESC`)
      : await baseFilteredQuery(sql`ORDER BY ba.name DESC, bt.outstanding_paise DESC`);
  } else if (sortBy === "overdue") {
    rows = sortOrder === "asc"
      ? await baseFilteredQuery(sql`ORDER BY bt.overdue_paise ASC, ba.name ASC`)
      : await baseFilteredQuery(sql`ORDER BY bt.overdue_paise DESC, ba.name ASC`);
  } else {
    rows = sortOrder === "asc"
      ? await baseFilteredQuery(sql`ORDER BY bt.outstanding_paise ASC, ba.name ASC`)
      : await baseFilteredQuery(sql`ORDER BY bt.outstanding_paise DESC, ba.name ASC`);
  }

  const [countResult] = await sql<{ count: string }[]>`
    SELECT COUNT(DISTINCT i."buyerAccountId")::text AS count
    FROM "Invoice" i
    JOIN "BuyerAccount" ba ON ba.id = i."buyerAccountId"
    WHERE i."shopId" = ${shopId}
      AND i.status = 'open'
      AND i.outstanding > 0
      AND ba.gated_at IS NOT NULL
  `;

  return {
    rows,
    totalCount: parseInt(countResult?.count ?? "0", 10),
  };
}

const VALID_SORT_BY = ["outstanding", "overdue", "name"] as const;
type SortBy = (typeof VALID_SORT_BY)[number];

const VALID_SORT_ORDER = ["asc", "desc"] as const;
type SortOrder = (typeof VALID_SORT_ORDER)[number];

function parsePositiveInt(value: string | null, defaultValue: number): number {
  if (value === null) return defaultValue;
  const parsed = parseInt(value, 10);
  if (Number.isNaN(parsed) || parsed < 1) return defaultValue;
  return parsed;
}

function parseSortBy(value: string | null): SortBy {
  if (value && VALID_SORT_BY.includes(value as SortBy)) {
    return value as SortBy;
  }
  return "outstanding";
}

function parseSortOrder(value: string | null): SortOrder {
  if (value && VALID_SORT_ORDER.includes(value as SortOrder)) {
    return value as SortOrder;
  }
  return "desc";
}

async function checkOnboardingRedirect(
  sql: ReturnType<typeof getRequestSql>,
  shopId: string
): Promise<boolean> {
  try {
    const [shop] = await sql<{ onboarding_dismissed_at: Date | null }[]>`
      SELECT onboarding_dismissed_at FROM "Shop" WHERE id = ${shopId}
    `;

    if (shop?.onboarding_dismissed_at !== null) {
      return false;
    }

    const buyerCountResult = await sql<{ count: string }[]>`
      SELECT COUNT(*)::text as count FROM "BuyerAccount" WHERE "shopId" = ${shopId}
    `;
    const buyerCount = parseInt(buyerCountResult[0]?.count ?? "0", 10);
    if (buyerCount > 0) return false;

    const tagRuleCountResult = await sql<{ count: string }[]>`
      SELECT COUNT(*)::text as count FROM "AccountSource" WHERE "shopId" = ${shopId}
    `;
    const tagRuleCount = parseInt(tagRuleCountResult[0]?.count ?? "0", 10);
    if (tagRuleCount > 0) return false;

    return true;
  } catch {
    return false;
  }
}

/**
 * Deferred dashboard data type for streaming.
 * This is the shape of the promise returned by loadDashboardData.
 */
export interface DeferredDashboardData {
  plan: {
    key: PlanKey;
    name: string;
    isTest: boolean;
  } | null;
  usage: {
    companies: { current: number; limit: number };
    importsThisMonth: { current: number; limit: number };
  } | null;
  agingTotals: SerializableAgingTotals | null;
  buyerLedger: { rows: BuyerLedgerRow[]; totalCount: number } | null;
  selectedBuyerInvoices: {
    rows: BuyerInvoiceRow[];
    totalCount: number;
    buyerName: string;
  } | null;
  overLimitCount: number;
  error: string | null;
  newAccountsPausedBanner: {
    show: boolean;
    heading: string;
    bodyText: string;
    upgradeUrl: string | null;
  };
  pagination: {
    page: number;
    pageSize: number;
    totalCount: number;
  };
}

/**
 * Load dashboard data (deferred).
 * This function is NOT awaited in the loader - it returns a promise that
 * React Router streams to the client for Suspense rendering.
 *
 * Timing: Deferred phases (plan_resolve, ledger_rows, ledger_count) are logged
 * after the promise settles, using the existing per-phase timing codes.
 */
async function loadDashboardData(
  sql: Sql,
  shop: { id: string; currency: string; timezone: string },
  shopDomain: string,
  sessionToken: { sub?: string } | undefined,
  session: { shop: string; accessToken?: string; onlineAccessInfo?: { associated_user?: { id?: string | number | bigint } } },
  params: {
    page: number;
    sortBy: SortBy;
    sortOrder: SortOrder;
    selectedBuyerId: string | null;
    onlyOverLimit: boolean;
  },
  timing: ServerTiming,
): Promise<DeferredDashboardData> {
  const { page, sortBy, sortOrder, selectedBuyerId, onlyOverLimit } = params;
  const gatingEnforced = isGatingEnforced();

  let planData: ResolvedPlan | null = null;
  let usage: {
    companies: { current: number; limit: number };
    importsThisMonth: { current: number; limit: number };
  } | null = null;
  let agingTotals: SerializableAgingTotals | null = null;
  let buyerLedger: { rows: BuyerLedgerRow[]; totalCount: number } | null = null;
  let selectedBuyerInvoices: {
    rows: BuyerInvoiceRow[];
    totalCount: number;
    buyerName: string;
  } | null = null;
  let error: string | null = null;
  let overLimitCount = 0;

  const asOf = new Date();

  try {
    const ledgerOptions = {
      limit: PAGE_SIZE,
      offset: (page - 1) * PAGE_SIZE,
      sortBy,
      sortOrder,
    };

    const [planResult, usageResult, agingResult, ledgerResult, countResult] = await Promise.all([
      timing.time("plan_resolve", () => resolvePlan(sql, shopDomain)),
      getUsageStats(sql, shop.id).catch((err) => {
        safeLog("warn", "usage_stats_error", { shopId: shop.id, err: toErrorCode(err) });
        return null;
      }),
      getShopAgingTotals(sql, shop.id, asOf),
      timing.time("ledger_rows", () =>
        onlyOverLimit
          ? getOverLimitBuyerLedger(sql, shop.id, asOf, ledgerOptions)
          : getBuyerLedger(sql, shop.id, asOf, ledgerOptions)
      ),
      onlyOverLimit
        ? Promise.resolve(null)
        : timing.time("ledger_count", () => getOverLimitCount(sql, shop.id)),
    ]);

    planData = planResult;
    usage = usageResult;
    agingTotals = agingResult;
    buyerLedger = ledgerResult;

    overLimitCount = onlyOverLimit ? buyerLedger.totalCount : (countResult ?? 0);

    if (selectedBuyerId) {
      const buyerInvoices = await getBuyerInvoices(
        sql,
        shop.id,
        selectedBuyerId,
        asOf,
        { limit: 50, offset: 0 }
      );

      const buyerRow = buyerLedger?.rows.find(
        (r) => r.buyer_account_id === selectedBuyerId
      );
      if (!buyerRow) {
        const [buyerAccount] = await sql<{ name: string }[]>`
          SELECT name FROM "BuyerAccount" WHERE id = ${selectedBuyerId} AND "shopId" = ${shop.id}
        `;
        selectedBuyerInvoices = {
          ...buyerInvoices,
          buyerName: buyerAccount?.name ?? "Unknown Buyer",
        };
      } else {
        selectedBuyerInvoices = {
          ...buyerInvoices,
          buyerName: buyerRow.buyer_name,
        };
      }
    }
  } catch (err) {
    safeLog("error", "app._index.load_aging_data_failed", { err: toErrorCode(err) });
    error = "Failed to load aging data. Please try again.";
  }

  timing.logPhases(["plan_resolve", "ledger_rows", "ledger_count"]);

  if (!error) {
    const accessParams: Parameters<typeof recordAccess>[1] = {
      shopId: shop.id,
      actor: getActorFromSessionToken(sessionToken, session),
      action: "dashboard",
      recordType: "BuyerAccount",
      count: buyerLedger?.totalCount ?? 0,
    };
    if (selectedBuyerId) {
      accessParams.recordId = selectedBuyerId;
    }
    recordAccess(sql, accessParams);
  }

  return {
    plan: planData
      ? {
          key: resolvePlanKey(planData.plan.key),
          name: PLAN_DISPLAY_NAMES[resolvePlanKey(planData.plan.key) as PlanKey],
          isTest: planData.isTest,
        }
      : null,
    usage,
    agingTotals,
    buyerLedger,
    selectedBuyerInvoices,
    overLimitCount,
    error,
    newAccountsPausedBanner: (gatingEnforced && usage)
      ? buildNewAccountsPausedBannerState(
          usage.companies.current,
          usage.companies.limit,
          gatingEnforced,
          (() => {
            const handle = getAppHandle();
            if (handle === null) return null;
            return buildPlanSelectionUrl(shopDomain, handle);
          })()
        )
      : { show: false, heading: "", bodyText: "", upgradeUrl: null },
    pagination: {
      page,
      pageSize: PAGE_SIZE,
      totalCount: buyerLedger?.totalCount ?? 0,
    },
  };
}

export const loader = async ({ request, context }: LoaderFunctionArgs) => {
  const cold = readColdOnce(context);
  const timing = new ServerTiming(cold);
  timing.startPhase("loader_total");

  const { shopify } = context;

  timing.startPhase("auth_index");
  const { session, sessionToken, redirect: shopifyRedirect, admin } = await shopify.authenticate.admin(request);
  timing.endPhase("auth_index");

  const sql = getRequestSql();
  const shopDomain = session.shop;

  const url = new URL(request.url);
  const page = parsePositiveInt(url.searchParams.get("page"), 1);
  const sortBy = parseSortBy(url.searchParams.get("sortBy"));
  const sortOrder = parseSortOrder(url.searchParams.get("sortOrder"));
  const selectedBuyerId = url.searchParams.get("buyer") ?? null;
  const skipOnboarding = url.searchParams.get("skipOnboarding") === "true";
  const onlyOverLimit = url.searchParams.get("overlimit") === "true";

  timing.startPhase("shop_lookup");
  const [shop] = await sql<{ id: string; currency: string; timezone: string }[]>`
    SELECT id, currency, timezone FROM "Shop" WHERE domain = ${shopDomain}
  `;
  timing.endPhase("shop_lookup");

  const currencyResult = shop
    ? await checkAndRecoverCurrency(sql, shopDomain, shop.currency, admin, shop.id)
    : null;
  const shopCurrency = currencyResult?.currency ?? NO_CURRENCY_SENTINEL;
  const currencyFlipBlocked = currencyResult?.flipBlocked ?? false;

  const currencySupported = isCurrencyGateOpen(shopCurrency);
  if (!currencySupported) {
    timing.endPhase("loader_total");
    timing.logAllPhases();
    const serverTiming = timing.toHeaderValue();
    const headers: HeadersInit = {};
    if (serverTiming) {
      headers["Server-Timing"] = serverTiming;
    }
    const notSupportedStoreHandle = shopDomain.replace(".myshopify.com", "");
    return data({
      notSupported: true,
      shopName: notSupportedStoreHandle,
      shopDomain,
      storeHandle: notSupportedStoreHandle,
      shopCurrency: getEffectiveCurrency(shopCurrency),
      currencySupported: false as const,
      currencyFlipBlocked,
      gatingEnforced: false,
      upgradeUrl: null,
      sortBy: "outstanding" as SortBy,
      sortOrder: "desc" as SortOrder,
      onlyOverLimit: false,
      selectedBuyerId: null,
      agingTotals: null,
      buyerLedger: null,
      selectedBuyerInvoices: null,
      dashboardData: null,
    }, { headers });
  }

  if (shop && !skipOnboarding) {
    timing.startPhase("onboarding_checks");
    const shouldRedirect = await checkOnboardingRedirect(sql, shop.id);
    timing.endPhase("onboarding_checks");
    if (shouldRedirect) {
      throw shopifyRedirect("/app/onboarding");
    }
  }

  const storeHandle = shopDomain.replace(".myshopify.com", "");
  const gatingEnforced = isGatingEnforced();
  const upgradeUrl = (() => {
    const handle = getAppHandle();
    if (handle === null) {
      safeLog("warn", "plan_url_app_handle_missing", {});
      return null;
    }
    return buildPlanSelectionUrl(shopDomain, handle);
  })();

  timing.endPhase("loader_total");
  timing.logAllPhases();

  const serverTiming = timing.toHeaderValue();
  const headers: HeadersInit = {};
  if (serverTiming) {
    headers["Server-Timing"] = serverTiming;
  }

  const dashboardData = loadDashboardData(
    sql,
    shop,
    shopDomain,
    sessionToken,
    session,
    { page, sortBy, sortOrder, selectedBuyerId, onlyOverLimit },
    timing,
  );

  return data({
    shopName: storeHandle,
    shopDomain,
    storeHandle,
    shopCurrency,
    currencySupported: true as const,
    currencyFlipBlocked,
    gatingEnforced,
    upgradeUrl,
    sortBy,
    sortOrder,
    onlyOverLimit,
    selectedBuyerId,
    dashboardData,
  }, { headers });
};

const BUCKET_LABELS: Record<AgingBucketKey, string> = {
  current: "Current",
  "1-30": "1-30 days",
  "31-60": "31-60 days",
  "61-90": "61-90 days",
  "90+": "90+ days",
};

function AgingBucketSummary({
  totals,
  currency,
}: {
  totals: SerializableAgingTotals;
  currency: string;
}) {
  const bucketData = AGING_BUCKET_KEYS.map((key) => {
    const amount = totals.buckets[key].byCurrency[currency];
    return {
      key,
      label: BUCKET_LABELS[key],
      amount: amount ? BigInt(amount) : 0n,
    };
  });

  const totalOutstanding = totals.totalByCurrency[currency]
    ? BigInt(totals.totalByCurrency[currency])
    : 0n;
  const totalOverdue = totals.overdueByCurrency[currency]
    ? BigInt(totals.overdueByCurrency[currency])
    : 0n;

  return (
    <s-stack>
      <s-paragraph>
        <s-text type="strong">Total Outstanding: </s-text>
        <s-text>{formatPaiseAmount(totalOutstanding, currency)}</s-text>
      </s-paragraph>
      {totalOverdue > 0n && (
        <s-paragraph>
          <s-text type="strong">Total Overdue: </s-text>
          <s-text tone="critical">{formatPaiseAmount(totalOverdue, currency)}</s-text>
          {totals.oldestOverdueDays && (
            <s-text> (oldest: {totals.oldestOverdueDays} days)</s-text>
          )}
        </s-paragraph>
      )}
      <s-paragraph>
        <s-text type="strong">Aging Breakdown:</s-text>
      </s-paragraph>
      <s-table>
        <s-table-header-row>
          <s-table-header listSlot="primary">Bucket</s-table-header>
          <s-table-header listSlot="labeled" format="currency">Amount</s-table-header>
        </s-table-header-row>
        <s-table-body>
          {bucketData.map((bucket) => (
            <s-table-row key={bucket.key}>
              <s-table-cell>{bucket.label}</s-table-cell>
              <s-table-cell>
                {bucket.key !== "current" && bucket.amount > 0n ? (
                  <s-text tone="critical">
                    {formatPaiseAmount(bucket.amount, currency)}
                  </s-text>
                ) : (
                  formatPaiseAmount(bucket.amount, currency)
                )}
              </s-table-cell>
            </s-table-row>
          ))}
        </s-table-body>
      </s-table>
    </s-stack>
  );
}

/**
 * BuyerLedgerTable: Renders the buyer accounts table.
 * Exported for render testing.
 */
export function BuyerLedgerTable({
  rows,
  sortBy,
  sortOrder,
  page,
  totalCount,
  pageSize,
  onlyOverLimit,
  onNextPage,
  onPreviousPage,
  gatingEnforced,
}: {
  rows: BuyerLedgerRow[];
  sortBy: string;
  sortOrder: string;
  page: number;
  totalCount: number;
  pageSize: number;
  onlyOverLimit: boolean;
  onNextPage: string;
  onPreviousPage: string;
  gatingEnforced: boolean;
}) {
  const totalPages = Math.ceil(totalCount / pageSize);
  const fp = onlyOverLimit ? "&overlimit=true" : "";
  const buildSortUrl = (col: string) => `?sortBy=${col}&sortOrder=${sortBy === col && sortOrder === "desc" ? "asc" : "desc"}${fp}`;

  const getSortIndicator = (column: string) => {
    if (sortBy !== column) return "";
    return sortOrder === "desc" ? " ↓" : " ↑";
  };

  if (rows.length === 0) {
    return (
      <s-empty-state heading="No outstanding invoices">
        <s-text slot="subheading">
          All your buyers have paid their invoices. Great job!
        </s-text>
      </s-empty-state>
    );
  }

  return (
    <s-stack>
      <s-table>
        <s-table-header-row>
          <s-table-header listSlot="primary">
            <s-link href={buildSortUrl("name")}>Buyer{getSortIndicator("name")}</s-link>
          </s-table-header>
          <s-table-header listSlot="labeled" format="currency">Credit Limit</s-table-header>
          <s-table-header listSlot="labeled" format="currency">
            <s-link href={buildSortUrl("outstanding")}>
              Outstanding{getSortIndicator("outstanding")}
            </s-link>
          </s-table-header>
          <s-table-header listSlot="labeled" format="currency">
            <s-link href={buildSortUrl("overdue")}>
              Overdue{getSortIndicator("overdue")}
            </s-link>
          </s-table-header>
          <s-table-header listSlot="labeled">Oldest Overdue</s-table-header>
          <s-table-header listSlot="inline">Hold Status</s-table-header>
        </s-table-header-row>
        <s-table-body>
          {rows.map((row) => {
            const outstanding = BigInt(row.outstanding_paise);
            const overdue = BigInt(row.overdue_paise);
            const creditLimit = row.credit_limit_paise
              ? BigInt(row.credit_limit_paise)
              : null;

            return (
              <s-table-row key={`${row.buyer_account_id}-${row.currency}`}>
                <s-table-cell>
                  <s-link href={`?buyer=${row.buyer_account_id}&sortBy=${sortBy}&sortOrder=${sortOrder}&page=${page}${fp}`}>
                    {row.buyer_name}
                  </s-link>
                  {gatingEnforced && row.is_gated && <s-badge tone="warning">over plan limit</s-badge>}
                </s-table-cell>
                <s-table-cell>
                  {creditLimit !== null
                    ? formatPaiseAmount(creditLimit, row.currency)
                    : "No limit"}
                </s-table-cell>
                <s-table-cell>
                  {formatPaiseAmount(outstanding, row.currency)}
                </s-table-cell>
                <s-table-cell>
                  {overdue > 0n ? (
                    <s-text tone="critical">
                      {formatPaiseAmount(overdue, row.currency)}
                    </s-text>
                  ) : (
                    formatPaiseAmount(0n, row.currency)
                  )}
                </s-table-cell>
                <s-table-cell>
                  {row.oldest_overdue_days !== null
                    ? `${row.oldest_overdue_days} days`
                    : "—"}
                </s-table-cell>
                <s-table-cell>
                  {row.hold_state === "HELD" ? (
                    <s-badge tone="critical">Held</s-badge>
                  ) : row.hold_state === "NEAR_LIMIT" ? (
                    <s-badge tone="warning">Near Limit</s-badge>
                  ) : row.hold_state === "BYPASS" ? (
                    <s-badge tone="info">Bypass</s-badge>
                  ) : (
                    <s-badge>OK</s-badge>
                  )}
                </s-table-cell>
              </s-table-row>
            );
          })}
        </s-table-body>
      </s-table>

      {totalPages > 1 && (
        <s-stack direction="inline">
          {page > 1 && <s-button href={onPreviousPage}>Previous</s-button>}
          <s-text>Page {page} of {totalPages} ({totalCount} buyers)</s-text>
          {page < totalPages && <s-button href={onNextPage}>Next</s-button>}
        </s-stack>
      )}
    </s-stack>
  );
}

function BuyerInvoiceList({
  invoices,
  buyerName,
  onClose,
}: {
  invoices: BuyerInvoiceRow[];
  buyerName: string;
  onClose: string;
}) {
  if (invoices.length === 0) {
    return (
      <s-section heading={`Invoices for ${buyerName}`}>
        <s-empty-state heading="No open invoices">
          <s-text slot="subheading">
            This buyer has no outstanding invoices.
          </s-text>
        </s-empty-state>
        <s-button href={onClose}>Back to Ledger</s-button>
      </s-section>
    );
  }

  return (
    <s-section heading={`Open Invoices for ${buyerName}`}>
      <s-stack>
        <s-table>
          <s-table-header-row>
            <s-table-header listSlot="primary">Invoice</s-table-header>
            <s-table-header listSlot="labeled">Due Date</s-table-header>
            <s-table-header listSlot="labeled" format="currency">Outstanding</s-table-header>
            <s-table-header listSlot="inline">Days Past Due</s-table-header>
            <s-table-header listSlot="labeled">Order</s-table-header>
          </s-table-header-row>
          <s-table-body>
            {invoices.map((inv) => {
              const outstanding = BigInt(inv.outstanding_paise);
              const orderUrl = buildOrderAdminUrl(inv.order_id);

              return (
                <s-table-row key={inv.id}>
                  <s-table-cell>{inv.name}</s-table-cell>
                  <s-table-cell>
                    {inv.due_at
                      ? new Date(inv.due_at).toLocaleDateString("en-IN", {
                          timeZone: "Asia/Kolkata",
                        })
                      : "—"}
                  </s-table-cell>
                  <s-table-cell>
                    {formatPaiseAmount(outstanding, inv.currency)}
                  </s-table-cell>
                  <s-table-cell>
                    {inv.days_past_due > 0 ? (
                      <s-text tone="critical">{inv.days_past_due} days</s-text>
                    ) : inv.days_past_due === 0 ? (
                      "Due today"
                    ) : (
                      `${Math.abs(inv.days_past_due)} days left`
                    )}
                  </s-table-cell>
                  <s-table-cell>
                    {orderUrl ? (
                      <s-link href={orderUrl}>View Order</s-link>
                    ) : (
                      "—"
                    )}
                  </s-table-cell>
                </s-table-row>
              );
            })}
          </s-table-body>
        </s-table>
        <s-button href={onClose}>Back to Ledger</s-button>
      </s-stack>
    </s-section>
  );
}

/**
 * Polaris skeleton component for the dashboard while data loads.
 * Matches the layout footprint of DashboardContent to minimize CLS.
 * Uses s-spinner with placeholder text in each section.
 * Exported for testing.
 */
export function DashboardSkeleton() {
  return (
    <>
      {/* Plan section skeleton - matches PlanBanner height */}
      <s-section heading="Your Plan">
        <s-box padding="base">
          <s-stack gap="base">
            <s-stack direction="inline" gap="base">
              <s-spinner size="base" />
              <s-text>Loading plan information...</s-text>
            </s-stack>
          </s-stack>
        </s-box>
      </s-section>

      {/* Receivables Summary skeleton - matches AgingBucketSummary height */}
      <s-section heading="Receivables Summary">
        <s-box padding="base">
          <s-stack gap="base">
            <s-stack direction="inline" gap="base">
              <s-spinner size="base" />
              <s-text>Loading receivables data...</s-text>
            </s-stack>
          </s-stack>
        </s-box>
      </s-section>

      {/* Buyer Ledger skeleton - matches BuyerLedgerTable height */}
      <s-section heading="Buyer Ledger">
        <s-box padding="base">
          <s-stack gap="base">
            <s-stack direction="inline" gap="base">
              <s-spinner size="base" />
              <s-text>Loading buyer ledger...</s-text>
            </s-stack>
          </s-stack>
        </s-box>
      </s-section>
    </>
  );
}

/**
 * Error fallback for deferred dashboard data.
 * Shows a retryable banner inside the page without triggering the route ErrorBoundary.
 * The rest of the page (header, nav, aside sections) remains usable.
 * Exported for testing.
 */
export function DashboardErrorBanner() {
  const revalidator = useRevalidator();
  const isRetrying = revalidator.state === "loading";

  const handleRetry = () => {
    revalidator.revalidate();
  };

  return (
    <>
      <s-section heading="Your Plan">
        <s-banner tone="critical" heading="Error">
          <s-stack gap="base">
            <s-text>Failed to load aging data. Please try again.</s-text>
            <s-button onClick={handleRetry} disabled={isRetrying}>
              {isRetrying ? "Retrying..." : "Retry"}
            </s-button>
          </s-stack>
        </s-banner>
      </s-section>

      {/* Empty sections maintain layout structure */}
      <s-section heading="Receivables Summary">
        <s-empty-state heading="Data unavailable">
          <s-text slot="subheading">
            Unable to load receivables data. Click retry above to reload.
          </s-text>
        </s-empty-state>
      </s-section>

      <s-section heading="Buyer Ledger">
        <s-empty-state heading="Data unavailable">
          <s-text slot="subheading">
            Unable to load buyer ledger. Click retry above to reload.
          </s-text>
        </s-empty-state>
      </s-section>
    </>
  );
}

/**
 * Dashboard content component that renders with resolved data.
 * Separated from Index to allow Suspense boundary wrapping.
 */
function DashboardContent({
  dashboardData,
  gatingEnforced,
  upgradeUrl,
  sortBy,
  sortOrder,
  onlyOverLimit,
}: {
  dashboardData: DeferredDashboardData;
  gatingEnforced: boolean;
  upgradeUrl: string | null;
  sortBy: SortBy;
  sortOrder: SortOrder;
  onlyOverLimit: boolean;
}) {
  const {
    plan,
    usage,
    agingTotals,
    buyerLedger,
    selectedBuyerInvoices,
    overLimitCount,
    error,
    newAccountsPausedBanner,
    pagination,
  } = dashboardData;

  const planKey = (plan?.key ?? "none") as PlanKey;
  const planName = plan?.name ?? PLAN_DISPLAY_NAMES.none;
  const isTest = plan?.isTest ?? false;

  const usageUnavailable = usage === null;
  const companiesUsed = usage?.companies.current ?? 0;
  const companiesLimit = usage?.companies.limit ?? -1;

  const hasInvoices =
    agingTotals && Object.keys(agingTotals.totalByCurrency).length > 0;
  const currencies = agingTotals
    ? Object.keys(agingTotals.totalByCurrency)
    : [];

  const closeInvoiceListUrl = `?sortBy=${sortBy}&sortOrder=${sortOrder}&page=${pagination.page}`;

  return (
    <>
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

      {/* S21: Plan Banner */}
      <s-section heading="Your Plan">
        <PlanBanner
          planKey={planKey}
          planName={planName}
          isTest={isTest}
          companiesUsed={companiesUsed}
          companiesLimit={companiesLimit}
          gatingEnforced={gatingEnforced}
          upgradeUrl={upgradeUrl}
          usageUnavailable={usageUnavailable}
        />
      </s-section>

      {/* Error State */}
      {error && (
        <s-section>
          <s-banner tone="critical" heading="Error">
            {error}
          </s-banner>
        </s-section>
      )}

      {/* S7: Aging Dashboard */}
      {!error && (
        <>
          {/* Shop Totals */}
          <s-section heading="Receivables Summary">
            {!hasInvoices ? (
              <s-empty-state heading="No outstanding receivables">
                <s-text slot="subheading">
                  You don&apos;t have any open invoices yet. Outstanding amounts
                  will appear here when you have unpaid orders with payment
                  terms.
                </s-text>
              </s-empty-state>
            ) : (
              <s-stack>
                {currencies.map((currency) => (
                  <div key={currency}>
                    {currencies.length > 1 && (
                      <s-paragraph>
                        <s-text type="strong">{currency}</s-text>
                      </s-paragraph>
                    )}
                    <AgingBucketSummary
                      totals={agingTotals!}
                      currency={currency}
                    />
                  </div>
                ))}
              </s-stack>
            )}
          </s-section>

          {/* Buyer Invoice Drill-down */}
          {selectedBuyerInvoices && (
            <BuyerInvoiceList
              invoices={selectedBuyerInvoices.rows}
              buyerName={selectedBuyerInvoices.buyerName}
              onClose={closeInvoiceListUrl}
            />
          )}

          {/* Buyer Ledger */}
          {!selectedBuyerInvoices && (
            <s-section heading="Buyer Ledger">
              <s-stack>
                {/* Over plan limit banner */}
                {(() => {
                  const bannerState = buildOverLimitBannerState(overLimitCount, gatingEnforced);
                  return bannerState.show && (
                    <s-banner tone="warning" heading={bannerState.heading}>
                      <s-text>
                        {bannerState.bodyText}
                        {bannerState.enforcementNote && ` ${bannerState.enforcementNote}`}
                        {" "}
                        {!onlyOverLimit && (
                          <s-link href={`?sortBy=${sortBy}&sortOrder=${sortOrder}&overlimit=true`}>
                            Show only over-limit accounts
                          </s-link>
                        )}
                      </s-text>
                    </s-banner>
                  );
                })()}
                {/* Filter UI */}
                <s-paragraph>
                  <s-text type="strong">Show: </s-text>
                  {!onlyOverLimit ? "All" : <s-link href={`?sortBy=${sortBy}&sortOrder=${sortOrder}`}>All</s-link>}
                  {gatingEnforced && overLimitCount > 0 && (
                    <>
                      {" | "}
                      {onlyOverLimit ? "Over limit only" : <s-link href={`?sortBy=${sortBy}&sortOrder=${sortOrder}&overlimit=true`}>Over limit only</s-link>}
                    </>
                  )}
                </s-paragraph>
                {buyerLedger ? (
                  <BuyerLedgerTable
                    rows={buyerLedger.rows}
                    sortBy={sortBy}
                    sortOrder={sortOrder}
                    page={pagination.page}
                    totalCount={pagination.totalCount}
                    pageSize={pagination.pageSize}
                    onlyOverLimit={onlyOverLimit}
                    onNextPage={`?sortBy=${sortBy}&sortOrder=${sortOrder}&page=${pagination.page + 1}${onlyOverLimit ? "&overlimit=true" : ""}`}
                    onPreviousPage={`?sortBy=${sortBy}&sortOrder=${sortOrder}&page=${pagination.page - 1}${onlyOverLimit ? "&overlimit=true" : ""}`}
                    gatingEnforced={gatingEnforced}
                  />
                ) : (
                  <s-empty-state heading="No buyer accounts">
                    <s-text slot="subheading">
                      {onlyOverLimit
                        ? "No accounts over your plan limit."
                        : "You don\u0027t have any buyer accounts with outstanding invoices."}
                    </s-text>
                  </s-empty-state>
                )}
              </s-stack>
            </s-section>
          )}
        </>
      )}
    </>
  );
}

export default function Index() {
  const {
    upgradeUrl,
    gatingEnforced,
    sortBy,
    sortOrder,
    onlyOverLimit,
    currencySupported,
    currencyFlipBlocked,
    dashboardData,
  } = useLoaderData<typeof loader>();

  if (!currencySupported) {
    return (
      <s-page heading="Termwise: Net Terms & Credit">
        <s-section>
          {currencyFlipBlocked ? (
            <s-banner tone="critical" heading="Currency Conversion Not Available">
              {CURRENCY_FLIP_BLOCKED_BANNER_TEXT}{" "}
              Please <s-link href={SUPPORT_EMAIL_MAILTO}>contact support</s-link> for assistance.
            </s-banner>
          ) : (
            <s-banner tone="critical" heading="Currency Not Supported">
              {CURRENCY_NOT_SUPPORTED_BANNER_COPY}
            </s-banner>
          )}
        </s-section>
      </s-page>
    );
  }

  return (
    <s-page heading="Termwise: Net Terms & Credit">
      <Suspense fallback={<DashboardSkeleton />}>
        <Await resolve={dashboardData} errorElement={<DashboardErrorBanner />}>
          {(data) => (
            <DashboardContent
              dashboardData={data}
              gatingEnforced={gatingEnforced}
              upgradeUrl={upgradeUrl}
              sortBy={sortBy}
              sortOrder={sortOrder}
              onlyOverLimit={onlyOverLimit}
            />
          )}
        </Await>
      </Suspense>

      <s-section slot="aside" heading="Getting Started">
        <s-paragraph>Features included in this app:</s-paragraph>
        <s-unordered-list>
          <s-list-item>Track unpaid invoices per wholesale buyer</s-list-item>
          <s-list-item>
            Manage credit limits and automatic credit holds
          </s-list-item>
          <s-list-item>Send payment reminders</s-list-item>
          <s-list-item>
            Match Indian bank transfer payments (NEFT/RTGS/IMPS/UPI/CMS) to orders
          </s-list-item>
        </s-unordered-list>
      </s-section>

      <s-section slot="aside" heading="About Aging Buckets">
        <s-paragraph>
          Invoices are categorized by how many days past due they are:
        </s-paragraph>
        <s-unordered-list>
          <s-list-item>
            <s-text type="strong">Current</s-text>: Not yet due
          </s-list-item>
          <s-list-item>
            <s-text type="strong">1-30 days</s-text>: 1 to 30 days past due
          </s-list-item>
          <s-list-item>
            <s-text type="strong">31-60 days</s-text>: 31 to 60 days past due
          </s-list-item>
          <s-list-item>
            <s-text type="strong">61-90 days</s-text>: 61 to 90 days past due
          </s-list-item>
          <s-list-item>
            <s-text type="strong">90+ days</s-text>: Over 90 days past due
          </s-list-item>
        </s-unordered-list>
        <s-paragraph>
          Invoices become overdue 1 day after the due date (end of day, shop time).
          All calculations use the shop timezone.
        </s-paragraph>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  const boundaryHeaders = boundary.headers(headersArgs);
  const resultHeaders = new Headers(boundaryHeaders);

  // Merge Server-Timing from layout (parent) and index (this loader)
  const parentTiming = headersArgs.parentHeaders?.get("Server-Timing");
  const loaderTiming = headersArgs.loaderHeaders?.get("Server-Timing");
  const mergedTiming = mergeServerTimingHeaders(parentTiming, loaderTiming);
  if (mergedTiming) {
    resultHeaders.set("Server-Timing", mergedTiming);
  }

  return resultHeaders;
};
