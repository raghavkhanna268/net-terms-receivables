# S10 Acceptance Test Plan: Queue drain, cron auth, reconcile drift report

**Status:** S10 is not built yet. As of `main` @ 9343632 there is no drain route, no cron job and no reconcile code. Everything below is **required behaviour**, not a description of what exists. The plan is grounded in:
- PR #28 (S6, head 5abf252): adds the `s6_sync` and `s6_bulk` pgmq queues, `s6_processed_webhooks`, `s6_bulk_operations` and the sync processors in `app/services/sync/*`. Its migration enables `pg_cron` and `pg_net` as optional and states "No cron jobs are scheduled here; that's S10".
- PR #32 (S8, head d3e60a9): adds customer and draft-order processors and the `customers` bulk type.
- `workers/app.ts`: a per-request lazy `getSql()` over Hyperdrive, with no `sql.end()` since #33.
- Platform: Cloudflare Workers Free, with a **10 ms CPU** limit per invocation.

> **Assumption (no spec in repo):** no story document defines S10. These are assumed until product confirms them:
> - the drain is an HTTP route (for example `POST /internal/drain`) that pg_cron calls via `pg_net`
> - the secret lives in a Worker secret (for example `DRAIN_SECRET`) and travels in a header (for example `X-Drain-Secret` or `Authorization: Bearer`)
> - reconcile is a separate read-only job (for example `POST /internal/reconcile`) that produces a drift report
>
> Adjust names to match the implementation, but keep the required behaviour.

## 1. Purpose
This plan verifies that:
- the S10 drain processes S6/S8 queue messages in **bounded, configurable batches** that stay within the 10 ms CPU budget
- the drain and cron endpoints accept only callers holding the shared secret, compared in constant time, and the secret never leaks
- the reconcile job **detects** drift (missing, extra or stale rows) between Postgres and Shopify **without destructive writes**

