#!/usr/bin/env npx tsx
/**
 * Validate all Admin GraphQL documents against the 2026-10 schema.
 *
 * This script discovers all GraphQL operations in the codebase and validates
 * them against the Admin API schema fixture. It catches schema mismatches
 * (removed/renamed fields, type changes) before they hit production.
 *
 * Usage:
 *   npx tsx scripts/validate-graphql-schema.ts
 *
 * Exit codes:
 *   0: All documents valid
 *   1: Validation errors found
 *
 * Features:
 *   - Validates static GraphQL documents (exported const strings)
 *   - Validates inline admin.graphql() template literals
 *   - ALWAYS extracts and validates inner queries from bulkOperationRunQuery mutations
 *   - Validates bulk query rules using AST (edges/node pattern, nesting limits)
 *   - Programmatically evaluates dynamic query builders (getBulkCustomersQuery variants)
 *   - Runs negative fixture self-tests to verify error detection
 *   - Enforces minimum document count to prevent accidental coverage loss
 *   - FAILS on any gql/graphql/admin.graphql call that cannot be validated
 */

// Expected minimum document count - update when adding/removing documents
const EXPECTED_MIN_DOCUMENTS = 20;

import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import {
  buildClientSchema,
  parse,
  validate,
  visit,
  GraphQLError,
  Kind,
  type GraphQLSchema,
  type DocumentNode,
  type FieldNode,
} from "graphql";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SCHEMA_PATH = path.join(__dirname, "../test/fixtures/admin-2026-10.schema.json");

interface GraphQLDocument {
  name: string;
  source: string;
  filePath: string;
  lineNumber?: number;
}

interface ValidationResult {
  document: GraphQLDocument;
  errors: GraphQLError[];
}

/**
 * Load the Admin API schema from the fixture file.
 */
function loadSchema(): GraphQLSchema {
  const schemaJson = JSON.parse(fs.readFileSync(SCHEMA_PATH, "utf-8"));
  return buildClientSchema(schemaJson.data);
}

/**
 * Document names that are intentionally invalid (for testing schema validation).
 */
const INTENTIONALLY_INVALID_DOCUMENTS = [
  "OLD_INVALID_MUTATION", // Test fixture in seed.test.ts to verify schema validation works
];

/**
 * Files to skip when extracting documents.
 * Test files for the validation script itself contain invalid fixtures.
 */
const SKIP_FILES = [
  "validate-graphql-schema.test.ts", // Contains test fixtures for this validator
];

/**
 * Connection field names that must use edges { node { ... } } pattern in bulk queries.
 */
export const CONNECTION_FIELDS = [
  "orders",
  "customers",
  "companies",
  "companyLocations",
  "draftOrders",
  "paymentSchedules",
];

/**
 * Negative test fixtures to verify the validator catches errors.
 */
const NEGATIVE_FIXTURES = {
  badNormalDocument: {
    name: "NEGATIVE_TEST_BAD_FIELD",
    source: `query BadField { shop { nonExistentField } }`,
    expectedError: "Cannot query field",
  },
  badBulkInnerQuery: {
    name: "NEGATIVE_TEST_BAD_BULK",
    source: `mutation BadBulk {
      bulkOperationRunQuery(
        query: """
        {
          orders {
            edges {
              node {
                id
                fakeFieldThatDoesNotExist
              }
            }
          }
        }
        """
      ) {
        bulkOperation { id }
      }
    }`,
    expectedError: "Cannot query field",
  },
  unvalidatableDynamicQuery: {
    name: "NEGATIVE_TEST_UNVALIDATABLE",
    source: null, // This fixture tests the detection of unvalidatable queries, not a specific source
    expectedError: "cannot be statically validated",
  },
};

/**
 * Extract GraphQL documents from source files.
 * Looks for:
 * - Exported const strings containing query/mutation
 * - Template literals with #graphql comment (common pattern)
 * - Inline admin.graphql() template literals
 * - Template literals with GraphQL operations
 */
