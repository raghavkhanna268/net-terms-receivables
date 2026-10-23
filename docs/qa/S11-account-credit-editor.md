# S11 Acceptance Test Plan: Account page, credit editor and credit-hold metafield

**Status:** not built on `main` @ `51d2266` (2026-10-23). The metafield **definitions** are merged: `app/lib/metafield-definitions.server.ts` runs `metafieldDefinitionCreate` for `$app.credit_status` on `COMPANY_LOCATION` and `CUSTOMER` during afterAuth (see `docs/metafields-contract.md`). The serializer is `app/lib/metafields-contract.ts`. There is no account-page route, no credit editor and no `metafieldsSet` writer. Everything below is **required behaviour** unless it is labelled **(existing on main)**.

> **Assumptions (no spec in repo):**
> - The account page is an embedded admin route (`app.accounts.$id.tsx` or similar) for one `BuyerAccount`. It shows the limit, exposure, open invoices, aging, and hold state.
> - The credit editor edits `creditLimit` (bigint paise), `holdState` and `holdReasonCode`. It writes the DB first, then pushes `$app.credit_status` with `metafieldsSet`.
> - The metafield owner is **CompanyLocation** for B2B and **Customer** for tagged buyers, as in `docs/metafields-contract.md` ("CompanyLocation overrides Company"). It is **not** written on `Company`. If the team intends the Company owner, the contract must change first.
> - `write_companies` / `write_customers` cover `metafieldsSet` on these owners. No new scope is needed.

## 1. Purpose
This plan verifies that:
- a merchant can view a buyer account and edit its credit limit and hold
- every edit produces a correct, schema-valid `$app.credit_status` on the right owner, idempotently, without PII and without new scopes

## 2. Preconditions and fixtures (synthetic data only)
- CI Postgres with all migrations on `main` applied.
- Shop `qa-shop-a.myshopify.com` (INR) with these buyer accounts:
  - B1 (COMPANY, `gid://shopify/CompanyLocation/7101`, limit `10000000` paise, exposure `2500000`)
  - T1 (TAGGED_CUSTOMER, `gid://shopify/Customer/8001`)
  - G1, gated (`gated_at` set), used only for PLAN_GATING_ENFORCED=true cases
- Open invoices for B1 in each aging bucket (synthetic, `qa-` prefixed GIDs).
- A mocked Admin GraphQL client that records `metafieldsSet` variables and can return `userErrors` / HTTP 429 / 5xx.
- `tests/fixtures/credit-status.json` (the shared Rust/TS fixture).

## 3. Test cases

### A. Account page
| # | Steps | Expected |
|---|---|---|
| S11-01 | Open the account page for B1 as an authenticated admin. | Shows the name (company name, or customer displayName only when `CUSTOMER_PII_FIELDS=1`), limit, exposure, available credit (limit − exposure, never negative-wrapped), hold state, and open invoices with aging buckets that match S7 for the same `asOf`. |
| S11-02 | Open an account id belonging to another shop. | 404. No data leak. Every query is scoped by `shopId`. |
| S11-03 | Unauthenticated, or a bad session token. | Redirect or 401 from `authenticate.admin`. |
| S11-04 | Amounts are formatted. | INR uses `formatPaiseAmount` (en-IN). There is no float math, and currencies are never mixed. |
| S11-05 | T1 with `CUSTOMER_PII_FIELDS` unset. | Shows the GID or "Customer 8001" only. No email or name. |

### B. Credit editor (DB)
| # | Steps | Expected |
|---|---|---|
| S11-10 | Set the limit to ₹1,50,000.00. | `creditLimit = 15000000` paise (bigint). One `AuditEvent` with old and new values (amounts only). |
| S11-11 | Invalid input: negative, non-numeric, more than 2 decimals, or above the max u64. | Server-side validation error. No DB write, no metafield push. |
| S11-12 | Put on hold with reason `MANUAL_HOLD`, then release. | `holdState` transitions. `holdReasonCode` is from the contract enum only. AuditEvent per change. |
| S11-13 | Double submit, or two tabs saving at once. | The last write wins deterministically (optimistic version or `updatedAt` check). No lost update without a warning. |
| S11-14 | CSRF / non-POST mutation. | Rejected. Mutations happen only in the `action` with a valid session. |

