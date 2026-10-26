/**
 * Bank import persistence (S14/S16), shared by the Imports route action and
 * scripts/e2e-bank-import.ts.
 *
 * Extracted verbatim from app/routes/app.imports.tsx so the server-side e2e
 * import uses the exact same dedupe-key and INSERT path as the UI import.
 *
 * - Dedupe keys are computed server-side (UTR when valid for the rail,
 *   otherwise a SYNTH- hash key)
 * - Payment rows dedupe on ("shopId", utr) via ON CONFLICT DO NOTHING
 * - Writes ONLY "BankImport" and "Payment" (status 'unmatched'); never
 *   creates, confirms or applies a Match
 * - Logs counts and ids only (never remitter names or narrations)
 */

import type { TransactionSql } from "postgres";
import { generateDedupeKey, isValidUtrForRail } from "~/lib/banks/dedupe";
import type { PaymentRail } from "~/lib/banks/types";
import { safeLog } from "~/lib/log.server";

/** Credit row accepted by the import endpoint (validated upstream). */
export interface ImportCreditRow {
  date: string;
  valueDate?: string;
  amountPaise: number;
  balancePaise?: number;
  rail: string;
  utr?: string;
  payerName?: string;
  narration: string;
  refNo?: string;
}

/**
 * Compute server-side dedupe keys for credits.
 * Only trusts a UTR when it is valid for the rail; otherwise hash-based.
 */
export async function computeCreditDedupeKeys<T extends ImportCreditRow>(
  credits: T[]
): Promise<Array<T & { dedupeKey: string }>> {
  const creditsWithKeys: Array<T & { dedupeKey: string }> = [];
  for (const credit of credits) {
    const hasValidUtr = credit.utr && isValidUtrForRail(credit.utr, credit.rail as PaymentRail);
    // Hash-based key includes balancePaise for identical same-day distinction
    const dedupeKey = await generateDedupeKey(
      credit.date,
      credit.amountPaise,
      "CR",
      credit.narration,
      credit.rail as PaymentRail,
      hasValidUtr ? credit.utr : undefined, // Don't pass untrusted UTR
      credit.balancePaise,
      credit.valueDate,
      credit.refNo
    );
    creditsWithKeys.push({ ...credit, dedupeKey });
  }
  return creditsWithKeys;
}

/**
 * Normalize dedupe keys for DB storage.
 * UTR-based keys stay as the raw UTR, hash-based get a SYNTH- prefix.
 */
export function normalizeDedupeKeyForDb(key: string): string {
  if (key.startsWith("utr:")) {
    // Extract the actual UTR value from utr:RAIL:DIR:VALUE format
    const parts = key.split(":");
    return parts[3] || key;
  }
  return `SYNTH-${key}`;
}

export interface InsertBankImportResult {
  importId: string;
  inserted: number;
  duplicates: number;
}

/**
 * Insert one BankImport row and its credit Payment rows inside the caller's
 * transaction. Duplicates (same shop + UTR/SYNTH key) are skipped.
 */
export async function insertBankImportRows(
  tx: TransactionSql,
  input: {
    shopId: string;
    bank: string;
    fileName: string;
    credits: ImportCreditRow[];
    now: Date;
  }
): Promise<InsertBankImportResult> {
  const { shopId, bank, fileName, credits, now } = input;
  const creditsWithKeys = await computeCreditDedupeKeys(credits);

  const [bankImport] = await tx<{ id: string }[]>`
    INSERT INTO "BankImport" (
      "shopId", bank, "fileName", "rowCount", "createdAt"
    )
    VALUES (
      ${shopId},
      ${bank.toLowerCase()},
      ${fileName},
      ${credits.length},
      ${now}
    )
    RETURNING id
  `;

  const importId = bankImport.id;

  // Log import start (counts only, no PII)
  safeLog("info", "import.start", {
    shopId,
    importId,
    count: credits.length,
  });

  const rows = creditsWithKeys.map((credit) => {
    const dbUtr = normalizeDedupeKeyForDb(credit.dedupeKey);
    // Convert to ISO string for JSON serialization (tx.json() needs string, not Date)
    const valueDate = credit.valueDate
      ? new Date(credit.valueDate + "T00:00:00Z").toISOString()
      : new Date(credit.date + "T00:00:00Z").toISOString();
    // Use exact decimal string to avoid float precision issues
    const amountString = (credit.amountPaise / 100).toFixed(2);

    return {
      shopId,
      importId,
      valueDate,
      amount: amountString,
      rail: credit.rail,
      utr: dbUtr,
      payerText: credit.payerName ?? null,
      narration: credit.narration,
    };
  });

  // Batch insert with ON CONFLICT DO NOTHING; returns only inserted rows.
  // Use tx.json() for proper JSON serialization - JSON.stringify() causes
  // postgres.js to double-encode, sending a JSON string scalar instead of array
  const insertedRows = await tx<{ id: string }[]>`
    INSERT INTO "Payment" (
      "shopId",
      "importId",
      "valueDate",
      amount,
      rail,
      utr,
      "payerText",
      narration,
      status,
      "createdAt",
      "updatedAt"
    )
    SELECT
      r."shopId",
      r."importId",
      r."valueDate"::timestamptz,
      r.amount::decimal(14,2),
      r.rail,
      r.utr,
      r."payerText",
      r.narration,
      'unmatched',
      ${now},
      ${now}
    FROM jsonb_to_recordset(${tx.json(rows)}) AS r(
      "shopId" text,
      "importId" text,
      "valueDate" text,
      amount text,
      rail text,
      utr text,
      "payerText" text,
      narration text
    )
    ON CONFLICT ("shopId", utr) DO NOTHING
    RETURNING id
  `;

  const inserted = insertedRows.length;
  const duplicates = rows.length - inserted;

  // Log import completion (counts only, no PII)
  safeLog("info", "import.complete", {
    importId,
    insertedCount: inserted,
    duplicateCount: duplicates,
  });

  return { importId, inserted, duplicates };
}
