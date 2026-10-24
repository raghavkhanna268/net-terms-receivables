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
  type EligibilityContext,
} from "~/lib/invoice-eligibility";
import { isWebhookProcessed, markWebhookProcessed } from "./company.server";
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
 * Error classification for retry logic.
 * - retryable: network, 5xx, 429, timeouts - increment failure_count, retry until 5
 * - permanent: 4xx (not 429), bad data - go straight to DLQ
 */
export type ErrorType = "retryable" | "permanent";

/**
 * Result of a bulk operation processing.
 * Extends SyncResult with a status field for progress tracking.
 */
export interface BulkProcessResult extends SyncResult {
  /** Processing status: 'complete', 'progress', or 'error' */
  status?: "complete" | "progress" | "error";
  /** Whether to chain to orders reconcile after companies complete */
  chainToOrders?: boolean;
  /** Error classification for retry logic (only set when status='error') */
  errorType?: ErrorType;
}

/**
 * Bulk operation status from Shopify.
 */
interface BulkOperationStatus {
  id: string;
  status: string;
  url: string | null;
  fileSize: number | null;
  objectCount: number | null;
  errorCode: string | null;
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
    // Network errors are retryable
    return {
      success: false,
      isEof: false,
      error: err instanceof Error ? err.message : "Network error",
      httpStatus: 0, // Network error, not an HTTP response
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
 */
async function processCompanyLines(
  sql: Sql,
  shopId: string,
  lines: string[]
): Promise<number> {
  const jsonl = lines.join("\n");
  const { companies, orphanLocations, errors } = parseCompanyBulkJsonl(jsonl);

  if (errors.length > 0) {
    console.warn(
      `[bulk-jsonl] ${errors.length} parse errors in companies batch`
    );
  }

  // Map company locations to buyer accounts
  const accounts: ReturnType<typeof mapCompanyLocationToBuyerAccount>[] = [];

  // Process locations from companies in this batch
  for (const { locations } of companies.values()) {
    for (const loc of locations) {
      const shopifyLoc = bulkLocationToShopifyLocation(loc);
      accounts.push(mapCompanyLocationToBuyerAccount(shopId, shopifyLoc));
    }
  }

  // Handle orphan locations: parent company from earlier chunk or slice
  // Map unconditionally using parent company GID - guarded upserts handle duplicates
  // This ensures locations are processed even when company ended previous slice
  for (const orphanLoc of orphanLocations) {
    const shopifyLoc = bulkLocationToShopifyLocation(orphanLoc);
    accounts.push(mapCompanyLocationToBuyerAccount(shopId, shopifyLoc));
  }

  return await bulkUpsertBuyerAccounts(sql, accounts);
}

/**
 * Process a batch of JSONL lines for orders.
 *
 * Eligibility gates CREATION only. If an Invoice already exists for an order,
 * it is ALWAYS updated (to heal status changes like PAID, REFUNDED, etc.).
 */
async function processOrderLines(
  sql: Sql,
  shopId: string,
  lines: string[],
  context?: EligibilityContext
): Promise<number> {
  const jsonl = lines.join("\n");
  const { orders, errors } = parseOrderBulkJsonl(jsonl);

  if (errors.length > 0) {
    console.warn(`[bulk-jsonl] ${errors.length} parse errors in orders batch`);
  }

  if (orders.length === 0) {
    return 0;
  }

  // Get eligibility context if not provided
  const eligibilityContext = context ?? await getEligibilityContext(sql, shopId);
  if (!eligibilityContext) {
    console.warn(`[bulk-jsonl] No eligibility context for shop ${shopId}`);
    return 0;
  }

  // Batch lookup: find existing invoices for these orders
  const orderIds = orders.map((o) => o.id);
  const existingInvoices = await sql<{ orderId: string; buyerAccountId: string }[]>`
    SELECT "orderId", "buyerAccountId" FROM "Invoice"
    WHERE "shopId" = ${shopId} AND "orderId" = ANY(${orderIds})
  `;
  const existingByOrderId = new Map(existingInvoices.map((i) => [i.orderId, i.buyerAccountId]));

  const invoices: InvoiceData[] = [];
  let skippedCount = 0;

  for (const order of orders) {
    const shopifyOrder = bulkOrderToShopifyOrder(order);
    const existingBuyerAccountId = existingByOrderId.get(shopifyOrder.id);

    // Check eligibility
    const eligibility = await checkOrderEligibility(sql, shopifyOrder, eligibilityContext);

    if (existingBuyerAccountId) {
      // Invoice exists - ALWAYS update it (eligibility only gates creation)
      invoices.push(
        mapOrderToInvoiceWithEligibility(
          shopId,
          eligibility.buyerAccountId ?? existingBuyerAccountId,
          shopifyOrder,
          eligibility
        )
      );
    } else if (eligibility.eligible) {
      // No existing Invoice and eligible - create it
      invoices.push(
        mapOrderToInvoiceWithEligibility(
          shopId,
          eligibility.buyerAccountId!,
          shopifyOrder,
          eligibility
        )
      );
    } else {
      skippedCount++;
    }
  }

  if (skippedCount > 0) {
    console.log(`[bulk-jsonl] ${skippedCount} orders skipped (not eligible, no existing invoice)`);
  }

  return await bulkUpsertInvoices(sql, invoices);
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
  chunkSize: number;
  failureCount: number;
} | null> {
  const [row] = await sql<{
    byte_offset: string | null;
    completed_at: Date | null;
    chunk_size: number;
    failure_count: number;
  }[]>`
    SELECT byte_offset, completed_at, chunk_size, failure_count
    FROM s6_bulk_operations
    WHERE bulk_operation_id = ${bulkOperationId}
  `;

  if (!row) return null;

  return {
    byteOffset: row.byte_offset !== null ? parseInt(row.byte_offset, 10) : 0,
    completedAt: row.completed_at,
    chunkSize: row.chunk_size,
    failureCount: row.failure_count,
  };
}

/**
 * Save bulk operation progress to database.
 * byte_offset is the end of the last fully processed line.
 */
export async function saveBulkOperationProgress(
  sql: Sql,
  bulkOperationId: string,
  byteOffset: number,
  completedAt: Date | null = null,
  chunkSize?: number
): Promise<void> {
  if (chunkSize !== undefined) {
    await sql`
      UPDATE s6_bulk_operations
      SET byte_offset = ${byteOffset},
          completed_at = ${completedAt},
          chunk_size = ${chunkSize}
      WHERE bulk_operation_id = ${bulkOperationId}
    `;
  } else {
    await sql`
      UPDATE s6_bulk_operations
      SET byte_offset = ${byteOffset},
          completed_at = ${completedAt}
      WHERE bulk_operation_id = ${bulkOperationId}
    `;
  }
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
  switch (bulkType) {
    case "companies":
      return await processCompanyLines(sql, shopId, lines);
    case "orders":
      return await processOrderLines(sql, shopId, lines);
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
      error: `Shop not found: ${shop}`,
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

  // If already completed, skip
  if (progress.completedAt) {
    await markWebhookProcessed(
      sql,
      webhookId,
      "BULK_OPERATIONS_FINISH",
      bulkOperationId
    );
    return {
      success: true,
      action: "skipped",
      skipReason: "Bulk operation already completed",
      status: "complete",
    };
  }

  // Check failure count - if already at max, this goes to DLQ
  if (progress.failureCount >= MAX_FAILURE_COUNT) {
    return {
      success: false,
      action: "skipped",
      error: `Max failures exceeded (${progress.failureCount})`,
      status: "error",
      errorType: "permanent", // Already exhausted retries
    };
  }

  // Get result URL from Shopify
  const statusResult = await getBulkOperationStatus(shop, bulkOperationId);

  if (!statusResult.success || !statusResult.data?.url) {
    // Increment failure count for retryable API error
    const newFailureCount = await incrementBulkOperationFailureCount(
      sql,
      bulkOperationId
    );
    const exhaustedRetries = newFailureCount >= MAX_FAILURE_COUNT;
    return {
      success: false,
      action: "skipped",
      error: statusResult.error || "No result URL available",
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
        error: chunkResult.error || "Failed to fetch chunk",
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
    return {
      success: false,
      action: "skipped",
      error: chunkResult.error || "Failed to fetch chunk",
      status: "error",
      errorType: exhaustedRetries ? "permanent" : "retryable",
    };
  }

  const bytes = chunkResult.bytes;

  // Handle empty response at EOF
  if (bytes.length === 0 && chunkResult.isEof) {
    // Mark as completed
    await saveBulkOperationProgress(
      sql,
      bulkOperationId,
      startByteOffset,
      new Date()
    );
    await markWebhookProcessed(
      sql,
      webhookId,
      "BULK_OPERATIONS_FINISH",
      bulkOperationId
    );

    console.log(`[bulk-jsonl] Completed ${bulkType} for ${shop}: EOF reached`);

    // Check if we should chain to orders
    const metadata = await getBulkOperationMetadata(sql, bulkOperationId);
    const chainToOrders =
      metadata?.origin === "reconcile" &&
      metadata?.reconcileStage === "companies";

    return {
      success: true,
      action: "updated",
      entityId: bulkOperationId,
      status: "complete",
      chainToOrders,
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

  // Limit lines processed per invocation
  const linesToProcess = allLines.slice(0, maxLines);

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
    } catch (err) {
      // Increment failure count on processing error
      await incrementBulkOperationFailureCount(sql, bulkOperationId);
      return {
        success: false,
        action: "skipped",
        error: err instanceof Error ? err.message : "Processing error",
        status: "error",
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
    await saveBulkOperationProgress(
      sql,
      bulkOperationId,
      newByteOffset,
      new Date()
    );
    await markWebhookProcessed(
      sql,
      webhookId,
      "BULK_OPERATIONS_FINISH",
      bulkOperationId
    );

    console.log(
      `[bulk-jsonl] Completed ${bulkType} for ${shop}: ${linesToProcess.length} lines, ${totalUpserted} upserted`
    );

    // Check if we should chain to orders
    const metadata = await getBulkOperationMetadata(sql, bulkOperationId);
    const chainToOrders =
      metadata?.origin === "reconcile" &&
      metadata?.reconcileStage === "companies";

    return {
      success: true,
      action: "updated",
      entityId: bulkOperationId,
      status: "complete",
      chainToOrders,
    };
  }

  // Save progress for next iteration
  // Reset chunk size to default if we found lines
  const nextChunkSize = lines.length > 0 ? DEFAULT_CHUNK_SIZE : currentChunkSize;
  await saveBulkOperationProgress(sql, bulkOperationId, newByteOffset, null, nextChunkSize);

  // Reset failure count on successful progress
  await resetBulkOperationFailureCount(sql, bulkOperationId);

  console.log(
    `[bulk-jsonl] Progress ${bulkType} for ${shop}: offset=${newByteOffset}, lines=${linesToProcess.length}, upserted=${totalUpserted}`
  );

  // Return progress status
  return {
    success: true,
    action: "updated",
    entityId: bulkOperationId,
    status: "progress",
  };
}
