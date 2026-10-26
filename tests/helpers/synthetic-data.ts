/**
 * Synthetic data generators for scale and N+1 tests.
 *
 * Generates realistic-sized datasets with fully synthetic data:
 * - No real customer data, no 'gid://' literals
 * - Synthetic names like 'Buyer 0001', emails like buyer0001@example.com
 * - Test domains like 'test-scale-*.myshopify.com'
 * - GIDs built at runtime using tests/helpers/gid.ts
 */

import { customerGid, orderGid, draftOrderGid, companyGid, companyLocationGid } from "./gid";

export interface SeedConfig {
  shopId: string;
  shopDomain: string;
  buyerCount: number;
  invoiceCount: number;
  bankPaymentCount: number;
  reminderSendCount: number;
  draftOrderCount: number;
}

export const FULL_SIZE: Omit<SeedConfig, "shopId" | "shopDomain"> = {
  buyerCount: 500,
  invoiceCount: 3000,
  bankPaymentCount: 1500,
  reminderSendCount: 200,
  draftOrderCount: 300,
};

export const HALF_SIZE: Omit<SeedConfig, "shopId" | "shopDomain"> = {
  buyerCount: 250,
  invoiceCount: 1500,
  bankPaymentCount: 750,
  reminderSendCount: 100,
  draftOrderCount: 150,
};

function padNumber(n: number, width: number): string {
  return String(n).padStart(width, "0");
}

export function syntheticBuyerName(index: number): string {
  return `Buyer ${padNumber(index, 4)}`;
}

export function syntheticEmail(index: number): string {
  return `buyer${padNumber(index, 4)}@example.com`;
}

export function syntheticInvoiceName(index: number): string {
  return `#INV-${padNumber(index, 5)}`;
}

export function syntheticRemitterName(index: number): string {
  const prefixes = ["ACME", "GLOBAL", "METRO", "PRIME", "DELTA", "APEX"];
  const suffixes = ["CORP", "LTD", "PVT", "INC", "LLC", "TRADING"];
  return `${prefixes[index % prefixes.length]} ${suffixes[Math.floor(index / 6) % suffixes.length]} ${padNumber(index, 4)}`;
}

export function syntheticNarration(index: number, rail: string, utr: string): string {
  const purposes = ["INVOICE PAYMENT", "ORDER SETTLEMENT", "BALANCE PAYMENT", "ADVANCE PAYMENT"];
  return `${rail}/${utr}/${purposes[index % purposes.length]}/REF${padNumber(index, 6)}`;
}

export function syntheticUtr(index: number, rail: string): string {
  const bankCodes = ["HDFC", "ICIC", "SBIN", "AXIS", "UTIB"];
  const bankCode = bankCodes[index % bankCodes.length];
  const date = new Date(2026, 9, 1);
  date.setDate(date.getDate() + (index % 90));
  const dateStr = date.toISOString().slice(0, 10).replace(/-/g, "");

  switch (rail) {
    case "NEFT":
      return `${bankCode}N${dateStr}${padNumber(index, 8)}`;
    case "RTGS":
      return `${bankCode}R${dateStr}${padNumber(index, 8)}`;
    case "IMPS":
      return `${padNumber(index, 12)}`;
    case "UPI":
      return `${padNumber(100000000000 + index, 12)}`;
    default:
      return `${bankCode}O${dateStr}${padNumber(index, 8)}`;
  }
}

const INVOICE_STATUS_DISTRIBUTION = ["open", "open", "open", "open", "paid", "paid", "paid", "cancelled"];
const PAYMENT_RAILS = ["NEFT", "NEFT", "NEFT", "RTGS", "IMPS", "UPI"];

export function pickInvoiceStatus(index: number): "open" | "paid" | "cancelled" {
  return INVOICE_STATUS_DISTRIBUTION[index % INVOICE_STATUS_DISTRIBUTION.length] as "open" | "paid" | "cancelled";
}

export function pickPaymentRail(index: number): string {
  return PAYMENT_RAILS[index % PAYMENT_RAILS.length];
}

export interface BuyerAccountRow {
  id: string;
  shopId: string;
  kind: "COMPANY" | "TAGGED_CUSTOMER";
  companyId: string | null;
  companyLocationId: string | null;
  customerId: string | null;
  name: string;
  creditLimit: number | null;
  holdState: "OK" | "NEAR_LIMIT" | "HELD";
  mainContactEmail: string | null;
}

export interface InvoiceRow {
  id: string;
  shopId: string;
  buyerAccountId: string;
  orderId: string | null;
  draftOrderId: string | null;
  name: string;
  total: number;
  outstanding: number;
  issuedAt: Date;
  dueAt: Date | null;
  dueSource: "schedule" | "inferred" | "none";
  status: "open" | "paid" | "cancelled";
}

