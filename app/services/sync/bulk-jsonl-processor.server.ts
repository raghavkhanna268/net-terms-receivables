/**
 * Bulk JSONL processor for S10b.
 *
 * Downloads JSONL result files from Shopify bulk operations using HTTP Range
 * requests, enabling resumable processing for large files that exceed the
 * Cloudflare Workers 10ms CPU time budget.
 *
 * Key features:
 * - HTTP Range chunking: Downloads in bounded chunks (starts at 512KB)
 * - Byte-accurate offsets: Tracks per-line byte positions
 * - UTF-8 safe: Split on byte 0x0A, decode with TextDecoder(fatal)
 * - Resumable: Can resume from saved offset after budget cut
 * - EOF tail handling: Processes final line without trailing newline
 * - Growing range: Doubles chunk size if no newline found (up to 8MB cap)
 *
 * Design notes:
 * - Uses fetch with Range header (supported by Shopify's S3-backed URLs)
 * - Processes complete lines only, partial trailing bytes are re-fetched
 * - EOF detection from Content-Range total or 416 response
 * - Returns {status:'progress'} for partial progress with continuation
 */

import type { Sql } from "~/lib/db-light.server";
import type { BulkMessage } from "~/lib/pgmq.server";
import type { SyncResult } from "./types";
import { safeLog, toErrorCode, shopHash } from "~/lib/log.server";
import { SUPPORTED_SHOP_CURRENCY } from "~/lib/shop-currency.server";
import {
  parseCompanyBulkJsonl,
  parseOrderBulkJsonl,
  parseCustomerBulkJsonl,
  bulkLocationToShopifyLocation,
  bulkOrderToShopifyOrder,
  bulkCustomerToShopifyCustomer,
} from "./bulk-parser.server";
import {
  mapCompanyLocationToBuyerAccount,
  bulkUpsertBuyerAccounts,
} from "./company-location.server";
import {
  mapOrderToInvoiceWithEligibility,
  bulkUpsertInvoices,
  type InvoiceData,
} from "./order.server";
import { processBulkCustomer, type CustomerPiiMode } from "./customer.server";
import { getRequestEnv } from "~/lib/request-context.server";
import {
  checkOrderEligibility,
  getEligibilityContext,
  isTerminalFinancialStatus,
  type EligibilityContext,
} from "~/lib/invoice-eligibility";
import { isWebhookProcessed, markWebhookProcessed } from "./company.server";
import { incrementOrderOutstandingMissing } from "../drain/reconcile-handlers.server";
import { adminGraphQL, BULK_OPERATION_STATUS_QUERY } from "../drain/admin-client.server";
import {
  getBulkOperationMetadata,
  updateBulkOperationChunkSize,
  incrementBulkOperationFailureCount,
  resetBulkOperationFailureCount,
} from "./bulk-operations.server";

/**
 * Default chunk size in bytes (512KB).
 * Balances between CPU time and network efficiency.
 */
export const DEFAULT_CHUNK_SIZE = 512 * 1024;

/**
 * Maximum chunk size in bytes (8MB).
 * Cap for growing range window on no-newline chunks.
 */
export const MAX_CHUNK_SIZE = 8 * 1024 * 1024;

/**
 * Maximum lines to process per invocation.
 * Prevents CPU timeout on dense JSONL.
 */
export const DEFAULT_MAX_LINES = 100;

/**
 * Maximum failure count before DLQ.
 */
export const MAX_FAILURE_COUNT = 5;

/**
 * Processing lease duration in seconds.
 * A processor must acquire the lease before processing.
 */
export const PROCESSING_LEASE_SECONDS = 60;

/**
 * Safe error codes for DLQ and logging.
 * These codes are allowlisted and do not contain sensitive data.
 */
export const BULK_ERROR_CODES = {
  NO_RESULT_URL: "bulk_no_result_url",
  MAX_FAILURES: "bulk_max_failures",
  CHUNK_HTTP_4XX: "bulk_chunk_http_4xx",
  PROCESSING_ERROR: "bulk_processing_error",
  LEASE_CONTENTION: "bulk_lease_contention",
  STALE_RECOVERY: "bulk_stale_recovery",
} as const;

/**
 * Error classification for retry logic.
 * - retryable: network, 5xx, 429, timeouts - increment failure_count, retry until 5
 * - permanent: 4xx (not 429), bad data - go straight to DLQ
 */
export type ErrorType = "retryable" | "permanent";

/**
 * Get the next reconcile stage after the current one completes.
 * Sequence: companies → customers → orders (→ draft_orders in PR-B)
 *
 * @param currentStage - The stage that just completed
 * @returns The next stage to enqueue, or undefined if this is the final stage
 */
export function getNextStage(
  currentStage: string | null
): "customers" | "orders" | undefined {
  switch (currentStage) {
    case "companies":
      return "customers";
    case "customers":
      return "orders";
    case "orders":
      return undefined;
    default:
      return undefined;
  }
}

/**
 * Check if a raw JSONL line has __parentId (is a child line).
 * Used for batch boundary detection to avoid splitting parent/child groups.
 * Exported for testing.
 */
export function lineHasParentId(line: string): boolean {
  try {
    const parsed = JSON.parse(line);
    return "__parentId" in parsed && parsed.__parentId !== undefined;
  } catch {
    // If we can't parse it, treat it as a parent (safer)
    return false;
  }
}

/**
 * Result of a bulk operation processing.
 * Extends SyncResult with a status field for progress tracking.
 */
export interface BulkProcessResult extends SyncResult {
  /** Processing status: 'complete', 'progress', or 'error' */
  status?: "complete" | "progress" | "error";
  /** Next stage to enqueue after this one completes (for reconcile chaining) */
  nextStage?: "customers" | "orders";
  /** @deprecated Use nextStage instead. Kept for compatibility. */
  chainToOrders?: boolean;
  /** Error classification for retry logic (only set when status='error') */
  errorType?: ErrorType;
  /** Safe error code for DLQ and logging */
  errorCode?: string;
}

/**
 * Bulk operation status from Shopify.
 */
