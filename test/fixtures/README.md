# Test Fixtures

## Shopify Admin API 2026-10 Schema

The `admin-2026-10.schema.json` file contains the GraphQL introspection schema for Shopify's Admin API version 2026-10.

### Source

- **URL**: `https://shopify.dev/admin-graphql-direct-proxy/2026-10`
- **Fetched**: 2026-10-23
- **Size**: ~6.6 MB (3716 types)

This schema is fetched from Shopify's public GraphQL introspection proxy. No authentication is required.

### Refreshing the Schema

To refresh the schema (e.g., when Shopify updates the 2026-10 version):

```bash
# Standard GraphQL introspection query
INTROSPECTION_QUERY='query IntrospectionQuery { __schema { queryType { name } mutationType { name } subscriptionType { name } types { ...FullType } directives { name description locations args { ...InputValue } } } } fragment FullType on __Type { kind name description fields(includeDeprecated: true) { name description args { ...InputValue } type { ...TypeRef } isDeprecated deprecationReason } inputFields { ...InputValue } interfaces { ...TypeRef } enumValues(includeDeprecated: true) { name description isDeprecated deprecationReason } possibleTypes { ...TypeRef } } fragment InputValue on __InputValue { name description type { ...TypeRef } defaultValue } fragment TypeRef on __Type { kind name ofType { kind name ofType { kind name ofType { kind name ofType { kind name ofType { kind name ofType { kind name ofType { kind name } } } } } } } }'

curl -s -H "Content-Type: application/json" -X POST \
  "https://shopify.dev/admin-graphql-direct-proxy/2026-10" \
  -d "{\"query\":\"$INTROSPECTION_QUERY\"}" \
  > test/fixtures/admin-2026-10.schema.json
```

After refreshing, update the "Fetched" date above.

### Usage in Tests

The schema is used by `scripts/__tests__/seed.test.ts` to:

1. **Validate GraphQL documents** - Uses `graphql-js` `validate()` to ensure mutations are syntactically valid against the 2026-10 schema (e.g., `displayFinancialStatus` instead of `financialStatus`).

2. **Coerce input variables** - Uses `graphql-js` `coerceInputValue()` to validate that the variable builder functions produce payloads that conform to the expected input types:
   - `CompanyCreateInput` (uses `CompanyAddressInput.zoneCode`)
   - `CompanyLocationInput` (uses `CompanyAddressInput.zoneCode`)
   - `OrderCreateOrderInput` (uses `MailingAddressInput.provinceCode`)

Key schema differences:
- `CompanyAddressInput` has `zoneCode` for company/location addresses
- `MailingAddressInput` has `provinceCode` for order billing/shipping addresses
- Both use ISO 3166-2:IN codes (e.g., MH, DL, KA) for Indian states