export interface PaymentRow {
  id: string;
  shopId: string;
  importId: string;
  valueDate: Date;
  amount: number;
  rail: string;
  utr: string;
  payerText: string;
  narration: string;
  status: "unmatched" | "partial" | "matched";
}

export interface MatchRow {
  id: string;
  shopId: string;
  paymentId: string;
  invoiceId: string;
  amount: number;
  score: number;
  reasons: unknown;
  state: "suggested" | "confirmed" | "pushing" | "pushed";
}

export interface ReminderLogRow {
  id: string;
  shopId: string;
  ruleId: string;
  invoiceId: string;
  status: "sent" | "delayed" | "skipped_daily_limit";
  sentAt: Date | null;
}

export interface DraftOrderRow {
  id: string;
  shopId: string;
  draftOrderId: string;
  buyerAccountId: string | null;
  name: string;
  total: number;
  hasPaymentTerms: boolean;
  status: string;
  createdAt: Date;
  updatedAt: Date;
}

export function generateBuyerAccounts(config: SeedConfig): BuyerAccountRow[] {
  const buyers: BuyerAccountRow[] = [];
  for (let i = 0; i < config.buyerCount; i++) {
    const isCompany = i % 3 !== 0;
    const holdStates: Array<"OK" | "NEAR_LIMIT" | "HELD"> = ["OK", "OK", "OK", "OK", "NEAR_LIMIT", "HELD"];
    buyers.push({
      id: `buyer-${config.shopId}-${padNumber(i, 5)}`,
      shopId: config.shopId,
      kind: isCompany ? "COMPANY" : "TAGGED_CUSTOMER",
      companyId: isCompany ? companyGid(1000000 + i) : null,
      companyLocationId: isCompany ? companyLocationGid(2000000 + i) : null,
      customerId: isCompany ? null : customerGid(3000000 + i),
      name: syntheticBuyerName(i),
      creditLimit: i % 5 === 0 ? null : 100000 + (i * 1000),
      holdState: holdStates[i % holdStates.length],
      mainContactEmail: isCompany ? syntheticEmail(i) : null,
    });
  }
  return buyers;
}

export function generateInvoices(config: SeedConfig, buyers: BuyerAccountRow[]): InvoiceRow[] {
  const invoices: InvoiceRow[] = [];
  const baseDate = new Date("2026-10-01T00:00:00Z");

  for (let i = 0; i < config.invoiceCount; i++) {
    const buyer = buyers[i % buyers.length];
    const status = pickInvoiceStatus(i);
    const total = 5000 + (i * 100) % 50000;
    const outstanding = status === "open" ? total * (0.3 + (i % 7) * 0.1) : 0;
    const issuedAt = new Date(baseDate.getTime() - (i % 180) * 24 * 60 * 60 * 1000);
    const dueAt = new Date(issuedAt.getTime() + (30 + (i % 30)) * 24 * 60 * 60 * 1000);

    invoices.push({
      id: `inv-${config.shopId}-${padNumber(i, 6)}`,
      shopId: config.shopId,
      buyerAccountId: buyer.id,
      orderId: orderGid(5000000 + i),
      draftOrderId: null,
      name: syntheticInvoiceName(i),
      total,
      outstanding: Math.round(outstanding * 100) / 100,
      issuedAt,
      dueAt,
      dueSource: "schedule",
      status,
    });
  }
  return invoices;
}

export function generatePayments(config: SeedConfig): { payments: PaymentRow[]; importId: string } {
  const importId = `import-${config.shopId}-scale`;
  const payments: PaymentRow[] = [];
  const baseDate = new Date("2026-10-01T00:00:00Z");

  for (let i = 0; i < config.bankPaymentCount; i++) {
    const rail = pickPaymentRail(i);
    const utr = syntheticUtr(i, rail);
    const valueDate = new Date(baseDate.getTime() - (i % 90) * 24 * 60 * 60 * 1000);
    const statuses: Array<"unmatched" | "partial" | "matched"> = ["unmatched", "unmatched", "matched", "partial"];

    payments.push({
      id: `pay-${config.shopId}-${padNumber(i, 6)}`,
      shopId: config.shopId,
      importId,
      valueDate,
      amount: 1000 + (i * 50) % 25000,
      rail,
      utr,
      payerText: syntheticRemitterName(i),
      narration: syntheticNarration(i, rail, utr),
      status: statuses[i % statuses.length],
    });
  }
  return { payments, importId };
}

