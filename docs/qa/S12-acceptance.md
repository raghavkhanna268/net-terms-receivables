# S12 Acceptance Test Plan: Credit hold, bypass and release

**Status:** S12 is not built yet. As of `main` @ 9343632 the schema has the fields but no hold logic exists. Everything below is **required behaviour**. The plan is grounded in:
- `prisma/schema.prisma` and `20261022000001_s5_data_model`:
  - `BuyerAccount.kind` is `COMPANY` or `TAGGED_CUSTOMER`.
  - `BuyerAccount.creditLimit` is set.
  - `BuyerAccount.holdState` is the enum `OK | NEAR_LIMIT | HELD | BYPASS`.
  - `BuyerAccount.bypass` is a Boolean.
  - `Invoice.outstanding` must satisfy `0 ≤ outstanding ≤ total` (CHECK).
  - `AuditEvent(shopId, actor, type, data jsonb, at)` exists.
  - The CHECK `BuyerAccount_kind_consistency` applies: COMPANY needs `companyLocationId` and TAGGED_CUSTOMER needs `customerId`.
- PR #28 (S6): CompanyLocation becomes `BuyerAccount(kind=COMPANY)`. Orders with payment terms become `Invoice`.
- PR #32 (S8): a tagged customer becomes `BuyerAccount(kind=TAGGED_CUSTOMER)`. **Tag sync never writes `holdState`** ("that belongs to credit logic alone"). **COMPANY takes precedence** when a customer is both a company contact and tagged. `s8_draft_orders.total` contributes pending exposure.

> **Assumptions (no spec in repo):**
> - Exposure = Σ open `Invoice.outstanding` + Σ `s8_draft_orders.total` where `has_payment_terms = true` for the account.
> - NEAR_LIMIT applies at ≥ 80% of `creditLimit` (configurable). HELD applies when exposure > `creditLimit`, or when an overdue invoice exists past a grace period, if the product chooses that.
> - "Blocked" means new net-terms orders or draft orders for a HELD account are prevented at checkout or draft-order completion. The exact mechanism might be a Shopify Function (payment customization or cart validation), removing payment terms, or a tag or metafield the store acts on; confirm it.
> - Only shop **staff with an admin session** (online session user from `Session`) can set or clear a bypass. The `actor` in `AuditEvent` is the staff user id or email, or `system` for automated transitions.
> - `holdState = BYPASS` and `bypass = true` must stay consistent. Assumption: `bypass=true` ⇔ `holdState=BYPASS`. Otherwise document which field is authoritative.

## 1. Purpose
This plan verifies that:
- held buyers (COMPANY and TAGGED_CUSTOMER) are blocked from new net-terms purchasing
- only authorised staff can bypass a hold, and every bypass leaves an audit trail
- releasing a hold (by payment, a limit change or an explicit release) restores normal purchasing, with an audit trail

## 2. Preconditions and fixtures (synthetic data only)
- **Shop:** `qa-shop-a.myshopify.com` (`"Shop"` row) and `qa-shop-b.myshopify.com` for isolation tests.
- **Company buyer:** `BuyerAccount` C1 with `kind=COMPANY`, `companyId=gid://shopify/Company/7001`, `companyLocationId=gid://shopify/CompanyLocation/7101`, `name="QA Wholesale Co"` and `creditLimit=100000.00`.
- **Tagged-customer buyer:** `BuyerAccount` T1 with `kind=TAGGED_CUSTOMER` and `customerId=gid://shopify/Customer/8001`. The matching `s8_tagged_customers` row has `tags=["net-terms"]`, `tag_active=true`, and `email` / `display_name` NULL.
- **Invoices:** for C1 and T1, open `Invoice` rows with synthetic `orderId` GIDs (`gid://shopify/Order/9100001…`) and `outstanding` values chosen per test.
- **Draft orders:** `s8_draft_orders` rows with `has_payment_terms=true` for pending-exposure tests.
- **Staff:** two synthetic online sessions. `staff-owner@example.test` has bypass permission; `staff-limited@example.test` does not (assumption: permission comes from a role or allow-list setting).

## 3. Test cases

### A. Hold evaluation
| # | Steps | Expected |
|---|---|---|
| S12-01 | Set C1 exposure to 50% of the limit, then run the credit evaluation. | `holdState=OK`. |
| S12-02 | Set C1 exposure to 85%. | `holdState=NEAR_LIMIT`. Not blocked. |
| S12-03 | Set C1 exposure to 101% (invoices only). | `holdState=HELD`. `AuditEvent(type='hold.applied', actor='system', data={buyerAccountId, exposure, creditLimit, reason})` is written. |
| S12-04 | C1 is at 95% from invoices, plus a draft order worth 10%. | HELD. The draft-order exposure is counted. |
| S12-05 | Run the evaluation twice with no change. | The state is unchanged and **no duplicate** `hold.applied` audit row is written (idempotent). |

