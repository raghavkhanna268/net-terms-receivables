/**
 * Performance test fixtures (S23 Web Vitals).
 *
 * Generates realistic fixture data for performance testing:
 * - ~200 buyer accounts with ~20 per page
 * - Representative aging data across buckets
 * - Test-prefixed domains (never real data)
 *
 * These fixtures are used by the perf harness to render pages
 * without requiring Shopify auth or a real database.
 */

import type { BuyerLedgerRow } from "~/lib/aging";

export interface FixtureLoaderData {
  shopName: string;
  shopDomain: string;
  storeHandle: string;
  shopCurrency: string;
  plan: {
    key: string;
    name: string;
    isTest: boolean;
  };
  usage: {
    companies: { current: number; limit: number };
    importsThisMonth: { current: number; limit: number };
  };
  appHandle: string;
  gatingEnforced: boolean;
  agingTotals: {
    totalByCurrency: Record<string, string>;
    buckets: {
      current: { byCurrency: Record<string, string> };
      "1-30": { byCurrency: Record<string, string> };
      "31-60": { byCurrency: Record<string, string> };
      "61-90": { byCurrency: Record<string, string> };
      "90+": { byCurrency: Record<string, string> };
    };
    overdueByCurrency: Record<string, string>;
    oldestOverdueDays: number | null;
  };
  buyerLedger: {
    rows: BuyerLedgerRow[];
    totalCount: number;
  };
  selectedBuyerInvoices: null;
  selectedBuyerId: null;
  pagination: {
    page: number;
    pageSize: number;
    totalCount: number;
  };
  sortBy: string;
  sortOrder: string;
  onlyOverLimit: boolean;
  overLimitCount: number;
  error: null;
}

const HOLD_STATES = ["OK", "NEAR_LIMIT", "HELD", "BYPASS"] as const;

function randomHoldState(): typeof HOLD_STATES[number] {
  const weights = [70, 15, 10, 5];
  const total = weights.reduce((a, b) => a + b, 0);
  let random = Math.random() * total;
  for (let i = 0; i < weights.length; i++) {
    random -= weights[i];
    if (random <= 0) return HOLD_STATES[i];
  }
  return "OK";
}

function generateCompanyName(index: number): string {
  const prefixes = [
    "Test", "Mock", "Example", "Fake", "Demo",
    "Sample", "Fixture", "Sandbox", "Lab", "Trial"
  ];
  const suffixes = [
    "Industries", "Corp", "Ltd", "Trading", "Exports",
    "Enterprises", "Solutions", "Group", "Holdings", "Partners"
  ];
  const prefix = prefixes[index % prefixes.length];
  const suffix = suffixes[Math.floor(index / prefixes.length) % suffixes.length];
  return `${prefix} ${suffix} ${index + 1}`;
}

export function generateBuyerLedgerRows(count: number, page: number = 1, pageSize: number = 20): BuyerLedgerRow[] {
  const startIndex = (page - 1) * pageSize;
  const rows: BuyerLedgerRow[] = [];

  for (let i = startIndex; i < Math.min(startIndex + pageSize, count); i++) {
    const hasLimit = Math.random() > 0.3;
    const outstanding = Math.floor(Math.random() * 50000000) + 100000;
    const overdue = Math.random() > 0.4 ? Math.floor(outstanding * Math.random() * 0.6) : 0;
    const creditLimit = hasLimit ? outstanding + Math.floor(Math.random() * 10000000) : null;
    const isGated = Math.random() < 0.1;

    rows.push({
      buyer_account_id: `test-buyer-${i + 1}`,
      buyer_name: generateCompanyName(i),
      credit_limit_paise: creditLimit?.toString() ?? null,
      hold_state: randomHoldState(),
      currency: "INR",
      outstanding_paise: outstanding.toString(),
      overdue_paise: overdue.toString(),
      oldest_overdue_days: overdue > 0 ? Math.floor(Math.random() * 120) + 1 : null,
      is_gated: isGated,
    });
  }

  return rows;
}

export function generateAgingTotals() {
  const current = 150000000;
  const bucket1_30 = 80000000;
  const bucket31_60 = 45000000;
  const bucket61_90 = 25000000;
  const bucket90plus = 12000000;
  const total = current + bucket1_30 + bucket31_60 + bucket61_90 + bucket90plus;
  const overdue = bucket1_30 + bucket31_60 + bucket61_90 + bucket90plus;

  return {
    totalByCurrency: { INR: total.toString() },
    buckets: {
      current: { byCurrency: { INR: current.toString() } },
      "1-30": { byCurrency: { INR: bucket1_30.toString() } },
      "31-60": { byCurrency: { INR: bucket31_60.toString() } },
      "61-90": { byCurrency: { INR: bucket61_90.toString() } },
      "90+": { byCurrency: { INR: bucket90plus.toString() } },
    },
    overdueByCurrency: { INR: overdue.toString() },
    oldestOverdueDays: 95,
  };
}