export function generateMatches(
  config: SeedConfig,
  payments: PaymentRow[],
  invoices: InvoiceRow[]
): MatchRow[] {
  const matches: MatchRow[] = [];
  const matchedPayments = payments.filter((p) => p.status === "matched" || p.status === "partial");
  const openInvoices = invoices.filter((inv) => inv.status === "open");

  const matchCount = Math.min(matchedPayments.length, openInvoices.length, 500);
  const states: Array<"suggested" | "confirmed" | "pushing" | "pushed"> = [
    "suggested", "suggested", "confirmed", "pushed",
  ];

  for (let i = 0; i < matchCount; i++) {
    const payment = matchedPayments[i % matchedPayments.length];
    const invoice = openInvoices[i % openInvoices.length];

    matches.push({
      id: `match-${config.shopId}-${padNumber(i, 5)}`,
      shopId: config.shopId,
      paymentId: payment.id,
      invoiceId: invoice.id,
      amount: Math.min(payment.amount, invoice.outstanding),
      score: 50 + (i % 50),
      reasons: [{ type: "amount_exact", points: 20 }],
      state: states[i % states.length],
    });
  }
  return matches;
}

export function generateReminderLogs(
  config: SeedConfig,
  invoices: InvoiceRow[],
  ruleId: string
): ReminderLogRow[] {
  const logs: ReminderLogRow[] = [];
  const openInvoices = invoices.filter((inv) => inv.status === "open");
  const logCount = Math.min(config.reminderSendCount, openInvoices.length);
  const statuses: Array<"sent" | "delayed" | "skipped_daily_limit"> = ["sent", "sent", "sent", "delayed"];

  for (let i = 0; i < logCount; i++) {
    const invoice = openInvoices[i % openInvoices.length];
    const status = statuses[i % statuses.length];

    logs.push({
      id: `rlog-${config.shopId}-${padNumber(i, 5)}`,
      shopId: config.shopId,
      ruleId,
      invoiceId: invoice.id,
      status,
      sentAt: status === "sent" ? new Date() : null,
    });
  }
  return logs;
}

export function generateDraftOrders(config: SeedConfig, buyers: BuyerAccountRow[]): DraftOrderRow[] {
  const drafts: DraftOrderRow[] = [];
  const baseDate = new Date("2026-10-15T00:00:00Z");

  for (let i = 0; i < config.draftOrderCount; i++) {
    const buyer = buyers[i % buyers.length];

    drafts.push({
      id: `draft-${config.shopId}-${padNumber(i, 5)}`,
      shopId: config.shopId,
      draftOrderId: draftOrderGid(8000000 + i),
      buyerAccountId: buyer.id,
      name: `#D${padNumber(i, 4)}`,
      total: 2000 + (i * 75) % 15000,
      hasPaymentTerms: i % 2 === 0,
      status: "open",
      createdAt: baseDate,
      updatedAt: baseDate,
    });
  }
  return drafts;
}

export interface GeneratedData {
  buyers: BuyerAccountRow[];
  invoices: InvoiceRow[];
  payments: PaymentRow[];
  matches: MatchRow[];
  reminderLogs: ReminderLogRow[];
  draftOrders: DraftOrderRow[];
  importId: string;
  ruleId: string;
}

export function generateAllData(config: SeedConfig): GeneratedData {
  const ruleId = `rule-${config.shopId}-default`;
  const buyers = generateBuyerAccounts(config);
  const invoices = generateInvoices(config, buyers);
  const { payments, importId } = generatePayments(config);
  const matches = generateMatches(config, payments, invoices);
  const reminderLogs = generateReminderLogs(config, invoices, ruleId);
  const draftOrders = generateDraftOrders(config, buyers);

  return { buyers, invoices, payments, matches, reminderLogs, draftOrders, importId, ruleId };
}

export interface HdfcStatementRow {
  date: string;
  narration: string;
  chqRefNo: string;
  valueDate: string;
  withdrawal: string;
  deposit: string;
  closingBalance: string;
}

export function generateSyntheticHdfcStatement(rowCount: number): HdfcStatementRow[] {
  const rows: HdfcStatementRow[] = [];
  let balance = 1000000;
  const baseDate = new Date("2026-10-01");

  for (let i = 0; i < rowCount; i++) {
    const rail = pickPaymentRail(i);
    const utr = syntheticUtr(i, rail);
    const amount = 1000 + (i * 50) % 25000;
    const date = new Date(baseDate.getTime() + (i % 60) * 24 * 60 * 60 * 1000);
    const dateStr = date.toISOString().slice(0, 10).split("-").reverse().join("/");

    balance += amount;

    rows.push({
      date: dateStr,
      narration: `${rail}/${utr}/${syntheticRemitterName(i)}/PAYMENT FOR INV${padNumber(i, 5)}`,
      chqRefNo: utr,
      valueDate: dateStr,
      withdrawal: "",
      deposit: (amount / 100).toFixed(2),
      closingBalance: (balance / 100).toFixed(2),
    });
  }

  return rows;
}
