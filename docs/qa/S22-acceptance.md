# S22 Acceptance Test Plan: shop/redact and customers/redact purge of all stored data

**Status:** partly built.
- **On `main` @ 9343632:** `app/routes/webhooks.compliance.tsx` verifies HMAC (`verifyWebhook`, constant-time, 401 on bad or missing HMAC, 400 on invalid JSON).
  - On `SHOP_REDACT` it calls `verifyPayloadShopMatch(shop, payload)` (400 on mismatch or missing `shop_domain`), then `sessionStorage.deleteAllForShop(payloadShop)` (`DELETE FROM "Session" WHERE shop = …`).
  - **It deletes sessions only; no S5 table is purged.**
  - `CUSTOMERS_REDACT` and `CUSTOMERS_DATA_REQUEST` are no-ops (`TODO(S22)`).
  - All of them return 200.
- **Pending in PR #32 (S8, head d3e60a9):**
  - `SHOP_REDACT` additionally calls `redactShopData`, which deletes `s8_tagged_customers` and `s8_draft_orders` by `shop_id`.
  - `CUSTOMERS_REDACT` calls `redactCustomerData`, which deletes `s8_tagged_customers` for `gid://shopify/Customer/<payload.customer.id>`.
  - It still **does not delete the `"Shop"` row**, so the S5 cascade never fires.
  - It resolves the shop for customers/redact from the **header** `shop`, without `verifyPayloadShopMatch`.
- Open issue #22 scopes the redaction of `Payment.narration`/`payerText` and `PayerAlias`.

Everything not listed above is **required behaviour**.

> **Assumptions (no spec in repo):**
> - shop/redact purges the shop by deleting the `"Shop"` row (letting the `ON DELETE CASCADE` FKs from `20261022000001_s5_data_model` remove the children), plus explicit deletes for tables with no FK to `"Shop"`.
> - customers/redact keeps financial records (amounts, UTR, match history) but removes or nulls personal data. This follows #22. Confirm with product.
> - The redact handlers run inside one transaction (`sql.begin`) so a partial purge cannot be committed.

## 1. Purpose
This plan verifies that:
- `shop/redact` removes **every** row the app stores for the shop identified by the **signed payload's `shop_domain`**
- `customers/redact` removes or redacts **only** the named customer's data in that shop
- unknown shops or customers are a safe no-op that returns 200
- the compliance endpoint stays secure, with HMAC, shop matching and no PII in logs