/**
 * Bulk operation status from Shopify.
 * Note: objectCount is UnsignedInt64 in Shopify's schema, serialized as STRING in JSON.
 * See: https://shopify.dev/docs/api/admin-graphql/latest/scalars/UnsignedInt64
 */
interface BulkOperationStatus {
  id: string;
  status: string;
  url: string | null;
  fileSize: number | null;
  objectCount: string | null;
  errorCode: string | null;
  partialDataUrl?: string | null;
}

/**
 * Get the bulk operation status and result URL from Shopify.
 */
export async function getBulkOperationStatus(
  shop: string,
  bulkOperationId: string
): Promise<{ success: boolean; data?: BulkOperationStatus; error?: string }> {
  const result = await adminGraphQL<{
    node: BulkOperationStatus | null;
  }>(shop, BULK_OPERATION_STATUS_QUERY, { id: bulkOperationId });

  if (!result.success) {
    return { success: false, error: result.error };
  }

  if (!result.data?.node) {
    return { success: false, error: "Bulk operation not found" };
  }

  return { success: true, data: result.data.node };
}

/**
 * Result of fetching a JSONL chunk.
 */
export interface ChunkFetchResult {
  /** Whether the fetch succeeded */
  success: boolean;
  /** Raw bytes from the response */
  bytes?: Uint8Array;
  /** Whether we've reached EOF */
  isEof: boolean;
  /** Total file size from Content-Range (if available) */
  totalSize?: number;
  /** Error message if failed */
  error?: string;
  /** HTTP status code (for error classification) */
  httpStatus?: number;
}

/**
 * Fetch a chunk of the JSONL file using HTTP Range request.
 * Returns raw bytes (Uint8Array) for proper byte-accurate processing.
 *
 * @param url - JSONL result URL from Shopify
 * @param startByte - Starting byte offset (inclusive)
 * @param chunkSize - Number of bytes to fetch
 * @returns Chunk data with bytes and EOF detection
 */
export async function fetchJsonlChunk(
  url: string,
  startByte: number,
  chunkSize: number = DEFAULT_CHUNK_SIZE
): Promise<ChunkFetchResult> {
  const endByte = startByte + chunkSize - 1;
  const rangeHeader = `bytes=${startByte}-${endByte}`;

  try {
    const response = await fetch(url, {
      headers: {
        Range: rangeHeader,
        Accept: "application/x-ndjson, text/plain",
      },
    });

    // 416 Range Not Satisfiable = offset at or past EOF
    if (response.status === 416) {
      return { success: true, bytes: new Uint8Array(0), isEof: true };
    }

    // Get raw bytes via arrayBuffer
    const buffer = await response.arrayBuffer();
    const bytes = new Uint8Array(buffer);

    // 200 OK = server ignored Range header, returned whole file
    // If startByte > 0 and we got 200, we need to slice
    if (response.status === 200 && startByte > 0) {
      // Server ignored our Range request - slice from startByte
      console.warn(
        `[bulk-jsonl] Server returned 200 instead of 206 for Range request (startByte=${startByte}). Slicing locally.`
      );
      if (bytes.length <= startByte) {
        // We're past EOF
        return { success: true, bytes: new Uint8Array(0), isEof: true };
      }
      const sliced = bytes.slice(startByte);
      return {
        success: true,
        bytes: sliced,
        isEof: true, // 200 means we have the whole file
        totalSize: bytes.length,
      };
    }

    // 206 Partial Content = range request worked
    if (!response.ok && response.status !== 206) {
      return {
        success: false,
        isEof: false,
        error: `HTTP ${response.status}: ${response.statusText}`,
        httpStatus: response.status,
      };
    }

    // Parse Content-Range header for EOF detection
    // Format: "bytes 0-999/5000" or "bytes 0-999/*"
    const contentRange = response.headers.get("Content-Range");
    let isEof = false;
    let totalSize: number | undefined;

    if (contentRange) {
      const match = contentRange.match(/bytes (\d+)-(\d+)\/(\d+|\*)/);
      if (match && match[3] !== "*") {
        totalSize = parseInt(match[3], 10);
        const rangeEnd = parseInt(match[2], 10);
        // EOF if the end of the returned range equals or exceeds the total minus 1
        isEof = rangeEnd >= totalSize - 1;
      }
    }

    // Also check: if server returned 200 (whole file), we have everything
    if (response.status === 200) {
      isEof = true;
      totalSize = bytes.length;
    }

    // Smaller-than-requested response also indicates EOF
    if (bytes.length < chunkSize && !isEof) {
      isEof = true;
    }

    return { success: true, bytes, isEof, totalSize };
  } catch (err) {
    return {
      success: false,
      isEof: false,
      error: `retryable:${toErrorCode(err)}`,
      httpStatus: 0,
    };
  }
}

/**
 * Classify HTTP status code for retry logic.
 * - Retryable: 0 (network error), 429 (rate limit), 5xx (server error)
 * - Permanent: 4xx (except 429) - client error, bad request
 */
export function classifyHttpError(httpStatus: number | undefined): ErrorType {
  if (httpStatus === undefined || httpStatus === 0) {
    // Network error - retryable
    return "retryable";
  }
  if (httpStatus === 429) {
    // Rate limit - retryable
    return "retryable";
  }
  if (httpStatus >= 500) {
    // Server error - retryable
    return "retryable";
  }
  if (httpStatus >= 400 && httpStatus < 500) {
    // Client error (4xx except 429) - permanent
    return "permanent";
  }
  // Anything else unexpected - retryable to be safe
  return "retryable";
}

/**
 * Result of splitting bytes into lines.
 */
export interface SplitResult {
  /** Complete lines decoded from bytes */
  lines: string[];
  /** Byte positions after each line's newline (for offset tracking) */
  lineEndPositions: number[];
  /** Total bytes consumed (position after last newline, or 0 if none) */
  bytesConsumed: number;
  /** Remaining bytes after last newline (for EOF tail processing) */
  tailBytes: Uint8Array;
}

