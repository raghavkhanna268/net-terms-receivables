# S24 Scope Audit: Production OAuth scope verification

**Audit date:** 2026-10-23  
**Commit:** `main` @ HEAD  
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
| `read_customers` | **USED** | `app/services/sync/customer-fields.server.ts` (getBulkCustomersQuery), `app/routes/webhooks.customers.tsx` |
| `read_draft_orders` | **PRE-GRANTED (S8)** | `app/routes/webhooks.draft_orders.tsx` (webhook handler exists), no bulk query merged |
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
| `app/services/sync/customer-fields.server.ts:243-260` | `getBulkCustomersQuery()` | `bulkOperationRunQuery` with `customers(query: "tag:'...'") { id tags email displayName }` |
| `app/routes/webhooks.customers.tsx` | Webhook handler | Handles `customers/create`, `customers/update`, `customers/delete` topics |
| `app/services/sync/customer.server.ts` | Processor | Upserts `s8_tagged_customers` from webhook payloads |

**Protected Customer Data:** Only `id`, `tags`, `email`, `displayName` are fetched. `email` and `displayName` require `CUSTOMER_PII_FIELDS=1`. Phone and address fields are blocked by `CUSTOMER_FORBIDDEN_FIELDS` in `customer-fields.server.ts`.

#### 3. `read_draft_orders` — **PRE-GRANTED (S8)**

| File | Operation | Details |
|------|-----------|---------|
| `app/routes/webhooks.draft_orders.tsx` | Webhook handler | Handles `draft_orders/create`, `draft_orders/update`, `draft_orders/delete` topics |
| `app/services/sync/draft-order.server.ts` | Processor | Upserts `s8_draft_orders` for pending credit exposure |

**Note:** Per `docs/scopes.md` line 49: "Pre-granted for S8: This scope is not used by S6 but is included now to avoid a second OAuth re-approval when S8 ships." The webhook handlers exist but no bulk `draftOrders` query is merged.

#### 4. `read_orders` — **USED**

| File | Operation | Details |
|------|-----------|---------|
| `app/services/sync/bulk-operations.server.ts:108-185` | `BULK_ORDERS_QUERY` | `bulkOperationRunQuery` with `orders(query: "financial_status:pending OR financial_status:partially_paid") { ... paymentTerms { ... } customer { id } purchasingEntity { ... } }` |
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

**Per `shopify.app.toml` line 26:**
> NOT in production: write_draft_orders (seed-only, in shopify.app.dev.toml)

**Per `docs/scopes.md` line 128:**
> **No `write_draft_orders`**: The seed uses `orderCreate` with custom line items instead of draft orders.

---

## Comparison: `docs/scopes.md` vs Code

| Scope | `docs/scopes.md` Status | Code Reality | Match? |
|-------|-------------------------|--------------|--------|
| `read_companies` | S6 | USED in bulk-operations.server.ts, webhooks | ✓ |
| `read_customers` | S8 | USED in customer-fields.server.ts, webhooks | ✓ |
| `read_draft_orders` | "Pre-granted for S8" | PRE-GRANTED, webhook handler exists | ✓ |
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

1. **No unused scopes found.** All 11 production scopes are either actively used or pre-granted for documented upcoming stories (S8, S12, S13, S17).

2. **Pre-granted scopes (4) should ship with their stories:**
   - `read_draft_orders` — S8 (bulk query pending)
   - `write_merchant_managed_fulfillment_orders` — S13
   - `write_orders` — S17
   - `write_payment_customizations` — S13

3. **Update `docs/scopes.md`:** Mark `write_validations` as USED (not pre-granted) since `validation-registration.server.ts` is merged.

4. **Confirm no `write_payment_terms` or `write_draft_orders` in production:** Verified ✓

---

## Audit Method

This audit was performed by:
1. Reading `shopify.app.toml` scopes configuration
2. Running `rg` searches for GraphQL operations (`bulkOperationRunQuery`, `metafieldDefinitionCreate`, `validationCreate`, etc.)
3. Inspecting webhook handlers in `app/routes/webhooks.*.tsx`
4. Reviewing `docs/scopes.md` for documented scope justifications
5. Cross-referencing with `scripts/seed.ts` (dev-only, not counted as production usage)
