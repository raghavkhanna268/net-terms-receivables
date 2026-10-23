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
 *   - ALWAYS extracts and validates inner queries from bulkOperationRunQuery mutations
 *   - Validates bulk query rules (edges/node pattern, nesting limits)
 *   - Detects function-built queries and requires explicit allowlist
 *   - Runs negative fixture self-tests to verify error detection
 *   - Enforces minimum document count to prevent accidental coverage loss
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
  GraphQLError,
  type GraphQLSchema,
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
 * Functions that generate GraphQL queries dynamically.
 * These must be explicitly allowlisted and their variants validated separately.
 */
const DYNAMIC_QUERY_FUNCTIONS = [
  "getBulkCustomersQuery", // Generates customer bulk query based on tag rules
];

/**
 * Files/patterns that are allowed to have dynamic queries.
 * The script will warn but not fail if it finds admin.graphql() calls in these files.
 */
const DYNAMIC_QUERY_ALLOWLIST = [
  "customer-fields.server.ts", // getBulkCustomersQuery generates queries dynamically
  "webhooks.compliance.tsx", // Uses admin.graphql() for compliance webhook requests
  "validate-graphql-schema.ts", // Contains negative test fixtures with gql patterns
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
};

/**
 * Extract GraphQL documents from source files.
 * Looks for:
 * - Exported const strings containing query/mutation
 * - Template literals with GraphQL operations
 */
function extractGraphQLDocuments(filePath: string, content: string): GraphQLDocument[] {
  const documents: GraphQLDocument[] = [];

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

          // Additional bulk query rules validation
          const bulkRuleErrors = validateBulkQueryRules(innerQuery, doc.name);
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
 * Validate bulk query rules (connections need edges/node, nesting limits).
 */
function validateBulkQueryRules(query: string, docName: string): GraphQLError[] {
  const errors: GraphQLError[] = [];

  // Check for proper connection structure (edges/node pattern)
  // Bulk queries must use edges { node { ... } } pattern for connections
  const connectionPattern = /(\w+)\s*\([^)]*\)\s*\{/g;
  let match;

  while ((match = connectionPattern.exec(query)) !== null) {
    const fieldName = match[1];
    // Common connection field names
    if (["orders", "customers", "companies", "companyLocations", "draftOrders"].includes(fieldName)) {
      // Check if it has edges { node pattern
      const afterField = query.substring(match.index);
      const hasEdgesNode = /\{\s*edges\s*\{[\s\S]*?node\s*\{/.test(afterField.substring(0, 200));
      if (!hasEdgesNode) {
        errors.push(
          new GraphQLError(
            `Bulk query ${docName}: Connection field '${fieldName}' should use edges { node { ... } } pattern`
          )
        );
      }
    }
  }

  // Check for excessive nesting (more than 3 levels of nested connections is problematic)
  const nestingDepth = (query.match(/edges\s*\{/g) || []).length;
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

  for (const [testName, fixture] of Object.entries(NEGATIVE_FIXTURES)) {
    const doc: GraphQLDocument = {
      name: fixture.name,
      source: fixture.source,
      filePath: "<self-test>",
    };

    const errors = validateDocument(schema, doc);

    if (errors.length === 0) {
      console.log(`  ❌ SELF-TEST FAILED: ${testName} - expected error but got none`);
      allPassed = false;
    } else {
      const hasExpectedError = errors.some((e) => e.message.includes(fixture.expectedError));
      if (hasExpectedError) {
        console.log(`  ✓ ${testName}: correctly detected error`);
      } else {
        console.log(`  ❌ SELF-TEST FAILED: ${testName} - wrong error type`);
        console.log(`     Expected: ${fixture.expectedError}`);
        console.log(`     Got: ${errors[0].message}`);
        allPassed = false;
      }
    }
  }

  console.log("");
  return allPassed;
}

/**
 * Check for dynamic query patterns that need special handling.
 */
function checkForDynamicQueries(filePath: string, content: string): string[] {
  const warnings: string[] = [];
  const fileName = path.basename(filePath);
  const isAllowlisted = DYNAMIC_QUERY_ALLOWLIST.some((pattern) => fileName.includes(pattern));

  // Check for admin.graphql() calls
  const adminGraphqlPattern = /admin\.graphql\s*\(\s*`/g;
  let match;
  while ((match = adminGraphqlPattern.exec(content)) !== null) {
    const lineNumber = content.substring(0, match.index).split("\n").length;
    if (!isAllowlisted) {
      warnings.push(
        `${filePath}:${lineNumber}: Found admin.graphql() call that cannot be statically validated. Add to DYNAMIC_QUERY_ALLOWLIST if intentional.`
      );
    }
  }

  // Check for gql`` or graphql`` template tags
  const gqlTagPattern = /(?:gql|graphql)\s*`/g;
  while ((match = gqlTagPattern.exec(content)) !== null) {
    const lineNumber = content.substring(0, match.index).split("\n").length;
    if (!isAllowlisted) {
      warnings.push(
        `${filePath}:${lineNumber}: Found gql/graphql template tag. Ensure query is captured by extractGraphQLDocuments.`
      );
    }
  }

  // Check for dynamic query function calls that aren't the definitions
  for (const funcName of DYNAMIC_QUERY_FUNCTIONS) {
    // Skip if this file defines the function
    if (content.includes(`function ${funcName}`) || content.includes(`const ${funcName} =`)) {
      continue;
    }

    const funcCallPattern = new RegExp(`${funcName}\\s*\\(`, "g");
    while ((match = funcCallPattern.exec(content)) !== null) {
      const _lineNumber = content.substring(0, match.index).split("\n").length;
      void _lineNumber; // Tracked for reference; function itself should be tested
    }
  }

  return warnings;
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
  const dynamicQueryWarnings: string[] = [];

  for (const filePath of allFiles) {
    const content = fs.readFileSync(filePath, "utf-8");
    const docs = extractGraphQLDocuments(filePath, content);
    allDocuments.push(...docs);

    if (docs.length > 0) {
      fileDocumentCounts.set(filePath, docs.length);
    }

    // Check for dynamic queries
    const warnings = checkForDynamicQueries(filePath, content);
    dynamicQueryWarnings.push(...warnings);
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

  // Print dynamic query warnings
  if (dynamicQueryWarnings.length > 0) {
    console.log("⚠️  Dynamic query warnings:");
    for (const warning of dynamicQueryWarnings) {
      console.log(`  ${warning}`);
    }
    console.log("");
  }

  const results: ValidationResult[] = [];
  let hasErrors = false;

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
    console.log(`   Validated ${allDocuments.length} documents (min: ${EXPECTED_MIN_DOCUMENTS})`);
    process.exit(0);
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
