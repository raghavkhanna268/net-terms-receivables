/**
 * Bulk JSONL processor for S10b.
 *
 * Downloads JSONL result files from Shopify bulk operations using HTTP Range
 * requests, enabling resumable processing for large files that exceed the
 * Cloudflare Workers 10ms CPU time budget.
 *
 * Key features:
 * - HTTP Range chunking: Downloads in bounded chunks (default 512KB)
 * - Byte-accurate offsets: Tracks position at end of last complete line
 * - Partial line carry-over: Preserves incomplete trailing lines across chunks
 * - UTF-8 safe: Offsets are in bytes, not characters
 * - Resumable: Can resume from saved offset after budget cut
 *
 * Design notes:
 * - Uses fetch with Range header (supported by Shopify's S3-backed URLs)
 * - Processes complete lines only, buffering partial lines
 * - Upserts via S6 services for consistency with webhook processing
 * - Marks operation complete only at true EOF
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
import { mapOrderToInvoice, bulkUpsertInvoices } from "./order.server";
import { processBulkCustomer } from "./customer.server";
import { isWebhookProcessed, markWebhookProcessed } from "./company.server";
import { adminGraphQL, BULK_OPERATION_STATUS_QUERY } from "../drain/admin-client.server";

/**
 * Default chunk size in bytes (512KB).
 * Balances between CPU time and network efficiency.
 */
export const DEFAULT_CHUNK_SIZE = 512 * 1024;

/**
 * Maximum lines to process per invocation.
 * Prevents CPU timeout on dense JSONL.
 */
export const DEFAULT_MAX_LINES = 100;

/**
 * Result of a chunk processing operation.
 */
