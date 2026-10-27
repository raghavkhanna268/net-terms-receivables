# Data Retention Schedule — Net Terms Receivables

**Owner:** Raghav  
**Audited Commit:** `df77eae4f4abe0caf3fec2a94d339f83cc458403`  
**Last Updated:** 2026-10-25

---

## Retention Table

| Data | Where Stored | Retention / Trigger | Mechanism | Source |
|------|--------------|---------------------|-----------|--------|
| Unmatched bank-statement narrations | `Payment.narration`, `Payment.payerText` | 180 days from `valueDate` | pg_cron job `s22_purge_unmatched_narration` at 04:00 UTC daily; sets `narration='[RETENTION_PURGED]'`, `payerText=NULL` | `prisma/migrations/20261101000000_s22_followups/migration.sql:20-77`, `UNMATCHED_NARRATION_RETENTION_DAYS` in `compliance.server.ts` |
| `customers/redact` (customer erasure) | `s8_tagged_customers`, `s8_draft_orders`, `s22_data_requests`, `Payment` (matched), `PayerAlias`, `BuyerAccount` | On Shopify webhook | Transaction in `redactCustomer()`: deletes tagged data, redacts matched payments (`narration='[REDACTED]'`), anonymizes BuyerAccount | `redactCustomer()` in `compliance.server.ts` |
| `customers/data_request` exports | `s22_data_requests.export_data` | 30 days from creation (`expires_at`) | pg_cron job `s22_purge_expired_data_requests` at 03:00 UTC daily (deletes rows with `expires_at < NOW()`), plus `purgeExpiredDataRequests()` called when the data-requests page loads (`loader` in `app.data-requests.tsx`) and when a data_request webhook arrives (`action` in `webhooks.compliance.tsx`) | `prisma/migrations/20261024020000_s22_compliance/migration.sql:142-146`, 30-day expiry in `persistDataRequest()` in `compliance.server.ts`, `purgeExpiredDataRequests()` in `compliance.server.ts` |
| `shop/redact` (shop erasure) | All shop data | On Shopify webhook (48h after uninstall) | Transaction in `deleteShop()`: CASCADE deletes from `Shop` row plus explicit deletes for non-FK tables | `deleteShop()` in `compliance.server.ts`, `action` SHOP_REDACT handler in `webhooks.compliance.tsx` |
| Processed webhooks | `s6_processed_webhooks` | 7 days | pg_cron job `s10_processed_webhooks_cleanup` at 04:00 UTC daily; also deleted on shop/redact (prefix delete in `deleteShop()`, `deleteProcessedWebhooksViaReceipts()` in `compliance.server.ts`) and on app/uninstalled via `deleteProcessedWebhooksViaReceipts()` (`action` in `webhooks.app.uninstalled.tsx`); `credit_*` and receipt-less rows are left to the 7-day TTL | `prisma/migrations/20261024010000_s10_drain_cron/migration.sql:185-189` |
| Webhook receipts | `webhook_receipts` | 30 days | pg_cron job `s20_webhook_receipts_cleanup` at 04:30 UTC daily; also deleted on shop/redact (`deleteShop()` in `compliance.server.ts`) and app/uninstalled (`action` in `webhooks.app.uninstalled.tsx`) | `prisma/migrations/20261025010000_s20_webhook_receipts/migration.sql:69-73` |
| ReminderLog entries | `ReminderLog` | Until shop/redact | CASCADE delete via `Shop` FK | `Shop.reminderLogs` relation in `schema.prisma`, no separate purge |
| Dead-letter queue | `s6_dead_letter` | 30 days | pg_cron job `s10_dlq_cleanup_weekly` at 03:00 UTC Sundays; also deleted per-shop on shop/redact (`deleteShop()` in `compliance.server.ts`); **sanitized on shop_not_found, shop_row_missing, or shop_uninstalled** (see Note 7) | `prisma/migrations/20261024010000_s10_drain_cron/migration.sql:176-180` |
| Order refetch null counts | `s10b_order_refetch_null` | 90 days | pg_cron job `s10b_purge_old_refetch_null` at 04:00 UTC daily; also deleted on shop/redact via `deleteShop()` in `compliance.server.ts` | `prisma/migrations/20261024030000_s10b_nightly_reconcile/migration.sql:175-179` |
| Global email send counts | `s18_global_sends` | 35 days (on `send_date`) | pg_cron job `s18_global_sends_cleanup` at 05:00 UTC daily | `prisma/migrations/20261030000000_s18_payment_reminders/migration.sql:240-244` |
| Sessions (OAuth) | `Session` (includes staff `firstName`, `lastName`, `email` for online sessions — `Session` model in `schema.prisma`) | Until app/uninstalled or shop/redact (no time-based purge of expired rows) | Deleted by `sessionStorage.deleteAllForShop()` | `action` in `webhooks.app.uninstalled.tsx`, `action` SHOP_REDACT handler in `webhooks.compliance.tsx` |
| Offline tokens | `Session.accessToken`, `Session.refreshToken` | Until session deletion | Part of Session table; deleted with sessions | `Session` model in `schema.prisma` |
| BuyerAccount.name | `BuyerAccount.name` | Until customers/redact (anonymized to "Redacted Customer") or shop/redact (CASCADE) | BuyerAccount anonymization in `redactCustomer()` in `compliance.server.ts` | `BuyerAccount` model in `schema.prisma` |
| Tagged customer PII | `s8_tagged_customers.email`, `s8_tagged_customers.display_name` | Until customers/redact or shop/redact; minimised on tag removal only if no open invoices | `minimiseCustomerPiiIfInactive()` in `compliance.server.ts`, called from `customer.server.ts` | See Notes |
| AuditEvent (access.* events) | `AuditEvent` | 365 days | pg_cron job `audit_purge_access_events_365d` at 03:30 UTC daily; deletes rows where `type LIKE 'access.%' AND at < NOW() - INTERVAL '365 days'`; also deleted on shop/redact via CASCADE | `prisma/migrations/20261115000000_access_event_purge/migration.sql` |
| AuditEvent (financial events) | `AuditEvent` | Until shop/redact (CASCADE) | Financial events (match.*, invoice.*, account.*) are not purged by schedule; deleted only by shop/redact FK cascade (`deleteShop()` Shop DELETE in `compliance.server.ts`, `prisma/migrations/20261022000001_s5_data_model/migration.sql:284`) | `AuditEvent` model in `schema.prisma` |
| Backstop processed orders | `backstop_processed_orders` | 30 days | pg_cron job `backstop-purge-30d` at 03:00 UTC daily | `prisma/migrations/20261028000000_s13_backstop_table/migration.sql:61-65` |
| Customer PII fallback counts | `s10b_customer_pii_fallback` | 90 days | pg_cron job `s10b_purge_old_pii_fallback` at 04:15 UTC daily; also deleted on shop/redact (`deleteShop()` in `compliance.server.ts`) | `prisma/migrations/20261027000000_s10b_customer_pii_fallback/migration.sql:47-51` |
| Order outstanding missing counts | `order_outstanding_missing` | 90 days | pg_cron job `purge_old_order_outstanding_missing` at 04:30 UTC daily; also deleted on shop/redact (`deleteShop()` in `compliance.server.ts`) | `prisma/migrations/20261026010000_order_outstanding_missing/migration.sql:50-54` |
| Bulk operations tracking | `s6_bulk_operations` | Until shop/redact | Deleted by `deleteShop()` in `compliance.server.ts` | No time-based purge |
| Reconcile stage claims | `s6_reconcile_stage_claims` | 30 days (purged), or reinstall/shop/redact | App code purges claims older than 30 days via `purgeOldReconcileClaims()` called from the nightly reconcile (`reconcile.server.ts` `enqueueReconcileForAllShops()`); also deleted on reinstall via `after-auth.server.ts` clearUninstalledAtAndMetafieldErrors CTE, and on shop/redact via `compliance.server.ts` `deleteShop()` | `app/services/drain/reconcile-handlers.server.ts` `purgeOldReconcileClaims()`, `after-auth.server.ts`, `compliance.server.ts` `deleteShop()` |
| Database backups (Supabase) | Supabase-managed | Provider-controlled. Supabase automatic daily backups only on Pro (7 days), Team (14 days), Enterprise (up to 30 days); no automatic backups on the Free plan (Supabase advises Free projects to export with `pg_dump`). PITR add-on: 7/14/28 days. [Raghav to confirm plan and any manual dump schedule] | Not app-controlled | [Supabase Backups docs](https://supabase.com/docs/guides/platform/backups) |
| Database backups (R2) | Cloudflare R2 bucket `ntr-db-backups`, prefix `db/` | 30-day rolling retention; always keeps newest 7 backups regardless of age. Deleted data may remain in encrypted backups for up to 30 days, after which it is permanently deleted. | Automated prune job in `db-backup.yml` after each nightly backup; deletion enabled for scheduled runs; manual dispatch is a dry run unless `dry_run=false` is chosen. Deletes nothing if fewer than 7 are listed or the listing fails. Sanity floor: refuses deletion if total < 8, if eligible would leave < 7, or if newest backup > 48h old. See `docs/runbooks/restore.md` "Retention" section. | `.github/workflows/db-backup.yml`, `scripts/ops/prune-backups.ts` |
| Sentry error events | Sentry cloud | Used only when configured (a DSN is set). When enabled: 30 days (Developer), 90 days (Team/Business/Enterprise). | Sentry data retention settings | [Sentry Data Retention docs](https://docs.sentry.io/security-legal-pii/security/data-retention-periods/) |
| Worker logs | Cloudflare | 3 days (Workers Free) / 7 days (Workers Paid). Logs carry only IDs, counts, enums, booleans, timestamps, and error codes per the `safeLog()` allowlist. | Cloudflare Workers dashboard or `wrangler tail` | [Cloudflare Workers Logs](https://developers.cloudflare.com/workers/observability/logs/workers-logs/) |

---

## All pg_cron Jobs

| Job Name | Schedule | Purpose | Migration |
|----------|----------|---------|-----------|
| `s10_drain_every_minute` | `* * * * *` (every minute) | Drain queue processing via pg_net | `20261024010000_s10_drain_cron/migration.sql:165-169` |
| `s10_dlq_cleanup_weekly` | `0 3 * * 0` (Sunday 03:00 UTC) | Delete dead-letter entries older than 30 days | `20261024010000_s10_drain_cron/migration.sql:176-180` |
| `s10_processed_webhooks_cleanup` | `0 4 * * *` (daily 04:00 UTC) | Delete processed webhooks older than 7 days | `20261024010000_s10_drain_cron/migration.sql:185-189` |
| `s22_purge_expired_data_requests` | `0 3 * * *` (daily 03:00 UTC) | Delete expired data request exports | `20261024020000_s22_compliance/migration.sql:142-146` |
| `s10b_nightly_reconcile` | `0 2 * * *` (daily 02:00 UTC) | Nightly company/order reconciliation | `20261024030000_s10b_nightly_reconcile/migration.sql:138-141` |
| `s10b_purge_old_refetch_null` | `0 4 * * *` (daily 04:00 UTC) | Delete order refetch null counts older than 90 days | `20261024030000_s10b_nightly_reconcile/migration.sql:175-179` |
| `s20_webhook_receipts_cleanup` | `30 4 * * *` (daily 04:30 UTC) | Delete webhook receipts older than 30 days | `20261025010000_s20_webhook_receipts/migration.sql:69-73` |
| `purge_old_order_outstanding_missing` | `30 4 * * *` (daily 04:30 UTC) | Delete order outstanding missing counts older than 90 days | `20261026010000_order_outstanding_missing/migration.sql:50-54` |
| `s10b_purge_old_pii_fallback` | `15 4 * * *` (daily 04:15 UTC) | Delete customer PII fallback counts older than 90 days | `20261027000000_s10b_customer_pii_fallback/migration.sql:47-51` |
| `backstop-purge-30d` | `0 3 * * *` (daily 03:00 UTC) | Delete backstop processed orders older than 30 days | `20261028000000_s13_backstop_table/migration.sql:61-65` |
| `credit_status_daily_sweep` | `0 19 * * *` (daily 19:00 UTC) | Enqueue credit status recomputes | `20261029010000_credit_status_daily_sweep/migration.sql:167-171` |
| `s18_enqueue_reminders_hourly` | `15 * * * *` (hourly at :15) | Enqueue payment reminder messages | `20261030000000_s18_payment_reminders/migration.sql:231-235` |
| `s18_global_sends_cleanup` | `0 5 * * *` (daily 05:00 UTC) | Delete global send counts older than 35 days | `20261030000000_s18_payment_reminders/migration.sql:240-244` |
| `s22_purge_unmatched_narration` | `0 4 * * *` (daily 04:00 UTC) | Purge narration on unmatched payments older than 180 days | `20261101000000_s22_followups/migration.sql:69-73` |
| `audit_purge_access_events_365d` | `30 3 * * *` (daily 03:30 UTC) | Delete access.* AuditEvent rows older than 365 days | `20261115000000_access_event_purge/migration.sql` |

**Workers Cron Trigger (not pg_cron):** `*/5 * * * *` (every 5 minutes) — fallback drain keep-alive (`triggers.crons` in `wrangler.jsonc`)

---

## Notes

1. **Matched payments:** Retain narration until explicitly redacted via `customers/redact` or `shop/redact`. No time-based purge for matched payments.

2. **Invoice records:** Invoice rows are kept on `customers/redact` (buyer link anonymised) but deleted by CASCADE on `shop/redact` (`deleteShop()` Shop DELETE in `compliance.server.ts`). No legal-hold/tax retention is implemented.

3. **pgmq queue tables:** Shop-scoped messages deleted by `deleteShop()` from `pgmq.q_s6_sync`, `pgmq.q_s6_bulk`, `pgmq.a_s6_sync`, `pgmq.a_s6_bulk` (pgmq purge section in `deleteShop()` in `compliance.server.ts`).

4. **AuditEvent:** Access events (`access.*` types) are purged after 365 days by the daily pg_cron job `audit_purge_access_events_365d` (03:30 UTC). Financial events (`match.*`, `invoice.*`, `account.*`) are not purged by schedule and are deleted only by the shop/redact FK cascade (`deleteShop()` Shop DELETE in `compliance.server.ts`, `prisma/migrations/20261022000001_s5_data_model/migration.sql:284`). See `prisma/migrations/20261115000000_access_event_purge/migration.sql`.

5. **S8 tagged customer PII minimisation:** `minimiseCustomerPiiIfInactive()` in `compliance.server.ts` runs only at tag removal (from `customer.server.ts`) and requires `email IS NOT NULL`. If open invoices exist at tag removal, PII is not nulled later — no sweep job exists. `minimiseInactiveCustomerPii()` in `compliance.server.ts` is defined but never called — not implemented.

6. **Session expiry purge:** Expired Session rows are not purged on a schedule — not implemented. They are deleted only on `app/uninstalled` or `shop/redact`.

7. **DLQ sanitization (#262, #392):** When a message is dead-lettered for a shop that is gone, the DLQ row is sanitized to remove PII. Sanitization reasons: `shop_not_found` (handler returned shop_not_found error), `shop_row_missing` (no Shop row exists), `shop_uninstalled` (Shop row exists but uninstalledAt is set, i.e. 48h pre-redact window). Sanitized rows keep: `topic`, `reason`, `attemptCount`, `enqueuedAt`, `failedAt`, `shopId` (internal UUID, never the domain), `webhookId`, `resourceGid`. The shop domain (PII) and payload are dropped. Only covered topics (orders, companies, company_locations) are sanitized; customers and draft_orders keep full messages (no reconcile coverage yet). **Replay:** Sanitized messages are skipped and archived with `drain_skip_sanitized_message` log event. **Recovery:** After reinstall, the nightly reconcile (`reconcile-handlers.server.ts`) re-fetches all companies/orders via RECONCILE_COMPANIES and RECONCILE_ORDERS bulk ops.

---

## Not Implemented

- **Time-based PII-minimisation sweep:** `minimiseInactiveCustomerPii()` is never called; PII minimisation only happens at tag removal
- **Time-based Session expiry purge:** Expired sessions are not automatically purged
- **Invoice legal-hold / 7-year tax retention:** Only a code comment; not enforced
