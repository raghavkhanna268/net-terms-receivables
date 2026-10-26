# Privacy Policy — Internal Implementation Details

> **Internal document.** This file contains engineering implementation details that map to the public privacy policy in `docs/privacy.md`. It is NOT rendered on the `/privacy` route.

---

## Database Schema Mapping

This section maps public privacy policy data categories to internal database tables and columns.

### Tagged Customer Data (S8)

| Table | Fields | Policy Section |
|-------|--------|----------------|
| s8_tagged_customers | Customer GID, tags, tag_active, email*, displayName* | 2.3 Tagged Customer Data |
| s8_draft_orders | Draft order GID, buyer account ref, total, status | 2.3 Tagged Customer Data |

*Email and displayName are **gated** by `CUSTOMER_PII_FIELDS=1` env var, which requires Protected Customer Data (PCD) approval. Level 2 (protected customer fields: Name, Email only) request is in Draft, not yet submitted (Raghav to submit), as of 26 Oct 17:15 IST; the fields remain NULL until approval and the flag is enabled.

**PII Minimisation (S22):** When a tagged customer becomes `tag_active=false` and has no open invoices, their email and displayName are automatically nulled.

### Bank Statement Data

| Table | Fields | Policy Section |
|-------|--------|----------------|
| Payment | value_date, amount, rail (NEFT/RTGS/IMPS/UPI), utr | 2.4 Bank Statement Data |
| Payment (PII) | payerText, narration | 2.4 Bank Statement Data |
| PayerAlias | normalized payer key, buyerAccountId | 2.4 Bank Statement Data |

**Implementation notes:**
- `Payment.narration` and `Payment.payerText` may contain personal data from bank statements
- Redacted during customers/redact if the payment is matched to the customer's buyer account: `payerText` becomes `NULL` and `narration` becomes `[REDACTED]`. This happens in a single transaction scoped to the signed shop, ensuring atomicity (if any step fails, the entire redaction rolls back so Shopify's retry can re-execute safely).
- Purged to `[RETENTION_PURGED]` after **180 days** for **unmatched** payments via nightly pg_cron job

**Retention purge implementation:**
- **What is purged:** `narration` → `[RETENTION_PURGED]`, `payerText` → `NULL`
- **What is kept:** `amount`, `utr`, `rail`, `valueDate`, `status`, and match history
- **Age calculation:** From `valueDate` (bank statement date), not import date
- **Schedule:** Daily at 04:00 UTC (09:30 IST) via `s22_purge_unmatched_narration` pg_cron job
- **Scope:** Unmatched payments only; matched payments retain narration until explicitly redacted via customers/redact or shop/redact

**Configuration:** The 180-day retention window is configured in the `s22_unmatched_narration_retention_days()` SQL function in migration `20261101000000_s22_followups`. The TS constant `UNMATCHED_NARRATION_RETENTION_DAYS` in `app/services/compliance/compliance.server.ts` documents the same value for reference.

### Data Request Records (S22)

| Table | Fields | Policy Section |
|-------|--------|----------------|
| s22_data_requests | Shop ID, customer GID, request ID, status, export JSON, expires_at | 2.5 Data Request Records |

### Operational Data

| Table | Fields | Policy Section |
|-------|--------|----------------|
| AuditEvent | Actor, action type, timestamp, event data | 2.6 Operational Data |
| ReminderLog | Rule ID, invoice ID, sent timestamp | 2.6 Operational Data |
| s6_processed_webhooks | Webhook ID, topic, resource GID | 2.6 Operational Data |
| s6_dead_letter | Queue, message, error | 2.6 Operational Data |
| s6_bulk_operations | Bulk operation ID, shop, type, byte offset | 2.6 Operational Data |
| s10b_order_refetch_null | Shop domain, date, count | 2.6 Operational Data |

---

## Compliance Webhook Handlers

### `app/uninstalled` Handler

**Handler:** `app/routes/webhooks.app.uninstalled.tsx`

When a merchant uninstalls the app:
1. All OAuth sessions for the shop are **immediately deleted** (`Session` table)
2. The shop is marked as uninstalled (`Shop.uninstalledAt` timestamp)
3. Shop configuration and business data remain until `shop/redact`

### `customers/data_request` Handler

**Handler:** `app/routes/webhooks.compliance.tsx`

Implementation details for data export:
1. **Verify** payload `shop_domain` matches header shop (returns 401 on mismatch)
2. **Look up** all customer data scoped to that shop:
   - `s8_tagged_customers`: GID, tags, tag_active, email, displayName
   - `s8_draft_orders`: Draft orders linked to customer's buyer account
   - `BuyerAccount`: Account details (kind=TAGGED_CUSTOMER)
   - `Invoice`: Invoice history linked to buyer account (no LIMIT)