### B. Blocking
| # | Steps | Expected |
|---|---|---|
| S12-10 | **Held company:** C1 is HELD. A buyer from CompanyLocation 7101 attempts a net-terms checkout or draft-order completion. | Blocked. The error or message is merchant-safe and contains no PII beyond the company name. No `Invoice` is created. |
| S12-11 | **Held tagged customer:** T1 is HELD. Customer 8001 attempts a net-terms order. | Blocked, as in S12-10. |
| S12-12 | Customer 8001 is both a contact of C1 (C1 is OK) and tagged (T1 is HELD). | The COMPANY account takes precedence (S8 rule), so the order maps to C1 and is **not** blocked. Repeat with C1 HELD and T1 OK: blocked. |
| S12-13 | Tag removed: an S8 `customers/update` drops the tag, so `tag_active=false`. | `holdState` is **unchanged** (S8 invariant). A HELD T1 stays HELD in the DB. Assumption: an inactive-tag buyer gets no net terms at all. |
| S12-14 | Shop isolation: C1 in shop A is HELD, and a buyer with the same GID exists in shop B. | Shop B is not blocked. |
| S12-15 | NEAR_LIMIT buyer orders. | Allowed. An optional merchant warning is shown. |

### C. Bypass (negative and security)
| # | Steps | Expected |
|---|---|---|
| S12-20 | `staff-owner` sets a bypass on a HELD C1 with a reason. | `holdState=BYPASS` and `bypass=true`. `AuditEvent(type='hold.bypass_set', actor=<staff id/email>, data={buyerAccountId, reason, previousState:'HELD', expiresAt?})` is written. The next order is allowed. |
| S12-21 | `staff-limited` attempts a bypass. | 403. The state is unchanged. Assumption: a denied attempt writes `AuditEvent(type='hold.bypass_denied')`. |
| S12-22 | An unauthenticated request, a forged form post without a session, or a request with the shop param spoofed to shop B. | 401 or 403. No change. The action is scoped to the session's shop only. |
| S12-23 | Bypass with an empty reason. | Rejected (400). Assumption: a reason is mandatory. |
| S12-24 | A webhook or sync path (S6/S8 processors, the S10 drain) tries to set `bypass`. | Code review and test: no sync path writes `bypass` or `holdState=BYPASS`. Only the staff action does. |
| S12-25 | Bypass expiry, if implemented. | After `expiresAt`, re-evaluation returns HELD and writes `hold.bypass_expired`. |
| S12-26 | Audit immutability. | No UI or route updates or deletes `AuditEvent` rows, except the S22 shop purge. |

### D. Release
| # | Steps | Expected |
|---|---|---|
| S12-30 | A HELD C1 receives a payment (`Match` reduces `Invoice.outstanding`) that brings exposure below the limit. | `holdState=OK` (or NEAR_LIMIT). `AuditEvent(type='hold.released', actor='system', data={reason:'payment', …})` is written. Orders are allowed. |
| S12-31 | Staff raise `creditLimit` above exposure. | Released. The audit records the actor and the old and new limits. |
| S12-32 | Staff clear the bypass on a BYPASS account that is still over the limit. | It returns to HELD (not OK). `bypass=false`. `hold.bypass_cleared` is audited. |
| S12-33 | Explicit manual release while still over the limit. | Not allowed unless it is done as a bypass (assumption). |
| S12-34 | Concurrent evaluation (two evaluations race on a payment and an order). | The final state matches the final exposure. There are no lost updates; use row lock or `UPDATE … WHERE holdState=…` guards. |

## 4. Data-minimization checks
Only **Level 1 plus email and name** may be stored. **Phone and address are a fail.**
- **DM-1:** the `AuditEvent.data` JSON for every hold, bypass and release event contains only ids, GIDs, amounts, states and the reason text. Fail on keys or values matching phone, address, email or name of the *customer*. The staff actor id or email is allowed as operator data, not customer data.
- **DM-2:** the block message shown to the buyer or merchant contains no customer email, phone or address.
- **DM-3:** `BuyerAccount.name` for TAGGED_CUSTOMER holds only the customer name when `CUSTOMER_PII_FIELDS=1`. Otherwise it holds a non-PII label (assumption; confirm with the S8 implementation).
- **DM-4:** the global schema scan (same as S10 DM-4) finds no phone or address columns.

## 5. Vitest automation hints
- Unit-test a pure `evaluateHold({exposure, creditLimit, bypass, thresholds})`, using a table-driven `it.each`.
- For integration against CI Postgres, seed with `scripts/seed.ts`-style helpers and synthetic GIDs, and assert `holdState` plus the `AuditEvent` rows via `SELECT type, actor, data FROM "AuditEvent" WHERE "shopId"=$1 ORDER BY at`.
- For route or authz tests, mock `authenticate.admin` to return the `staff-owner` or `staff-limited` session, and assert 403 for limited staff.
- For the "sync never writes bypass" check, spy on the SQL template in the processor tests from #32 (`customer.server.ts` tests) and assert no statement contains `"holdState"` or `"bypass"` in SET clauses.
- For concurrency, use `Promise.all` with two connections (`postgres()` twice) against CI Postgres.

## 6. Done criteria
- [ ] S12-01 through S12-05 pass, and evaluation is idempotent.
- [ ] S12-10 through S12-15 pass. Held COMPANY and held TAGGED_CUSTOMER are both blocked, and the precedence rule holds.
- [ ] S12-20 through S12-26 pass. Only authorised staff can bypass, a reason is required, and every bypass set, clear or deny is audited.
- [ ] S12-30 through S12-34 pass. Release paths are audited, and a cleared bypass while over the limit returns to HELD.
- [ ] DM-1 through DM-4 pass.
- [ ] The blocking mechanism and the bypass permission model are documented in the repo, replacing the assumptions above.