/**
 * Split bytes into complete lines at byte 0x0A (newline).
 * Returns decoded strings for complete lines and per-line byte positions.
 *
 * @param bytes - Raw bytes from chunk
 * @param decoder - TextDecoder instance with fatal=true
 * @returns Complete lines with byte positions
 */
export function splitBytesIntoLines(
  bytes: Uint8Array,
  decoder: TextDecoder
): SplitResult {
  const NEWLINE = 0x0a;
  const lines: string[] = [];
  const lineEndPositions: number[] = [];
  let lastNewlinePos = -1;

  // Find all newlines and decode complete lines
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] === NEWLINE) {
      // Extract bytes from after last newline to this newline (exclusive)
      const lineBytes = bytes.slice(lastNewlinePos + 1, i);
      if (lineBytes.length > 0) {
        try {
          const line = decoder.decode(lineBytes, { stream: false });
          const trimmed = line.trim();
          if (trimmed.length > 0) {
            lines.push(trimmed);
            lineEndPositions.push(i + 1); // Position after the newline
          }
        } catch {
          // Invalid UTF-8 - skip this line entirely, don't record position
          // (lineEndPositions must stay aligned with lines array)
          console.warn("[bulk-jsonl] Invalid UTF-8 in line, skipping");
        }
      }
      lastNewlinePos = i;
    }
  }

  // bytesConsumed is position after last newline (or 0 if no newlines)
  const bytesConsumed = lastNewlinePos >= 0 ? lastNewlinePos + 1 : 0;

  // Tail bytes are everything after the last newline
  const tailBytes = lastNewlinePos >= 0
    ? bytes.slice(lastNewlinePos + 1)
    : bytes;

  return { lines, lineEndPositions, bytesConsumed, tailBytes };
}

/**
 * Decode tail bytes as a final line (for EOF without trailing newline).
 */
export function decodeTailAsLine(
  tailBytes: Uint8Array,
  decoder: TextDecoder
): string | null {
  if (tailBytes.length === 0) return null;
  try {
    const line = decoder.decode(tailBytes, { stream: false });
    const trimmed = line.trim();
    return trimmed.length > 0 ? trimmed : null;
  } catch {
    console.warn("[bulk-jsonl] Invalid UTF-8 in tail, skipping");
    return null;
  }
}

/**
 * Process a batch of JSONL lines for companies.
 * Also handles orphan locations by looking up parent company in DB.
 *
 * Orphan location handling: Orphan locations (whose parent company was in an
 * earlier chunk) are marked with contactKnown=false so their mainContact*
 * columns are preserved rather than overwritten with NULL.
 *
 * @param sql - postgres.js SQL client
 * @param shopId - Shop ID
 * @param lines - JSONL lines to process
 * @param env - Environment for PII flag (required)
 */
async function processCompanyLines(
  sql: Sql,
  shopId: string,
  lines: string[],
  env: import("./customer-fields.server").PiiEnv
): Promise<number> {
  const jsonl = lines.join("\n");
  const { companies, orphanLocations, errors } = parseCompanyBulkJsonl(jsonl);

  if (errors.length > 0) {
    console.warn(
      `[bulk-jsonl] ${errors.length} parse errors in companies batch`
    );
  }

  // Map company locations to buyer accounts
  const accounts: import("./company-location.server").MappedBuyerAccount[] = [];

  // Process locations from companies in this batch
  // Pass company's mainContact to each location (B2B recipient is the company's main contact)
  // contactKnown=true because we have the company data
  for (const { company, locations } of companies.values()) {
    for (const loc of locations) {
      const shopifyLoc = bulkLocationToShopifyLocation(loc, company.mainContact);
      accounts.push(mapCompanyLocationToBuyerAccount(shopId, shopifyLoc, env, true));
    }
  }

  // Handle orphan locations: parent company from earlier chunk or slice
  // Map unconditionally using parent company GID - guarded upserts handle duplicates
  // This ensures locations are processed even when company ended previous slice
  // contactKnown=false so existing mainContact* values are preserved
  for (const orphanLoc of orphanLocations) {
    const shopifyLoc = bulkLocationToShopifyLocation(orphanLoc);
    accounts.push(mapCompanyLocationToBuyerAccount(shopId, shopifyLoc, env, false));
  }

  return await bulkUpsertBuyerAccounts(sql, accounts);
}

/**
 * Process a batch of JSONL lines for orders.
 *
 * Eligibility gates CREATION only. If an Invoice already exists for an order,
 * it is ALWAYS updated (to heal status changes like PAID, REFUNDED, etc.).
 *
 * Orphan schedules (PaymentSchedule lines whose parent Order is not in this batch)
 * are handled by updating the dueAt on existing Invoices for those parent orders.
 *
 * Exported for testing.
 */