export interface ChunkResult {
  /** Whether processing was successful */
  success: boolean;
  /** Number of complete lines processed */
  linesProcessed: number;
  /** New byte offset (end of last complete line) */
  newByteOffset: number;
  /** Partial line to carry over (if any) */
  partialLine: string;
  /** Whether we reached EOF */
  isEof: boolean;
  /** Number of entities upserted */
  upsertedCount: number;
  /** Error message if failed */
  error?: string;
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
 * Fetch a chunk of the JSONL file using HTTP Range request.
 *
 * @param url - JSONL result URL from Shopify
 * @param startByte - Starting byte offset (inclusive)
 * @param chunkSize - Number of bytes to fetch
 * @returns Chunk data with content-range info
 */
export async function fetchJsonlChunk(
  url: string,
  startByte: number,
  chunkSize: number = DEFAULT_CHUNK_SIZE
): Promise<{
  success: boolean;
  data?: string;
  isEof: boolean;
  contentLength?: number;
  error?: string;
}> {
  const endByte = startByte + chunkSize - 1;
  const rangeHeader = `bytes=${startByte}-${endByte}`;

  try {
    const response = await fetch(url, {
      headers: {
        Range: rangeHeader,
        Accept: "application/x-ndjson, text/plain",
      },
    });

    // 206 Partial Content = more data available
    // 200 OK = server ignored Range header, returned whole file
    // 416 Range Not Satisfiable = offset past EOF
    if (response.status === 416) {
      return { success: true, data: "", isEof: true };
    }

    if (!response.ok && response.status !== 206) {
      return {
        success: false,
        isEof: false,
        error: `HTTP ${response.status}: ${response.statusText}`,
      };
    }

    const data = await response.text();

    // Check if we've reached EOF
    const contentRange = response.headers.get("Content-Range");
    let isEof = false;
    let contentLength: number | undefined;

    if (contentRange) {
      // Format: "bytes 0-999/5000" or "bytes 0-999/*"
      const match = contentRange.match(/bytes \d+-\d+\/(\d+|\*)/);
      if (match && match[1] !== "*") {
        contentLength = parseInt(match[1], 10);
        isEof = startByte + data.length >= contentLength;
      }
    } else {
      // If server returned 200 (whole file), we have everything
      isEof = response.status === 200;
      contentLength = data.length;
    }

    // Also check if response is smaller than requested (indicates EOF)
    if (data.length < chunkSize) {
      isEof = true;
    }

    return { success: true, data, isEof, contentLength };
  } catch (err) {
    return {
      success: false,
      isEof: false,
      error: err instanceof Error ? err.message : "Network error",
    };
  }
}

/**
 * Split chunk data into complete lines, preserving partial trailing line.
 * Returns byte offsets, not character offsets (UTF-8 safe).
 *
 * @param data - Raw chunk data
 * @param previousPartial - Partial line from previous chunk
 * @returns Complete lines and remaining partial
 */
export function splitChunkIntoLines(
  data: string,
  previousPartial: string = ""
): { lines: string[]; partial: string; bytesConsumed: number } {
  // Prepend any partial line from previous chunk
  const combined = previousPartial + data;

  // Find all complete lines (ending with \n)
  const lines: string[] = [];
  let lastNewlineIndex = -1;

  for (let i = 0; i < combined.length; i++) {
    if (combined[i] === "\n") {
      const line = combined.substring(lastNewlineIndex + 1, i);
      if (line.trim().length > 0) {
        lines.push(line);
      }
      lastNewlineIndex = i;
    }
  }

  // Calculate bytes consumed from the new data only
  // This is the offset within `data` where the partial line begins
  const partialStartInCombined = lastNewlineIndex + 1;
  const partial = combined.substring(partialStartInCombined);

  // Bytes consumed is the position in data where we left off
  // If previousPartial was consumed, we need to account for it
  const encoder = new TextEncoder();
  const previousPartialBytes = encoder.encode(previousPartial).length;
  const bytesFromDataConsumed =
    lastNewlineIndex >= 0
      ? encoder.encode(combined.substring(0, lastNewlineIndex + 1)).length -
        previousPartialBytes
      : 0;

  // If no newlines found, we consumed 0 bytes of data (everything is partial)
  const bytesConsumed = lastNewlineIndex >= 0 ? bytesFromDataConsumed : 0;

  return { lines, partial, bytesConsumed };
}

/**
 * Process a batch of JSONL lines for companies.
 */
async function processCompanyLines(
  sql: Sql,
  shopId: string,
  lines: string[]
): Promise<number> {
  const jsonl = lines.join("\n");
  const { companies, errors } = parseCompanyBulkJsonl(jsonl);

  if (errors.length > 0) {
    console.warn(
      `[bulk-jsonl] ${errors.length} parse errors in companies batch`
    );
  }

  // Map company locations to buyer accounts
  const accounts: ReturnType<typeof mapCompanyLocationToBuyerAccount>[] = [];

  for (const { locations } of companies.values()) {
    for (const loc of locations) {
      const shopifyLoc = bulkLocationToShopifyLocation(loc);
      accounts.push(mapCompanyLocationToBuyerAccount(shopId, shopifyLoc));
    }
  }

  return await bulkUpsertBuyerAccounts(sql, accounts);
}

/**
 * Process a batch of JSONL lines for orders.
 */
async function processOrderLines(
  sql: Sql,
  shopId: string,
  lines: string[]
): Promise<number> {
  const jsonl = lines.join("\n");
  const { orders, errors, skippedNoTerms } = parseOrderBulkJsonl(jsonl);

  if (errors.length > 0) {
    console.warn(`[bulk-jsonl] ${errors.length} parse errors in orders batch`);
  }

  if (skippedNoTerms > 0) {
    console.log(`[bulk-jsonl] ${skippedNoTerms} orders skipped (no payment terms)`);
  }

  // Map orders to invoices
  const invoices: ReturnType<typeof mapOrderToInvoice>[] = [];

  for (const order of orders) {
    const shopifyOrder = bulkOrderToShopifyOrder(order);

    // Resolve buyer account
    const buyerAccountId = await resolveBuyerAccountForBulkOrder(
      sql,
      shopId,
      shopifyOrder
    );

    if (buyerAccountId) {
      invoices.push(mapOrderToInvoice(shopId, buyerAccountId, shopifyOrder));
    }
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

  let processed = 0;
  for (const customer of customers) {
    const shopifyCustomer = bulkCustomerToShopifyCustomer(customer);
    const result = await processBulkCustomer(sql, shop, shopifyCustomer);
    if (result.success && result.action !== "skipped") {
      processed++;
    }
  }

  return processed;
}

/**
 * Resolve buyer account for an order in bulk processing.
 * Similar to order.server.ts but without webhook context.
 */
async function resolveBuyerAccountForBulkOrder(
  sql: Sql,
  shopId: string,
  order: { purchasingEntity?: { company?: { id: string }; location?: { id: string }; id?: string } | null; customer?: { id: string } | null }
): Promise<string | null> {
  const purchasingEntity = order.purchasingEntity;

  // Try CompanyLocation first
  if (purchasingEntity?.location?.id) {
    const [account] = await sql<{ id: string }[]>`
      SELECT id FROM "BuyerAccount"
      WHERE "shopId" = ${shopId}
        AND "companyLocationId" = ${purchasingEntity.location.id}
    `;
    if (account) return account.id;
  }

  // Try Company
  if (purchasingEntity?.company?.id) {
    const [account] = await sql<{ id: string }[]>`
      SELECT id FROM "BuyerAccount"
      WHERE "shopId" = ${shopId}
        AND "companyId" = ${purchasingEntity.company.id}
      LIMIT 1
    `;
    if (account) return account.id;
  }

  // Try customer
  if (order.customer?.id) {
    const [account] = await sql<{ id: string }[]>`
      SELECT id FROM "BuyerAccount"
      WHERE "shopId" = ${shopId}
        AND "customerId" = ${order.customer.id}
    `;
    if (account) return account.id;
  }

  return null;
}

/**
 * Load bulk operation progress from database.
 */
export async function loadBulkOperationProgress(
  sql: Sql,
  bulkOperationId: string
): Promise<{ byteOffset: number; partialLine: string; completedAt: Date | null } | null> {
  const [row] = await sql<{
    byte_offset: string;
    partial_line: string;
    completed_at: Date | null;
  }[]>`
    SELECT byte_offset, partial_line, completed_at
    FROM s6_bulk_operations
    WHERE bulk_operation_id = ${bulkOperationId}
  `;

  if (!row) return null;

  return {
    byteOffset: parseInt(row.byte_offset, 10),
    partialLine: row.partial_line,
    completedAt: row.completed_at,
  };
}

/**
 * Save bulk operation progress to database.
 */
export async function saveBulkOperationProgress(
  sql: Sql,
  bulkOperationId: string,
  byteOffset: number,
  partialLine: string,
  completedAt: Date | null = null
): Promise<void> {
  await sql`
    UPDATE s6_bulk_operations
    SET byte_offset = ${byteOffset},
        partial_line = ${partialLine},
        completed_at = ${completedAt}
    WHERE bulk_operation_id = ${bulkOperationId}
  `;
}

/**
 * Process a BULK_OPERATIONS_FINISH message.
 *
 * Downloads JSONL in chunks, processes lines, and tracks progress for
 * resumption after CPU budget cuts.
 *
 * @param sql - postgres.js SQL client
 * @param message - Bulk message from queue
 * @param chunkSize - Bytes to fetch per chunk (default 512KB)
 * @param maxLines - Max lines to process per invocation (default 100)
 * @returns Sync result
 */
export async function processBulkOperation(
  sql: Sql,
  message: BulkMessage,
  chunkSize: number = DEFAULT_CHUNK_SIZE,
  maxLines: number = DEFAULT_MAX_LINES
): Promise<SyncResult> {
  const { shop, webhookId, bulkOperationId, bulkType } = message;

  // Idempotency check
  if (await isWebhookProcessed(sql, webhookId)) {
    return {
      success: true,
      action: "skipped",
      skipReason: "Webhook already processed (idempotent)",
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
    };
  }

  // If already completed, skip
  if (progress.completedAt) {
    await markWebhookProcessed(sql, webhookId, "BULK_OPERATIONS_FINISH", bulkOperationId);
    return {
      success: true,
      action: "skipped",
      skipReason: "Bulk operation already completed",
    };
  }

  // Get result URL from Shopify
  const statusResult = await getBulkOperationStatus(shop, bulkOperationId);

  if (!statusResult.success || !statusResult.data?.url) {
    return {
      success: false,
      action: "skipped",
      error: statusResult.error || "No result URL available",
    };
  }

  const resultUrl = statusResult.data.url;
  const startByteOffset = progress.byteOffset;
  let partialLine = progress.partialLine;
  let totalUpserted = 0;
  let totalLinesProcessed = 0;

  // Fetch and process one chunk
  const chunkResult = await fetchJsonlChunk(resultUrl, startByteOffset, chunkSize);

  if (!chunkResult.success) {
    return {
      success: false,
      action: "skipped",
      error: chunkResult.error,
    };
  }

  // Handle empty chunk (EOF with no data)
  if (!chunkResult.data || chunkResult.data.length === 0) {
    if (chunkResult.isEof) {
      // Process any remaining partial line
      if (partialLine.trim().length > 0) {
        try {
          const lineResult = await processLines(sql, shop, shopId, bulkType, [partialLine]);
          totalUpserted += lineResult;
        } catch {
          // Ignore parse errors on final partial
        }
      }

      // Mark as completed
      await saveBulkOperationProgress(sql, bulkOperationId, startByteOffset, "", new Date());
      await markWebhookProcessed(sql, webhookId, "BULK_OPERATIONS_FINISH", bulkOperationId);

      return {
        success: true,
        action: "updated",
        entityId: bulkOperationId,
      };
    }

    return {
      success: false,
      action: "skipped",
      error: "Empty chunk returned but not EOF",
    };
  }

  // Split chunk into complete lines
  const { lines, partial, bytesConsumed } = splitChunkIntoLines(
    chunkResult.data,
    partialLine
  );

  // Limit lines processed per invocation
  const linesToProcess = lines.slice(0, maxLines);
  const encoder = new TextEncoder();

  // Process lines
  if (linesToProcess.length > 0) {
    try {
      totalUpserted = await processLines(sql, shop, shopId, bulkType, linesToProcess);
      totalLinesProcessed = linesToProcess.length;
    } catch (err) {
      return {
        success: false,
        action: "skipped",
        error: err instanceof Error ? err.message : "Processing error",
      };
    }
  }

  // Calculate new byte offset
  // We only advance the offset for fully processed lines
  let newByteOffset = startByteOffset;

  if (linesToProcess.length === lines.length) {
    // All lines processed, advance by bytesConsumed
    newByteOffset = startByteOffset + bytesConsumed;
    // Carry over the partial line from this chunk
    partialLine = partial;
  } else {
    // Not all lines processed, need to recalculate
    // Only advance by the bytes of the lines we actually processed
    const processedText = linesToProcess.join("\n") + "\n";
    const processedBytes = encoder.encode(processedText).length;
    newByteOffset = startByteOffset + processedBytes - encoder.encode(progress.partialLine).length;
    // Remaining lines become the new partial (prepended with their text)
    const remainingLines = lines.slice(linesToProcess.length);
    partialLine = remainingLines.join("\n") + (partial ? "\n" + partial : "");
  }

  // Check if we've reached EOF and processed everything
  const isComplete =
    chunkResult.isEof &&
    linesToProcess.length === lines.length &&
    partial.trim().length === 0;

  if (isComplete) {
    await saveBulkOperationProgress(sql, bulkOperationId, newByteOffset, "", new Date());
    await markWebhookProcessed(sql, webhookId, "BULK_OPERATIONS_FINISH", bulkOperationId);

    console.log(
      `[bulk-jsonl] Completed ${bulkType} for ${shop}: ${totalLinesProcessed} lines, ${totalUpserted} upserted`
    );

    return {
      success: true,
      action: "updated",
      entityId: bulkOperationId,
    };
  }

  // Save progress for next iteration
  await saveBulkOperationProgress(sql, bulkOperationId, newByteOffset, partialLine);

  console.log(
    `[bulk-jsonl] Progress ${bulkType} for ${shop}: offset=${newByteOffset}, lines=${totalLinesProcessed}, upserted=${totalUpserted}`
  );

  // Return success=false to keep message in queue for retry
  // This allows the drain to process more messages before coming back
  return {
    success: false,
    action: "skipped",
    error: "Partial chunk processed, more data remaining",
  };
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
