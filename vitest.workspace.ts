import { defineWorkspace } from "vitest/config";

/**
 * Vitest workspace configuration to prevent cross-file race conditions
 * in tests that use the shared pgmq drain queues.
 *
 * Problem: Multiple test files (credit-status-recompute-db, processor-backstop-db,
 * s10b-bulk-queue) call the real runDrain against a shared Postgres database.
 * When they run in parallel:
 * - One file's runDrain can read another file's messages
 * - mockImplementationOnce gets consumed by stray messages
 * - Global queue deletes (WHERE TRUE) delete other files' messages
 *
 * Solution: Run drain-using DB tests in a separate project with singleFork: true,
 * so they execute sequentially while other tests can still run in parallel.
 */
export default defineWorkspace([
  {
    extends: "./vitest.config.ts",
    test: {
      name: "drain-db-sequential",
      include: [
        "app/services/__tests__/credit-status-recompute-db.test.ts",
        "app/services/drain/__tests__/processor-backstop-db.test.ts",
        "app/__tests__/integration/s10b-bulk-queue.test.ts",
      ],
      pool: "forks",
      poolOptions: {
        forks: {
          singleFork: true,
        },
      },
    },
  },
  {
    extends: "./vitest.config.ts",
    test: {
      name: "default",
      exclude: [
        "node_modules",
        "build",
        ".react-router",
        "**/build-no-xlsx.test.ts",
        "app/services/__tests__/credit-status-recompute-db.test.ts",
        "app/services/drain/__tests__/processor-backstop-db.test.ts",
        "app/__tests__/integration/s10b-bulk-queue.test.ts",
      ],
    },
  },
]);
