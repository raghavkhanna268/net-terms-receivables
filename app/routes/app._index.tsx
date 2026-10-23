import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { getRequestSql } from "~/lib/request-context.server";
import { resolvePlan, type ResolvedPlan } from "~/services/plan.server";
import { getUsageStats } from "~/services/gating.server";
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

const PAGE_SIZE = 20;

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

export const loader = async ({ request, context }: LoaderFunctionArgs) => {
  const { shopify } = context;
  const { session } = await shopify.authenticate.admin(request);
  const sql = getRequestSql();
  const shopDomain = session.shop;

  const url = new URL(request.url);
  const page = parsePositiveInt(url.searchParams.get("page"), 1);
  const sortBy = parseSortBy(url.searchParams.get("sortBy"));
  const sortOrder = parseSortOrder(url.searchParams.get("sortOrder"));
  const selectedBuyerId = url.searchParams.get("buyer") ?? null;

  const [shop] = await sql<{ id: string; currency: string; timezone: string }[]>`
    SELECT id, currency, timezone FROM "Shop" WHERE domain = ${shopDomain}
  `;

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

  if (shop) {
    const asOf = new Date();

    try {
      [planData, usage, agingTotals, buyerLedger] = await Promise.all([
        resolvePlan(sql, shopDomain),
        getUsageStats(sql, shop.id),
        getShopAgingTotals(sql, shop.id, asOf),
        getBuyerLedger(sql, shop.id, asOf, {
          limit: PAGE_SIZE,
          offset: (page - 1) * PAGE_SIZE,
          sortBy,
          sortOrder,
        }),
      ]);

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
      console.error("[app._index] Error loading aging data:", err);
      error = "Failed to load aging data. Please try again.";
    }
  }

  const storeHandle = shopDomain.replace(".myshopify.com", "");

  return {
    shopName: storeHandle,
    shopDomain,
    storeHandle,
    shopCurrency: shop?.currency ?? "INR",
    plan: planData
      ? {
          key: planData.plan.key,
          name: planData.subscriptionName ?? planData.plan.key,
          isTest: planData.isTest,
        }
      : null,
    usage: usage ?? {
      companies: { current: 0, limit: 3 },
      importsThisMonth: { current: 0, limit: 1 },
    },
    appHandle: process.env.APP_HANDLE ?? "net-terms-receivables",
    agingTotals,
    buyerLedger,
    selectedBuyerInvoices,
    selectedBuyerId,
    pagination: {
      page,
      pageSize: PAGE_SIZE,
      totalCount: buyerLedger?.totalCount ?? 0,
    },
    sortBy,
    sortOrder,
    error,
  };
};

function formatLimit(limit: number): string {
  return limit === -1 ? "Unlimited" : String(limit);
}

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
          <s-table-header>Bucket</s-table-header>
          <s-table-header format="currency">Amount</s-table-header>
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

