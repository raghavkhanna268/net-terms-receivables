# Test Fixtures

## Shopify Admin API 2026-10 Schema

The `admin-2026-10.schema.json` file contains the GraphQL introspection schema for Shopify's Admin API version 2026-10.

### Source

This schema is fetched from Shopify's public GraphQL introspection proxy:

```bash
curl -s -H "Content-Type: application/json" -X POST \
  "https://shopify.dev/admin-graphql-direct-proxy/2026-10" \
  -d '{"query":"<introspection-query>"}' \
  > test/fixtures/admin-2026-10.schema.json
```

No authentication is required for fetching the schema.

### Refreshing the Schema

To refresh the schema (e.g., when a new API version is released or to update to the latest 2026-10 schema):

```bash
# Standard GraphQL introspection query
INTROSPECTION_QUERY='query IntrospectionQuery { __schema { queryType { name } mutationType { name } subscriptionType { name } types { ...FullType } directives { name description locations args { ...InputValue } } } } fragment FullType on __Type { kind name description fields(includeDeprecated: true) { name description args { ...InputValue } type { ...TypeRef } isDeprecated deprecationReason } inputFields { ...InputValue } interfaces { ...TypeRef } enumValues(includeDeprecated: true) { name description isDeprecated deprecationReason } possibleTypes { ...TypeRef } } fragment InputValue on __InputValue { name description type { ...TypeRef } defaultValue } fragment TypeRef on __Type { kind name ofType { kind name ofType { kind name ofType { kind name ofType { kind name ofType { kind name ofType { kind name ofType { kind name } } } } } } } }'

curl -s -H "Content-Type: application/json" -X POST \
  "https://shopify.dev/admin-graphql-direct-proxy/2026-10" \
  -d "{\"query\":\"$INTROSPECTION_QUERY\"}" \
  > test/fixtures/admin-2026-10.schema.json
```

### Usage in Tests

The schema is used by `scripts/__tests__/seed.test.ts` to validate that the GraphQL documents in `scripts/seed.ts` conform to the Admin API 2026-10 schema using `graphql-js` `validate()` function.

This ensures that:
- All field selections are valid (e.g., `displayFinancialStatus` instead of `financialStatus`)
- All input types have the correct shape
- Mutations and queries reference existing types
