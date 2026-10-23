/**
 * Database queries for payment matching.
 *
 * All queries use postgres.js and respect activeAccountFragment for gating.
 * Amounts are returned as bigint strings (paise) for exact arithmetic.
 */

import type { Sql } from "~/lib/db-light.server";
import { activeAccountFragment } from "~/services/gating.server";
import type {
  InvoiceForScoring,
  PaymentForScoring,
  BuyerForScoring,
} from "./score";
import type { PaymentRail } from "~/lib/banks/types";

/** Row shape for unmatched payments */
interface PaymentRow {
  id: string;
  amount_paise: string;
  narration: string;
  payer_text: string | null;
  utr: string | null;
  rail: string | null;
  value_date: Date;
  import_id: string;
  import_file_name: string;
  bank: string;
}

/** Row shape for open invoices */
interface InvoiceRow {
  id: string;
  name: string;
  order_id: string | null;
  outstanding_paise: string;
  buyer_account_id: string;
  buyer_name: string;
  due_at: Date | null;
}

/** Row shape for buyer accounts */
interface BuyerRow {
  id: string;
  name: string;
  email: string | null;
}

/** Row shape for payer aliases */
interface AliasRow {
  buyer_account_id: string;
  payer_key: string;
}

/** Row shape for suggested matches */
interface MatchRow {
  id: string;
  payment_id: string;
  invoice_id: string;
  amount_paise: string;
  score: number;
  reasons: unknown;
  state: string;
  invoice_name: string;
  buyer_name: string;
  buyer_account_id: string;
}

/**
 * Get unmatched or partially matched payments for a shop.
 * Returns credits only (DR transactions are excluded at import time).
 *
 * @param sql - postgres.js SQL client
 * @param shopId - Shop ID
 * @param options - Pagination options
 */
export async function getUnmatchedPayments(
  sql: Sql,
  shopId: string,
  options: { limit: number; offset: number }
): Promise<{ payments: PaymentForScoring[]; totalCount: number }> {
  const { limit, offset } = options;

  const rows = await sql<PaymentRow[]>`
    SELECT
      p.id,
      (ROUND(p.amount * 100))::text AS amount_paise,
      p.narration,
      p."payerText" AS payer_text,
      p.utr,
      p.rail,
      p."valueDate" AS value_date,
      p."importId" AS import_id,
      bi."fileName" AS import_file_name,
      bi.bank
    FROM "Payment" p
    JOIN "BankImport" bi ON bi.id = p."importId"
    WHERE p."shopId" = ${shopId}
      AND p.status IN ('unmatched', 'partial')
    ORDER BY p."valueDate" DESC, p.id
    LIMIT ${limit}
    OFFSET ${offset}
  `;

  const [countRow] = await sql<{ count: string }[]>`
    SELECT COUNT(*)::text AS count
    FROM "Payment"
    WHERE "shopId" = ${shopId}
      AND status IN ('unmatched', 'partial')
  `;

  const payments: PaymentForScoring[] = rows.map((row) => ({
    id: row.id,
    amountPaise: BigInt(row.amount_paise),
    narration: row.narration,
    payerText: row.payer_text,
    utr: row.utr,
    rail: row.rail as PaymentRail | null,
  }));

  return {
    payments,
    totalCount: parseInt(countRow?.count ?? "0", 10),
  };
}

/**
 * Get open invoices for a shop within an amount window.
 * Used for SQL-prefiltered matching to respect 10ms CPU budget.
 *
 * @param sql - postgres.js SQL client
 * @param shopId - Shop ID
 * @param minPaise - Minimum outstanding amount (inclusive)
 * @param maxPaise - Maximum outstanding amount (inclusive)
 */
export async function getOpenInvoicesInAmountWindow(
  sql: Sql,
  shopId: string,
  minPaise: bigint,
  maxPaise: bigint
): Promise<InvoiceForScoring[]> {
  // Convert paise back to decimal for SQL comparison
  const minDecimal = Number(minPaise) / 100;
  const maxDecimal = Number(maxPaise) / 100;

  const rows = await sql<InvoiceRow[]>`
    SELECT
      i.id,
      i.name,
      i."orderId" AS order_id,
      (ROUND(i.outstanding * 100))::text AS outstanding_paise,
      i."buyerAccountId" AS buyer_account_id,
      ba.name AS buyer_name,
      i."dueAt" AS due_at
    FROM "Invoice" i
    JOIN "BuyerAccount" ba ON ba.id = i."buyerAccountId"
    WHERE i."shopId" = ${shopId}
      AND i.status = 'open'
      AND i.outstanding > 0
      AND i.outstanding >= ${minDecimal}
      AND i.outstanding <= ${maxDecimal}
      AND ${activeAccountFragment(sql)}
    ORDER BY i."dueAt" ASC NULLS LAST, i.name ASC
  `;

  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    orderId: row.order_id,
    outstandingPaise: BigInt(row.outstanding_paise),
    buyerAccountId: row.buyer_account_id,
    dueAt: row.due_at,
  }));
}

