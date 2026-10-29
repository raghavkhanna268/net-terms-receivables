# Drain vs shop/redact: handler trace (#239 part b)

What each drain handler does when a queued message's Shop row is gone, and
whether it can re-create shop data after `deleteShop`. Line numbers are against
`main` at the commit that added this file.

## How a message reaches a handler after redact

`deleteShop` (`app/services/compliance/compliance.server.ts:136`) takes
`FOR UPDATE` on the Shop row, deletes the shop's rows from `pgmq.q_s6_sync`,
`q_s6_bulk`, `a_s6_sync`, `a_s6_bulk` and `s6_dead_letter`, and commits in one
transaction. After that, a message for the shop can only be in a worker's hands
if the worker read it before the commit (pgmq visibility timeout is not a lock).

1. **Drain guard, before any handler.** If the shop is not in the batch currency
   map, the drain re-checks `"Shop"` by exact domain. No row: the message is
   deleted with `pgmq.delete` and logged as `drain_shop_missing_deleted`
   (`app/services/drain/processor.server.ts:1411-1452` sync, `:1699-1740` bulk).
   No retry, no archive, no dead-letter.
2. **Race window.** The guard saw the row, then `deleteShop` committed before or
   while the handler ran. The handler outcomes below apply. Whatever the
   handler returns, the worker's last step touches a queue row that is already
   gone:
   - success: `pgmq.archive` returns false, nothing written to `a_s6_*`.
   - failure that dead-letters: `moveToDeadLetter`
     (`processor.server.ts:1222`) deletes first and inserts into
     `s6_dead_letter` only if the delete returned true, so nothing is written.
   - retryable failure: left for retry, but the queue row is gone, so it never
     comes back.

## Handlers

| Topic(s) | Handler | Shop lookup | Shop row gone (race window) | Can re-create rows? |
|---|---|---|---|---|
| COMPANIES_* | `handleCompany` (`processor.server.ts:232`) → `processCompanyWebhook` (`app/services/sync/company.server.ts:86`) | None | Writes `s6_processed_webhooks` (webhook_id, topic, company GID) via `markWebhookProcessed` (`company.server.ts:54-66`). CREATE/UPDATE call Admin first; `no_session` is relabelled to `shop_not_found` by `checkNoSessionForUninstalledShop` (`processor.server.ts:91`) | Yes, one `s6_processed_webhooks` row with no domain. See residuals |
| COMPANY_LOCATIONS_* | `handleCompanyLocation` (`processor.server.ts:300`) → `company-location.server.ts` | `company-location.server.ts:68` | Returns `shop_not_found` (`:75`), non-retryable | No. `BuyerAccount` writes need the Shop FK |
| ORDERS_* | `handleOrder` (`processor.server.ts:507`) → `order.server.ts` | `getEligibilityContextByDomain` (`order.server.ts:83`) | Returns `shop_not_found` (`:90`). `no_session` on a missing/uninstalled shop is acked (`processor.server.ts:549`) | No. `Invoice` writes need the Shop FK |
| CUSTOMERS_* | `handleCustomer` (`processor.server.ts:684`) → `customer.server.ts` | `customer.server.ts:108` | Returns `Shop not found` (`:115`), retryable by default; dead-letter attempt after 5 reads is a no-op (queue row gone) | No. `s8_tagged_customers` / `BuyerAccount` need the Shop FK |
| DRAFT_ORDERS_* | `handleDraftOrder` (`processor.server.ts:785`) → `draft-order.server.ts` | `draft-order.server.ts:73` | Returns `Shop not found` (`:80`) | No. `s8_draft_orders` needs the Shop FK |
| BULK_OPERATIONS_FINISH | `handleBulkOperationsFinish` (`processor.server.ts:874`) → `bulk-jsonl-processor.server.ts` | `bulk-jsonl-processor.server.ts:1268` | Returns `shop_not_found` (`:1275`) | No. Row writes are FK-linked; `s10b_*` / `order_outstanding_missing` counters take `FOR SHARE` on Shop (#463) |
| RECONCILE_* | `processor.server.ts:896-958` → `reconcile-handlers.server.ts` | `reconcile-handlers.server.ts:315` (customers), enqueue guards `:591`, `:655`, `:686` | Returns `shop_not_found` (`:408-416`); enqueue guards send nothing | No |
| CREDIT_STATUS_RECOMPUTE | `handleCreditStatusRecompute` (`processor.server.ts:992`) | Via BuyerAccount (`app/services/credit-status-recompute.server.ts:106`) | BuyerAccount cascaded away → `Buyer account not found`, non-retryable (`:110-118`); `markWebhookProcessed` is not reached | No. Enqueue takes `FOR SHARE` on Shop (#463) |
| REMINDER_SEND / REMINDER_CATCHUP | `app/jobs/reminders.ts:116`, `:185` | Via `ReminderRule` (Shop FK, cascade) | Rule not found → acked as skipped (`reminders.ts:122-128`) | No. No email is sent |

## Dead-letter rows from the uninstall window

Between app/uninstalled and shop/redact (about 48h) the Shop row exists with
`uninstalledAt` set. Messages that fail in that window are dead-lettered in a
sanitized form (`app/services/drain/dead-letter-sanitize.server.ts`): the domain
is dropped and the internal Shop id is kept at `message->>'shopId'`.

`deleteShop` used to delete `s6_dead_letter` only by `message->>'shop'`, so
these rows survived redact until the weekly 30-day cleanup. It now also deletes
by `message->>'shopId'` (`compliance.server.ts`, the `s6_dead_letter` block).
Rows sanitized up front for a `shop_not_found` reason (for example a bulk
`permanent:shop_not_found`) used to carry no `shopId` at all; `moveToDeadLetter`
now adds it when the Shop row is still present, so those rows match too.
Covered by `app/services/drain/__tests__/dlq-uninstall-redact-db.test.ts`.

## Residuals (not fixed, low impact)

- **`s6_processed_webhooks` row from COMPANIES_* in the race window.**
  `processCompanyWebhook` has no Shop lookup, so if `deleteShop` commits between
  the drain guard and `markWebhookProcessed`, one row (webhook_id, topic,
  company GID, no domain) can be written after redact. `deleteShop` removes
  Shopify webhook ids through `webhook_receipts`, which are already gone by then.
  The row expires through the 7-day `s10_processed_webhooks_cleanup` cron.
- **Sanitized dead-letter rows with no `shopId`.** If the Shop row is already
  missing when a row is dead-lettered (the race in
  `dlq-redact-race-db.test.ts`), the sanitized row has no domain and no shop id,
  so nothing links it to the shop. It expires through the 30-day DLQ cleanup.