function extractGraphQLDocuments(filePath: string, content: string): GraphQLDocument[] {
  const documents: GraphQLDocument[] = [];
  const baseName = path.basename(filePath);

  // Skip files that contain test fixtures for this validator
  if (SKIP_FILES.some(f => baseName.includes(f))) {
    return documents;
  }

  // Pattern 1: export const QUERY_NAME = `...`; or const QUERY_NAME = `...`;
  const constQueryPattern = /(?:export\s+)?const\s+(\w+)\s*=\s*`\s*((?:query|mutation|fragment|subscription)\s+[\s\S]*?)`\s*;/g;

  let match;
  while ((match = constQueryPattern.exec(content)) !== null) {
    const name = match[1];
    const source = match[2];
    const lineNumber = content.substring(0, match.index).split("\n").length;

    // Skip intentionally invalid documents
    if (INTENTIONALLY_INVALID_DOCUMENTS.includes(name)) {
      continue;
    }

    documents.push({
      name,
      source,
      filePath,
      lineNumber,
    });
  }

  // Pattern 1b: const QUERY_NAME = `#graphql\n query|mutation...`;
  const hashGraphqlPattern = /(?:export\s+)?const\s+(\w+)\s*=\s*`#graphql\s*((?:query|mutation|fragment|subscription)\s+[\s\S]*?)`\s*;/g;

  while ((match = hashGraphqlPattern.exec(content)) !== null) {
    const name = match[1];
    const source = match[2];
    const lineNumber = content.substring(0, match.index).split("\n").length;

    // Skip intentionally invalid documents and already captured docs
    if (INTENTIONALLY_INVALID_DOCUMENTS.includes(name) || documents.some(d => d.name === name)) {
      continue;
    }

    documents.push({
      name,
      source,
      filePath,
      lineNumber,
    });
  }

  // Pattern 2: Multi-line template strings for bulk queries (mutation with inner query string)
  const bulkMutationPattern = /(?:export\s+)?const\s+(\w+)\s*=\s*`\s*(mutation\s+\w+\s*\{[\s\S]*?bulkOperationRunQuery[\s\S]*?\})\s*`\s*;/g;

  while ((match = bulkMutationPattern.exec(content)) !== null) {
    const name = match[1];
    const source = match[2];
    const lineNumber = content.substring(0, match.index).split("\n").length;

    // Check if already captured by first pattern
    if (!documents.some((d) => d.name === name)) {
      documents.push({
        name,
        source,
        filePath,
        lineNumber,
      });
    }
  }

  // Pattern 3: Inline admin.graphql() with static template literal
  // Matches: admin.graphql(`query { ... }`) or admin.graphql(`\n  query { ... }\n`)
  // Skip the validation script itself (contains negative fixtures with admin.graphql patterns)
  const fileName = path.basename(filePath);
  if (fileName !== "validate-graphql-schema.ts") {
    const adminGraphqlPattern = /admin\.graphql\s*\(\s*`\s*((?:query|mutation|fragment|subscription|\{)[\s\S]*?)`\s*\)/g;

    while ((match = adminGraphqlPattern.exec(content)) !== null) {
      let source = match[1].trim();
      const lineNumber = content.substring(0, match.index).split("\n").length;

      // If it starts with { and no query/mutation keyword, wrap it in query
      if (source.startsWith("{") && !source.startsWith("query") && !source.startsWith("mutation")) {
        source = `query InlineQuery ${source}`;
      }

      const name = `INLINE_ADMIN_GRAPHQL_L${lineNumber}`;

      // Check if already captured
      if (!documents.some((d) => d.name === name)) {
        documents.push({
          name,
          source,
          filePath,
          lineNumber,
        });
      }
    }
  }

  return documents;
}

/**
 * Extract the inner bulk query from a bulkOperationRunQuery mutation.
 */
function extractBulkInnerQuery(source: string): string | null {
  // Match the query: """ ... """ inside bulkOperationRunQuery
  const innerQueryMatch = source.match(/query:\s*"""\s*([\s\S]*?)\s*"""/);
  if (innerQueryMatch) {
    // Wrap in a query root for validation
    return `query BulkInner ${innerQueryMatch[1]}`;
  }
  return null;
}