function BuyerLedgerTable({
  rows,
  sortBy,
  sortOrder,
  page,
  totalCount,
  pageSize,
  onNextPage,
  onPreviousPage,
}: {
  rows: BuyerLedgerRow[];
  sortBy: string;
  sortOrder: string;
  page: number;
  totalCount: number;
  pageSize: number;
  onNextPage: string;
  onPreviousPage: string;
}) {
  const totalPages = Math.ceil(totalCount / pageSize);
  const hasNextPage = page < totalPages;
  const hasPreviousPage = page > 1;

  const buildSortUrl = (newSortBy: string) => {
    const newOrder =
      sortBy === newSortBy && sortOrder === "desc" ? "asc" : "desc";
    return `?sortBy=${newSortBy}&sortOrder=${newOrder}&page=1`;
  };

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
      <s-table
        paginate={totalPages > 1}
        hasNextPage={hasNextPage}
        hasPreviousPage={hasPreviousPage}
      >
        <s-table-header-row>
          <s-table-header>
            <s-link href={buildSortUrl("name")}>Buyer{getSortIndicator("name")}</s-link>
          </s-table-header>
          <s-table-header format="currency">Credit Limit</s-table-header>
          <s-table-header format="currency">
            <s-link href={buildSortUrl("outstanding")}>
              Outstanding{getSortIndicator("outstanding")}
            </s-link>
          </s-table-header>
          <s-table-header format="currency">
            <s-link href={buildSortUrl("overdue")}>
              Overdue{getSortIndicator("overdue")}
            </s-link>
          </s-table-header>
          <s-table-header>Oldest Overdue</s-table-header>
          <s-table-header>Hold Status</s-table-header>
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
                  <s-link
                    href={`?buyer=${row.buyer_account_id}&sortBy=${sortBy}&sortOrder=${sortOrder}&page=${page}`}
                  >
                    {row.buyer_name}
                  </s-link>
                  {row.is_gated && <s-text tone="critical"> (gated)</s-text>}
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
          {hasPreviousPage && (
            <s-button href={onPreviousPage}>Previous</s-button>
          )}
          <s-text>
            Page {page} of {totalPages} ({totalCount} buyers)
          </s-text>
          {hasNextPage && (
            <s-button href={onNextPage}>Next</s-button>
          )}
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
            <s-table-header>Invoice</s-table-header>
            <s-table-header>Due Date</s-table-header>
            <s-table-header format="currency">Outstanding</s-table-header>
            <s-table-header>Days Past Due</s-table-header>
            <s-table-header>Order</s-table-header>
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

export default function Index() {
  const {
    storeHandle,
    plan,
    usage,
    appHandle,
    agingTotals,
    buyerLedger,
    selectedBuyerInvoices,
    pagination,
    sortBy,
    sortOrder,
    error,
  } = useLoaderData<typeof loader>();

  const planKey = plan?.key ?? "free";
  const planName = plan?.name ?? "Free";
  const isTest = plan?.isTest ?? false;

  const upgradeUrl = `https://admin.shopify.com/store/${storeHandle}/charges/${appHandle}/pricing_plans`;

  const companiesUsed = usage.companies.current;
  const companiesLimit = usage.companies.limit;
  const companiesText =
    companiesLimit === -1
      ? `${companiesUsed} companies`
      : `${companiesUsed} / ${formatLimit(companiesLimit)} companies`;
  const companiesAtLimit =
    companiesLimit !== -1 && companiesUsed >= companiesLimit;

  const displayPlanName = planName.charAt(0).toUpperCase() + planName.slice(1);

  const hasInvoices =
    agingTotals && Object.keys(agingTotals.totalByCurrency).length > 0;
  const currencies = agingTotals
    ? Object.keys(agingTotals.totalByCurrency)
    : [];

  const closeInvoiceListUrl = `?sortBy=${sortBy}&sortOrder=${sortOrder}&page=${pagination.page}`;

  return (
    <s-page heading="Net Terms Receivables">
      {/* S21: Plan Banner */}
      <s-section heading="Your Plan">
        <s-stack>
          <s-paragraph>
            <s-text type="strong">Current Plan: </s-text>
            <s-text>
              {displayPlanName}
              {isTest ? " (Test)" : ""}
            </s-text>
          </s-paragraph>
          <s-paragraph>
            <s-text type="strong">Companies: </s-text>
            <s-text>{companiesText}</s-text>
            {companiesAtLimit && (
              <s-text> — Limit reached, upgrade to add more</s-text>
            )}
          </s-paragraph>
          {planKey !== "scale" && (
            <s-button href={upgradeUrl} target="_top">
              Upgrade Plan
            </s-button>
          )}
        </s-stack>
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
              {buyerLedger ? (
                <BuyerLedgerTable
                  rows={buyerLedger.rows}
                  sortBy={sortBy}
                  sortOrder={sortOrder}
                  page={pagination.page}
                  totalCount={pagination.totalCount}
                  pageSize={pagination.pageSize}
                  onNextPage={`?sortBy=${sortBy}&sortOrder=${sortOrder}&page=${pagination.page + 1}`}
                  onPreviousPage={`?sortBy=${sortBy}&sortOrder=${sortOrder}&page=${pagination.page - 1}`}
                />
              ) : (
                <s-empty-state heading="No buyer accounts">
                  <s-text slot="subheading">
                    You don&apos;t have any buyer accounts with outstanding
                    invoices.
                  </s-text>
                </s-empty-state>
              )}
            </s-section>
          )}
        </>
      )}

      <s-section slot="aside" heading="Getting Started">
        <s-paragraph>Features included in this app:</s-paragraph>
        <s-unordered-list>
          <s-list-item>Track unpaid invoices per wholesale buyer</s-list-item>
          <s-list-item>
            Manage credit limits and automatic credit holds
          </s-list-item>
          <s-list-item>Send payment reminders</s-list-item>
          <s-list-item>
            Match Indian bank transfer payments (NEFT/RTGS/IMPS/UPI) to orders
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
          All calculations use the Asia/Kolkata timezone.
        </s-paragraph>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