export async function processOrderLines(
  sql: Sql,
  shopId: string,
  shopDomain: string,
  lines: string[],
  context?: EligibilityContext
): Promise<number> {
  const jsonl = lines.join("\n");
  const { orders, orphanSchedules, attachedChildCount, orphanChildCount, errors } = parseOrderBulkJsonl(jsonl);

  if (errors.length > 0) {
    console.warn(`[bulk-jsonl] ${errors.length} parse errors in orders batch`);
  }

  // #292: Filter out orders with missing or non-INR currency (fail-closed)
  // Orders created before shop switched to INR should not be stored as INR amounts
  // Orders without currency code are also skipped
  const skippedOrders = orders.filter((o) => {
    const currency = o.totalPriceSet?.shopMoney?.currencyCode;
    return !currency || currency !== SUPPORTED_SHOP_CURRENCY;
  });
  if (skippedOrders.length > 0) {
    const hash = await shopHash(shopDomain);
    safeLog("info", "drain_skip_non_inr_order", { shopHash: hash, count: skippedOrders.length });
  }
  const inrOrders = orders.filter((o) => {
    const currency = o.totalPriceSet?.shopMoney?.currencyCode;
    return currency && currency === SUPPORTED_SHOP_CURRENCY;
  });

  if (attachedChildCount > 0 || orphanChildCount > 0) {
    console.log(`[bulk-jsonl] PaymentSchedule children: ${attachedChildCount} attached, ${orphanChildCount} orphaned`);
  }

  // Handle orphan schedules by updating existing invoices (P1 safety net)
  // Skip paid/cancelled/closed invoices. Batch updates using SQL arrays.
  let orphansUpdated = 0;
  if (orphanSchedules.length > 0) {
    const orphanParentIds = orphanSchedules.map((s) => s.__parentId);
    // Batch lookup existing open invoices for orphan parents (skip paid/cancelled/closed)
    // S25: Use IN ${sql(ids)} for fetch_types:false compatibility
    const existingOrphanInvoices = await sql<{ id: string; orderId: string }[]>`
      SELECT id, "orderId" FROM "Invoice"
      WHERE "shopId" = ${shopId}
        AND "orderId" IN ${sql(orphanParentIds)}
        AND status = 'open'
    `;
    const invoiceByOrderId = new Map(existingOrphanInvoices.map((i) => [i.orderId, i.id]));

    // Build arrays for batched UPDATE
    const updateIds: string[] = [];
    const updateDueAts: string[] = [];
    const updateReasons: string[] = [];

    for (const schedule of orphanSchedules) {
      const invoiceId = invoiceByOrderId.get(schedule.__parentId);
      if (invoiceId && schedule.dueAt) {
        updateIds.push(invoiceId);
        updateDueAts.push(schedule.dueAt);
        updateReasons.push("Payment schedule from Shopify (orphan reconcile)");
      }
    }

    // Batch UPDATE using unnest
    if (updateIds.length > 0) {
      const result = await sql`
        UPDATE "Invoice" AS i
        SET
          "dueAt" = v."dueAt"::timestamptz,
          "dueSource" = 'schedule',
          "dueBasis" = NULL,
          "dueReason" = v."dueReason"
        FROM unnest(
          ${updateIds}::text[],
          ${updateDueAts}::timestamptz[],
          ${updateReasons}::text[]
        ) AS v(id, "dueAt", "dueReason")
        WHERE i.id = v.id
          AND (i."dueAt" IS DISTINCT FROM v."dueAt"::timestamptz)
      `;
      orphansUpdated = result.count;
    }

    if (orphansUpdated > 0) {
      console.log(`[bulk-jsonl] ${orphansUpdated} orphan schedules updated existing invoices`);
    }
  }

  if (inrOrders.length === 0) {
    return orphansUpdated;
  }

  // Batch lookup: find existing invoices with their buyer account IDs, merchant overrides, and status (P2 fix)
  // S25: Handle empty list case by skipping query
  const orderIds = inrOrders.map((o) => o.id);
  let existingInvoices: {
    orderId: string;
    buyerAccountId: string;
    dueOverrideAt: Date | null;
    dueSource: string;
    dueAt: Date | null;
    outstanding: string;
    status: "open" | "paid" | "cancelled";
  }[] = [];
  
  if (orderIds.length > 0) {
    existingInvoices = await sql<typeof existingInvoices>`
      SELECT "orderId", "buyerAccountId", "dueOverrideAt", "dueSource", "dueAt",
             outstanding::text, status::"InvoiceStatus"
      FROM "Invoice"
      WHERE "shopId" = ${shopId} AND "orderId" IN ${sql(orderIds)}
    `;
  }
  const existingByOrderId = new Map(existingInvoices.map((i) => [i.orderId, i]));

  // Separate orders into existing and new for different processing paths
  const ordersWithExisting: typeof inrOrders = [];
  const ordersWithoutExisting: typeof inrOrders = [];
  for (const order of inrOrders) {
    if (existingByOrderId.has(order.id)) {
      ordersWithExisting.push(order);
    } else {
      ordersWithoutExisting.push(order);
    }
  }

  // Get eligibility context if needed (for new orders or context resolution)
  let eligibilityContext: EligibilityContext | null = context ?? null;
  const needsContext = ordersWithoutExisting.some(
    (o) => !isTerminalFinancialStatus(o.displayFinancialStatus)
  ) || ordersWithExisting.length > 0;
  
  if (needsContext && !eligibilityContext) {
    eligibilityContext = await getEligibilityContext(sql, shopId);
    if (!eligibilityContext) {
      console.warn(`[bulk-jsonl] No eligibility context for shop ${shopId}`);
    }
  }

  const invoices: InvoiceData[] = [];
  let skippedCount = 0;
  let outstandingMissingCount = 0;

  // Process existing invoices: mirror webhook path (order.server.ts:111-118)
  // Call checkOrderEligibility with full context for due-date precedence
  for (const order of ordersWithExisting) {
    const shopifyOrder = bulkOrderToShopifyOrder(order);
    const existing = existingByOrderId.get(shopifyOrder.id)!;

    // Mirror webhook path: call checkOrderEligibility for proper due-date precedence
    // This ensures account defaults, tag rules, and merchant overrides are respected
    if (eligibilityContext) {
      const eligibility = await checkOrderEligibility(sql, shopifyOrder, eligibilityContext);
      
      // Check if invoice has a merchant override that should be preserved
      // A schedule dueAt beats merchant override, but merchant override beats inferred
      const hasScheduleDueAt = hasOrderScheduleDueAt(shopifyOrder);
      const hasMerchantOverride = existing.dueOverrideAt !== null;
      
      let finalDueDate = eligibility.dueDate;
      
      // If no schedule dueAt and merchant override exists, use the existing dueAt
      // (merchant override was already applied to existing.dueAt)
      if (!hasScheduleDueAt && hasMerchantOverride) {
        finalDueDate = {
          dueAt: existing.dueAt,
          dueSource: "override" as const,
          basis: null,
          reason: "Merchant override preserved during reconcile",
        };
      }
      
      // Pass existing outstanding/status for fallback when totalOutstandingSet is missing (P2 fix)
      const { invoiceData, outstandingMissing } = mapOrderToInvoiceWithEligibility(
        shopId,
        eligibility.buyerAccountId ?? existing.buyerAccountId,
        shopifyOrder,
        {
          ...eligibility,
          eligible: true,
          buyerAccountId: eligibility.buyerAccountId ?? existing.buyerAccountId,
          dueDate: finalDueDate,
        },
        { outstanding: existing.outstanding, status: existing.status }
      );
      invoices.push(invoiceData);
      if (outstandingMissing) {
        outstandingMissingCount++;
      }
    } else {
      // No eligibility context - preserve existing dueAt (don't overwrite with shop default)
      // Also pass existing outstanding/status for fallback (P2 fix)
      const { invoiceData, outstandingMissing } = mapOrderToInvoiceWithEligibility(
        shopId,
        existing.buyerAccountId,
        shopifyOrder,
        {
          eligible: true,
          reason: "shopify_payment_terms",
          explanation: "Updating existing invoice (no context, preserving dueAt)",
          buyerAccountId: existing.buyerAccountId,
          dueDate: existing.dueAt
            ? {
                dueAt: existing.dueAt,
                dueSource: existing.dueSource as "schedule" | "override" | "inferred" | "none",
                basis: null,
                reason: "Preserved during reconcile (no context)",
              }
            : undefined,
        },
        { outstanding: existing.outstanding, status: existing.status }
      );
      invoices.push(invoiceData);
      if (outstandingMissing) {
        outstandingMissingCount++;
      }
    }
  }

  // Process new orders: check eligibility for creation
  for (const order of ordersWithoutExisting) {
    const shopifyOrder = bulkOrderToShopifyOrder(order);
    
    if (eligibilityContext) {
      const eligibility = await checkOrderEligibility(sql, shopifyOrder, eligibilityContext);
      if (eligibility.eligible) {
        const { invoiceData, outstandingMissing } = mapOrderToInvoiceWithEligibility(
          shopId,
          eligibility.buyerAccountId!,
          shopifyOrder,
          eligibility
        );
        invoices.push(invoiceData);
        if (outstandingMissing) {
          outstandingMissingCount++;
        }
      } else {
        skippedCount++;
      }
    } else {
      // No eligibility context and no existing invoice - skip
      skippedCount++;
    }
  }

  if (skippedCount > 0) {
    console.log(`[bulk-jsonl] ${skippedCount} orders skipped (not eligible, no existing invoice)`);
  }

  const upserted = await bulkUpsertInvoices(sql, invoices);

  // Best-effort increment of diagnostic counter (single DB round-trip for the batch)
  if (outstandingMissingCount > 0) {
    try {
      // Get shop domain from eligibility context for the counter
      const [shopRow] = await sql<{ domain: string }[]>`
        SELECT domain FROM "Shop" WHERE id = ${shopId}
      `;
      if (shopRow) {
        await incrementOrderOutstandingMissing(sql, shopRow.domain, outstandingMissingCount);
      }
    } catch (err) {
      safeLog("warn", "bulk_order_outstanding_missing_counter_failed", { shopId, err: toErrorCode(err) });
    }
  }

  return upserted + orphansUpdated;
}