### C. metafieldsSet writer
| # | Steps | Expected |
|---|---|---|
| S11-20 | Save B1. | One `metafieldsSet` call with `ownerId = gid://shopify/CompanyLocation/7101`, `namespace: "$app"`, `key: "credit_status"`, `type: "json"`. |
| S11-21 | Save T1. | `ownerId = gid://shopify/Customer/8001`. |
| S11-22 | Validate the value. | Produced by `serializeCreditStatus()`. It passes the JSON schema in `docs/metafields-contract.md`: `schemaVersion: 1`, `currencyCode` = shop currency, `hold`, `holdReasonCode`, `limitPaise`/`exposurePaise` as digit strings, ISO `updatedAt`, no extra keys. |
| S11-23 | The value round-trips through the Rust validation test, using the same fixture. | `credit-check-validation` blocks when `hold=true` or exposure + cart > limit, and passes otherwise. |
| S11-24 | Re-save with no change. | It is safe to set the same value again. No duplicate AuditEvent for a no-op (or it is documented). |
| S11-25 | `metafieldsSet` returns `userErrors`. | The DB change stays. The push is retried or queued. The UI shows "Saved; syncing to Shopify failed, will retry". Errors are logged with codes only. |
| S11-26 | 429 / 5xx. | Bounded retry with backoff (S20 throttle helpers). It does not block the request beyond the CPU budget. |
| S11-27 | No metafield is ever written to a `Company` owner, or to an owner outside the shop. | Asserted on all recorded calls. |
| S11-28 | Exposure changes from S6 sync or S17 apply. | The metafield is refreshed with the new `exposurePaise` (hook point documented). |

### D. Gating (PLAN_GATING_ENFORCED stays off)
| # | Steps | Expected |
|---|---|---|
| S11-30 | `PLAN_GATING_ENFORCED` unset, or `"false"` (prod value in `wrangler.jsonc`). | All accounts are editable, including G1. `activeAccountFragment` returns `TRUE`. |
| S11-31 | Test-only, with `"true"`. | G1 is read-only or hidden with an upgrade notice. Prod config is not changed. |

## 4. Protected customer data, scopes and data minimization (DPDP)
- **PCD-1:** Only Level 1 plus customer **Email and Name** (`email`, `displayName`) may be read, and only when `CUSTOMER_PII_FIELDS=1`. **Phone, addresses, firstName, lastName and defaultAddress are a fail.** Any new GraphQL query must pass `validateNoForbiddenFields()` / the allowed-field check in `customer-fields.server.ts`.
- **PCD-2:** The `credit_status` metafield value contains no PII (schema `additionalProperties: false`, with reason codes only).
- **SCOPE-1:** `shopify.app.toml` `scopes` and the `wrangler.jsonc` `SCOPES` var remain exactly the 11 production scopes. **No `write_payment_terms` and no `write_draft_orders`.** `scripts/check-scope-sync.ts` passes in CI.
- **SCOPE-2:** `metafieldsSet` works with the existing `write_companies` / `write_customers`. Any `ACCESS_DENIED` is a fail, not a reason to add scopes.
- **DPDP-1:** AuditEvents store ids, amounts and reason codes only. No email or name is copied into audit rows or logs.
- **DPDP-2:** Logs (`console.*` spy) print GIDs and codes only.
- **DPDP-3:** The schema scan finds no phone or address columns. A `customers/redact` or `shop/redact` compliance webhook removes or blanks any stored name or email for the account.

## 5. Vitest automation hints
- Route tests next to `app/routes/__tests__/app._index.test.ts`, with loaders and actions mocked via `authenticate.admin`.
- Writer unit tests mock `adminGraphQL` and snapshot the `metafieldsSet` variables, then validate them against the JSON schema with `ajv` or a hand check, using `tests/fixtures/credit-status.json`.
- Integration tests run against CI Postgres for the DB writes, AuditEvent rows and cross-shop isolation.
- Rust: `cargo test` in `extensions/credit-check-validation` must load the same fixture.

## 6. Done criteria
- [ ] S11-01 through S11-05 pass. The account page is shop-scoped and shows no PII when the flag is off.
- [ ] S11-10 through S11-14 pass.
- [ ] S11-20 through S11-28 pass. The metafield is on CompanyLocation or Customer only and is schema-valid.
- [ ] S11-30 and S11-31 pass, and prod `PLAN_GATING_ENFORCED` is still `"false"`.
- [ ] PCD-1/2, SCOPE-1/2 and DPDP-1 through DPDP-3 pass.
- [ ] CI "CI" workflow is green on the PR head: lint, scope-sync, typecheck, vitest, Rust functions and build. New tests are real (they import production code and assert DB or GraphQL effects), not tautologies.
