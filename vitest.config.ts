import { defineConfig } from "vitest/config";
import tsconfigPaths from "vite-tsconfig-paths";

/**
 * DB-backed test files that hit the real Postgres/pgmq and must run sequentially.
 * These share the global s6_sync/s6_bulk queues and database state.
 *
 * Identified by grepping for:
 * - postgres(TEST_DATABASE_URL!
 * - describeWithDb = TEST_DATABASE_URL
 * - process.env.DATABASE_URL in test files
 *
 * Files included (37 total):
 *
 * Integration tests:
 * - app/__tests__/integration/s6-pgmq.test.ts
 * - app/__tests__/integration/s10-drain.test.ts
 * - app/__tests__/integration/s10b-bulk-queue.test.ts
 * - app/__tests__/integration/s20-idempotency.test.ts
 * - app/__tests__/integration/s22-compliance.test.ts
 * - app/__tests__/integration/s5-schema.test.ts
 * - app/__tests__/integration/light-session-storage.test.ts
 * - app/__tests__/integration/prisma-session-storage.test.ts
 *
 * Service DB tests:
 * - app/services/__tests__/apply-db.test.ts
 * - app/services/__tests__/backstop-db.test.ts
 * - app/services/__tests__/credit-hold-lifecycle-db.test.ts
 * - app/services/__tests__/credit-status-db.test.ts
 * - app/services/__tests__/credit-status-recompute-db.test.ts (Developer 3 owns, included via pattern)
 * - app/services/__tests__/gated-account-db.test.ts
 * - app/services/__tests__/plan-gating-actions-db.test.ts
 * - app/services/__tests__/s18-enqueue-skip-gated-db.test.ts
 * - app/services/__tests__/gating.test.ts
 *
 * Drain processor DB tests:
 * - app/services/drain/__tests__/processor-backstop-db.test.ts
 * - app/services/drain/__tests__/reconcile-manual-key-db.test.ts
 * - app/services/drain/__tests__/dlq-sanitize-db.test.ts
 * - app/services/drain/__tests__/s25-exactly-once-db.test.ts
 * - app/services/drain/__tests__/currency-guard-followups-db.test.ts
 *
 * Compliance DB tests:
 * - app/services/compliance/__tests__/redact-customer-db.test.ts
 *
 * Sync DB tests:
 * - app/services/sync/__tests__/company-location.test.ts
 * - app/services/sync/__tests__/customer.test.ts
 * - app/services/sync/__tests__/order.test.ts
 * - app/services/sync/__tests__/draft-order.test.ts
 * - app/services/sync/__tests__/draft-order-bulk-db.test.ts
 * - app/services/sync/__tests__/bulk-empty-result-db.test.ts
 *
 * Route DB tests:
 * - app/routes/__tests__/app.imports.test.ts
 * - app/routes/__tests__/app._index.test.ts
 * - app/routes/__tests__/app.accounts.$id-db.test.ts
 *
 * Lib DB tests:
 * - app/lib/__tests__/after-auth-db.test.ts
 * - app/lib/__tests__/aging-reconcile.test.ts
 * - app/lib/__tests__/initial-sync-db.test.ts
 * - app/lib/__tests__/offline-token.test.ts
 * - app/lib/matching/__tests__/integration.test.ts
 *
 * Script DB tests:
 * - scripts/__tests__/seed.test.ts
 * - scripts/__tests__/backstop-backfill.test.ts
 * - scripts/__tests__/credit-status-metafield-backfill.test.ts
 * - scripts/__tests__/refresh-offline-token.test.ts
 * - scripts/ci/__tests__/backfill-dry-run-preflight.test.ts
 * - scripts/__tests__/e2e-bank-import.test.ts
 */
