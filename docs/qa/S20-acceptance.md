# S20 Acceptance Test Plan: Webhook idempotency, duplicates and out-of-order delivery

**Status:** partly built, **pending** in open PRs #28 (S6, head 5abf252) and #32 (S8, head d3e60a9). Nothing below exists on `main` @ 9343632 except header parsing. Behaviour that exists in those PRs is labelled **(existing in #28/#32)**; everything else is **required**.

What exists:
- **On main:** `app/lib/webhook-verify.server.ts` (`verifyWebhook`) returns `webhookId` from `X-Shopify-Webhook-Id`, or from `shopify-webhook-id` for event-style headers, with HMAC checked by constant-time compare.
- **Existing in #28/#32:**
  - Webhook routes (`webhooks.orders.tsx`, `webhooks.companies.tsx`, `webhooks.company_locations.tsx`, `webhooks.customers.tsx`, `webhooks.draft_orders.tsx`) verify, then `pgmq.send` to `s6_sync` with `{topic, shop, webhookId, resourceGid, enqueuedAt}`. They do **not** dedupe at enqueue, so a duplicate delivery produces a second queue message.
  - Processors call `isWebhookProcessed(sql, webhookId)` (`SELECT EXISTS … FROM s6_processed_webhooks`), then do the domain upsert (`ON CONFLICT ("orderId")`, `("shopId","companyLocationId")`, `(shop_id, customer_id)` or `(shop_id, draft_order_id)`), then `markWebhookProcessed` (`INSERT … ON CONFLICT (webhook_id) DO NOTHING`).
  - Check, write and mark are **separate statements, not one transaction**. This plan treats that as a risk to test (see S20-20).
  - `s6_processed_webhooks(webhook_id PK, topic, resource_gid, processed_at)` has **no shop column**. Its index on `processed_at` is meant for a ">7 days" purge in S10.

> **Assumptions (no spec in repo):**
> - The idempotency key is the Shopify webhook id. When an event id header is present (`X-Shopify-Event-Id`), it may be used as a secondary key for the same event delivered to multiple subscriptions.
> - Ordering is decided by the resource's `updated_at` from the payload or the Admin API, **not** by arrival order. A newer DB state must never be overwritten by an older event.
> - Dedupe retention is at least Shopify's retry window (48 h). 7 days is proposed in #28.

## 1. Purpose
This plan verifies that:
- duplicate deliveries (same webhook id or event id), retries, replays and out-of-order deliveries never cause double writes or regress state
- the idempotency keys are stored durably and safely, including under concurrent delivery