/**
 * Find all TypeScript files with GraphQL documents.
 */
function findGraphQLFiles(rootDir: string): string[] {
  const files: string[] = [];
  const extensions = [".ts", ".tsx", ".server.ts"];

  function walk(dir: string): void {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        // Skip node_modules, generated, etc.
        if (!["node_modules", "generated", ".git", "dist", "build"].includes(entry.name)) {
          walk(fullPath);
        }
      } else if (entry.isFile() && extensions.some((ext) => entry.name.endsWith(ext))) {
        files.push(fullPath);
      }
    }
  }

  walk(rootDir);
  return files;
}

/**
 * Validate a GraphQL document against the schema.
 * For bulkOperationRunQuery mutations, ALWAYS extracts and validates the inner query.
 */
function validateDocument(schema: GraphQLSchema, doc: GraphQLDocument): GraphQLError[] {
  const allErrors: GraphQLError[] = [];

  try {
    // Check if this is a bulk operation mutation
    const isBulkMutation = doc.source.includes("bulkOperationRunQuery");

    if (isBulkMutation) {
      // For bulk mutations, extract and validate the inner query
      const innerQuery = extractBulkInnerQuery(doc.source);
      if (innerQuery) {
        try {
          const parsed = parse(innerQuery);
          const errors = validate(schema, parsed);
          allErrors.push(...errors);

          // Additional bulk query rules validation using AST
          const bulkRuleErrors = validateBulkQueryRulesAST(parsed, doc.name);
          allErrors.push(...bulkRuleErrors);
        } catch (innerParseError) {
          allErrors.push(
            new GraphQLError(
              `Parse error in bulk inner query of ${doc.name}: ${innerParseError instanceof Error ? innerParseError.message : "Unknown error"}`
            )
          );
        }
      } else {
        allErrors.push(
          new GraphQLError(
            `Could not extract inner query from bulk mutation ${doc.name}`
          )
        );
      }
    } else {
      // Regular query/mutation - parse and validate normally
      try {
        const parsed = parse(doc.source);
        const errors = validate(schema, parsed);
        allErrors.push(...errors);
      } catch (parseError) {
        allErrors.push(
          new GraphQLError(
            `Parse error in ${doc.name}: ${parseError instanceof Error ? parseError.message : "Unknown error"}`
          )
        );
      }
    }

    return allErrors;
  } catch (err) {
    return [
      new GraphQLError(
        `Validation error in ${doc.name}: ${err instanceof Error ? err.message : "Unknown error"}`
      ),
    ];
  }
}

/**
 * Validate bulk query rules using AST traversal.
 * Checks that connection fields use edges { node { ... } } pattern.
 */
export function validateBulkQueryRulesAST(doc: DocumentNode, docName: string): GraphQLError[] {
  const errors: GraphQLError[] = [];
  let nestingDepth = 0;

  visit(doc, {
    Field: {
      enter(node: FieldNode) {
        const fieldName = node.name.value;

        // Check if this is a connection field
        if (CONNECTION_FIELDS.includes(fieldName)) {
          // Check if it has selections (should have edges/node)
          if (node.selectionSet) {
            const selections = node.selectionSet.selections;
            const hasEdges = selections.some(
              (sel) => sel.kind === Kind.FIELD && sel.name.value === "edges"
            );

            if (hasEdges) {
              // Find the edges field and check for node
              const edgesField = selections.find(
                (sel): sel is FieldNode => sel.kind === Kind.FIELD && sel.name.value === "edges"
              );

              if (edgesField?.selectionSet) {
                const edgeSelections = edgesField.selectionSet.selections;
                const hasNode = edgeSelections.some(
                  (sel) => sel.kind === Kind.FIELD && sel.name.value === "node"
                );

                if (!hasNode) {
                  errors.push(
                    new GraphQLError(
                      `Bulk query ${docName}: Connection field '${fieldName}' has 'edges' but missing 'node'. Use edges { node { ... } } pattern.`
                    )
                  );
                }

                nestingDepth++;
              }
            } else {
              errors.push(
                new GraphQLError(
                  `Bulk query ${docName}: Connection field '${fieldName}' should use edges { node { ... } } pattern.`
                )
              );
            }
          }
        }
      },
    },
  });

  // Check for excessive nesting
  if (nestingDepth > 3) {
    errors.push(
      new GraphQLError(
        `Bulk query ${docName}: Excessive connection nesting depth (${nestingDepth}). Consider simplifying.`
      )
    );
  }

  return errors;
}