3. **Generate** JSON export with all found data
4. **Persist** `s22_data_requests` record with status, export data, and 30-day expiration
5. **Notify** shop owner via email (if configured)
6. **Return** 200 (export available for merchant download)

**Data delivery implementation:**
- **Primary:** In-admin download via `/app/data-requests` route (fetches resource route, creates Blob, marks downloaded on success)
- **Notification:** Email to shop owner via Resend API (gated on `RESEND_API_KEY` and `RESEND_FROM` env vars)
- **Retention:** Exports are retained for **30 days** (DPDP minimisation), purged on next access and nightly where pg_cron is enabled

**Email notification implementation:**
- Email contains ONLY a notice and link to the in-admin download page
- **NO customer PII** is included in the email (no GID, email, name, or tags)
- Shop owner email is fetched via Admin API (`shop { email contactEmail }`) using the app's offline session at send time and **never stored or logged**
- If `RESEND_API_KEY` or `RESEND_FROM` is not set, email is skipped and logged as `data_request_email_skipped`
- Pre-launch recipient allowlist guard: when `RESEND_RECIPIENT_ALLOWLIST_ENFORCED` is not exactly `"false"` (default: enforced), the allowlist blocks sends:
  - If `RESEND_TEST_RECIPIENTS` is empty/unset, email is skipped with reason `recipient_allowlist_empty`
  - If recipient is not in `RESEND_TEST_RECIPIENTS` allowlist, email is skipped with reason `recipient_not_allowlisted`
- When `RESEND_RECIPIENT_ALLOWLIST_ENFORCED=false`, the allowlist guard is disabled and all recipients are allowed
- **No diagnostics output exists for this flag** (Actions cannot read Worker secret values). Verification at the launch flip is a live send to a non-allowlisted test inbox, performed by DevOps after setting the flag to exactly `"false"`, and only with owner approval. The flag stays enforced until then.
- Resend API failures do not fail the webhook (still returns 200, logs status code only, export still available)

### `customers/redact` Handler

**Handler:** `app/routes/webhooks.compliance.tsx`

Implementation details for customer erasure:
1. **Verify** payload `shop_domain` matches header shop (returns 401 on mismatch)
2. **All operations run in a single database transaction** for atomicity. If any step fails, the entire redaction rolls back, allowing Shopify's retry mechanism to safely re-execute.
3. **Delete** `s8_tagged_customers` row for the customer
4. **Delete** `s8_draft_orders` linked to customer's buyer account
5. **Delete** `s22_data_requests` for the customer (contains PII in export)
6. **Redact** `Payment` fields for payments linked via Match→Invoice→BuyerAccount:
   - `payerText` → `NULL`
   - `narration` → `[REDACTED]`
   - Preserved: `amount`, `utr`, `rail`, `valueDate`, and all Match/RejectedMatch rows and AuditEvent history
   - Shop-scoped: queries include `p."shopId"`, `m."shopId"`, and `i."shopId"` predicates
7. **Delete** `PayerAlias` rows for the customer's buyer account (learned payer keys)
8. **Anonymize** `BuyerAccount`:
   - Set `name` to "Redacted Customer"
   - Append timestamp to `customerId` to prevent FK conflicts
9. **Preserve** `Invoice` records for legal/tax compliance (Invoice has no customer-identifying fields; buyer relationship is through BuyerAccount which is anonymized)

### `shop/redact` Handler

**Handler:** `app/routes/webhooks.compliance.tsx`

Implementation details for shop data deletion:
1. **Verify** payload `shop_domain` matches header shop (returns 401 on mismatch)
2. **Delete** all OAuth sessions for the shop (`Session` table)
3. **Delete** `webhook_receipts` for the shop
4. **Delete** shop data via `deleteShop` (in `app/services/compliance/compliance.server.ts`) in a single transaction:
   - Non-FK tables with `shop` text column: `s10b_order_refetch_null`, `s6_bulk_operations`, `order_outstanding_missing`, `s10b_customer_pii_fallback`
   - pgmq queue and archive tables: `pgmq.q_s6_sync`, `pgmq.q_s6_bulk`, `pgmq.a_s6_sync`, `pgmq.a_s6_bulk` (messages where `message->>'shop'` matches)
   - Dead-letter queue: `s6_dead_letter` (rows where `message->>'shop'` matches)
   - `Shop` row — **all shop data cascades via ON DELETE CASCADE FKs**:
     - `AccountSource`, `BuyerAccount`, `BankImport`, `ReminderRule`, `AuditEvent`
     - `Invoice`, `Payment`, `Match`, `ReminderLog` (direct Shop FKs)
     - `s8_tagged_customers`, `s8_draft_orders` (S8 FKs)
     - `s22_data_requests`, `backstop_processed_orders`, `s18_shop_reminder_settings` (S22/S13/S18 FKs)