/**
 * Check if an order has a PaymentSchedule with dueAt set.
 */
function hasOrderScheduleDueAt(order: import("./types").ShopifyOrder): boolean {
  const schedules = order.paymentTerms?.paymentSchedules?.edges ?? [];
  return schedules.some((e) => e.node.dueAt != null);
}


/**
 * Process a batch of JSONL lines for customers.
 */
async function processCustomerLines(
  sql: Sql,
  shop: string,
  lines: string[]
): Promise<number> {
  const jsonl = lines.join("\n");
  const { customers, errors } = parseCustomerBulkJsonl(jsonl);

  if (errors.length > 0) {
    console.warn(
      `[bulk-jsonl] ${errors.length} parse errors in customers batch`
    );
  }

  // Determine piiMode based on CUSTOMER_PII_FIELDS env
  const env = getRequestEnv() ?? {};
  const piiMode: CustomerPiiMode = env.CUSTOMER_PII_FIELDS === "1" ? "fetched" : "disabled";

  let processed = 0;
  for (const customer of customers) {
    const shopifyCustomer = bulkCustomerToShopifyCustomer(customer);
    const result = await processBulkCustomer(sql, shop, shopifyCustomer, piiMode);
    if (result.success && result.action !== "skipped") {
      processed++;
    }
  }

  return processed;
}


/**
 * Load bulk operation progress from database.
 */
export async function loadBulkOperationProgress(
  sql: Sql,
  bulkOperationId: string
): Promise<{
  byteOffset: number;
  completedAt: Date | null;
  closedAt: Date | null;
  chunkSize: number;
  failureCount: number;
} | null> {
  const [row] = await sql<{
    byte_offset: string | null;
    completed_at: Date | null;
    closed_at: Date | null;
    chunk_size: number;
    failure_count: number;
  }[]>`
    SELECT byte_offset, completed_at, closed_at, chunk_size, failure_count
    FROM s6_bulk_operations
    WHERE bulk_operation_id = ${bulkOperationId}
  `;

  if (!row) return null;

  return {
    byteOffset: row.byte_offset !== null ? parseInt(row.byte_offset, 10) : 0,
    completedAt: row.completed_at,
    closedAt: row.closed_at,
    chunkSize: row.chunk_size,
    failureCount: row.failure_count,
  };
}

/**
 * Save bulk operation progress to database.
 * byte_offset is the end of the last fully processed line.
 *
 * S25: Progress saves never write completed_at, only advance byte_offset.
 * Only updates if byte_offset < new AND completed_at IS NULL.
 * This prevents reopening a closed/completed row.
 */
export async function saveBulkOperationProgress(
  sql: Sql,
  bulkOperationId: string,
  byteOffset: number,
  _completedAt: Date | null = null,
  chunkSize?: number
): Promise<{ rowUpdated: boolean }> {
  let result;
  if (chunkSize !== undefined) {
    result = await sql`
      UPDATE s6_bulk_operations
      SET byte_offset = ${byteOffset},
          chunk_size = ${chunkSize}
      WHERE bulk_operation_id = ${bulkOperationId}
        AND closed_at IS NULL
        AND completed_at IS NULL
        AND (byte_offset IS NULL OR byte_offset < ${byteOffset})
    `;
  } else {
    result = await sql`
      UPDATE s6_bulk_operations
      SET byte_offset = ${byteOffset}
      WHERE bulk_operation_id = ${bulkOperationId}
        AND closed_at IS NULL
        AND completed_at IS NULL
        AND (byte_offset IS NULL OR byte_offset < ${byteOffset})
    `;
  }
  return { rowUpdated: result.count > 0 };
}

