/**
 * Shared utilities for DB tests that touch the queue (pgmq/s6_sync/s6_bulk/s6_dead_letter).
 * 
 * All test files that call runDrain or interact with these queue tables must:
 * 1. Hold the advisory lock for the entire file via sql.reserve()'d connection
 * 2. Key mocks on buyerAccountId/shop so stray messages get neutral success
 * 3. Drain queue to empty before assertions (for DLQ tests)
 */

import type { Sql } from "~/lib/db-light.server";

/**
 * Advisory lock ID for serializing queue-touching DB tests.
 * All test files that call runDrain or interact with s6_sync/s6_bulk/s6_dead_letter
 * must acquire this lock in beforeAll (via sql.reserve()) and release in afterAll.
 * 
 * Using a memorable number that's unlikely to conflict with production locks.
 */
export const QUEUE_DB_TEST_LOCK_ID = 8675309;

/**
 * Drain the queue to empty using real runDrain.
 * This clears any leftover messages from other tests/passes before running assertions.
 * Returns the total number of messages processed.
 */
export async function drainQueueToEmpty(
  sql: Sql,
  runDrain: (sql: Sql, config: { batchSize: number; timeBudgetMs: number }) => Promise<{ processed: number; failed: number; deadLettered: number; skipped: number }>
): Promise<number> {
  let totalProcessed = 0;
  let iterations = 0;
  const maxIterations = 100; // Safety limit
  
  while (iterations < maxIterations) {
    const result = await runDrain(sql, { batchSize: 50, timeBudgetMs: 30000 });
    const messagesHandled = result.processed + result.failed + result.deadLettered + result.skipped;
    totalProcessed += messagesHandled;
    
    if (messagesHandled === 0) {
      break; // Queue is empty
    }
    iterations++;
  }
  
  return totalProcessed;
}