/**
 * Get all open invoices for a specific buyer.
 *
 * @param sql - postgres.js SQL client
 * @param shopId - Shop ID
 * @param buyerAccountId - Buyer account ID
 */
export async function getOpenInvoicesForBuyer(
  sql: Sql,
  shopId: string,
  buyerAccountId: string
): Promise<InvoiceForScoring[]> {
  const rows = await sql<InvoiceRow[]>`
    SELECT
      i.id,
      i.name,
      i."orderId" AS order_id,
      (ROUND(i.outstanding * 100))::text AS outstanding_paise,
      i."buyerAccountId" AS buyer_account_id,
      ba.name AS buyer_name,
      i."dueAt" AS due_at
    FROM "Invoice" i
    JOIN "BuyerAccount" ba ON ba.id = i."buyerAccountId"
    WHERE i."shopId" = ${shopId}
      AND i."buyerAccountId" = ${buyerAccountId}
      AND i.status = 'open'
      AND i.outstanding > 0
      AND ${activeAccountFragment(sql)}
    ORDER BY i."dueAt" ASC NULLS LAST, i.name ASC
  `;

  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    orderId: row.order_id,
    outstandingPaise: BigInt(row.outstanding_paise),
    buyerAccountId: row.buyer_account_id,
    dueAt: row.due_at,
  }));
}

/**
 * Get active buyer accounts for a shop with their aliases.
 *
 * @param sql - postgres.js SQL client
 * @param shopId - Shop ID
 */
export async function getBuyersWithAliases(
  sql: Sql,
  shopId: string
): Promise<BuyerForScoring[]> {
  // Get buyers with respect to gating
  const buyers = await sql<BuyerRow[]>`
    SELECT
      ba.id,
      ba.name,
      tc.email
    FROM "BuyerAccount" ba
    LEFT JOIN "s8_tagged_customers" tc ON tc."shop_id" = ba."shopId" AND tc."customer_id" = ba."customerId"
    WHERE ba."shopId" = ${shopId}
      AND ${activeAccountFragment(sql)}
  `;

  if (buyers.length === 0) {
    return [];
  }

  // Get all aliases for these buyers
  const buyerIds = buyers.map((b) => b.id);
  const aliases = await sql<AliasRow[]>`
    SELECT
      "buyerAccountId" AS buyer_account_id,
      "payerKey" AS payer_key
    FROM "PayerAlias"
    WHERE "buyerAccountId" IN ${sql(buyerIds)}
  `;

  // Group aliases by buyer
  const aliasesByBuyer = new Map<string, string[]>();
  for (const alias of aliases) {
    const existing = aliasesByBuyer.get(alias.buyer_account_id) ?? [];
    existing.push(alias.payer_key);
    aliasesByBuyer.set(alias.buyer_account_id, existing);
  }

  return buyers.map((buyer) => ({
    id: buyer.id,
    name: buyer.name,
    aliases: aliasesByBuyer.get(buyer.id) ?? [],
    email: buyer.email,
  }));
}

/**
 * Get suggested matches for a shop's review queue.
 *
 * @param sql - postgres.js SQL client
 * @param shopId - Shop ID
 * @param options - Pagination and filter options
 */
export async function getSuggestedMatches(
  sql: Sql,
  shopId: string,
  options: {
    limit: number;
    offset: number;
    state?: "suggested" | "confirmed" | "unmatched";
  }
): Promise<{
  matches: Array<{
    id: string;
    paymentId: string;
    invoiceId: string;
    invoiceName: string;
    amountPaise: bigint;
    score: number;
    reasons: unknown;
    state: string;
    buyerName: string;
    buyerAccountId: string;
  }>;
  totalCount: number;
}> {
  const { limit, offset, state } = options;

  const stateFilter = state ? sql`AND m.state = ${state}` : sql``;

  const rows = await sql<MatchRow[]>`
    SELECT
      m.id,
      m."paymentId" AS payment_id,
      m."invoiceId" AS invoice_id,
      (ROUND(m.amount * 100))::text AS amount_paise,
      m.score,
      m.reasons,
      m.state,
      i.name AS invoice_name,
      ba.name AS buyer_name,
      ba.id AS buyer_account_id
    FROM "Match" m
    JOIN "Invoice" i ON i.id = m."invoiceId"
    JOIN "BuyerAccount" ba ON ba.id = i."buyerAccountId"
    WHERE m."shopId" = ${shopId}
      ${stateFilter}
    ORDER BY m."createdAt" DESC
    LIMIT ${limit}
    OFFSET ${offset}
  `;

  const [countRow] = await sql<{ count: string }[]>`
    SELECT COUNT(*)::text AS count
    FROM "Match" m
    WHERE m."shopId" = ${shopId}
      ${stateFilter}
  `;

  return {
    matches: rows.map((row) => ({
      id: row.id,
      paymentId: row.payment_id,
      invoiceId: row.invoice_id,
      invoiceName: row.invoice_name,
      amountPaise: BigInt(row.amount_paise),
      score: row.score,
      reasons: row.reasons,
      state: row.state,
      buyerName: row.buyer_name,
      buyerAccountId: row.buyer_account_id,
    })),
    totalCount: parseInt(countRow?.count ?? "0", 10),
  };
}