/**
 * Claim bulk operation completion atomically.
 * Only the winner gets to chain nextStage; losers mark their message processed and skip.
 *
 * S25: This is the ONLY path that writes completed_at.
 *
 * @returns true if this caller won the claim, false otherwise
 */
export async function claimBulkCompletion(
  sql: Sql,
  bulkOperationId: string
): Promise<boolean> {
  const result = await sql`
    UPDATE s6_bulk_operations
    SET completed_at = now()
    WHERE bulk_operation_id = ${bulkOperationId}
      AND completed_at IS NULL
      AND closed_at IS NULL
    RETURNING bulk_operation_id
  `;
  return result.count > 0;
}

/**
 * Acquire processing lease atomically.
 * Returns true if lease acquired, false if another processor holds the lease.
 *
 * S25: Processing lease prevents concurrent processing of the same bulk op.
 * Losing the lease is retryable WITHOUT bumping failure_count.
 */
export async function acquireProcessingLease(
  sql: Sql,
  bulkOperationId: string
): Promise<boolean> {
  const result = await sql`
    UPDATE s6_bulk_operations
    SET processing_lease_until = now() + interval '${sql.unsafe(String(PROCESSING_LEASE_SECONDS))} seconds'
    WHERE bulk_operation_id = ${bulkOperationId}
      AND closed_at IS NULL
      AND (processing_lease_until IS NULL OR processing_lease_until < now())
    RETURNING bulk_operation_id
  `;
  return result.count > 0;
}

/**
 * Release processing lease (e.g., on completion or when giving up).
 */
export async function releaseProcessingLease(
  sql: Sql,
  bulkOperationId: string
): Promise<void> {
  await sql`
    UPDATE s6_bulk_operations
    SET processing_lease_until = NULL
    WHERE bulk_operation_id = ${bulkOperationId}
      AND closed_at IS NULL
  `;
}

/**
 * Set next_stage_enqueued_at atomically to prevent duplicate nextStage enqueues.
 * Returns true if this is the first enqueue, false if already set.
 */
export async function markNextStageEnqueued(
  sql: Sql,
  bulkOperationId: string
): Promise<boolean> {
  const result = await sql`
    UPDATE s6_bulk_operations
    SET next_stage_enqueued_at = now()
    WHERE bulk_operation_id = ${bulkOperationId}
      AND next_stage_enqueued_at IS NULL
      AND closed_at IS NULL
    RETURNING bulk_operation_id
  `;
  return result.count > 0;
}

/**
 * Process lines based on bulk type.
 */
async function processLines(
  sql: Sql,
  shop: string,
  shopId: string,
  bulkType: string,
  lines: string[]
): Promise<number> {
  // Get Worker env for PII flag (used by companies and customers)
  const env = getRequestEnv() ?? {};
  
  switch (bulkType) {
    case "companies":
      return await processCompanyLines(sql, shopId, lines, env);
    case "orders":
      return await processOrderLines(sql, shopId, shop, lines);
    case "customers":
      return await processCustomerLines(sql, shop, lines);
    default:
      console.warn(`[bulk-jsonl] Unknown bulk type: ${bulkType}`);
      return 0;
  }
}

/**
 * Process a BULK_OPERATIONS_FINISH message.
 *
 * Downloads JSONL in chunks, processes lines, and tracks progress for
 * resumption after CPU budget cuts.
 *
 * @param sql - postgres.js SQL client
 * @param message - Bulk message from queue
 * @param maxLines - Max lines to process per invocation (default 100)
 * @returns Sync result with status field
 */
