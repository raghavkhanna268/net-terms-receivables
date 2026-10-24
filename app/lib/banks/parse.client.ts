/**
 * Client-only bank statement parsing module.
 *
 * This file uses the .client.ts extension to ensure it's NEVER included
 * in the server bundle. React Router v7 / Vite will exclude .client.ts
 * files from SSR builds.
 *
 * This keeps SheetJS (~1MB) out of the Cloudflare Worker bundle.
 *
 * Usage: Import this module only in browser-side code (useEffect, event handlers).
 * Do NOT import at module level in route files.
 */

export { parseBankStatement, parseAndFilterStatement } from "./index.js";

export type {
  BankId,
  TxnDirection,
  PaymentRail,
  DetectionResult,
  RawTxnRow,
  NormalisedTxn,
  ParsedNarration,
  ParseResult,
  ParseError,
  ParseOptions,
  FileType,
  SheetData,
} from "./types.js";
