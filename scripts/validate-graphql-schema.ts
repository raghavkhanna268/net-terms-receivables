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
 */

import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import {
  buildClientSchema,
  parse,
  validate,
  GraphQLError,
  type GraphQLSchema,
  type DocumentNode,
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
 */
function validateDocument(schema: GraphQLSchema, doc: GraphQLDocument): GraphQLError[] {
  try {
    let parsed: DocumentNode;
    let errors: readonly GraphQLError[];

    // Try parsing the document
    try {
      parsed = parse(doc.source);
    } catch (parseError) {
      // For bulk mutations, extract and validate the inner query
      const innerQuery = extractBulkInnerQuery(doc.source);
      if (innerQuery) {
        try {
          parsed = parse(innerQuery);
        } catch (innerParseError) {
          return [
            new GraphQLError(
              `Parse error in ${doc.name}: ${innerParseError instanceof Error ? innerParseError.message : "Unknown error"}`
            ),
          ];
        }
      } else {
        return [
          new GraphQLError(
            `Parse error in ${doc.name}: ${parseError instanceof Error ? parseError.message : "Unknown error"}`
          ),
        ];
      }
    }

    // Validate against schema
    errors = validate(schema, parsed);
    return [...errors];
  } catch (err) {
    return [
      new GraphQLError(
        `Validation error in ${doc.name}: ${err instanceof Error ? err.message : "Unknown error"}`
      ),
    ];
  }
}

/**
 * Main validation function.
 */
async function main(): Promise<void> {
  console.log("Loading Admin API 2026-10 schema...");
  const schema = loadSchema();

  console.log("\nScanning for GraphQL documents...");

  const appDir = path.join(__dirname, "../app");
  const scriptsDir = path.join(__dirname, "../scripts");

  const appFiles = findGraphQLFiles(appDir);
  const scriptFiles = findGraphQLFiles(scriptsDir);
  const allFiles = [...appFiles, ...scriptFiles];

  console.log(`Found ${allFiles.length} TypeScript files to scan\n`);

  const allDocuments: GraphQLDocument[] = [];

  for (const filePath of allFiles) {
    const content = fs.readFileSync(filePath, "utf-8");
    const docs = extractGraphQLDocuments(filePath, content);
    allDocuments.push(...docs);
  }

  console.log(`Found ${allDocuments.length} GraphQL documents\n`);

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
    console.log(`   Validated ${allDocuments.length} documents`);
    process.exit(0);
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