export async function processBulkOperation(
  sql: Sql,
  message: BulkMessage,
  maxLines: number = DEFAULT_MAX_LINES
): Promise<BulkProcessResult> {
  const { shop, webhookId, bulkOperationId, bulkType } = message;

  // Idempotency check
  if (await isWebhookProcessed(sql, webhookId)) {
    return {
      success: true,
      action: "skipped",
      skipReason: "Webhook already processed (idempotent)",
      status: "complete",
    };
  }

  // Get shop ID
  const [shopRow] = await sql<{ id: string }[]>`
    SELECT id FROM "Shop" WHERE domain = ${shop}
  `;

  if (!shopRow) {
    return {
      success: false,
      action: "skipped",
      error: "shop_not_found",
      status: "error",
      errorType: "permanent", // Bad data, shop doesn't exist
    };
  }

  const shopId = shopRow.id;

  // Load existing progress
  const progress = await loadBulkOperationProgress(sql, bulkOperationId);

  if (!progress) {
    return {
      success: false,
      action: "skipped",
      error: `Bulk operation not found: ${bulkOperationId}`,
      status: "error",
      errorType: "permanent", // Bad data, operation not registered
    };
  }

  // If already completed or closed, skip
  if (progress.completedAt || progress.closedAt) {
    await markWebhookProcessed(
      sql,
      webhookId,
      "BULK_OPERATIONS_FINISH",
      bulkOperationId
    );
    return {
      success: true,
      action: "skipped",
      skipReason: progress.closedAt
        ? "Bulk operation closed (reinstall reset)"
        : "Bulk operation already completed",
      status: "complete",
    };
  }

  // S25: Acquire processing lease to prevent concurrent processing
  const leaseAcquired = await acquireProcessingLease(sql, bulkOperationId);
  if (!leaseAcquired) {
    // Losing the lease is retryable WITHOUT bumping failure_count
    return {
      success: false,
      action: "skipped",
      error: BULK_ERROR_CODES.LEASE_CONTENTION,
      errorCode: BULK_ERROR_CODES.LEASE_CONTENTION,
      status: "error",
      errorType: "retryable",
    };
  }

  // S25: Use try/finally to ensure lease is ALWAYS released on any exit path
  try {
  // Check failure count - if already at max, this goes to DLQ
  if (progress.failureCount >= MAX_FAILURE_COUNT) {
    return {
      success: false,
      action: "skipped",
      error: BULK_ERROR_CODES.MAX_FAILURES,
      errorCode: BULK_ERROR_CODES.MAX_FAILURES,
      status: "error",
      errorType: "permanent",
    };
  }

  // Get result URL from Shopify
  const statusResult = await getBulkOperationStatus(shop, bulkOperationId);

  // S25: Handle empty results (COMPLETED with url null and objectCount 0)
  // Per Shopify docs: COMPLETED with url=null and objectCount=0 is a valid empty result
  // Note: objectCount is UnsignedInt64 serialized as STRING in Shopify's JSON response
  if (statusResult.success && statusResult.data) {
    const { status, url, objectCount, partialDataUrl } = statusResult.data;
    const parsedObjectCount = objectCount != null ? Number(objectCount) : null;
    
    if (status === "COMPLETED" && url === null && parsedObjectCount === 0) {
      // Empty result - complete the operation with 0 lines processed
      const claimed = await claimBulkCompletion(sql, bulkOperationId);
      await markWebhookProcessed(
        sql,
        webhookId,
        "BULK_OPERATIONS_FINISH",
        bulkOperationId
      );

      safeLog("info", "bulk_jsonl_completed", {
        shopId,
        bulkType,
        status: "empty_result",
        lineCount: 0,
      });

      // Only chain to next stage if this caller won the completion claim
      let nextStage: "customers" | "orders" | undefined;
      if (claimed) {
        const metadata = await getBulkOperationMetadata(sql, bulkOperationId);
        nextStage =
          metadata?.origin === "reconcile"
            ? getNextStage(metadata.reconcileStage)
            : undefined;
      }

      return {
        success: true,
        action: "updated",
        entityId: bulkOperationId,
        status: "complete",
        nextStage,
        chainToOrders: nextStage === "orders",
      };
    }

    // S25: partialDataUrl set or objectCount > 0 with no url is a permanent error
    if (status === "COMPLETED" && url === null && (partialDataUrl || (parsedObjectCount != null && parsedObjectCount > 0))) {
      return {
        success: false,
        action: "skipped",
        error: BULK_ERROR_CODES.NO_RESULT_URL,
        errorCode: BULK_ERROR_CODES.NO_RESULT_URL,
        status: "error",
        errorType: "permanent",
      };
    }
  }

  if (!statusResult.success || !statusResult.data?.url) {
    // Increment failure count for retryable API error
    const newFailureCount = await incrementBulkOperationFailureCount(
      sql,
      bulkOperationId
    );
    const exhaustedRetries = newFailureCount >= MAX_FAILURE_COUNT;
    const errorCode = exhaustedRetries ? BULK_ERROR_CODES.MAX_FAILURES : BULK_ERROR_CODES.NO_RESULT_URL;
    return {
      success: false,
      action: "skipped",
      error: errorCode,
      errorCode,
      status: "error",
      errorType: exhaustedRetries ? "permanent" : "retryable",
    };
  }

  const resultUrl = statusResult.data.url;
  const startByteOffset = progress.byteOffset;
  const currentChunkSize = progress.chunkSize;

  // Fetch chunk starting from saved offset
  const chunkResult = await fetchJsonlChunk(
    resultUrl,
    startByteOffset,
    currentChunkSize
  );

  if (!chunkResult.success || !chunkResult.bytes) {
    // Classify error based on HTTP status
    const httpErrorType = classifyHttpError(chunkResult.httpStatus);

    if (httpErrorType === "permanent") {
      // Permanent error (4xx) - go straight to DLQ
      return {
        success: false,
        action: "skipped",
        error: BULK_ERROR_CODES.CHUNK_HTTP_4XX,
        errorCode: BULK_ERROR_CODES.CHUNK_HTTP_4XX,
        status: "error",
        errorType: "permanent",
      };
    }

    // Retryable error - increment failure count
    const newFailureCount = await incrementBulkOperationFailureCount(
      sql,
      bulkOperationId
    );
    const exhaustedRetries = newFailureCount >= MAX_FAILURE_COUNT;
    const errorCode = exhaustedRetries ? BULK_ERROR_CODES.MAX_FAILURES : BULK_ERROR_CODES.PROCESSING_ERROR;
    return {
      success: false,
      action: "skipped",
      error: errorCode,
      errorCode,
      status: "error",
      errorType: exhaustedRetries ? "permanent" : "retryable",
    };
  }

  const bytes = chunkResult.bytes;

  // Handle empty response at EOF
  if (bytes.length === 0 && chunkResult.isEof) {
    // S25: Use claimBulkCompletion for exactly-once completion
    const claimed = await claimBulkCompletion(sql, bulkOperationId);
    await markWebhookProcessed(
      sql,
      webhookId,
      "BULK_OPERATIONS_FINISH",
      bulkOperationId
    );

    safeLog("info", "bulk_jsonl_completed", {
      shopId,
      bulkType,
      status: "eof_reached",
    });

    // Only chain to next stage if this caller won the completion claim
    let nextStage: "customers" | "orders" | undefined;
    if (claimed) {
      const metadata = await getBulkOperationMetadata(sql, bulkOperationId);
      nextStage =
        metadata?.origin === "reconcile"
          ? getNextStage(metadata.reconcileStage)
          : undefined;
    }

    return {
      success: true,
      action: "updated",
      entityId: bulkOperationId,
      status: "complete",
      nextStage,
      chainToOrders: nextStage === "orders",
    };
  }

  // Split bytes into complete lines using TextDecoder with fatal mode
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const { lines, lineEndPositions, bytesConsumed, tailBytes } =
    splitBytesIntoLines(bytes, decoder);

  // Handle case where no newlines found in chunk (bytesConsumed===0 means no newlines)
  if (bytesConsumed === 0 && !chunkResult.isEof) {
    // No newlines found - grow the range window
    const newChunkSize = Math.min(currentChunkSize * 2, MAX_CHUNK_SIZE);

    if (newChunkSize <= currentChunkSize) {
      // Already at max chunk size - line exceeds cap, terminal error (bad data)
      return {
        success: false,
        action: "skipped",
        error: `Line exceeds ${MAX_CHUNK_SIZE} byte cap`,
        status: "error",
        errorType: "permanent", // Bad data, not retryable
      };
    }

    // Save increased chunk size and retry
    await updateBulkOperationChunkSize(sql, bulkOperationId, newChunkSize);

    // Reset failure count on successful progress
    await resetBulkOperationFailureCount(sql, bulkOperationId);

    console.log(
      `[bulk-jsonl] No newlines in ${currentChunkSize}B chunk, growing to ${newChunkSize}B`
    );

    return {
      success: true,
      action: "updated",
      entityId: bulkOperationId,
      status: "progress",
    };
  }

  // At EOF, also process any remaining tail as a final line
  const allLines = [...lines];
  let finalByteOffset = startByteOffset + bytesConsumed;

  if (chunkResult.isEof && tailBytes.length > 0) {
    const tailLine = decodeTailAsLine(tailBytes, decoder);
    if (tailLine) {
      allLines.push(tailLine);
      // Final offset is end of file
      finalByteOffset = startByteOffset + bytes.length;
    }
  }

  // Limit lines processed per invocation, but for orders:
  // Never end a non-EOF batch on a top-level (parent) line.
  // This prevents splitting parent Orders from their PaymentSchedule children.
  let linesToProcess = allLines.slice(0, maxLines);
  
  // P1 approach (a): On non-EOF order batches with >1 line, if the final line is
  // top-level (no __parentId), drop just that final line. Children immediately
  // follow their parent, so if the final line is a child, its parent is in the batch.
  // A 1-line batch always processes (to avoid stall).
  //
  // NOTE: Ending on a child line assumes it is the last sibling for that parent.
  // This is valid because BULK_ORDERS_QUERY requests paymentSchedules(first: 1),
  // so each Order has at most one PaymentSchedule child line in the bulk export.
  const isNonEofBatch = !chunkResult.isEof || linesToProcess.length < allLines.length;
  if (bulkType === "orders" && isNonEofBatch && linesToProcess.length > 1) {
    const finalLine = linesToProcess[linesToProcess.length - 1];
    if (!lineHasParentId(finalLine)) {
      // Final line is top-level (a parent Order) - its children may be in the next batch
      // Drop just this final line and move offset back to its start
      console.log(`[bulk-jsonl] Dropping final top-level line to keep parent/child together (${linesToProcess.length} -> ${linesToProcess.length - 1})`);
      linesToProcess = linesToProcess.slice(0, -1);
    }
    // If final line is a child (__parentId), its parent is already in this batch - keep all
  }

  // Process lines
  let totalUpserted = 0;
  if (linesToProcess.length > 0) {
    try {
      totalUpserted = await processLines(
        sql,
        shop,
        shopId,
        bulkType,
        linesToProcess
      );
    } catch {
      // Increment failure count on processing error
      await incrementBulkOperationFailureCount(sql, bulkOperationId);
      return {
        success: false,
        action: "skipped",
        error: BULK_ERROR_CODES.PROCESSING_ERROR,
        errorCode: BULK_ERROR_CODES.PROCESSING_ERROR,
        status: "error",
        errorType: "retryable",
      };
    }
  }

  // Calculate new byte offset using per-line positions
  let newByteOffset: number;

  if (linesToProcess.length === allLines.length) {
    // Processed all lines (including tail if at EOF)
    newByteOffset = finalByteOffset;
  } else {
    // Processed only some lines - use position from lineEndPositions
    const processedCount = Math.min(linesToProcess.length, lineEndPositions.length);
    if (processedCount > 0) {
      newByteOffset = startByteOffset + lineEndPositions[processedCount - 1];
    } else {
      newByteOffset = startByteOffset;
    }
  }

  // Check if we've reached EOF and processed everything
  const isComplete =
    chunkResult.isEof && linesToProcess.length === allLines.length;

  if (isComplete) {
    // S25: Use claimBulkCompletion for exactly-once completion
    const claimed = await claimBulkCompletion(sql, bulkOperationId);
    await markWebhookProcessed(
      sql,
      webhookId,
      "BULK_OPERATIONS_FINISH",
      bulkOperationId
    );

    safeLog("info", "bulk_jsonl_completed", {
      shopId,
      bulkType,
      lineCount: linesToProcess.length,
      upsertedCount: totalUpserted,
    });

    // Only chain to next stage if this caller won the completion claim
    let nextStage: "customers" | "orders" | undefined;
    if (claimed) {
      const metadata = await getBulkOperationMetadata(sql, bulkOperationId);
      nextStage =
        metadata?.origin === "reconcile"
          ? getNextStage(metadata.reconcileStage)
          : undefined;
    }

    return {
      success: true,
      action: "updated",
      entityId: bulkOperationId,
      status: "complete",
      nextStage,
      chainToOrders: nextStage === "orders",
    };
  }

  // Save progress for next iteration
  // Reset chunk size to default if we found lines
  const nextChunkSize = lines.length > 0 ? DEFAULT_CHUNK_SIZE : currentChunkSize;
  await saveBulkOperationProgress(sql, bulkOperationId, newByteOffset, null, nextChunkSize);

  // Reset failure count on successful progress
  await resetBulkOperationFailureCount(sql, bulkOperationId);

  safeLog("info", "bulk_jsonl_progress", {
    shopId,
    bulkType,
    byteOffset: newByteOffset,
    lineCount: linesToProcess.length,
    upsertedCount: totalUpserted,
  });

  return {
    success: true,
    action: "updated",
    entityId: bulkOperationId,
    status: "progress",
  };
  } finally {
    // S25: Always release processing lease on any exit path
    await releaseProcessingLease(sql, bulkOperationId);
  }
}