export function generateDashboardFixture(page: number = 1): FixtureLoaderData {
  const totalAccounts = 200;
  const pageSize = 20;
  const overLimitCount = 18;

  return {
    shopName: "test-perf-store",
    shopDomain: "test-perf-store.myshopify.com",
    storeHandle: "test-perf-store",
    shopCurrency: "INR",
    plan: {
      key: "growth",
      name: "Growth",
      isTest: false,
    },
    usage: {
      companies: { current: totalAccounts, limit: 500 },
      importsThisMonth: { current: 5, limit: 50 },
    },
    appHandle: "test-net-terms-receivables",
    gatingEnforced: true,
    agingTotals: generateAgingTotals(),
    buyerLedger: {
      rows: generateBuyerLedgerRows(totalAccounts, page, pageSize),
      totalCount: totalAccounts,
    },
    selectedBuyerInvoices: null,
    selectedBuyerId: null,
    pagination: {
      page,
      pageSize,
      totalCount: totalAccounts,
    },
    sortBy: "outstanding",
    sortOrder: "desc",
    onlyOverLimit: false,
    overLimitCount,
    error: null,
  };
}

export interface OnboardingFixtureData {
  error: null;
  state: {
    steps: Array<{
      id: string;
      title: string;
      description: string;
      status: "complete" | "incomplete" | "attention" | "coming_soon";
      helpText?: string;
      actionUrl?: string;
      actionLabel?: string;
    }>;
    isComplete: boolean;
    completedCount: number;
    totalCount: number;
    dismissedAt: string | null;
  };
  shopId: string;
  registrationStatus: {
    validation: { name: string; status: "ok" | "missing" | "error"; errorCode?: string };
    paymentCustomization: { name: string; status: "ok" | "missing" | "error"; errorCode?: string };
    metafieldDefinitions: { name: string; status: "ok" | "missing" | "error"; errorCode?: string };
  };
  initialSyncState: {
    status: "not_started" | "in_progress" | "done" | "failed";
  };
}

export function generateOnboardingFixture(): OnboardingFixtureData {
  return {
    error: null,
    state: {
      steps: [
        {
          id: "tag-rules",
          title: "Set up tag rules",
          description: "Configure which customers get net terms",
          status: "complete",
          actionUrl: "/app/tag-rules",
          actionLabel: "Configure",
        },
        {
          id: "default-terms",
          title: "Set default payment terms",
          description: "Choose default net days for new accounts",
          status: "complete",
          actionUrl: "/app/settings",
          actionLabel: "Configure",
        },
        {
          id: "reminders",
          title: "Configure payment reminders",
          description: "Set up automated reminder emails",
          status: "incomplete",
          actionUrl: "/app/settings/reminders",
          actionLabel: "Configure",
        },
        {
          id: "import",
          title: "Import bank statement",
          description: "Match payments to invoices",
          status: "incomplete",
          actionUrl: "/app/imports",
          actionLabel: "Import",
        },
      ],
      isComplete: false,
      completedCount: 2,
      totalCount: 4,
      dismissedAt: null,
    },
    shopId: "test-shop-123",
    registrationStatus: {
      validation: { name: "Validation Function", status: "ok" },
      paymentCustomization: { name: "Payment Customization", status: "ok" },
      metafieldDefinitions: { name: "Metafield Definitions", status: "ok" },
    },
    initialSyncState: {
      status: "done",
    },
  };
}

export interface AccountFixtureData {
  account: {
    id: string;
    name: string;
    kind: "COMPANY" | "TAGGED_CUSTOMER";
    companyId: string | null;
    defaultTermsDays: number | null;
    defaultTermsSource: "explicit" | "tag" | null;
    isGated: boolean;
  };
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
  };
  companyTotals: null;
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
  error: null;
}

export function generateAccountFixture(accountId: string = "test-buyer-1"): AccountFixtureData {
  const invoiceCount = 8;
  const invoices = [];

  for (let i = 0; i < invoiceCount; i++) {
    const daysOffset = (i - 3) * 15;
    const dueDate = new Date();
    dueDate.setDate(dueDate.getDate() + daysOffset);

    invoices.push({
      id: `test-inv-${i + 1}`,
      name: `#INV-${1000 + i}`,
      orderId: `gid://shopify/Order/${100000 + i}`,
      dueAt: dueDate.toISOString(),
      outstandingPaise: (Math.floor(Math.random() * 5000000) + 100000).toString(),
      currency: "INR",
      daysPastDue: -daysOffset,
    });
  }

  return {
    account: {
      id: accountId,
      name: "Test Industries Corp 1",
      kind: "COMPANY",
      companyId: "test-company-1",
      defaultTermsDays: 30,
      defaultTermsSource: "explicit",
      isGated: false,
    },
    creditStatus: {
      creditLimitAmount: 500000,
      creditLimitPaise: "50000000",
      exposurePaise: "25000000",
      draftExposurePaise: "2000000",
      availableCreditPaise: "25000000",
      currency: "INR",
      holdState: "OK",
      manualHold: false,
      holdReasonCode: null,
      holdNote: null,
      isOnHold: false,
      holdReasonDisplay: null,
      isOverLimit: false,
      isOverdue: true,
      utilizationPercent: 50,
      syncPending: false,
    },
    companyTotals: null,
    invoices: {
      rows: invoices,
      totalCount: invoiceCount,
    },
    error: null,
  };
}

export interface ImportsFixtureData {
  shopDomain: string;
  shopCurrency: string;
  maxImportRows: number;
  importsThisMonth: {
    current: number;
    limit: number;
    allowed: boolean;
  };
}

export function generateImportsFixture(): ImportsFixtureData {
  return {
    shopDomain: "test-perf-store.myshopify.com",
    shopCurrency: "INR",
    maxImportRows: 1000,
    importsThisMonth: {
      current: 5,
      limit: 50,
      allowed: true,
    },
  };
}