## 2. Preconditions and fixtures (synthetic data only)
- CI Postgres with pgmq, with all migrations up to `20261024000000_s8_customer_draft_order` applied (pending #28/#32).
- Shop `qa-shop-a.myshopify.com` in `"Shop"`, with buyer account C1 (COMPANY, `gid://shopify/CompanyLocation/7101`) and T1 (TAGGED_CUSTOMER, `gid://shopify/Customer/8001`).
- Signed synthetic webhook requests built with the test secret `test-api-secret-0000`, using HMAC-SHA256 over the raw body. Use the helper pattern from `app/lib/__tests__/webhook-verify.test.ts`.
- Synthetic payloads:
  - `orders/create` and `orders/updated` for `gid://shopify/Order/9200001` with payment terms, `total_price`, and `updated_at` T1 < T2 < T3
  - `customers/update` for 8001 with `tags`
  - `draft_orders/update` for `gid://shopify/DraftOrder/9300001`
- Webhook ids `qa-wh-dup-0001` and so on. Event ids `qa-evt-0001` and so on.

## 3. Test cases

### A. Duplicates
| # | Steps | Expected |
|---|---|---|
| S20-01 | Deliver `orders/create` with webhook id W twice, then drain. | Both HTTP responses are 200. Exactly **one** `Invoice` row for the order. `s6_processed_webhooks` has one row for W. The second message is skipped ("already processed") and removed from the queue. |
| S20-02 | Same as S20-01 for `company_locations/update`, `customers/update` and `draft_orders/update`. | Exactly one `BuyerAccount`, one `s8_tagged_customers` row and one `s8_draft_orders` row. Field values are unchanged by the duplicate. `updated_at` is not bumped by the duplicate (required). |
| S20-03 | Same event id, different webhook id (for example a second subscription). | No second domain write. Assumption: event id dedupe is required if more than one subscription can target the same handler. |
| S20-04 | Replay a W that is older than the retention window, after a purge. | The domain upsert is still safe: an identical payload yields an identical row, and an older `updated_at` is ignored (see section B). |
| S20-05 | Duplicate `orders/paid` or `orders/cancelled`. | The invoice status transitions once. There are no duplicate `AuditEvent` or `Match` rows and no double reduction of `outstanding`. |
| S20-06 | Missing webhook id header. | 400, from `getRequiredHeader` in `verifyWebhook` (existing on main). Nothing is enqueued. |

### B. Out-of-order delivery
| # | Steps | Expected |
|---|---|---|
| S20-10 | Deliver `orders/updated` (T2) **before** `orders/create` (T1), then drain. | The final `Invoice` reflects T2. The create (T1) does not overwrite newer fields. |
| S20-11 | Deliver updated T3, then updated T2. | The final state is T3. Required: the upsert carries `WHERE excluded.source_updated_at > existing` or equivalent. Assumption: a source `updated_at` column, or a fetch-latest-from-Admin-API strategy, is added. |
| S20-12 | `orders/cancelled` arrives before `orders/create`. | The final state is cancelled or closed. A late create does not resurrect an open invoice. |
| S20-13 | `customers/update` removing the tag arrives, then an older update re-adding it arrives. | The final `tag_active=false`. `holdState` is untouched (the S8 invariant). |
| S20-14 | `draft_orders/delete` arrives, then an older `draft_orders/update`. | The row stays deleted, so pending exposure does not reappear. Assumption: a tombstone or the processed-id check covers this. |
| S20-15 | Delete-then-create for the same CompanyLocation, with T2 newer than T1. | Matches the payload ordering. Document the expected result. |

### C. Idempotency-key storage and concurrency (negative and security)
| # | Steps | Expected |
|---|---|---|
| S20-20 | **Concurrent duplicate:** process two messages with the same W in parallel on two DB connections (`Promise.all`). | Exactly one domain write and one processed row. **Required fix if this fails:** do the claim atomically, with `INSERT … ON CONFLICT DO NOTHING RETURNING` *before* the write, or wrap check, write and mark in `sql.begin()` with `SELECT … FOR UPDATE`/advisory lock on the resource GID. |
| S20-21 | Crash between the domain write and the mark (inject a throw after the upsert). | The retry produces the same final state (the upsert is idempotent). There is no partial double effect on counters such as `outstanding`. |
| S20-22 | Crash after the mark but before the domain write (if claim-first is adopted). | The message is not ack'd, or the claim is rolled back. The event must not be silently lost. |
| S20-23 | Cross-shop key collision: the same W string for shop A and shop B. | Required: the key is scoped by shop, by adding `shop` to the PK, or by documenting that Shopify ids are globally unique and adding a test. |
| S20-24 | Key-storage hygiene: inspect `s6_processed_webhooks` rows. | They contain only `webhook_id, topic, resource_gid, processed_at`. No payload body, no HMAC, no secret. |
| S20-25 | Forged duplicate (bad HMAC) carrying a real W. | 401 from `verifyWebhook`. It is **not** recorded as processed, so it cannot poison the dedupe table and block the real event. |
| S20-26 | Retention purge (S10 pg_cron). | Only rows older than the window are deleted. Purging does not cause reprocessing of in-flight messages. |
| S20-27 | Shopify retry storm: 20 identical deliveries in under 1 s. | Every response is 200 within the CPU budget. One domain write. Queue depth is drained without errors. Assumption: enqueue-time dedupe is optional; it is fine as long as the drain is idempotent. |

## 4. Data-minimization checks
Only **Level 1 plus email and name** may be stored. **Phone and address are a fail.**
- **DM-1:** queue messages and `s6_processed_webhooks` hold no customer PII.
- **DM-2:** the customer processor (#32 `customer.server.ts` / `customer-fields.server.ts`) persists only `customer_id`, `tags`, `tag_active` and `tag_deactivated_at`, plus `email` / `display_name` **only** when `CUSTOMER_PII_FIELDS=1`. Feed a payload that **includes** phone, addresses and default_address, and assert that none of them reach any table or log.
- **DM-3:** duplicate and out-of-order logs print GIDs and webhook ids only.
- **DM-4:** the global schema scan finds no phone or address columns.

## 5. Vitest automation hints
- Extend `app/routes/__tests__/webhooks.s6.test.ts` / `webhooks.s8.test.ts` (from #28/#32) and `app/services/sync/__tests__/order.test.ts` / `customer.test.ts`.
- Build signed requests with node `crypto.createHmac('sha256', secret).update(body).digest('base64')`, and set `X-Shopify-Webhook-Id`, `X-Shopify-Topic` and `X-Shopify-Shop-Domain`.
- Integration goes in `app/__tests__/integration/s20-idempotency.test.ts` against the CI pgmq Postgres. Open two `postgres()` clients for real concurrency. Assert with `SELECT count(*)`.
- For out-of-order cases, use `it.each` over the permutations of [create T1, update T2, update T3, cancel] and assert the final state equals the newest event.
- For crash injection, `vi.spyOn(module, 'markWebhookProcessed').mockRejectedValueOnce(new Error('boom'))`.

## 6. Done criteria
- [ ] S20-01 through S20-06 pass for orders, company locations, customers and draft orders.
- [ ] S20-10 through S20-15 pass. There is a documented ordering strategy (source `updated_at` guard or fetch-latest).
- [ ] S20-20 passes under real concurrency, which means the claim is atomic or transactional.
- [ ] S20-21 through S20-27 pass. Forged requests cannot poison the dedupe table. The key scope (per-shop or global) is documented.
- [ ] DM-1 through DM-4 pass.
