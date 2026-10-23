# S13 Acceptance Test Plan: Hide payment terms (payment customization Function) and merchant-managed fulfillment hold

**Status:** not built on `main` @ `51d2266` (2026-10-23). The only extension is `extensions/credit-check-validation` (S12). There is no payment-customization extension and no `paymentCustomizationCreate` / `fulfillmentOrderHold` code. The scopes `write_payment_customizations` and `write_merchant_managed_fulfillment_orders` are pre-granted (see `docs/qa/S24-scope-audit.md`). Everything below is **required behaviour**.

> **Assumptions (no spec in repo):**
> - A Rust payment-customization Function (`extensions/net-terms-payment-customization`) reads `$app.credit_status` with the same precedence as S12: `purchasingCompany.location.metafield` first, then `customer.metafield`. It **hides** the deferred/net-terms payment option when `hold=true` or `exposurePaise + cartTotal > limitPaise` (same currency). Otherwise it is a no-op.
> - The app registers the customization once per shop with `paymentCustomizationCreate` in afterAuth, idempotently, next to `validation-registration.server.ts`.
> - Fulfillment hold: when an order arrives from a held account, the drain calls `fulfillmentOrderHold` (reason `AWAITING_PAYMENT` or `OTHER`, with a code-only reason note) on its **merchant-managed** fulfillment orders. It calls `fulfillmentOrderReleaseHold` when the hold is cleared (S11 editor or S17 apply).
> - Payment terms on the order are **never modified**. This needs no `write_payment_terms`.

## 1. Purpose
This plan verifies that:
- held or over-limit buyers do not see net terms at checkout, and everyone else is unaffected (fail-open)
- orders from held accounts are put on fulfillment hold and released correctly
- all of this works with the existing 11 scopes and no PII

## 2. Preconditions and fixtures (synthetic data only)
- Shared fixture `tests/fixtures/credit-status.json`. Function input JSON fixtures:
  - B2B held
  - B2B over limit
  - B2B under limit
  - tagged customer held
  - guest
  - malformed metafield
  - unknown `schemaVersion`
  - currency mismatch
  - B2B + customer both present (precedence)
- Payment methods in fixtures: "Net 30" (deferred), "Credit card", "Bank transfer".
- CI Postgres with B1 (COMPANY, HELD), B2 (COMPANY, ACTIVE) and T1 (TAGGED_CUSTOMER, HELD). Orders `gid://shopify/Order/9400001…`, and merchant-managed FulfillmentOrders `gid://shopify/FulfillmentOrder/9500001…`. One third-party FO (not merchant-managed).
- Mock Admin client that records mutations and can return userErrors, 429 or 5xx.

## 3. Test cases

### A. Payment customization Function (Rust)
| # | Steps | Expected |
|---|---|---|
| S13-01 | B2B, `hold=true`. | Output has one `hide` operation for the net-terms method(s) only. Card and bank transfer stay visible. |
| S13-02 | B2B, over limit (same currency). | Net terms hidden. |
| S13-03 | B2B, under limit, no hold. | Empty operations (no-op). |
| S13-04 | Tagged customer, `hold=true`, no purchasingCompany. | Net terms hidden, using `customer.metafield`. |
| S13-05 | B2B location not held, but the customer metafield is held. | No-op. B2B takes precedence. |
| S13-06 | Guest, missing metafield, malformed JSON, missing fields, unknown `schemaVersion` or currency mismatch. | Fail-open: empty operations, never a panic. |
| S13-07 | Amount edge cases: exposure + cart == limit; limit `"0"`; amounts at the u64 max. | == limit is allowed (matches S12). There is no overflow (checked arithmetic). |
| S13-08 | The input query references `metafield(namespace: "$app", key: "credit_status")` on both owners. | Prod Diagnostics-style grep passes. The query requests no customer email, phone or address. |
| S13-09 | Instruction count / WASM size. | Within Shopify Function limits. `cargo test` and the WASM build pass in the CI "Rust functions" job. |

### B. Registration
| # | Steps | Expected |
|---|---|---|
| S13-10 | afterAuth on a fresh shop. | One `paymentCustomizationCreate` (enabled) for the function handle. |
| S13-11 | Re-auth, or a second install. | Idempotent: an existing one is found and no duplicate is created. A disabled one is re-enabled or reported. |
| S13-12 | `userErrors` / `ACCESS_DENIED`. | Logged with codes only. Install is not blocked, and the shop is not marked done. No scope is added. |

### C. Merchant-managed fulfillment hold
| # | Steps | Expected |
|---|---|---|
| S13-20 | `orders/create` for B1 (HELD), then drain. | `fulfillmentOrderHold` is called on each **merchant-managed** FO of the order, with a code-only reason. One AuditEvent. The order's payment terms are untouched. |
| S13-21 | Order for B2 (ACTIVE). | No hold call. |
| S13-22 | A third-party / app-fulfilled FO on a B1 order. | Not held (outside the scope). Logged as skipped. |
| S13-23 | Duplicate `orders/create` (same webhook id, S20). | Only one hold. A second hold attempt on an already-held FO is treated as success. |
| S13-24 | The hold is cleared through the S11 editor or S17 apply. | `fulfillmentOrderReleaseHold` is called for every FO this app held. FOs held by others are not touched. AuditEvent. |
| S13-25 | 429 / 5xx on hold. | Retried via the queue. The message is not ack'd until the hold succeeds or hits the DLQ, then it surfaces in Prod Diagnostics. |
| S13-26 | Order is cancelled or already fulfilled. | No hold. No error loop. |

## 4. Protected customer data, scopes and data minimization (DPDP)
- **PCD-1:** The Function input and Admin queries use Level 1 data only (ids, amounts, metafield). Customer **Email and Name** are only allowed where already gated by `CUSTOMER_PII_FIELDS=1`. **Phone and address are a fail.**
- **SCOPE-1:** The 11 production scopes are unchanged in `shopify.app.toml` and `wrangler.jsonc`. **No `write_payment_terms`** (we hide options, we do not edit terms). **No `write_draft_orders`.** The scope-sync check passes.
- **SCOPE-2:** `paymentCustomizationCreate` uses `write_payment_customizations`. Fulfillment hold and release use `write_merchant_managed_fulfillment_orders`. Any extra scope request is a fail.
- **DPDP-1:** Hold reason notes and AuditEvents carry codes and GIDs only. No buyer name or email.
- **DPDP-2:** Function logs (`log!`) and Worker logs contain no PII.
- **DPDP-3:** No new columns store customer contact data.

## 5. Vitest / cargo automation hints
- Rust: table-driven `#[test]`s over the JSON input fixtures, using `shopify_function::run_function_with_input`. Share `tests/fixtures/credit-status.json` with S12.
- TS: a unit test for the registration helper (mock `adminGraphQL`, assert idempotency). Integration tests for the drain hold/release against CI Postgres, with the Admin client mocked and asserting mutation variables.
- Use `it.each` over the merchant-managed vs third-party FO cases.

## 6. Done criteria
- [ ] S13-01 through S13-09 pass in the CI "Rust functions (test, build WASM)" job.
- [ ] S13-10 through S13-12 pass.
- [ ] S13-20 through S13-26 pass.
- [ ] PCD-1, SCOPE-1/2 and DPDP-1 through DPDP-3 pass. `PLAN_GATING_ENFORCED` is still `"false"` in prod.
- [ ] CI is green on the PR head. Tests import production code (no placebo assertions).
- [ ] Dev-store manual check (DevOps): a held B2B buyer does not see Net terms at checkout, and a held order shows "On hold" in admin.