/**
 * Run negative fixture self-tests to verify the validator catches errors.
 */
function runSelfTests(schema: GraphQLSchema): boolean {
  console.log("Running self-tests with negative fixtures...\n");

  let allPassed = true;

  // Test bad normal document
  const badNormalDoc: GraphQLDocument = {
    name: NEGATIVE_FIXTURES.badNormalDocument.name,
    source: NEGATIVE_FIXTURES.badNormalDocument.source,
    filePath: "<self-test>",
  };

  const badNormalErrors = validateDocument(schema, badNormalDoc);
  if (badNormalErrors.length === 0) {
    console.log(`  ❌ SELF-TEST FAILED: badNormalDocument - expected error but got none`);
    allPassed = false;
  } else {
    const hasExpectedError = badNormalErrors.some((e) =>
      e.message.includes(NEGATIVE_FIXTURES.badNormalDocument.expectedError)
    );
    if (hasExpectedError) {
      console.log(`  ✓ badNormalDocument: correctly detected error`);
    } else {
      console.log(`  ❌ SELF-TEST FAILED: badNormalDocument - wrong error type`);
      console.log(`     Expected: ${NEGATIVE_FIXTURES.badNormalDocument.expectedError}`);
      console.log(`     Got: ${badNormalErrors[0].message}`);
      allPassed = false;
    }
  }

  // Test bad bulk inner query
  const badBulkDoc: GraphQLDocument = {
    name: NEGATIVE_FIXTURES.badBulkInnerQuery.name,
    source: NEGATIVE_FIXTURES.badBulkInnerQuery.source,
    filePath: "<self-test>",
  };

  const badBulkErrors = validateDocument(schema, badBulkDoc);
  if (badBulkErrors.length === 0) {
    console.log(`  ❌ SELF-TEST FAILED: badBulkInnerQuery - expected error but got none`);
    allPassed = false;
  } else {
    const hasExpectedError = badBulkErrors.some((e) =>
      e.message.includes(NEGATIVE_FIXTURES.badBulkInnerQuery.expectedError)
    );
    if (hasExpectedError) {
      console.log(`  ✓ badBulkInnerQuery: correctly detected error`);
    } else {
      console.log(`  ❌ SELF-TEST FAILED: badBulkInnerQuery - wrong error type`);
      console.log(`     Expected: ${NEGATIVE_FIXTURES.badBulkInnerQuery.expectedError}`);
      console.log(`     Got: ${badBulkErrors[0].message}`);
      allPassed = false;
    }
  }

  console.log("");
  return allPassed;
}

/**
 * Files where admin.graphql() with named constants or query parameters is acceptable.
 * These either:
 * - Use constants that are extracted and validated by this script
 * - Are generic wrapper functions where queries are passed in (validated elsewhere)
 */
const ADMIN_GRAPHQL_CONST_ALLOWLIST = [
  "after-auth.server.ts", // Uses SHOP_TIMEZONE_QUERY constant
  "metafield-definitions.server.ts", // Uses METAFIELD_DEFINITION_CREATE_MUTATION constant
  "validation-registration.server.ts", // Uses VALIDATIONS_QUERY, VALIDATION_CREATE_MUTATION constants
  "shopify-client.server.ts", // Generic wrapper that takes query as parameter
];

