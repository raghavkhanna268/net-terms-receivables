# OAuth Scopes

This document lists all OAuth scopes requested by the Net Terms Receivables app, the features that use them, and the exact API calls that require them.

**Scope bar policy**: Production config (`shopify.app.toml` and `wrangler.jsonc` SCOPES) may only include scopes that merged code uses or that are pre-granted for imminent features. Before S24: audit and drop any unused scopes.

## Production Scopes (11 total)

### Read Scopes (5)

#### read_companies

| Feature | Step | API Call | Reference |
|---------|------|----------|-----------|
| Company/location sync | S6 | `companies` query | [companies query](https://shopify.dev/docs/api/admin-graphql/2026-10/queries/companies) |
| Company/location sync | S6 | `companyLocations` query | [companyLocations query](https://shopify.dev/docs/api/admin-graphql/2026-10/queries/companyLocations) |
| Bulk companies export | S6 | `bulkOperationRunQuery` with companies | [bulkOperationRunQuery](https://shopify.dev/docs/api/admin-graphql/2026-10/mutations/bulkOperationRunQuery) |

#### read_orders

| Feature | Step | API Call | Reference |
|---------|------|----------|-----------|
| Order sync | S6 | `orders` query | [orders query](https://shopify.dev/docs/api/admin-graphql/2026-10/queries/orders) |
| Bulk orders export | S6 | `bulkOperationRunQuery` with orders | [bulkOperationRunQuery](https://shopify.dev/docs/api/admin-graphql/2026-10/mutations/bulkOperationRunQuery) |
| Order webhooks | S6 | orders/create, orders/updated, orders/cancelled, orders/paid | [Webhook topics](https://shopify.dev/docs/api/admin-rest/2026-10/resources/webhook) |

#### read_payment_terms

| Feature | Step | API Call | Reference |
|---------|------|----------|-----------|
| Order payment terms | S6 | `Order.paymentTerms` field | [Order.paymentTerms](https://shopify.dev/docs/api/admin-graphql/2026-10/objects/Order#field-order-paymentterms) |
| Company location payment terms | S6 | `CompanyLocation.buyerExperienceConfiguration.paymentTermsTemplate` | [buyerExperienceConfiguration](https://shopify.dev/docs/api/admin-graphql/2026-10/objects/CompanyLocation#field-companylocation-buyerexperienceconfiguration) |

#### read_customers

| Feature | Step | API Call | Reference |
|---------|------|----------|-----------|
| Tagged customer sync | S8 | `customers` query with tag filter (id, tags, email, displayName) | [customers query](https://shopify.dev/docs/api/admin-graphql/2026-10/queries/customers) |
| Bulk customer export | S8 | `bulkOperationRunQuery` with customers | [bulkOperationRunQuery](https://shopify.dev/docs/api/admin-graphql/2026-10/mutations/bulkOperationRunQuery) |

> **Protected Customer Data (2026-10-23):** Level 1 + Name + Email approved. Fields fetched: `id`, `tags`, `email`, `displayName`. Fields NEVER fetched: `phone`, `addresses`, `firstName`, `lastName`, `defaultAddress`. See "Protected Customer Data" section below.

#### read_draft_orders

| Feature | Step | API Call | Reference |
|---------|------|----------|-----------|
| Draft order payment terms | S8 | `draftOrders` query | [draftOrders query](https://shopify.dev/docs/api/admin-graphql/2026-10/queries/draftOrders) |

> **Pre-granted for S8**: This scope is not used by S6 but is included now to avoid a second OAuth re-approval when S8 ships.

### Write Scopes (6)

#### write_companies

| Feature | Step | Mutation | Reference |
|---------|------|----------|-----------|
| Credit/hold metafields on Company | S11 | `metafieldsSet` with Company ownerId | [metafieldsSet](https://shopify.dev/docs/api/admin-graphql/2026-10/mutations/metafieldsSet) |
| Credit/hold metafields on CompanyLocation | S11 | `metafieldsSet` with CompanyLocation ownerId | [metafieldsSet](https://shopify.dev/docs/api/admin-graphql/2026-10/mutations/metafieldsSet) |
| Dev seed: set payment terms on location | S4 | `companyLocationUpdate` with `buyerExperienceConfiguration.paymentTermsTemplateId` | [companyLocationUpdate](https://shopify.dev/docs/api/admin-graphql/2026-10/mutations/companyLocationUpdate) |

> **Note**: `metafieldsSet` requires write access to the owner resource. For Company/CompanyLocation metafields, this requires `write_companies`.

#### write_customers

| Feature | Step | Mutation | Reference |
|---------|------|----------|-----------|
| Credit/hold metafields on Customer | S11 | `metafieldsSet` with Customer ownerId | [metafieldsSet](https://shopify.dev/docs/api/admin-graphql/2026-10/mutations/metafieldsSet) |

> **Note**: `metafieldsSet` requires write access to the owner resource. For Customer metafields, this requires `write_customers`.

#### write_orders

| Feature | Step | Mutation | Reference |
|---------|------|----------|-----------|
| Mark order as paid after bank match | S17 | `orderMarkAsPaid` | [orderMarkAsPaid](https://shopify.dev/docs/api/admin-graphql/2026-10/mutations/orderMarkAsPaid) |
| Add tags to orders (overdue, hold, etc.) | S17 | `tagsAdd` with Order gid | [tagsAdd](https://shopify.dev/docs/api/admin-graphql/2026-10/mutations/tagsAdd) |
| Remove tags from orders | S17 | `tagsRemove` with Order gid | [tagsRemove](https://shopify.dev/docs/api/admin-graphql/2026-10/mutations/tagsRemove) |

#### write_validations

| Feature | Step | Mutation | Reference |
|---------|------|----------|-----------|
| Cart/checkout validation function | S12 | `validationCreate` | [validationCreate](https://shopify.dev/docs/api/admin-graphql/2026-10/mutations/validationCreate) |
| Update validation function | S12 | `validationUpdate` | [validationUpdate](https://shopify.dev/docs/api/admin-graphql/2026-10/mutations/validationUpdate) |
| Delete validation function | S12 | `validationDelete` | [validationDelete](https://shopify.dev/docs/api/admin-graphql/2026-10/mutations/validationDelete) |

> **Pre-granted for S12**: Shopify Functions validation to block checkout for accounts on hold or over credit limit.

#### write_payment_customizations

| Feature | Step | Mutation | Reference |
|---------|------|----------|-----------|
| Payment method customization function | S13 | `paymentCustomizationCreate` | [paymentCustomizationCreate](https://shopify.dev/docs/api/admin-graphql/2026-10/mutations/paymentCustomizationCreate) |
| Update payment customization | S13 | `paymentCustomizationUpdate` | [paymentCustomizationUpdate](https://shopify.dev/docs/api/admin-graphql/2026-10/mutations/paymentCustomizationUpdate) |
| Delete payment customization | S13 | `paymentCustomizationDelete` | [paymentCustomizationDelete](https://shopify.dev/docs/api/admin-graphql/2026-10/mutations/paymentCustomizationDelete) |

> **Pre-granted for S13**: Shopify Functions payment customization to hide/show payment methods based on account status.

#### write_merchant_managed_fulfillment_orders

| Feature | Step | Mutation | Reference |
|---------|------|----------|-----------|
| Fulfillment hold on overdue accounts | S13 | `fulfillmentOrderHold` | [fulfillmentOrderHold](https://shopify.dev/docs/api/admin-graphql/2026-10/mutations/fulfillmentOrderHold) |
| Release fulfillment hold | S13 | `fulfillmentOrderReleaseHold` | [fulfillmentOrderReleaseHold](https://shopify.dev/docs/api/admin-graphql/2026-10/mutations/fulfillmentOrderReleaseHold) |

> **Pre-granted for S13**: Hold fulfillment for orders from accounts that are overdue or on credit hold. Both mutations require `write_merchant_managed_fulfillment_orders` OR `write_third_party_fulfillment_orders`. Since this app is merchant-facing (not a fulfillment service), we use `write_merchant_managed_fulfillment_orders`.

## Dev Seed Script

The seed script (`scripts/seed.ts`) runs with **the same 11 production scopes** — no separate dev app needed. It uses **only the dev-store token** (`SHOPIFY_ADMIN_TOKEN` env var) and refuses to run on any shop other than `net-terms-receivables.myshopify.com`.

### How the Seed Uses Production Scopes

| Feature | Scope | Mutation | Reference |
|---------|-------|----------|-----------|
| Create B2B companies | write_companies | `companyCreate` | [companyCreate](https://shopify.dev/docs/api/admin-graphql/2026-10/mutations/companyCreate) |
| Create company locations (Net 15/30/60) | write_companies | `companyLocationCreate` | [companyLocationCreate](https://shopify.dev/docs/api/admin-graphql/2026-10/mutations/companyLocationCreate) |
| Set payment terms on location | write_companies | `companyLocationUpdate` with `buyerExperienceConfiguration.paymentTermsTemplateId` | [companyLocationUpdate](https://shopify.dev/docs/api/admin-graphql/2026-10/mutations/companyLocationUpdate) |
| Create orders with custom line items | write_orders | `orderCreate` with title + priceSet (no variantId needed) | [orderCreate](https://shopify.dev/docs/api/admin-graphql/2026-10/mutations/orderCreate) |
| Backdate orders | write_orders | `orderCreate` with `processedAt` | [OrderCreateOrderInput.processedAt](https://shopify.dev/docs/api/admin-graphql/2026-10/input-objects/OrderCreateOrderInput) |

### Backdating with processedAt

Orders are backdated using `processedAt` from [OrderCreateOrderInput](https://shopify.dev/docs/api/admin-graphql/2026-10/input-objects/OrderCreateOrderInput): *"The date and time when the order was created."* This creates overdue invoices for testing S9 due date inference.

### Why No Additional Scopes Are Needed

**No `write_draft_orders`**: The seed uses `orderCreate` with custom line items instead of draft orders. Custom line items only require `title` + `priceSet` — no product or variant lookup needed.

**No `read_products`**: Custom line items bypass the product catalog entirely. See [OrderCreateLineItemInput](https://shopify.dev/docs/api/admin-graphql/2026-10/input-objects/OrderCreateLineItemInput).

**No `write_payment_terms`**: Payment terms are configured on company locations via `companyLocationUpdate` with `buyerExperienceConfiguration.paymentTermsTemplateId` (requires `write_companies`). If Shopify doesn't inherit these terms to orders created via API, S9 inference uses DB defaults instead (BuyerAccount.defaultTermsDays or AccountSource tag rules).

**FIXED terms not supported**: FIXED payment terms require a specific `dueAt` date per order, which cannot be expressed through location templates. The seed only creates NET terms (15, 30, 60 days).

### Payment Terms Inheritance (Warning, Not Failure)

`OrderCreateOrderInput` does not have a `paymentTerms` field. We rely on Shopify inheriting terms from `companyLocationId`. If orders come back with null `paymentTerms`:
- The seed logs a **warning** (not a failure) with counts of inherited vs inferred
- S9 inference computes due dates from DB defaults seeded by this script
- **No `write_payment_terms` scope is added** (Team Lead scope decision)

## Final Production Scope List (11)

```
read_companies,read_customers,read_draft_orders,read_orders,read_payment_terms,write_companies,write_customers,write_merchant_managed_fulfillment_orders,write_orders,write_payment_customizations,write_validations
```

## Protected Customer Data

**Approval date:** 2026-10-23

**Level:** Level 1 + Name + Email

| Field | Fetched | Stored | Purpose |
|-------|---------|--------|---------|
| `id` | ✅ | ✅ | Customer GID for account linking |
| `tags` | ✅ | ✅ | Net-terms eligibility matching |
| `email` | ✅ | ✅ | S8 labels, S16 payment matching, S18 reminders |
| `displayName` | ✅ | ✅ | S8 labels, S16 payment matching |
| `phone` | ❌ | ❌ | Not approved, blocked in code |
| `addresses` | ❌ | ❌ | Not approved, blocked in code |
| `firstName` | ❌ | ❌ | Not approved, blocked in code |
| `lastName` | ❌ | ❌ | Not approved, blocked in code |
| `defaultAddress` | ❌ | ❌ | Not approved, blocked in code |

**Environment variable:** `CUSTOMER_PII_FIELDS=1` (set in wrangler.jsonc)

**Code enforcement:**
- `CUSTOMER_FORBIDDEN_FIELDS` in `app/services/sync/customer-fields.server.ts` blocks phone/address fields
- `validateNoForbiddenFields()` throws on any query containing forbidden fields
- Tests verify forbidden fields are never included, even with `CUSTOMER_PII_FIELDS=1`

## Audit Reminder

**Before S24**: Audit requested scopes and drop any that no merged code uses.