---

## Data Retention After Deletion — Known Limitations

### pgmq Message Queue and Dead-Letter Cleanup

**Shop deletion removes queue messages:**

`deleteShop` (in `app/services/compliance/compliance.server.ts`) deletes the shop's messages from:
- Live queues: `pgmq.q_s6_sync`, `pgmq.q_s6_bulk`
- Archive tables: `pgmq.a_s6_sync`, `pgmq.a_s6_bulk`
- Dead-letter queue: `s6_dead_letter`

All deletes match `message->>'shop' = shopDomain` and run in a single transaction.

The legacy `purgePgmqMessages` function (in `compliance.server.ts`) is now a no-op kept for backward compatibility; `deleteShop` handles the pgmq cleanup.

**In-flight message edge case:**

pgmq visibility timeout (VT) is not a row lock. When a drain worker holds a message under VT and `deleteShop` runs, `deleteShop` deletes the message row from the queue table (see the in-code comment above the pgmq deletes in `deleteShop`). The test at `app/__tests__/integration/shop-redact-complete-db.test.ts` (the in-flight case) confirms this behavior.

When the worker finishes:
- If the handler succeeds, its `pgmq.archive()` or `pgmq.delete()` on the now-missing `msg_id` returns `false` without throwing — this is safe.
- If the handler fails with `retryable: false` (e.g., `no_session` because sessions were deleted), it dead-letters immediately. The `moveToDeadLetter` function (in `processor.server.ts`) calls `pgmq.delete` **before** inserting into `s6_dead_letter`. If the message was already deleted by `deleteShop`, `pgmq.delete` returns false and the dead-letter insert is skipped — no data is re-created.
- If the handler fails without `retryable: false` (e.g., `shop_not_found`), the message is dead-lettered only if that read had already reached `maxRetries`; otherwise it's left for retry, and because `deleteShop` removed its queue row, it never comes back.