/**
 * Get payment details with all its suggested matches.
 *
 * @param sql - postgres.js SQL client
 * @param shopId - Shop ID
 * @param paymentId - Payment ID
 */
export async function getPaymentWithMatches(
  sql: Sql,
  shopId: string,
  paymentId: string
): Promise<{
  payment: PaymentForScoring & { valueDate: Date; importFileName: string };
  matches: Array<{
    id: string;
    invoiceId: string;
    invoiceName: string;
    amountPaise: bigint;
    score: number;
    reasons: unknown;
    state: string;
    buyerName: string;
  }>;
} | null> {
  const [paymentRow] = await sql<PaymentRow[]>`
    SELECT
      p.id,
      (ROUND(p.amount * 100))::text AS amount_paise,
      p.narration,
      p."payerText" AS payer_text,
      p.utr,
      p.rail,
      p."valueDate" AS value_date,
      p."importId" AS import_id,
      bi."fileName" AS import_file_name,
      bi.bank
    FROM "Payment" p
    JOIN "BankImport" bi ON bi.id = p."importId"
    WHERE p.id = ${paymentId}
      AND p."shopId" = ${shopId}
  `;

  if (!paymentRow) return null;

  const matchRows = await sql<MatchRow[]>`
    SELECT
      m.id,
      m."paymentId" AS payment_id,
      m."invoiceId" AS invoice_id,
      (ROUND(m.amount * 100))::text AS amount_paise,
      m.score,
      m.reasons,
      m.state,
      i.name AS invoice_name,
      ba.name AS buyer_name,
      ba.id AS buyer_account_id
    FROM "Match" m
    JOIN "Invoice" i ON i.id = m."invoiceId"
    JOIN "BuyerAccount" ba ON ba.id = i."buyerAccountId"
    WHERE m."paymentId" = ${paymentId}
      AND m."shopId" = ${shopId}
    ORDER BY m.score DESC
  `;

  return {
    payment: {
      id: paymentRow.id,
      amountPaise: BigInt(paymentRow.amount_paise),
      narration: paymentRow.narration,
      payerText: paymentRow.payer_text,
      utr: paymentRow.utr,
      rail: paymentRow.rail as PaymentRail | null,
      valueDate: paymentRow.value_date,
      importFileName: paymentRow.import_file_name,
    },
    matches: matchRows.map((row) => ({
      id: row.id,
      invoiceId: row.invoice_id,
      invoiceName: row.invoice_name,
      amountPaise: BigInt(row.amount_paise),
      score: row.score,
      reasons: row.reasons,
      state: row.state,
      buyerName: row.buyer_name,
    })),
  };
}

/**
 * Create a suggested match.
 *
 * @param sql - postgres.js SQL client
 * @param data - Match data
 */
export async function createMatch(
  sql: Sql,
  data: {
    shopId: string;
    paymentId: string;
    invoiceId: string;
    amountPaise: bigint;
    score: number;
    reasons: unknown;
  }
): Promise<string> {
  const amountDecimal = Number(data.amountPaise) / 100;

  const [result] = await sql<{ id: string }[]>`
    INSERT INTO "Match" (
      "shopId",
      "paymentId",
      "invoiceId",
      amount,
      score,
      reasons,
      state,
      "createdAt",
      "updatedAt"
    ) VALUES (
      ${data.shopId},
      ${data.paymentId},
      ${data.invoiceId},
      ${amountDecimal},
      ${data.score},
      ${JSON.stringify(data.reasons)},
      'suggested',
      NOW(),
      NOW()
    )
    RETURNING id
  `;

  return result.id;
}

