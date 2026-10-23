# OAuth Scopes

This document lists all OAuth scopes requested by the Net Terms Receivables app, the features that use them, and the exact API calls that require them.

**Scope bar policy**: Production config (`shopify.app.toml` and `wrangler.jsonc` SCOPES) may only include scopes that a planned, shipped feature uses. Before S24: any scope unused by merged code is dropped.

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
| Tagged customer sync | S8 | `customers` query with tag filter | [customers query](https://shopify.dev/docs/api/admin-graphql/2026-10/queries/customers) |

> **Pre-granted for S8**: This scope is not used by S6 but is included now to avoid a second OAuth re-approval when S8 ships.

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
| Dev store seed: create companies | S4 | `companyCreate` | [companyCreate](https://shopify.dev/docs/api/admin-graphql/2026-10/mutations/companyCreate) |
| Dev store seed: set payment terms on location | S4 | `companyLocationUpdate` with `buyerExperienceConfiguration.paymentTermsTemplateId` | [companyLocationUpdate](https://shopify.dev/docs/api/admin-graphql/2026-10/mutations/companyLocationUpdate) |

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
| Add tags to orders (overdue, hold, etc.) | S13 | `tagsAdd` with Order gid | [tagsAdd](https://shopify.dev/docs/api/admin-graphql/2026-10/mutations/tagsAdd) |
| Remove tags from orders | S17 | `tagsRemove` with Order gid | [tagsRemove](https://shopify.dev/docs/api/admin-graphql/2026-10/mutations/tagsRemove) |
| Dev store seed: create orders | S4 | `orderCreate` | [orderCreate](https://shopify.dev/docs/api/admin-graphql/2026-10/mutations/orderCreate) |

#### write_validations

| Feature | Step | Mutation | Reference |
|---------|------|----------|-----------|
| Cart/checkout validation function | S12 | `validationCreate` | [validationCreate](https://shopify.dev/docs/api/admin-graphql/2026-10/mutations/validationCreate) |
| Update validation function | S12 | `validationUpdate` | [validationUpdate](https://shopify.dev/docs/api/admin-graphql/2026-10/mutations/validationUpdate) |
| Delete validation function | S12 | `validationDelete` | [validationDelete](https://shopify.dev/docs/api/admin-graphql/2026-10/mutations/validationDelete) |

> **S12 feature**: Shopify Functions validation to block checkout for accounts on hold or over credit limit.

#### write_payment_customizations

| Feature | Step | Mutation | Reference |
|---------|------|----------|-----------|
| Payment method customization function | S13 | `paymentCustomizationCreate` | [paymentCustomizationCreate](https://shopify.dev/docs/api/admin-graphql/2026-10/mutations/paymentCustomizationCreate) |
| Update payment customization | S13 | `paymentCustomizationUpdate` | [paymentCustomizationUpdate](https://shopify.dev/docs/api/admin-graphql/2026-10/mutations/paymentCustomizationUpdate) |
| Delete payment customization | S13 | `paymentCustomizationDelete` | [paymentCustomizationDelete](https://shopify.dev/docs/api/admin-graphql/2026-10/mutations/paymentCustomizationDelete) |

> **S13 feature**: Shopify Functions payment customization to hide/show payment methods based on account status.

#### write_merchant_managed_fulfillment_orders

| Feature | Step | Mutation | Reference |
|---------|------|----------|-----------|
| Fulfillment hold on overdue accounts | S13 | `fulfillmentOrderHold` | [fulfillmentOrderHold](https://shopify.dev/docs/api/admin-graphql/2026-10/mutations/fulfillmentOrderHold) |
| Release fulfillment hold | S13 | `fulfillmentOrderReleaseHold` | [fulfillmentOrderReleaseHold](https://shopify.dev/docs/api/admin-graphql/2026-10/mutations/fulfillmentOrderReleaseHold) |

> **S13 feature**: Hold fulfillment for orders from accounts that are overdue or on credit hold. Both mutations require `write_merchant_managed_fulfillment_orders` OR `write_third_party_fulfillment_orders`. Since this app is merchant-facing (not a fulfillment service), we use `write_merchant_managed_fulfillment_orders`.

## Scopes NOT in Production Config

### write_draft_orders

**Not required.** The dev store seed creates orders directly with `orderCreate` (which supports `companyLocationId` for B2B orders) and sets payment terms on the CompanyLocation via `companyLocationUpdate` with `buyerExperienceConfiguration.paymentTermsTemplateId`. Orders for that location automatically inherit the payment terms.

References:
- [orderCreate](https://shopify.dev/docs/api/admin-graphql/2026-10/mutations/orderCreate) — supports `companyLocationId` in [OrderCreateOrderInput](https://shopify.dev/docs/api/admin-graphql/2026-10/input-objects/OrderCreateOrderInput)
- [companyLocationUpdate](https://shopify.dev/docs/api/admin-graphql/2026-10/mutations/companyLocationUpdate) — accepts `buyerExperienceConfiguration.paymentTermsTemplateId`
- [BuyerExperienceConfigurationInput](https://shopify.dev/docs/api/admin-graphql/2026-10/input-objects/BuyerExperienceConfigurationInput) — `paymentTermsTemplateId` field

### write_payment_terms

**Not required.** Payment terms are set on CompanyLocations via `companyLocationUpdate` (under `write_companies`), not via the `paymentTermsCreate` mutation. Orders created for B2B company locations inherit the payment terms from the location's `buyerExperienceConfiguration.paymentTermsTemplate`.

Per [companyLocationUpdate docs](https://shopify.dev/docs/api/admin-graphql/2026-10/mutations/companyLocationUpdate):
> "You can also configure the B2B checkout experience through `BuyerExperienceConfiguration` settings that control whether orders require merchant review, `PaymentTermsTemplate` settings..."

This approach requires only `write_companies` (or `write_customers`), which we already have.

## Final Scope List

```
read_companies,read_customers,read_draft_orders,read_orders,read_payment_terms,write_companies,write_customers,write_merchant_managed_fulfillment_orders,write_orders,write_payment_customizations,write_validations
```

## Audit Reminder

**Before S24**: Audit requested scopes and drop any that no merged code uses.