## 2. Table inventory (every table that must be covered)
| Table | Source | On main? | Shop key | Purged on shop/redact by | customers/redact scope |
|---|---|---|---|---|---|
| `Session` | init migration | **main** | `shop` (domain) | `deleteAllForShop` (**existing**) | n/a. Holds staff (online session) name and email, not customer data. |
| `Shop` | S5 `20261022000001` | **main** | `domain` | **required:** `DELETE FROM "Shop" WHERE domain = payload.shop_domain` | n/a |
| `AccountSource` | S5 | **main** | `shopId` FK CASCADE | Shop cascade (required) | n/a |
| `BuyerAccount` | S5 | **main** | `shopId` FK CASCADE | Shop cascade | **required:** for `kind=TAGGED_CUSTOMER` and `customerId=<gid>`, delete it or redact `name`. Decide how financial history is kept (#22). |
| `Invoice` | S5 | **main** | `shopId` FK CASCADE (direct) | Shop cascade, deleted before BuyerAccount per the migration notes | keep amounts; no customer PII columns |
| `BankImport` | S5 | **main** | `shopId` FK CASCADE | Shop cascade | n/a |
| `Payment` | S5 | **main** | `shopId` FK CASCADE (direct) | Shop cascade | **required (#22):** null or redact `narration` and `payerText` for payments matched to the customer's buyer account |
| `Match` | S5 | **main** | `shopId` FK CASCADE (direct) | Shop cascade | keep |
| `PayerAlias` | S5 | **main** | via `BuyerAccount` CASCADE | cascade via BuyerAccount | **required (#22):** delete the aliases for the customer's buyer account |
| `ReminderRule` | S5 | **main** | `shopId` FK CASCADE | Shop cascade | n/a |
| `ReminderLog` | S5 | **main** | `shopId` FK CASCADE (direct) | Shop cascade | keep (ids only) |
| `AuditEvent` | S5 | **main** | `shopId` FK CASCADE | Shop cascade | **required:** redact customer PII inside `data` JSON, if any |
| `s6_processed_webhooks` | #28 `20261023000000` | **pending #28** | **none** (no shop column) | **required:** a decision. Either add `shop` and delete by it, or document that rows hold no shop data and are TTL-purged (7 d). | n/a (`resource_gid` may be a Customer GID; TTL or delete) |
| `s6_bulk_operations` | #28 | **pending #28** | `shop` (domain, no FK) | **required:** explicit `DELETE … WHERE shop = …` | n/a |
| `pgmq.q_s6_sync`, `pgmq.a_s6_sync` | #28 (`pgmq.create`) | **pending #28** | `message->>'shop'` | **required:** delete the queued and archived messages for the shop, or document drain-side drop | delete messages whose `resourceGid` is the customer GID |
| `pgmq.q_s6_bulk`, `pgmq.a_s6_bulk` | #28 | **pending #28** | `message->>'shop'` | **required:** as above | n/a |
| `s8_tagged_customers` | #32 `20261024000000` | **pending #32** | `shop_id` (**no FK** to Shop) | `redactShopData` (**existing in #32**) | `redactCustomerData` (**existing in #32**) |
| `s8_draft_orders` | #32 | **pending #32** | `shop_id` (**no FK**) | `redactShopData` (**existing in #32**) | n/a (no PII columns) |

`_prisma_migrations` is excluded because it holds no shop data. **Whenever a migration adds a table, add a row here.** Test S22-09 enforces this.

## 3. Preconditions and fixtures (synthetic data only)
- CI Postgres with pgmq, with all migrations applied (on main, plus #28 and #32 when merged).
- **Shop A** `qa-redact-a.myshopify.com` (target) and **Shop B** `qa-redact-b.myshopify.com` (control). For each shop, seed **at least one row in every table in section 2**:
  - sessions
  - an AccountSource tag `net-terms`
  - BuyerAccounts: COMPANY C1, and TAGGED_CUSTOMER T1 (`gid://shopify/Customer/8001`) and T2 (`…/8002`)
  - invoices
  - a BankImport and Payments, with synthetic `narration="UPI/QA PAYER 8001/REF0001"`, `payerText="QA PAYER 8001"` and `utr="QAUTR0001"`
  - Matches and PayerAliases
  - a ReminderRule and ReminderLog
  - AuditEvents
  - `s6_processed_webhooks` and `s6_bulk_operations` rows
  - pgmq messages with `shop` set
  - `s8_tagged_customers` for 8001 and 8002
  - `s8_draft_orders`
- Test secret `test-api-secret-0000`. Bodies are signed with HMAC-SHA256 base64.
- Payloads follow Shopify's documented shapes:
  - shop/redact: `{shop_id, shop_domain}`
  - customers/redact: `{shop_id, shop_domain, customer:{id, email, phone}, orders_to_redact:[…]}`

  The payload's synthetic `email` and `phone` must **never** be stored or logged.

## 4. Test cases

### A. shop/redact
| # | Steps | Expected |
|---|---|---|
| S22-01 | Send a signed shop/redact with header shop A and payload `shop_domain` A. | 200. **Every** table in section 2 has 0 rows for shop A. Shop B row counts are unchanged. |
| S22-02 | Check the cascade ordering. | No FK violation (the NoAction FKs on Invoice, Payment and Match are satisfied by the direct Shop cascades, as the S5 migration notes). Single transaction: if it is forced to fail midway (inject an error), **no** shop A rows are deleted. |
| S22-03 | The header shop is A, but payload `shop_domain` is B. | **400** (existing `verifyPayloadShopMatch`). Neither shop loses any data. |
| S22-04 | Payload is missing `shop_domain`. | 400 (existing). Nothing deleted. |
| S22-05 | **Purge key comes from the signed payload:** assert the delete statements are parameterised with `payloadShop` (the value returned by `verifyPayloadShopMatch`), not with any unsigned input such as a query string. | Pass. |
| S22-06 | Unknown shop `qa-unknown.myshopify.com` (no `"Shop"` row, no sessions). | **200**. No error. No rows deleted anywhere. The log says no data was found. |
| S22-07 | Repeat S22-01 (a Shopify retry). | 200. Idempotent no-op. |
| S22-08 | shop/redact for a shop that was already uninstalled (sessions already removed by `webhooks.app.uninstalled`). | 200. The remaining S5, S6 and S8 data is purged. |
| S22-09 | **Inventory guard:** query `information_schema.tables` for `public` and `pgmq`. | Every table except `_prisma_migrations` appears in an allow-list kept in the test, mirroring section 2. A new unlisted table fails the test. |

### B. customers/redact
| # | Steps | Expected |
|---|---|---|
| S22-20 | Send a signed customers/redact for shop A, `customer.id=8001`. | `s8_tagged_customers` for 8001 is deleted (existing in #32). 8002's rows in shop A and all of shop B are untouched. |
| S22-21 | Same request: check the S5 tables. | **Required:** BuyerAccount T1 PII (`name`) is deleted or redacted. `PayerAlias` rows for T1 are deleted. `Payment.narration` and `payerText` for payments matched to T1 invoices are nulled or redacted, while `amount`, `utr` and `Match` rows are kept (#22). `AuditEvent.data` has no remaining 8001 PII. |
| S22-22 | pgmq messages whose `resourceGid=gid://shopify/Customer/8001` (shop A). | Required: deleted or archived-and-scrubbed. |
| S22-23 | **Shop resolution from the signed payload:** header A, payload `shop_domain` B. | **Required: 400**, with `verifyPayloadShopMatch` applied to customers/redact as well. As of #32 it uses the header `shop`; this test is expected to fail until fixed. |
| S22-24 | Unknown shop, or a known shop with an unknown customer id 9999. | **200**. No rows deleted (existing in #32: it logs "No shop or customer ID"). |
| S22-25 | Missing `customer.id`. | 200 with a no-op. Assumption: or 400. It must never fall back to deleting all customers. |
| S22-26 | `customer.id` given as a non-numeric string, or as an SQL-ish string. | Parameterised query; no injection. A no-op, 200. |
| S22-27 | customers/data_request. | 200. Assumption: the export covers only what is stored (GID, tags, and email/name if enabled). |

### C. Endpoint security (negative)
| # | Steps | Expected |
|---|---|---|
| S22-40 | Missing HMAC header. | **401** (existing). Nothing deleted. |
| S22-41 | Wrong HMAC, or a body altered after signing. | **401** (existing, constant-time compare). |
| S22-42 | Invalid JSON with a valid HMAC. | **400** (existing, `requireValidJson`). |
| S22-43 | GET request. | **405** (existing). |
| S22-44 | `SHOPIFY_API_SECRET` unset. | **500** (existing). Nothing deleted. |
| S22-45 | Logging: spy on console for all cases. | Logs contain topic, shop domain, webhook id and counts only. **No** customer email or phone from the payload, no narration, no secret. |

## 5. Data-minimization checks
Only **Level 1 plus email and name** may be stored. **Phone and address, or any other customer PII field, is a fail.**
- **DM-1:** schema scan across `public`. Fail on any column matching `/phone|address|addr|street|city|zip|postal|province|country_code|dob|birth/i`. `s8_tagged_customers.email` and `display_name` are allowed but must be NULL unless `CUSTOMER_PII_FIELDS=1`.
- **DM-2:** after S22-01, no row in any table contains the string `qa-redact-a`. After S22-20/21, no row contains `QA PAYER 8001`, `Customer/8001` or the payload's synthetic email.
- **DM-3:** the customers/redact payload's `email` and `phone` are never persisted or logged. Grep the console spy output and `SELECT … ::text ILIKE '%qa-phone%'`.
- **DM-4:** `Payment.narration` and `payerText` are recognised as PII-bearing (per the schema comment and #22) and are covered by redaction.

## 6. Vitest automation hints
- The route unit tests are in `app/routes/__tests__/webhooks.compliance.test.ts`. That file currently **mocks** `~/lib/webhook-verify.server`; keep those tests. Add a non-mocked suite that signs real requests, using the HMAC helper pattern from `app/lib/__tests__/webhook-verify.test.ts`.
- Integration goes in `app/__tests__/integration/s22-redact.test.ts`, next to `integration/s5-schema.test.ts`, against the CI Postgres service. Call `action({request, context})` with a real `getSql`, using the request-context pattern from `route-context-storage.test.ts`.
- Write a `countAllTablesFor(shopDomain|shopId)` helper that loops over the section 2 inventory (including `SELECT count(*) FROM pgmq.q_s6_sync WHERE message->>'shop'=$1`), and snapshot shop B before and after.
- For transaction atomicity, `vi.spyOn` the second delete to throw, then assert shop A counts are unchanged.
- Use `it.each` over the unknown shop, unknown customer, missing customer id and mismatched shop cases.

## 7. Done criteria
- [ ] S22-01 through S22-09 pass. Every table in section 2 is purged for the payload shop, and the control shop is untouched. The inventory guard is in CI.
- [ ] S22-20 through S22-27 pass. Only the named customer's data is removed or redacted, and the #22 narration/payerText/PayerAlias redaction is implemented.
- [ ] customers/redact validates payload `shop_domain` against the signed header (S22-23).
- [ ] Unknown shop or customer returns 200 with no deletes.
- [ ] S22-40 through S22-45 and DM-1 through DM-4 pass.
- [ ] Section 2 is updated as #28 and #32 merge (change "pending" to "main").
