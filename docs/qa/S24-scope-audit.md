# S24 Scope Audit: Production OAuth scope verification

> **Note (2026-10-27):** production has had 9 scopes since #289; the counts below are historical and kept as recorded.

---

## 2026-10-25: Scope reduction 11 → 8

**Commit:** This PR  
**Change:** Dropped `read_companies`, `read_customers`, `read_orders` from production scopes.

### Justification

Per [Shopify Access Scopes documentation](https://shopify.dev/docs/api/usage/access-scopes), 'How it works' section:

> "Any scope that writes a resource also grants read access to it, so request the write scope only when your app needs both."

### Scope Mapping

| Dropped Scope | Granted By | Code That Relies on Read Access |
|---------------|------------|--------------------------------|
| `read_companies` | `write_companies` | `bulk-operations.server.ts:32-70` (BULK_COMPANIES_QUERY), `webhooks.companies.tsx`, `webhooks.company_locations.tsx` |
| `read_customers` | `write_customers` | `admin-client.server.ts:136-191` (ORDER_QUERY `customer { id }`), `bulk-operations.server.ts:108-186` (BULK_ORDERS_QUERY `purchasingEntity … on Customer`, `customer { id }`), `customer-fields.server.ts:149,229` (`getCustomerQuery`, `getBulkCustomersQuery`), `webhooks.customers.tsx` |
| `read_orders` | `write_orders` | `bulk-operations.server.ts:108-186` (BULK_ORDERS_QUERY), `webhooks.orders.tsx` |

**Protected Customer Data note:** Reading customer data via `write_customers` is still protected customer data. PCD Level 2 (protected customer fields: Name, Email only): request complete (16/16), in Draft until App Store listing submission; Shopify reviews it with the listing.

### Final Production Scope List (8)

```
read_draft_orders,read_payment_terms,write_companies,write_customers,write_merchant_managed_fulfillment_orders,write_orders,write_payment_customizations,write_validations
```

### Runtime Scope Checking

The app does NOT compare granted scopes against requested scopes:

- **afterAuth** (`app/lib/after-auth.server.ts`): No scope validation. The `afterAuth` hook calls `upsertShopOnAuth` (line 354) and `syncShopTimezone` (line 222) but does not check session scopes against expected scopes.
- **app/scopes_update handler** (`app/routes/webhooks.app.scopes_update.tsx:42-48`): Stores whatever scopes Shopify grants via `sessionStorage.updateScopeForShop`. No comparison against expected scopes.

### Behaviour for Already-Installed Stores

Behaviour for already-installed stores (whether removed scopes are revoked, and whether a re-auth prompt appears) is to be verified by DevOps on the dev store after deploy.

### Webhook Subscription Scope Requirements

All webhook topics in `shopify.app.toml` are verified deliverable with the 8 production scopes:

| Topic | Required Scope | Status |
|-------|---------------|--------|
| `app/uninstalled` | None (app lifecycle) | ✓ |
| `app/scopes_update` | None (app lifecycle) | ✓ |
| `app_subscriptions/update` | None (app billing) | ✓ |
| `customers/data_request`, `customers/redact`, `shop/redact` | None (mandatory compliance) | ✓ |
| `companies/*` | `read_companies` (implied by `write_companies`) | ✓ |
| `company_locations/*` | `read_companies` (implied by `write_companies`) | ✓ |
| `orders/*` | `read_orders` (implied by `write_orders`) | ✓ |
| `bulk_operations/finish` | None (app's own operations) | ✓ |
| `customers/*` | `read_customers` (implied by `write_customers`) | ✓ |
| `draft_orders/*` | `read_draft_orders` (explicit) | ✓ |

**Verification method:** The original 2026-10-23 audit (below) documented that `companies/*`, `company_locations/*`, `customers/*`, `orders/*`, and `draft_orders/*` webhook subscriptions existed and were deliverable with the then-11 scopes. Per [Shopify Access Scopes](https://shopify.dev/docs/api/usage/access-scopes), write scopes imply read access, so these webhooks remain deliverable. App lifecycle, billing, and compliance webhooks do not require resource scopes.

---

## 2026-10-23: Original audit at 51d2266

**Audit date:** 2026-10-23  
**Commit:** `main` @ [`51d2266`](https://github.com/raghavkhanna268/net-terms-receivables/commit/51d22662b0629656fb810221a01054ef012f0d93) (`51d22662b0629656fb810221a01054ef012f0d93`, #70 S10b). All file:line citations below are at this SHA.  
**Auditor:** QA

This document maps each of the 11 production OAuth scopes in `shopify.app.toml` to the merged code on `main` that actually uses them. Each scope is classified as:
- **USED**: Merged code on `main` exercises the scope via GraphQL operations or webhooks
- **PRE-GRANTED**: Scope is included for an unshipped story; no merged code uses it yet
- **UNUSED**: Scope is in production config but no code (merged or planned) requires it

---

## Summary Table

| Scope | Status | Evidence |
|-------|--------|----------|
| `read_companies` | **USED** | `app/services/sync/bulk-operations.server.ts` (bulkOperationRunQuery), `app/routes/webhooks.companies.tsx`, `app/routes/webhooks.company_locations.tsx` |
| `read_customers` | **USED** | `app/services/drain/admin-client.server.ts:136-191` (ORDER_QUERY selects `customer { id }`, run by the drain for every order webhook), `app/services/sync/bulk-operations.server.ts:108-186` (BULK_ORDERS_QUERY selects `customer { id }` and `purchasingEntity … on Customer`), `app/routes/webhooks.customers.tsx` (customers/* subscription), `app/services/sync/customer-fields.server.ts:149,229` |
| `read_draft_orders` | **USED** | `shopify.app.toml` draft_orders/* webhook subscription, `app/routes/webhooks.draft_orders.tsx:41-43,77` (verifies, records receipt and enqueues DRAFT_ORDERS_CREATE/UPDATE/DELETE), `app/services/sync/draft-order.server.ts` (processDraftOrderWebhook → `s8_draft_orders`) |
| `read_orders` | **USED** | `app/services/sync/bulk-operations.server.ts` (BULK_ORDERS_QUERY), `app/routes/webhooks.orders.tsx` |
| `read_payment_terms` | **USED** | `app/services/sync/bulk-operations.server.ts` (Order.paymentTerms, CompanyLocation.buyerExperienceConfiguration.paymentTermsTemplate) |
| `write_companies` | **USED** | `app/lib/metafield-definitions.server.ts` (metafieldDefinitionCreate on COMPANY_LOCATION) |
| `write_customers` | **USED** | `app/lib/metafield-definitions.server.ts` (metafieldDefinitionCreate on CUSTOMER) |
| `write_merchant_managed_fulfillment_orders` | **PRE-GRANTED (S13)** | No merged code. Reserved for fulfillmentOrderHold/fulfillmentOrderReleaseHold |
| `write_orders` | **PRE-GRANTED (S17)** | No merged code in `app/`. Reserved for orderMarkAsPaid, tagsAdd, tagsRemove. (Note: `scripts/seed.ts` uses orderCreate and tagsAdd but seed is dev-only, not production app code) |
| `write_payment_customizations` | **PRE-GRANTED (S13)** | No merged code. Reserved for paymentCustomizationCreate |
| `write_validations` | **USED** | `app/lib/validation-registration.server.ts` (validationCreate for credit-check-validation Function) |

---

## Detailed Scope Analysis

### Read Scopes (5)

#### 1. `read_companies` — **USED**

| File | Operation | Details |
|------|-----------|---------|
| `app/services/sync/bulk-operations.server.ts:32-70` | `BULK_COMPANIES_QUERY` | `bulkOperationRunQuery` with `companies { ... locations { ... buyerExperienceConfiguration { paymentTermsTemplate { ... } } } }` |
| `app/routes/webhooks.companies.tsx` | Webhook handler | Handles `companies/create`, `companies/update`, `companies/delete` topics |
| `app/routes/webhooks.company_locations.tsx` | Webhook handler | Handles `company_locations/create`, `company_locations/update`, `company_locations/delete` topics |
| `app/services/sync/company-location.server.ts` | Processor | Upserts `BuyerAccount(kind=COMPANY)` from webhook payloads |

#### 2. `read_customers` — **USED**

| File | Operation | Details |
|------|-----------|---------|
| `app/services/drain/admin-client.server.ts:136-191` (`customer { id }` at line 185) | `ORDER_QUERY` | Drain re-fetch for every ORDERS_* message (`processor.server.ts` `handleOrder`, registered at lines 351-354). Reading `Order.customer` requires `read_customers`. |
| `app/services/sync/bulk-operations.server.ts:108-186` (lines 162, 166) | `BULK_ORDERS_QUERY` | `purchasingEntity { … on Customer { id } }` and `customer { id }` |
| `app/routes/webhooks.customers.tsx:38-40,74` | Webhook handler | `customers/create`, `customers/update`, `customers/delete` (subscription needs `read_customers`); receipt and enqueue in one `sql.begin` |
| `app/services/sync/customer-fields.server.ts:149` / `:229` | `getCustomerQuery()` / `getBulkCustomersQuery()` | `customer(id:)` and `bulkOperationRunQuery` with `customers(query: "tag:'...'") { id tags [email displayName] }` |
| `app/services/sync/customer.server.ts` | Processor | Upserts `s8_tagged_customers` (`processBulkCustomer` is called from `bulk-jsonl-processor.server.ts:456-458`) |

**Wiring gap found at 51d2266 (does not change the USED status):** `processor.server.ts:345-354` registers sync handlers only for COMPANIES_*, COMPANY_LOCATIONS_* and ORDERS_*. There is no handler for CUSTOMERS_* or DRAFT_ORDERS_*, so those messages are dead-lettered after `noHandlerMaxReads` (48 reads, at 1 h each; lines 68 and 566-575). `getBulkCustomersQuery` is only re-exported (`bulk-operations.server.ts:265`). The drain starts reconcile bulk operations for `companies` and `orders` only (`processor.server.ts:402,418`). This is raised as an S8 follow-up.

**Protected Customer Data:** Only `id`, `tags`, `email`, `displayName` are fetched. `email` and `displayName` require `CUSTOMER_PII_FIELDS=1`. Phone and address fields are blocked by `CUSTOMER_FORBIDDEN_FIELDS` in `customer-fields.server.ts`.

#### 3. `read_draft_orders` — **USED**

| File | Operation | Details |
|------|-----------|---------|
| `shopify.app.toml` | Webhook subscription | `draft_orders/create`, `draft_orders/update`, `draft_orders/delete`. Shopify needs `read_draft_orders` to deliver these. |
| `app/routes/webhooks.draft_orders.tsx:41-43,77` | Webhook handler | HMAC verify, topic allowlist, then `recordWebhookReceipt` + `sendSyncMessage` in one `sql.begin` |
| `app/services/sync/draft-order.server.ts` | Processor | `processDraftOrderWebhook`, `upsertDraftOrder`, `deleteDraftOrder`, `bulkUpsertDraftOrders` → `s8_draft_orders` (pending credit exposure) |

**Status change from the previous revision:** this was PRE-GRANTED. The S8 subscription, route and processor are merged on `main`, so the scope is exercised by production delivery of draft_orders/* webhooks. `docs/scopes.md` line 49 ("Pre-granted for S8") is now stale. **Caveat:** no drain handler is registered for DRAFT_ORDERS_* (see the wiring gap under `read_customers`), and no bulk `draftOrders` query is merged.

#### 4. `read_orders` — **USED**

| File | Operation | Details |
|------|-----------|---------|
| `app/services/sync/bulk-operations.server.ts:108-186` | `BULK_ORDERS_QUERY` | `bulkOperationRunQuery` with `orders(query: "financial_status:pending OR financial_status:partially_paid") { ... paymentTerms { ... } customer { id } purchasingEntity { ... } }` |
| `app/routes/webhooks.orders.tsx` | Webhook handler | Handles `orders/create`, `orders/updated`, `orders/cancelled`, `orders/paid` topics |
| `app/services/sync/order.server.ts` | Processor | Upserts `Invoice` from order webhook payloads |

#### 5. `read_payment_terms` — **USED**

| File | Operation | Details |
|------|-----------|---------|
| `app/services/sync/bulk-operations.server.ts:56-60` | `BULK_COMPANIES_QUERY` | Reads `CompanyLocation.buyerExperienceConfiguration.paymentTermsTemplate { id name dueInDays paymentTermsType }` |
| `app/services/sync/bulk-operations.server.ts:131-150` | `BULK_ORDERS_QUERY` | Reads `Order.paymentTerms { id paymentTermsName paymentTermsType dueInDays paymentSchedules { dueAt issuedAt completedAt amount } }` |
| `app/services/sync/order.server.ts:196-210` | Invoice due date | Computes `Invoice.dueAt` from `order.paymentTerms.paymentSchedules` or `dueInDays` |

---

### Write Scopes (6)

#### 6. `write_companies` — **USED**

| File | Operation | Details |
|------|-----------|---------|
| `app/lib/metafield-definitions.server.ts:83-100` | `metafieldDefinitionCreate` | Creates `credit_status` metafield definition on `ownerType: COMPANY_LOCATION` |

**Note:** The seed script (`scripts/seed.ts`) also uses `companyCreate`, `companyLocationCreate`, `companyLocationUpdate` but that is dev-only tooling, not production app code.

#### 7. `write_customers` — **USED**

| File | Operation | Details |
|------|-----------|---------|
| `app/lib/metafield-definitions.server.ts:83-100` | `metafieldDefinitionCreate` | Creates `credit_status` metafield definition on `ownerType: CUSTOMER` |

**Note:** The seed script uses `tagsAdd` on customers but that is dev-only tooling.

#### 8. `write_merchant_managed_fulfillment_orders` — **PRE-GRANTED (S13)**

**Status:** No merged code uses this scope.

**Planned usage per `docs/scopes.md` lines 100-108:**
- `fulfillmentOrderHold` — Hold fulfillment for orders from accounts that are overdue or on credit hold
- `fulfillmentOrderReleaseHold` — Release fulfillment hold

**Grep verification:**
```
rg "fulfillmentOrder" app/ --glob "*.ts" --glob "*.tsx"
(no results)
```

#### 9. `write_orders` — **PRE-GRANTED (S17)**

**Status:** No merged code in `app/` uses this scope.

**Planned usage per `docs/scopes.md` lines 74-77:**
- `orderMarkAsPaid` — Mark order as paid after bank match (S17)
- `tagsAdd` — Add tags to orders (overdue, hold, etc.) (S17)
- `tagsRemove` — Remove tags from orders (S17)

**Grep verification:**
```
rg "orderMarkAsPaid|tagsAdd|tagsRemove" app/ --glob "*.ts" --glob "*.tsx"
(no results)
```

**Note:** `scripts/seed.ts` uses `orderCreate` and `tagsAdd` but that is dev-only seed tooling, not production app behaviour.

#### 10. `write_payment_customizations` — **PRE-GRANTED (S13)**

**Status:** No merged code uses this scope.

**Planned usage per `docs/scopes.md` lines 91-96:**
- `paymentCustomizationCreate` — Payment method customization function
- `paymentCustomizationUpdate` — Update payment customization
- `paymentCustomizationDelete` — Delete payment customization

**Grep verification:**
```
rg "paymentCustomization" app/ --glob "*.ts" --glob "*.tsx"
(no results)
```

#### 11. `write_validations` — **USED**

| File | Operation | Details |
|------|-----------|---------|
| `app/lib/validation-registration.server.ts:78-97` | `validationCreate` | Registers `credit-check-validation` Shopify Function via `validationCreate(validation: { functionHandle: "credit-check-validation", title: "Net Terms Credit Check", blockOnFailure: false, enable: true })` |
| `extensions/credit-check-validation/shopify.extension.toml` | Function target | `target = "cart.validations.generate.run"` |

---

## Scopes NOT in Production

### `write_payment_terms` — **NOT IN PRODUCTION** ✓

**Verification:** `shopify.app.toml` scopes string does not include `write_payment_terms`.

**Per `docs/scopes.md` lines 132-141:**
> **No `write_payment_terms`**: Payment terms are configured on company locations via `companyLocationUpdate` with `buyerExperienceConfiguration.paymentTermsTemplateId` (requires `write_companies`). ... **No `write_payment_terms` scope is added** (Team Lead scope decision)

### `write_draft_orders` — **NOT IN PRODUCTION** ✓

**Verification:** `shopify.app.toml` scopes string does not include `write_draft_orders`.

**Per `shopify.app.toml` lines 26–28:**
> NOT in production: write_draft_orders. To add it for local development, run
> `shopify app config link` to create a local shopify.app.dev.toml (gitignored).
> See https://shopify.dev/docs/apps/build/cli-for-apps/manage-app-config-files

**Per `docs/scopes.md` line 128:**
> **No `write_draft_orders`**: The seed uses `orderCreate` with custom line items instead of draft orders.

---

## Comparison: `docs/scopes.md` vs Code

| Scope | `docs/scopes.md` Status | Code Reality | Match? |
|-------|-------------------------|--------------|--------|
| `read_companies` | S6 | USED in bulk-operations.server.ts, webhooks | ✓ |
| `read_customers` | S8 | USED: admin-client ORDER_QUERY, BULK_ORDERS_QUERY, customers webhooks, customer-fields.server.ts | ✓ |
| `read_draft_orders` | "Pre-granted for S8" | USED: draft_orders webhook subscription, route and processor merged | ⚠ docs/scopes.md stale |
| `read_orders` | S6 | USED in bulk-operations.server.ts, webhooks | ✓ |
| `read_payment_terms` | S6 | USED in bulk-operations.server.ts, order.server.ts | ✓ |
| `write_companies` | S11 (metafieldsSet), S4 (seed) | USED in metafield-definitions.server.ts | ✓ |
| `write_customers` | S11 (metafieldsSet) | USED in metafield-definitions.server.ts | ✓ |
| `write_merchant_managed_fulfillment_orders` | "Pre-granted for S13" | PRE-GRANTED, no code | ✓ |
| `write_orders` | S17 | PRE-GRANTED, no app/ code | ✓ |
| `write_payment_customizations` | "Pre-granted for S13" | PRE-GRANTED, no code | ✓ |
| `write_validations` | "Pre-granted for S12" but code exists | USED in validation-registration.server.ts | ✓ |

**Note on `write_validations`:** `docs/scopes.md` line 82 says "Pre-granted for S12" but `app/lib/validation-registration.server.ts` exists and calls `validationCreate`. The code is merged; the scope is actively USED, not just pre-granted.

---

## Recommendations

1. **No unused scopes found.** All 11 production scopes are either actively used or pre-granted for documented upcoming stories (S13, S17).

2. **Pre-granted scopes (3) should ship with their stories:**
   - `write_merchant_managed_fulfillment_orders` — S13
   - `write_orders` — S17
   - `write_payment_customizations` — S13

3. **Update `docs/scopes.md`:** Mark `write_validations` and `read_draft_orders` as USED (not pre-granted), since `validation-registration.server.ts` and the S8 draft-order route and processor are merged.

4. **S8 wiring follow-up (engineering):** register drain handlers for CUSTOMERS_* and DRAFT_ORDERS_*, or stop enqueueing them. At present they are dead-lettered after 48 reads (`processor.server.ts:68,566-575`).

5. **Session scope string:** the prod offline session stores 8 scope tokens (`read_draft_orders, read_payment_terms, write_companies, write_customers, write_merchant_managed_fulfillment_orders, write_orders, write_payment_customizations, write_validations`), per Prod Diagnostics run [39980626029](https://github.com/raghavkhanna268/net-terms-receivables/actions/runs/39980626029) on 2026-10-23 21:12 IST. Shopify omits `read_X` when `write_X` is granted, so this is the same 11 effective scopes with no `write_payment_terms` and no `write_draft_orders`.

6. **Confirm no `write_payment_terms` or `write_draft_orders` in production:** Verified ✓ (`shopify.app.toml` and the `wrangler.jsonc` SCOPES var at 51d2266, plus the prod session scope string above)

---

## Audit Method

This audit was performed by:
1. Reading `shopify.app.toml` scopes configuration
2. Running `rg` searches for GraphQL operations (`bulkOperationRunQuery`, `metafieldDefinitionCreate`, `validationCreate`, etc.)
3. Inspecting webhook handlers in `app/routes/webhooks.*.tsx`
4. Reviewing `docs/scopes.md` for documented scope justifications
5. Cross-referencing with `scripts/seed.ts` (dev-only, not counted as production usage)