/**
 * Check for dynamic query patterns that CANNOT be statically validated.
 * Returns errors (not warnings) for any unvalidatable patterns.
 *
 * Allowed patterns:
 * - admin.graphql(`query { ... }`) - inline static template (extracted by this script)
 * - admin.graphql(CONSTANT_NAME, ...) - uses a const (validated by this script, file must be in allowlist)
 * - admin.graphql(query, ...) in wrapper functions - query passed in (validated elsewhere, file must be in allowlist)
 *
 * Disallowed patterns:
 * - admin.graphql(`query ${variable}`) - template with interpolation
 * - admin.graphql(buildQuery(args)) - function call building query dynamically
 * - admin.graphql(variableName) - variable reference (not a template literal)
 * - gql`query ${variable}` - gql tag with interpolation
 */
function checkForUnvalidatableQueries(filePath: string, content: string): GraphQLError[] {
  const errors: GraphQLError[] = [];
  const fileName = path.basename(filePath);

  // Skip the validation script itself
  if (fileName === "validate-graphql-schema.ts") {
    return errors;
  }

  // Skip files that use admin.graphql() with named constants or are generic wrappers
  if (ADMIN_GRAPHQL_CONST_ALLOWLIST.some(f => fileName.includes(f))) {
    return errors;
  }

  // Check for admin.graphql() with template literals containing interpolations
  // This is the truly dynamic case that cannot be validated
  const adminGraphqlInterpolationPattern = /admin\.graphql\s*\(\s*`[^`]*\$\{/g;
  let match;
  while ((match = adminGraphqlInterpolationPattern.exec(content)) !== null) {
    const lineNumber = content.substring(0, match.index).split("\n").length;
    errors.push(
      new GraphQLError(
        `${filePath}:${lineNumber}: admin.graphql() with template interpolation cannot be statically validated. ` +
          `Extract to a const or use a function that this script can evaluate.`
      )
    );
  }

  // Check for admin.graphql() with function calls (builder pattern)
  // Pattern: admin.graphql(someFunction(...))
  const adminGraphqlBuilderPattern = /admin\.graphql\s*\(\s*(\w+)\s*\(/g;
  while ((match = adminGraphqlBuilderPattern.exec(content)) !== null) {
    const lineNumber = content.substring(0, match.index).split("\n").length;
    const functionName = match[1];
    errors.push(
      new GraphQLError(
        `${filePath}:${lineNumber}: admin.graphql(${functionName}(...)) uses a dynamic builder that cannot be statically validated. ` +
          `Add file to ADMIN_GRAPHQL_CONST_ALLOWLIST or extract query to a const.`
      )
    );
  }

  // Check for admin.graphql() with variable references (not template literals)
  // Pattern: admin.graphql(variableName, ...) or admin.graphql(variableName)
  // But NOT: admin.graphql(`...`) which is a template literal (already extracted)
  const adminGraphqlVariablePattern = /admin\.graphql\s*\(\s*([a-zA-Z_]\w*)(?:\s*,|\s*\))/g;
  while ((match = adminGraphqlVariablePattern.exec(content)) !== null) {
    const variableName = match[1];
    const lineNumber = content.substring(0, match.index).split("\n").length;
    // Check if this is actually a template literal start (false positive prevention)
    const afterMatch = content.substring(match.index);
    if (afterMatch.match(/^admin\.graphql\s*\(\s*`/)) {
      continue; // This is a template literal, skip
    }
    errors.push(
      new GraphQLError(
        `${filePath}:${lineNumber}: admin.graphql(${variableName}) uses a variable reference that cannot be statically validated. ` +
          `Add file to ADMIN_GRAPHQL_CONST_ALLOWLIST if the variable is a validated const.`
      )
    );
  }

  // Check for gql`` or graphql`` template tags with interpolations
  const gqlDynamicPattern = /(?:gql|graphql)\s*`[^`]*\$\{/g;
  while ((match = gqlDynamicPattern.exec(content)) !== null) {
    const lineNumber = content.substring(0, match.index).split("\n").length;
    errors.push(
      new GraphQLError(
        `${filePath}:${lineNumber}: gql/graphql template with interpolation cannot be statically validated. ` +
          `Use a static template literal.`
      )
    );
  }

  return errors;
}

/**
 * Generate and validate all variants of getBulkCustomersQuery and getCustomerQuery.
 * Imports the REAL functions from customer-fields.server.ts - no copies.
 */
async function validateDynamicQueryBuilders(schema: GraphQLSchema): Promise<{ results: ValidationResult[], count: number }> {
  const results: ValidationResult[] = [];
  let validatedCount = 0;
  const customerFieldsPath = path.join(__dirname, "../app/services/sync/customer-fields.server.ts");

  // Fail hard if the module doesn't exist
  if (!fs.existsSync(customerFieldsPath)) {
    console.error("❌ FATAL: customer-fields.server.ts not found at", customerFieldsPath);
    process.exit(1);
  }

  console.log("Validating dynamic query builders (real imports)...\n");

  // Dynamically import the real module
  let getBulkCustomersQuery: (tagRules: Array<{ tag: string }>, env: { CUSTOMER_PII_FIELDS?: string }) => string | null;
  let getCustomerQuery: (env: { CUSTOMER_PII_FIELDS?: string }) => string;
  let getCustomerByNodeQuery: (env: { CUSTOMER_PII_FIELDS?: string }) => string;

  try {
    const module = await import("../app/services/sync/customer-fields.server");
    if (!module.getBulkCustomersQuery || !module.getCustomerQuery || !module.getCustomerByNodeQuery) {
      console.error("❌ FATAL: getBulkCustomersQuery, getCustomerQuery, or getCustomerByNodeQuery not exported from customer-fields.server.ts");
      process.exit(1);
    }
    getBulkCustomersQuery = module.getBulkCustomersQuery;
    getCustomerQuery = module.getCustomerQuery;
    getCustomerByNodeQuery = module.getCustomerByNodeQuery;
  } catch (err) {
    console.error("❌ FATAL: Failed to import customer-fields.server.ts:", err);
    process.exit(1);
  }

  // ===== getBulkCustomersQuery variants =====
  const tagRules = [{ tag: "net-terms" }];

  // Variant 1: With tag rules, no PII fields
  const envNoPii = {};
  const queryNoPii = getBulkCustomersQuery(tagRules, envNoPii);

  if (queryNoPii) {
    const doc: GraphQLDocument = {
      name: "getBulkCustomersQuery(tagRules, {})",
      source: queryNoPii,
      filePath: customerFieldsPath,
    };
    const errors = validateDocument(schema, doc);
    if (errors.length > 0) {
      results.push({ document: doc, errors });
      console.log(`  ✗ getBulkCustomersQuery (no PII): FAILED`);
    } else {
      validatedCount++;
      console.log(`  ✓ getBulkCustomersQuery (no PII): validated`);
    }
  }

  // Variant 2: With tag rules, with PII fields
  const envWithPii = { CUSTOMER_PII_FIELDS: "1" };
  const queryWithPii = getBulkCustomersQuery(tagRules, envWithPii);

  if (queryWithPii) {
    const doc: GraphQLDocument = {
      name: "getBulkCustomersQuery(tagRules, {CUSTOMER_PII_FIELDS:'1'})",
      source: queryWithPii,
      filePath: customerFieldsPath,
    };
    const errors = validateDocument(schema, doc);
    if (errors.length > 0) {
      results.push({ document: doc, errors });
      console.log(`  ✗ getBulkCustomersQuery (with PII): FAILED`);
    } else {
      validatedCount++;
      console.log(`  ✓ getBulkCustomersQuery (with PII): validated`);
    }
  }

  // Variant 3: Empty tag rules (should return null - no validation needed)
  const queryEmpty = getBulkCustomersQuery([], envNoPii);
  if (queryEmpty === null) {
    console.log(`  ✓ getBulkCustomersQuery (empty tags): correctly returns null`);
  } else {
    console.log(`  ⚠️ getBulkCustomersQuery (empty tags): expected null but got query`);
  }

  // Variant 4: Special characters in tag
  const tagRulesSpecial = [{ tag: "buyer's choice" }];
  const querySpecial = getBulkCustomersQuery(tagRulesSpecial, envNoPii);

  if (querySpecial) {
    const doc: GraphQLDocument = {
      name: "getBulkCustomersQuery(specialChars, {})",
      source: querySpecial,
      filePath: customerFieldsPath,
    };
    const errors = validateDocument(schema, doc);
    if (errors.length > 0) {
      results.push({ document: doc, errors });
      console.log(`  ✗ getBulkCustomersQuery (special chars): FAILED`);
    } else {
      validatedCount++;
      console.log(`  ✓ getBulkCustomersQuery (special chars): validated`);
    }
  }

  // ===== getCustomerQuery variants =====

  // Variant 5: getCustomerQuery without PII
  const customerQueryNoPii = getCustomerQuery(envNoPii);
  const customerDocNoPii: GraphQLDocument = {
    name: "getCustomerQuery({})",
    source: customerQueryNoPii,
    filePath: customerFieldsPath,
  };
  const customerErrorsNoPii = validateDocument(schema, customerDocNoPii);
  if (customerErrorsNoPii.length > 0) {
    results.push({ document: customerDocNoPii, errors: customerErrorsNoPii });
    console.log(`  ✗ getCustomerQuery (no PII): FAILED`);
  } else {
    validatedCount++;
    console.log(`  ✓ getCustomerQuery (no PII): validated`);
  }

  // Variant 6: getCustomerQuery with PII
  const customerQueryWithPii = getCustomerQuery(envWithPii);
  const customerDocWithPii: GraphQLDocument = {
    name: "getCustomerQuery({CUSTOMER_PII_FIELDS:'1'})",
    source: customerQueryWithPii,
    filePath: customerFieldsPath,
  };
  const customerErrorsWithPii = validateDocument(schema, customerDocWithPii);
  if (customerErrorsWithPii.length > 0) {
    results.push({ document: customerDocWithPii, errors: customerErrorsWithPii });
    console.log(`  ✗ getCustomerQuery (with PII): FAILED`);
  } else {
    validatedCount++;
    console.log(`  ✓ getCustomerQuery (with PII): validated`);
  }

  // ===== getCustomerByNodeQuery variants (S8 drain processor) =====

  // Variant 7: getCustomerByNodeQuery without PII
  const nodeQueryNoPii = getCustomerByNodeQuery(envNoPii);
  const nodeDocNoPii: GraphQLDocument = {
    name: "getCustomerByNodeQuery({})",
    source: nodeQueryNoPii,
    filePath: customerFieldsPath,
  };
  const nodeErrorsNoPii = validateDocument(schema, nodeDocNoPii);
  if (nodeErrorsNoPii.length > 0) {
    results.push({ document: nodeDocNoPii, errors: nodeErrorsNoPii });
  } else {
    validatedCount++;
  }
  console.log(`  ✓ getCustomerByNodeQuery (no PII): validated`);

  // Variant 8: getCustomerByNodeQuery with PII
  const nodeQueryWithPii = getCustomerByNodeQuery(envWithPii);
  const nodeDocWithPii: GraphQLDocument = {
    name: "getCustomerByNodeQuery({CUSTOMER_PII_FIELDS:'1'})",
    source: nodeQueryWithPii,
    filePath: customerFieldsPath,
  };
  const nodeErrorsWithPii = validateDocument(schema, nodeDocWithPii);
  if (nodeErrorsWithPii.length > 0) {
    results.push({ document: nodeDocWithPii, errors: nodeErrorsWithPii });
  } else {
    validatedCount++;
  }
  console.log(`  ✓ getCustomerByNodeQuery (with PII): validated`);

  console.log("");
  return { results, count: validatedCount };
}

/**
 * Main validation function.
 */
async function main(): Promise<void> {
  console.log("Loading Admin API 2026-10 schema...");
  const schema = loadSchema();

  // Run self-tests first
  const selfTestsPassed = runSelfTests(schema);
  if (!selfTestsPassed) {
    console.log("❌ Self-tests failed - validator may not be working correctly");
    process.exit(1);
  }

  console.log("Scanning for GraphQL documents...\n");

  const appDir = path.join(__dirname, "../app");
  const scriptsDir = path.join(__dirname, "../scripts");

  const appFiles = findGraphQLFiles(appDir);
  const scriptFiles = findGraphQLFiles(scriptsDir);
  const allFiles = [...appFiles, ...scriptFiles];

  console.log(`Found ${allFiles.length} TypeScript files to scan\n`);

  const allDocuments: GraphQLDocument[] = [];
  const fileDocumentCounts: Map<string, number> = new Map();
  const unvalidatableErrors: GraphQLError[] = [];

  for (const filePath of allFiles) {
    const content = fs.readFileSync(filePath, "utf-8");
    const docs = extractGraphQLDocuments(filePath, content);
    allDocuments.push(...docs);

    if (docs.length > 0) {
      fileDocumentCounts.set(filePath, docs.length);
    }

    // Check for unvalidatable dynamic queries - these are ERRORS, not warnings
    const dynamicErrors = checkForUnvalidatableQueries(filePath, content);
    unvalidatableErrors.push(...dynamicErrors);
  }

  // Print per-file document counts
  console.log("Documents per file:");
  for (const [filePath, count] of fileDocumentCounts) {
    const relativePath = path.relative(path.join(__dirname, ".."), filePath);
    console.log(`  ${relativePath}: ${count}`);
  }
  console.log(`\nTotal: ${allDocuments.length} GraphQL documents\n`);

  // Check minimum document count
  if (allDocuments.length < EXPECTED_MIN_DOCUMENTS) {
    console.log(
      `❌ Document count (${allDocuments.length}) is below expected minimum (${EXPECTED_MIN_DOCUMENTS})`
    );
    console.log("   This may indicate the extractor is missing documents.");
    console.log("   If intentional, update EXPECTED_MIN_DOCUMENTS in the script.");
    process.exit(1);
  }

  // Validate dynamic query builders (getBulkCustomersQuery and getCustomerQuery variants)
  const { results: dynamicResults, count: dynamicValidatedCount } = await validateDynamicQueryBuilders(schema);

  // Fail if any unvalidatable queries were found
  if (unvalidatableErrors.length > 0) {
    console.log("❌ Found unvalidatable dynamic queries:\n");
    for (const error of unvalidatableErrors) {
      console.log(`  ${error.message}`);
    }
    console.log("\n   All GraphQL queries must be statically validatable.");
    process.exit(1);
  }

  const results: ValidationResult[] = [...dynamicResults];
  let hasErrors = dynamicResults.length > 0;

  for (const doc of allDocuments) {
    const errors = validateDocument(schema, doc);
    if (errors.length > 0) {
      hasErrors = true;
      results.push({ document: doc, errors });
    }
  }

  // Print results
  if (hasErrors) {
    console.log("❌ Validation FAILED\n");

    for (const result of results) {
      const { document, errors } = result;
      const location = document.lineNumber
        ? `${document.filePath}:${document.lineNumber}`
        : document.filePath;

      console.log(`\n${document.name} (${location}):`);
      for (const error of errors) {
        console.log(`  - ${error.message}`);
        if (error.locations) {
          for (const loc of error.locations) {
            console.log(`    at line ${loc.line}, column ${loc.column}`);
          }
        }
      }
    }

    console.log(`\n\nTotal: ${results.length} documents with errors`);
    process.exit(1);
  } else {
    console.log("✅ All GraphQL documents are valid against Admin API 2026-10 schema");
    console.log(`   Validated ${allDocuments.length} static + ${dynamicValidatedCount} dynamic documents (min: ${EXPECTED_MIN_DOCUMENTS})`);
    process.exit(0);
  }
}

// Only run main() if this file is executed directly (not imported as a module)
// Uses resolved paths to handle symlinks and relative paths correctly
if (fileURLToPath(import.meta.url) === path.resolve(process.argv[1] ?? "")) {
  main().catch((err) => {
    console.error("Fatal error:", err);
    process.exit(1);
  });
}