## 2. Preconditions and fixtures (synthetic data only)
- **Database:** CI Postgres with pgmq (`ghcr.io/pgmq/pg16-pgmq`, per #28 ci.yml), with every migration applied: `20261022000000_init`, `20261022000001_s5_data_model`, `20261023000000_s6_pgmq_queues` and `20261024000000_s8_customer_draft_order`. pg_cron is absent in CI, so cron scheduling is tested by calling the endpoint directly.
- **Shops:** `qa-shop-a.myshopify.com` and `qa-shop-b.myshopify.com`. Insert both into `"Shop"`.
- **Secrets:** `DRAIN_SECRET=test-drain-secret-0000` is set only in the test env (vitest `env` or a `.dev.vars` that is **not committed**). Never use a real secret.
- **Queue fixtures:** use `pgmq.send` to put N synthetic messages on `s6_sync`, matching the `SyncMessage` shape in `app/lib/pgmq.server.ts`: `{topic, shop, webhookId, resourceGid, enqueuedAt}`. Use GIDs like `gid://shopify/Order/9000001` and webhook ids like `qa-wh-0001`.
- **Shopify mock:** a mocked Admin GraphQL client that returns a fixed synthetic list of companies, company locations, orders with payment terms, and tagged customers (GID and tags only).
- **Env knobs:**
  - `DRAIN_BATCH_SIZE`: required. Assumed default is 10 and assumed hard max is 50.
  - `DRAIN_VT_SECONDS`: the pgmq visibility timeout.

## 3. Test cases

### A. Batch bounds and CPU budget
| # | Steps | Expected |
|---|---|---|
| S10-01 | Enqueue 100 messages on `s6_sync`. Call the drain once with a valid secret and default config. | Exactly `DRAIN_BATCH_SIZE` messages (default) are read via `pgmq.read(..., qty)`, processed and deleted or archived. 100 − batch remain. The response reports `{processed, remaining?}` counts. |
| S10-02 | Set `DRAIN_BATCH_SIZE=5` and repeat. | Exactly 5 processed. |
| S10-03 | Set `DRAIN_BATCH_SIZE=0`, a negative value, `abc`, or a value above the hard max. | The value is clamped to the documented range (or falls back to the default). It never reads an unbounded batch. A warning is logged without the secret. |
| S10-04 | Enqueue 0 messages and call the drain. | 200 with `processed: 0`. No Shopify calls. |
| S10-05 | CPU budget: run the drain with a full batch of realistic synthetic messages under `wrangler dev` / Miniflare with CPU timing, or measure the handler's sync CPU in Vitest with `performance.now()` around the non-I/O work. | Handler CPU stays under 10 ms (target ≤ 7 ms headroom). Record the measurement in the PR. |
| S10-06 | A message fails processing (Shopify mock throws). | The message is **not** deleted. It becomes visible again after the VT. After the retry ceiling it is archived (`pgmq.archive`), not lost. Other messages in the batch still complete. |
| S10-07 | Redeliver an already-processed message (same `webhookId`). | It is skipped via `s6_processed_webhooks` (`isWebhookProcessed`) and deleted from the queue. No double write (see S20). |
| S10-08 | Bulk queue: enqueue an `s6_bulk` message for `bulkType=orders`. | The JSONL download and parse is chunked so that a single invocation stays under the budget. Assumption: it uses a cursor or offset persisted between invocations. |

### B. Shared-secret authentication (negative and security)
| # | Steps | Expected |
|---|---|---|
| S10-10 | Call the drain with no secret header. | **401**. No queue read, no DB write. |
| S10-11 | Wrong secret, same length. | **401**. |
| S10-12 | Wrong secret, different length, empty string, or whitespace-padded correct secret. | **401**. |
| S10-13 | Correct secret. | 200. |
| S10-14 | Constant-time compare: unit-test the compare helper. | It uses a constant-time routine (the same approach as `timingSafeEqual` in `app/lib/webhook-verify.server.ts`, or `crypto.subtle.timingSafeEqual`). Review: no `===` or `==` on the secret, no early return on first mismatch. A length mismatch still returns false without leaking timing that depends on content. |
| S10-15 | `DRAIN_SECRET` unset in env. | The endpoint fails closed: 500 or 401. It **never** accepts all requests. |
| S10-16 | Use GET instead of POST. | 405 (assumption: POST-only). |
| S10-17 | Secret hygiene: spy on `console.*` for all the cases above. | No log line contains the secret value or the raw header. `git grep -n "test-drain-secret\|DRAIN_SECRET="` shows only test fixtures or docs placeholders. `wrangler.jsonc` `vars` does **not** contain `DRAIN_SECRET`; it is a `wrangler secret`. |
| S10-18 | pg_cron job definition (migration or SQL): inspect it. | The secret is not hard-coded in a committed migration. Assumption: it comes from Supabase Vault (`vault.decrypted_secrets`) or a DB setting configured out of band. |

### C. Reconcile drift report (non-destructive)
| # | Steps | Expected |
|---|---|---|
| S10-20 | **Missing:** the Shopify mock has CompanyLocation L1 and Order O1 with payment terms; the DB has neither. | The report lists L1 and O1 under `missing` (in Shopify, not in DB), with shop, type and GID. |
| S10-21 | **Extra:** the DB has a `BuyerAccount` for L2 and an `Invoice` for O2 that Shopify does not return. | Listed under `extra`. |
| S10-22 | **Stale:** the DB `Invoice.total` or `dueAt` differs from Shopify, or `s8_tagged_customers.tags` differs. | Listed under `stale`, with the field names and the old and new values. Values are non-PII only. |
| S10-23 | No drift. | The report has empty arrays and `ok: true`. |
| S10-24 | **No destructive writes:** snapshot row counts and checksums of every S5, S6 and S8 table before and after reconcile. | All are identical. No `DELETE` or `UPDATE` on domain tables. The only allowed write is to a report store, if one is added (assumption). Verify with a SQL spy or a read-only transaction (`SET TRANSACTION READ ONLY`). |
| S10-25 | Shop isolation: drift seeded for shop A only. | The shop B report is empty. Shop A's report never references shop B GIDs. |
| S10-26 | Reconcile without the secret. | 401 (same rules as section B). |
| S10-27 | Shopify throttled or erroring. | The report is marked `partial`, with the error class. Nothing is deleted. Retry is safe. |

## 4. Data-minimization checks
The app may hold only **protected customer data Level 1 plus email and name** (`s8_tagged_customers.email` and `display_name`, NULL unless `CUSTOMER_PII_FIELDS=1`). **Phone and address are never allowed.**
- **DM-1:** queue message payloads (`s6_sync` and `s6_bulk`) contain only `topic, shop, webhookId, resourceGid|bulkOperationId, bulkType, enqueuedAt`. Fail if any customer field appears: phone, address, email, name, note.
- **DM-2:** drift report entries contain GIDs, types, non-PII field names and values only. Fail if phone or address appears, or if email or name appears while `CUSTOMER_PII_FIELDS` is off.
- **DM-3:** drain logs contain no customer PII and no secret.
- **DM-4:** schema check (Vitest integration). Query `information_schema.columns` across `public`. **Fail** on any column matching `/phone|address|addr|street|city|zip|postal|province/i`.

## 5. Vitest automation hints
- Put route tests under `app/routes/__tests__/` and follow `webhooks.s6.test.ts` from #28. Inject `context` with a fake `getSql`, using the pattern in `app/__tests__/integration/route-context-storage.test.ts`.
- Queue integration goes in `app/__tests__/integration/s10-drain.test.ts`. Use the real pgmq in CI, gated like `s6-pgmq.test.ts`, and use `SELECT pgmq.metrics('s6_sync')` for queue depth.
- Use `vi.stubEnv('DRAIN_SECRET', 'test-drain-secret-0000')` and `vi.stubEnv('DRAIN_BATCH_SIZE', '5')`. Restore with `vi.unstubAllEnvs()`.
- For logs: `const spy = vi.spyOn(console, 'log')` (and `warn` / `error`), then `expect(spy.mock.calls.flat().join(' ')).not.toContain(secret)`.
- For constant-time: a unit test plus a lint or grep guard. Avoid timing-statistics tests in CI because they are flaky.
- For non-destructive checks: wrap reconcile in a test transaction, capture `pg_stat_user_tables.n_tup_upd/n_tup_del` before and after, or count rows per table.
- For the CPU check: add an opt-in `bench`/`it.skipIf(!process.env.CPU_BENCH)` and record the result. Do not gate CI on wall-clock time.

## 6. Done criteria
- [ ] S10-01 through S10-08 pass. Batch size is env-configurable, clamped, and never unbounded.
- [ ] A measured CPU per drain invocation under 10 ms is documented in the PR.
- [ ] S10-10 through S10-18 pass. Auth is constant-time and fails closed. The secret is absent from logs, `wrangler.jsonc` vars and committed migrations.
- [ ] S10-20 through S10-27 pass. The reconcile report covers missing, extra and stale rows, and the row-count snapshot proves no destructive writes.
- [ ] DM-1 through DM-4 pass.
- [ ] Tests run in CI against Postgres with pgmq and need no real secrets.
