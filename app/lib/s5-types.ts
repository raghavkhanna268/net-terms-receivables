/**
 * Type definitions for S5 data model.
 *
 * These types match the Prisma schema and are used by postgres.js queries.
 * Keep in sync with prisma/schema.prisma.
 *
 * Note: postgres.js with fetch_types: false returns:
 * - numeric/decimal as strings (to avoid precision loss)
 * - int8/bigint as strings (to avoid precision loss)
 * - timestamptz as Date objects
 * - jsonb as STRINGS (not parsed) - must JSON.parse() at runtime
 */

// =============================================================================
// ENUMS (match Prisma schema)
// =============================================================================

export type AccountKind = "COMPANY" | "TAGGED_CUSTOMER";
export type HoldState = "OK" | "NEAR_LIMIT" | "HELD" | "BYPASS";
export type DefaultTermsSource = "explicit" | "tag";
export type DueSource = "schedule" | "override" | "inferred" | "none";
export type InvoiceStatus = "open" | "paid" | "cancelled";
export type PaymentStatus = "unmatched" | "partial" | "matched";
export type MatchState = "suggested" | "confirmed" | "pushed" | "unmatched";
export type ReminderChannel = "native" | "email";

/**
 * Basis for inferred due dates (from due-date.ts)
 */
export type DueBasis =
  | "accountDefault"
  | "tagRule"
  | "shopDefault"
  | "paymentTermsDueInDays"
  | null;

// =============================================================================
// ROW TYPES (postgres.js result shapes)
// =============================================================================

export interface ShopRow {
  id: string;
  domain: string;
  currency: string;
  plan: string;
  defaultTermsDays: number | null;
  timezone: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface AccountSourceRow {
  id: string;
  shopId: string;
  tag: string;
  defaultTermsDays: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface BuyerAccountRow {
  id: string;
  shopId: string;
  kind: AccountKind;
  companyId: string | null;
  companyLocationId: string | null;
  customerId: string | null;
  name: string;
  creditLimit: string | null; // Decimal -> string
  defaultTermsDays: number | null;
  defaultTermsSource: DefaultTermsSource | null;
  holdState: HoldState;
  bypass: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface InvoiceRow {
  id: string;
  shopId: string;
  buyerAccountId: string;
  orderId: string | null;
  draftOrderId: string | null;
  name: string;
  gstInvoiceNo: string | null;
  total: string; // Decimal -> string
  outstanding: string; // Decimal -> string
  issuedAt: Date;
  dueAt: Date | null;
  dueSource: DueSource;
  dueBasis: string | null;
  dueReason: string | null;
  dueOverrideAt: Date | null;
  status: InvoiceStatus;
  createdAt: Date;
  updatedAt: Date;
}

export interface BankImportRow {
  id: string;
  shopId: string;
  bank: string;
  fileName: string;
  rowCount: number;
  createdAt: Date;
}

export interface PaymentRow {
  id: string;
  shopId: string;
  importId: string;
  valueDate: Date;
  amount: string; // Decimal -> string
  rail: string | null;
  utr: string | null;
  payerText: string | null;
  narration: string;
  status: PaymentStatus;
  createdAt: Date;
  updatedAt: Date;
}

export interface MatchRow {
  id: string;
  shopId: string;
  paymentId: string;
  invoiceId: string;
  amount: string; // Decimal -> string
  score: number;
  reasons: string; // JSONB -> string with fetch_types:false, JSON.parse() at runtime
  state: MatchState;
  confirmedBy: string | null;
  confirmedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface PayerAliasRow {
  id: string;
  buyerAccountId: string;
  payerKey: string;
  createdAt: Date;
}

export interface ReminderRuleRow {
  id: string;
  shopId: string;
  offsetDays: number;
  channel: ReminderChannel;
  enabled: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface ReminderLogRow {
  id: string;
  shopId: string;
  ruleId: string;
  invoiceId: string;
  sentAt: Date;
}

export interface AuditEventRow {
  id: string;
  shopId: string;
  actor: string;
  type: string;
  data: string; // JSONB -> string with fetch_types:false, JSON.parse() at runtime
  at: Date;
}