This race is fixed by [#247](https://github.com/raghavkhanna268/net-terms-receivables/pull/247), which added delete-first dead-lettering in `moveToDeadLetter` plus FOR UPDATE (`deleteShop`) / FOR SHARE (drain senders) serialization. Refs [#239](https://github.com/raghavkhanna268/net-terms-receivables/issues/239); part (a) drain-side ack logging is tracked in [#254](https://github.com/raghavkhanna268/net-terms-receivables/pull/254).

**Dead-letter retention:**

The weekly `s10_dlq_cleanup_weekly` cron job (`prisma/migrations/20261024010000_s10_drain_cron/migration.sql:176-180`) deletes dead-letter rows older than 30 days. Combined with the weekly schedule, leftover failed jobs are purged up to about 37 days after they dead-lettered.

**Sync handlers with shop lookup:**

Handlers that perform shop lookup return an error if the Shop row is missing:
- `app/services/sync/customer.server.ts:85-95` — returns `{ success: false, error: "Shop not found: {domain}" }`
- `app/services/sync/order.server.ts:84-91` — returns `{ success: false, error: "shop_not_found", errorCode: "shop_not_found" }`

### Supabase Database Backups

Supabase-managed database backups may retain deleted data for the provider's backup retention window:
- Pro Plan: 7 days of daily backups
- Team Plan: 14 days of daily backups
- Enterprise Plan: up to 30 days of daily backups

See [Supabase Backups documentation](https://supabase.com/docs/guides/platform/backups).

### Shopify App-Owned Metafields

The app's `credit_status` metafield (namespace `$app`, key `credit_status`) on Shopify Company records is not explicitly cleared by the app on uninstall or shop/redact.

Per [Shopify metafield documentation](https://shopify.dev/docs/apps/build/metafields/definitions):
> "When a user uninstalls your app, Shopify deletes its app-owned metafield definitions and temporarily retains the metafields and their values without a definition. This applies to any app-owned definition, whether declared in `shopify.app.toml` or created with the GraphQL Admin API. Cleanup of the retained data runs asynchronously."

**Impact:** Uninstalling the app removes the app's Shopify Functions (payment customization, checkout validation), so the `credit_status` metafield value cannot affect checkout behaviour even if it persists temporarily before Shopify's asynchronous cleanup removes it.

### Sentry Error Events — Data Scrubbing

When Sentry is enabled, error events are scrubbed by `beforeSend` and `beforeSendTransaction` hooks (`app/lib/sentry.ts:140-150`) before transmission:

**Removed entirely:**
- `request.headers`, `request.cookies`, `request.query_string`, `request.data` (lines 85-95)
- `event.breadcrumbs` (line 115)

**Transformed:**
- `request.url` — query string stripped (lines 89-92)
- `exception.value` — replaced with error code via `toErrorCode` (lines 99-106)
- `event.message` — redacted via `redactString` (lines 110-112)

**Scrubbed to allowlist:**
- `event.extra`, `event.tags`, `event.contexts` — only keys in `ALLOWED_SENTRY_KEYS` (lines 37-46) are retained: `shopId`, `code`, `requestId`, `webhookId`, `jobId`, `topic`, `status`, `errorCode`

**Disabled via `dataCollection` config (lines 19-31):**
- `userInfo`, `cookies`, `httpHeaders`, `httpBodies`, `urlQueryParams`, `graphQL`, `genAI`, `databaseQueryData`, `queues`, `stackFrameVariables`, `frameContextLines`

---

## S10b Nightly Reconcile (Operational)

The app performs nightly reconciliation to ensure local ledger consistency with Shopify:

1. **pg_cron** triggers at 02:00 UTC daily
2. Worker enqueues `RECONCILE_COMPANIES` messages per active shop
3. Bulk export downloads JSONL via HTTP Range chunking (CPU-safe)
4. After companies complete, `RECONCILE_CUSTOMERS` is enqueued (skipped if shop has no tag rules)
5. After customers complete, `RECONCILE_ORDERS` is enqueued
6. Orders are upserted via the same S6 services as webhooks

**Data minimisation:**
- No drift report is generated or stored (removed in QA review)
- `s10b_order_refetch_null` stores only aggregate counts (shop, day, count) — **no order IDs or PII**
- 90-day retention purge via pg_cron job
- All rows deleted on shop/redact

**Order null-refetch handling:**
- Orders >60 days old may return null without `read_all_orders` scope
- These are counted but never marked deleted/paid/cancelled
- Last known invoice state is preserved

**Customers stage limitations (S8 backlog):**
- Reconcile only adds or updates customers matching tag rules; it does not remove tagged customers
- Removing a tag relies on the `customers/update` webhook (not reconcile)
- If a webhook is missed, the customer remains a tagged buyer until the next webhook event

---

## Data Retention pg_cron Jobs

| Job Name | Schedule | Purpose |
|----------|----------|---------|
| s22_purge_unmatched_narration | Daily 04:00 UTC | Purge unmatched payment narration after 180 days |
| s22_purge_data_requests_cleanup | Nightly | Purge expired data request records (30-day retention) |
| s10b_refetch_null_cleanup | Nightly | Purge order refetch null counts (90-day rolling) |

---

## Protected Customer Data Configuration

**Environment variable:** `CUSTOMER_PII_FIELDS=1`

When enabled:
- `s8_tagged_customers.email` and `s8_tagged_customers.displayName` are populated from Shopify
- Requires Shopify PCD approval, Level 2 (protected customer fields: Name, Email only)

When disabled or unset:
- Email and displayName fields remain NULL
- Tag-based buyer accounts work without PII

---

## Implementation Checklist

### Pre-Launch

- [ ] Complete Shopify Protected Customer Data (PCD) approval form
- [ ] Fill in `[TBD: ...]` sections in `docs/privacy.md` with actual company details
- [ ] Set up DPAs with Cloudflare and Supabase
- [ ] Accept [Resend DPA](https://resend.com/legal/dpa) before enabling email notifications
- [ ] Configure data retention policies for audit events
- [ ] Decide on email delivery for data requests (currently in-admin only)
- [ ] Verify CUSTOMER_PII_FIELDS flag is off in production until PCD approval

### Technical Verification

- [ ] Run S22 migration on production database
- [ ] Verify FK constraints are in place (see `s22-compliance.test.ts`)
- [ ] Test all compliance webhooks with Shopify's compliance test tool
- [ ] Verify no PII appears in application logs
- [ ] Confirm pgmq message handling for deleted shops
- [ ] Verify `/privacy` route is accessible without authentication

### Post-Launch Monitoring

- [ ] Monitor compliance webhook success rates
- [ ] Review data request exports for completeness
- [ ] Set up alerts for failed shop/redact operations
- [ ] Periodic audit of data retention compliance
