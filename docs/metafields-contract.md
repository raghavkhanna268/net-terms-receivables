# Metafields Contract

This document is the single source of truth for the app-owned metafields used by the Net Terms Receivables app. All steps (S11 writer, S12 validation, S13 payment customization and fulfillment holds, S8 tagged customers) must follow this contract.

## References

- [App-owned metafields ($app namespace)](https://shopify.dev/docs/apps/build/metafields/definitions#app-reserved-namespace)
- [Metafield definitions via TOML](https://shopify.dev/docs/apps/build/metafields/definitions#toml-app-owned-example)
- [Using metafields with Shopify Functions](https://shopify.dev/docs/apps/build/functions/input-output/metafields-shopify-functions)
- [Function input queries](https://shopify.dev/docs/apps/build/functions/input-output/use-query-variables)

## Namespace

All metafields use the **app-reserved namespace `$app`**, which ensures only this app can create, update, or delete the metafield definitions. The `$app` prefix is automatically resolved to the app's unique namespace at deploy time.

## Metafield Definitions

### `$app.credit_status`

**Implemented**: [#50](https://github.com/raghavkhanna268/net-terms-receivables/issues/50)

Stores the credit status for a buyer account (B2B company location or tagged customer).

| Property | Value |
|----------|-------|
| **Namespace** | `$app` |
| **Key** | `credit_status` |
| **Type** | `json` |
| **Owner Types** | `CompanyLocation`, `Customer` |
| **Admin Access** | `merchant_read` (merchants can view but not edit) |

## JSON Schema

The `credit_status` metafield value is a JSON object with the following structure:

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "type": "object",
  "required": ["schemaVersion", "currencyCode", "hold", "limitPaise", "exposurePaise", "updatedAt"],
  "properties": {
    "schemaVersion": {
      "type": "integer",
      "description": "Schema version for forward compatibility",
      "const": 1
    },
    "currencyCode": {
      "type": "string",
      "description": "ISO 4217 currency code (e.g., INR, USD)",
      "pattern": "^[A-Z]{3}$"
    },
    "hold": {
      "type": "boolean",
      "description": "True if the account is on credit hold"
    },
    "holdReasonCode": {
      "type": ["string", "null"],
      "description": "Machine-readable reason code for the hold (no PII)",
      "enum": [null, "MANUAL_HOLD", "PAYMENT_OVERDUE", "CREDIT_REVIEW", "NEW_ACCOUNT", "FRAUD_SUSPECTED"]
    },
    "limitPaise": {
      "type": "string",
      "description": "Credit limit in integer paise (smallest currency unit) as a string",
      "pattern": "^[0-9]+$"
    },
    "exposurePaise": {
      "type": "string",
      "description": "Current outstanding exposure in integer paise as a string",
      "pattern": "^[0-9]+$"
    },
    "updatedAt": {
      "type": "string",
      "description": "ISO 8601 timestamp of last update",
      "format": "date-time"
    }
  },
  "additionalProperties": false
}
```

### Field Descriptions

| Field | Type | Description |
|-------|------|-------------|
| `schemaVersion` | integer | Always `1` for this version. Allows future schema evolution. |
| `currencyCode` | string | ISO 4217 currency code matching the shop's currency. |
| `hold` | boolean | `true` = checkout blocked regardless of credit limit. |
| `holdReasonCode` | string \| null | Machine-readable code explaining the hold. Never contains PII. |
| `limitPaise` | string | Credit limit in paise (integer as string). E.g., `"10000000"` = ₹100,000.00. |
| `exposurePaise` | string | Current outstanding amount in paise (integer as string). |
| `updatedAt` | string | ISO 8601 timestamp of when this status was last computed. |

**Hold state**: The `hold` field inside `credit_status` is the single source of truth for whether a buyer is on hold. There is no separate `$app.hold` metafield.

### Why Amounts Are Strings

Amounts are stored as **integer strings in paise** (the smallest currency unit) to:
1. Avoid floating-point precision errors
2. Ensure consistent serialization across Rust (u64) and TypeScript (BigInt)
3. Match Shopify's `UnsignedInt64` scalar convention

Example: ₹1,234.56 is stored as `"123456"` paise.

## Owner Types

### CompanyLocation (B2B)

For B2B buyers, the `credit_status` metafield is attached to the **CompanyLocation**:
- `gid://shopify/CompanyLocation/{id}`
- Represents a specific buying location within a B2B company
- The validation function reads this via `cart.buyerIdentity.purchasingCompany.location.metafield`

### Customer (Tagged Buyers)

For non-B2B buyers who have been granted net-terms (via tag rules in S8), the `credit_status` metafield is attached to the **Customer**:
- `gid://shopify/Customer/{id}`
- The validation function reads this via `cart.buyerIdentity.customer.metafield`

## Precedence Rules

When evaluating checkout validation:

1. **B2B carts take precedence**: If `cart.buyerIdentity.purchasingCompany` is present, use the `CompanyLocation.metafield`. Ignore any `Customer.metafield`.

2. **CompanyLocation overrides Company**: The metafield is always on `CompanyLocation`, not `Company`. Each location can have independent credit terms.

3. **Customer only for non-B2B**: The `Customer.metafield` is only evaluated when there is no `purchasingCompany` (standard checkout for tagged customers).

```
if purchasingCompany exists:
    use purchasingCompany.location.metafield
else if customer exists:
    use customer.metafield
else:
    no credit status (guest checkout) → pass
```

## Fail-Open vs Fail-Closed Behavior

### Fail-Open (Default)

The validation function **fails open** (allows checkout) when:

- **No metafield exists**: The buyer is not a net-terms customer. Do not block.
- **Metafield is null/empty**: Treat as "no credit status configured".
- **Malformed JSON**: Log the error but allow checkout. Never block due to app bugs.
- **Missing required fields**: Treat as invalid, fail open.
- **Unknown `schemaVersion`**: Fail open to allow forward compatibility.
- **Currency mismatch**: Cart currency ≠ metafield currency → log and allow.
- **Guest checkout**: No buyer identity → not a net-terms buyer → pass.

**Rationale**: Never block a legitimate sale due to missing/invalid data. Non-net-terms buyers must never be affected.

### Fail-Closed (Explicit Block)

The validation function **fails closed** (blocks checkout) only when:

1. **`hold` is explicitly `true`**: The account is on credit hold.
2. **Credit limit exceeded**: `exposurePaise + cartTotalPaise > limitPaise` AND currencies match.

Both conditions require a **valid, parseable metafield** with matching currency.

## Validation Error Messages

When blocking checkout, the function returns merchant-facing error messages:

| Condition | Error Message |
|-----------|---------------|
| Account on hold | "Your account is currently on hold. Please contact us to resolve any outstanding issues before placing an order." |
| Over credit limit | "This order would exceed your credit limit. Please contact us to discuss your account or make a payment on outstanding invoices." |

These messages:
- Are professional and non-accusatory
- Do not expose specific amounts or internal reason codes
- Direct the buyer to contact the merchant

## Metafield Definition Creation

S11 creates the metafield definitions programmatically during shop setup via `metafieldDefinitionCreate`.

> **Note**: The Shopify TOML format ([shopify.dev/docs/apps/build/metafields/definitions](https://shopify.dev/docs/apps/build/metafields/definitions)) documents `[<owner_type>.metafields.app.<key>]` and references MetafieldOwnerType for the full list. However, the documentation does not explicitly confirm that `company_location` and `customer` owner types deploy successfully via TOML. To ensure reliable deployment, S11 creates these definitions via `metafieldDefinitionCreate`.

**Implementation**: [#50](https://github.com/raghavkhanna268/net-terms-receivables/issues/50)

### Definitions Created

| Namespace | Key | Type | Owner Types | Admin Access |
|-----------|-----|------|-------------|--------------|
| `$app` | `credit_status` | `json` | `COMPANY_LOCATION`, `CUSTOMER` | `MERCHANT_READ` |

### Scopes Required

Creating metafield definitions uses `metafieldDefinitionCreate` which requires write access to the owner resource:
- `write_companies` for `COMPANY_LOCATION` owner type
- `write_customers` for `CUSTOMER` owner type

Both scopes are already granted (see `docs/scopes.md`).

### Programmatic Creation (S11 Responsibility)

S11 must create the definitions via GraphQL during shop setup (idempotent):

```graphql
mutation CreateCreditStatusDefinition($ownerType: MetafieldOwnerType!) {
  metafieldDefinitionCreate(definition: {
    namespace: "$app"
    key: "credit_status"
    name: "Credit Status"
    description: "Net terms credit status including hold flag, limit, and exposure"
    type: "json"
    ownerType: $ownerType
    access: { admin: MERCHANT_READ }
  }) {
    createdDefinition { id }
    userErrors { field message }
  }
}
```

Call this mutation twice during shop setup: once for `COMPANY_LOCATION` and once for `CUSTOMER`.
The operation is idempotent - if the definition already exists, the mutation returns a userError that S11 should handle gracefully.

## Implementation Checklist

### S11 (Metafield Definitions)
- [x] Create `credit_status` definition for `COMPANY_LOCATION` via `metafieldDefinitionCreate`
- [x] Create `credit_status` definition for `CUSTOMER` via `metafieldDefinitionCreate`
- [x] Handle TAKEN error code as success (idempotent)
- [x] Run during afterAuth alongside validation registration
- [x] Log userErrors without PII
- [x] Mark shop done only after success

### S11 (Credit Status Writer)
- [x] Use `metafieldsSet` mutation with owner GID
- [x] Serialize using `serializeCreditStatusFromDb()` from `app/lib/metafields-contract.ts`
- [x] Always include all required fields
- [x] Use `$app:credit_status` as namespace:key
- [x] Write to `CompanyLocation` for B2B accounts
- [x] Write to `Customer` for tagged customer accounts
- [x] Handle userErrors and set sync-pending flag on failure
- [x] Compute derived hold state (over-limit, overdue) before writing

### S11 (Account Page)
- [x] Route at `app.accounts.$id.tsx`
- [x] Display credit limit, outstanding, available credit
- [x] Display hold status with reason
- [x] Show recent invoices
- [x] Respect plan gating (read-only for gated accounts)
- [x] Credit-limit editor with validation

### S12 (Cart/Checkout Validation)
- [ ] Read `purchasingCompany.location.metafield` and `customer.metafield`
- [ ] Apply precedence rules (B2B first)
- [ ] Fail open on missing/invalid data
- [ ] Fail closed only on explicit hold or over-limit
- [ ] Log currency mismatches without blocking

### S13 (Payment Customization / Fulfillment Holds)
- [ ] Read `$app:credit_status` and check `credit_status.hold` for hold state
- [ ] Apply same precedence rules (B2B first, then Customer)
- [ ] Consider hold status when customizing payment options
- [ ] Place fulfillment holds on orders from accounts where `credit_status.hold` is `true`

### S8 (Tagged Customers)
- [ ] Write `credit_status` to Customer metafield for tagged buyers
- [ ] Use same schema and serialization

## Testing

A shared JSON fixture at `tests/fixtures/credit-status.json` contains valid and invalid examples that both Rust and TypeScript tests load. This ensures the implementations cannot drift.

### Shared Fixture Validation

Both TypeScript and Rust tests verify the shared fixtures:

- **TypeScript tests** (`app/lib/__tests__/metafields-contract.test.ts`):
  - `serializeCreditStatusFromDb` produces JSON matching fixture format
  - `parseCreditStatus` can parse all valid fixtures
  - `checkCreditStatus` produces expected block/allow results

- **Rust tests** (`extensions/credit-check-validation/src/cart_validations_generate_run.rs`):
  - All valid fixtures deserialize correctly via `CreditStatus::from_json_value`
  - `evaluate_credit_status` produces expected validation operations
  - S11-specific tests verify JS writer output format is compatible

## Dev-Store Verification Checklist

Use this checklist to verify S12 enforcement end-to-end on a development store. Complete all steps before closing issue #50.

### Prerequisites
- [ ] Development store with B2B enabled
- [ ] At least one B2B company with a location
- [ ] At least one tagged customer with net-terms
- [ ] The credit-check-validation function is deployed and enabled

### S11 Writer Verification
1. [ ] Open the account page for a B2B company location
2. [ ] Set a credit limit (e.g., ₹100,000)
3. [ ] Verify the limit appears in the account page UI
4. [ ] Query the CompanyLocation metafield via Admin API:
   ```graphql
   query {
     companyLocation(id: "gid://shopify/CompanyLocation/YOUR_ID") {
       metafield(namespace: "$app", key: "credit_status") {
         value
       }
     }
   }
   ```
5. [ ] Verify the JSON contains all required fields:
   - `schemaVersion: 1`
   - `currencyCode` matches shop currency
   - `hold` is boolean
   - `holdReasonCode` is valid enum or null
   - `limitPaise` is numeric string
   - `exposurePaise` is numeric string
   - `updatedAt` is ISO 8601 timestamp

### S12 Enforcement Verification

#### Test 1: Under Limit (Should Pass)
1. [ ] Set credit limit to ₹100,000
2. [ ] Ensure exposure is under ₹100,000
3. [ ] Place an order as the B2B buyer
4. [ ] Checkout should complete without error

#### Test 2: Over Limit (Should Block)
1. [ ] Set credit limit to ₹10,000
2. [ ] Create invoices or orders totaling > ₹10,000
3. [ ] Attempt to place another order
4. [ ] Checkout should show "credit limit exceeded" error

#### Test 3: Manual Hold (Should Block)
1. [ ] Set manual hold on the account via the account page
2. [ ] Attempt to place an order
3. [ ] Checkout should show "account on hold" error

#### Test 4: Currency Mismatch (Should Pass - Fail Open)
1. [ ] Set credit status with INR currency
2. [ ] Attempt checkout with a USD cart
3. [ ] Checkout should pass (currency mismatch = fail open)

#### Test 5: Tagged Customer
1. [ ] Repeat tests 1-3 for a tagged customer account
2. [ ] Verify metafield is written to Customer, not CompanyLocation

### Cleanup
- [ ] Remove test holds
- [ ] Reset credit limits to production values
- [ ] Document any issues in #50

### Sign-off
- [ ] DevOps has verified all tests pass
- [ ] Issue #50 can be closed