/**
 * Update match state (confirm or reject).
 *
 * @param sql - postgres.js SQL client
 * @param shopId - Shop ID
 * @param matchId - Match ID
 * @param state - New state
 * @param confirmedBy - Who confirmed (user ID or "auto")
 */
export async function updateMatchState(
  sql: Sql,
  shopId: string,
  matchId: string,
  state: "confirmed" | "unmatched",
  confirmedBy: string
): Promise<boolean> {
  const result = await sql`
    UPDATE "Match"
    SET
      state = ${state},
      "confirmedBy" = ${confirmedBy},
      "confirmedAt" = ${state === "confirmed" ? sql`NOW()` : sql`NULL`},
      "updatedAt" = NOW()
    WHERE id = ${matchId}
      AND "shopId" = ${shopId}
      AND state = 'suggested'
  `;

  return result.count > 0;
}

/**
 * Delete all suggested matches for a payment.
 * Used when re-running matching or rejecting all suggestions.
 *
 * @param sql - postgres.js SQL client
 * @param shopId - Shop ID
 * @param paymentId - Payment ID
 */
export async function deleteSuggestedMatchesForPayment(
  sql: Sql,
  shopId: string,
  paymentId: string
): Promise<number> {
  const result = await sql`
    DELETE FROM "Match"
    WHERE "shopId" = ${shopId}
      AND "paymentId" = ${paymentId}
      AND state = 'suggested'
  `;

  return result.count;
}

/**
 * Update payment status based on match state.
 *
 * @param sql - postgres.js SQL client
 * @param shopId - Shop ID
 * @param paymentId - Payment ID
 * @param status - New status
 */
export async function updatePaymentStatus(
  sql: Sql,
  shopId: string,
  paymentId: string,
  status: "unmatched" | "partial" | "matched"
): Promise<boolean> {
  const result = await sql`
    UPDATE "Payment"
    SET
      status = ${status},
      "updatedAt" = NOW()
    WHERE id = ${paymentId}
      AND "shopId" = ${shopId}
  `;

  return result.count > 0;
}

/**
 * Check if a UTR already exists for a shop.
 * Used for duplicate detection during import.
 *
 * @param sql - postgres.js SQL client
 * @param shopId - Shop ID
 * @param utr - UTR to check
 */
export async function checkUtrExists(
  sql: Sql,
  shopId: string,
  utr: string
): Promise<boolean> {
  const [result] = await sql<{ exists: boolean }[]>`
    SELECT EXISTS(
      SELECT 1 FROM "Payment"
      WHERE "shopId" = ${shopId}
        AND utr = ${utr}
    ) AS exists
  `;

  return result?.exists ?? false;
}

/**
 * Create or update a payer alias.
 *
 * @param sql - postgres.js SQL client
 * @param buyerAccountId - Buyer account ID
 * @param payerKey - Normalized payer key
 */
export async function upsertPayerAlias(
  sql: Sql,
  buyerAccountId: string,
  payerKey: string
): Promise<string> {
  const [result] = await sql<{ id: string }[]>`
    INSERT INTO "PayerAlias" (
      "buyerAccountId",
      "payerKey",
      "createdAt"
    ) VALUES (
      ${buyerAccountId},
      ${payerKey},
      NOW()
    )
    ON CONFLICT ("buyerAccountId", "payerKey") DO UPDATE
    SET "buyerAccountId" = EXCLUDED."buyerAccountId"
    RETURNING id
  `;

  return result.id;
}

/**
 * Find buyer by payer alias.
 *
 * @param sql - postgres.js SQL client
 * @param shopId - Shop ID
 * @param payerKey - Normalized payer key
 */
export async function findBuyerByAlias(
  sql: Sql,
  shopId: string,
  payerKey: string
): Promise<BuyerForScoring | null> {
  const [row] = await sql<BuyerRow[]>`
    SELECT
      ba.id,
      ba.name,
      tc.email
    FROM "PayerAlias" pa
    JOIN "BuyerAccount" ba ON ba.id = pa."buyerAccountId"
    LEFT JOIN "s8_tagged_customers" tc ON tc."shop_id" = ba."shopId" AND tc."customer_id" = ba."customerId"
    WHERE pa."payerKey" = ${payerKey}
      AND ba."shopId" = ${shopId}
      AND ${activeAccountFragment(sql)}
    LIMIT 1
  `;

  if (!row) return null;

  // Get all aliases for this buyer
  const aliases = await sql<{ payer_key: string }[]>`
    SELECT "payerKey" AS payer_key
    FROM "PayerAlias"
    WHERE "buyerAccountId" = ${row.id}
  `;

  return {
    id: row.id,
    name: row.name,
    email: row.email,
    aliases: aliases.map((a) => a.payer_key),
  };
}