const DB_TEST_PATTERNS = [
  // Integration tests (all use real DB)
  "app/__tests__/integration/s6-pgmq.test.ts",
  "app/__tests__/integration/s8-draft-delete-id-only-db.test.ts",
  "app/__tests__/integration/s10-drain.test.ts",
  "app/__tests__/integration/s10b-bulk-queue.test.ts",
  "app/__tests__/integration/s20-idempotency.test.ts",
  "app/__tests__/integration/s22-compliance.test.ts",
  "app/__tests__/integration/shop-redact-complete-db.test.ts",
  "app/__tests__/integration/shop-redact-reinstall-guard-db.test.ts",
  "app/__tests__/integration/s5-schema.test.ts",
  "app/__tests__/integration/light-session-storage.test.ts",
  "app/__tests__/integration/prisma-session-storage.test.ts",

  // Service DB tests (*-db.test.ts pattern plus gating.test.ts)
  "app/services/__tests__/*-db.test.ts",
  "app/services/__tests__/gating.test.ts",
  "app/services/__tests__/billing-plan-state-db.test.ts",
  "app/services/__tests__/reminders-catchup-db.test.ts",
  "app/services/__tests__/reminders-uninstalled-db.test.ts",
  "app/services/__tests__/reminder-optout-db.test.ts",
  "app/services/__tests__/retention-db.test.ts",

  // Drain processor DB tests
  "app/services/drain/__tests__/processor-backstop-db.test.ts",
  "app/services/drain/__tests__/reconcile-manual-key-db.test.ts",
  "app/services/drain/__tests__/dlq-sanitize-db.test.ts",
  "app/services/drain/__tests__/dlq-redact-race-db.test.ts",
  "app/services/drain/__tests__/bulk-op-recovery-db.test.ts",
  "app/services/drain/__tests__/s25-exactly-once-db.test.ts",
  "app/services/drain/__tests__/currency-guard-followups-db.test.ts",
  "app/services/drain/__tests__/orders-no-session-ack-db.test.ts",
  "app/services/drain/__tests__/drain-guard-db.test.ts",
  "app/services/drain/__tests__/drain-redact-inflight-pr2-db.test.ts",

  // Compliance DB tests
  "app/services/compliance/__tests__/redact-customer-db.test.ts",

  // Sync DB tests (these use TEST_DATABASE_URL)
  "app/services/sync/__tests__/company-location.test.ts",
  "app/services/sync/__tests__/customer.test.ts",
  "app/services/sync/__tests__/order.test.ts",
  "app/services/sync/__tests__/draft-order.test.ts",
  "app/services/sync/__tests__/draft-order-bulk-db.test.ts",
  "app/services/sync/__tests__/bulk-empty-result-db.test.ts",

  // Route DB tests
  "app/routes/__tests__/app.imports.test.ts",
  "app/routes/__tests__/app.imports-client-payload-db.test.ts",
  "app/routes/__tests__/app.imports-pii-logging.test.ts",
  "app/routes/__tests__/app._index.test.ts",
  "app/routes/__tests__/app._index-overlimit-db.test.ts",
  "app/routes/__tests__/app.accounts.$id-db.test.ts",
  "app/routes/__tests__/app.accounts.$id.reminder-optout-db.test.ts",
  "app/routes/__tests__/merchant-form-validation-db.test.ts",
  "app/routes/__tests__/webhooks.compliance.customers.test.ts",

  // Lib DB tests
  "app/lib/__tests__/after-auth-db.test.ts",
  "app/lib/__tests__/after-auth-syncshopinfo-db.test.ts",
  "app/lib/__tests__/aging-reconcile.test.ts",
  "app/lib/__tests__/initial-sync-db.test.ts",
  "app/lib/__tests__/offline-admin-db.test.ts",
  "app/lib/__tests__/offline-token.test.ts",
  "app/lib/__tests__/reinstall-sync-reset-db.test.ts",
  "app/lib/matching/__tests__/integration.test.ts",

  // Script DB tests
  "scripts/__tests__/seed.test.ts",
  "scripts/__tests__/backstop-backfill.test.ts",
  "scripts/__tests__/credit-status-metafield-backfill.test.ts",
  "scripts/__tests__/refresh-offline-token.test.ts",
  "scripts/ci/__tests__/backfill-dry-run-preflight.test.ts",
  "scripts/ci/__tests__/shop-identity-labels-db.test.ts",
  "scripts/__tests__/e2e-bank-import.test.ts",

  // Reviewer demo DB tests
  "tests/integration/review-csv-matcher-db.test.ts",

  // Confirm-reimport pin DB tests
  "tests/integration/confirm-reimport-pin-db.test.ts",

  // Bank upload robustness DB tests
  "tests/integration/bank-upload-robustness-db.test.ts",

  // Ingestion paths DB tests
  "tests/integration/ingestion-paths-db.test.ts",

  // Confirm concurrency lock DB tests
  "tests/integration/confirm-concurrency-lock-db.test.ts",
];

export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    projects: [
      {
        test: {
          name: "Parallel",
          environment: "node",
          include: ["**/*.test.{ts,tsx}", "**/__tests__/**/*.test.ts"],
          exclude: [
            "node_modules",
            "build",
            ".react-router",
            "**/build-no-xlsx.test.ts",
            ...DB_TEST_PATTERNS,
          ],
        },
      },
      {
        test: {
          name: "Sequential DB",
          environment: "node",
          include: DB_TEST_PATTERNS,
          exclude: ["node_modules", "build", ".react-router"],
          fileParallelism: false,
        },
      },
    ],
  },
});
