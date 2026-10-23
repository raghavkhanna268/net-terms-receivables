import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";
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

const SCHEMA_PATH = path.join(__dirname, "../../test/fixtures/admin-2026-10.schema.json");

/**
 * Connection field names that must use edges { node { ... } } pattern in bulk queries.
 */
const CONNECTION_FIELDS = [
  "orders",
  "customers",
  "companies",
  "companyLocations",
  "draftOrders",
  "paymentSchedules",
];

/**
 * Load the Admin API schema from the fixture file.
 */
function loadSchema(): GraphQLSchema {
  const schemaJson = JSON.parse(fs.readFileSync(SCHEMA_PATH, "utf-8"));
  return buildClientSchema(schemaJson.data);
}

/**
 * Validate bulk query rules using AST traversal (same logic as the main script).
 */
function validateBulkQueryRulesAST(doc: DocumentNode, docName: string): GraphQLError[] {
  const errors: GraphQLError[] = [];
  let nestingDepth = 0;

  visit(doc, {
    Field: {
      enter(node: FieldNode) {
        const fieldName = node.name.value;

        if (CONNECTION_FIELDS.includes(fieldName)) {
          if (node.selectionSet) {
            const selections = node.selectionSet.selections;
            const hasEdges = selections.some(
              (sel) => sel.kind === Kind.FIELD && sel.name.value === "edges"
            );

            if (hasEdges) {
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

  if (nestingDepth > 3) {
    errors.push(
      new GraphQLError(
        `Bulk query ${docName}: Excessive connection nesting depth (${nestingDepth}). Consider simplifying.`
      )
    );
  }

  return errors;
}

describe("validate-graphql-schema AST validation", () => {
  const schema = loadSchema();

  describe("validateBulkQueryRulesAST", () => {
    it("accepts valid bulk query with edges/node pattern", () => {
      const query = `
        query BulkInner {
          orders {
            edges {
              node {
                id
                name
              }
            }
          }
        }
      `;
      const parsed = parse(query);
      const errors = validateBulkQueryRulesAST(parsed, "TEST_QUERY");

      expect(errors).toHaveLength(0);
    });

    it("rejects bulk query without edges", () => {
      const query = `
        query BulkInner {
          orders {
            id
            name
          }
        }
      `;
      const parsed = parse(query);
      const errors = validateBulkQueryRulesAST(parsed, "TEST_QUERY");

      expect(errors).toHaveLength(1);
      expect(errors[0].message).toContain("should use edges { node { ... } } pattern");
    });

    it("rejects bulk query with edges but no node", () => {
      const query = `
        query BulkInner {
          orders {
            edges {
              cursor
            }
          }
        }
      `;
      const parsed = parse(query);
      const errors = validateBulkQueryRulesAST(parsed, "TEST_QUERY");

      expect(errors).toHaveLength(1);
      expect(errors[0].message).toContain("has 'edges' but missing 'node'");
    });

    it("validates nested connection fields", () => {
      const query = `
        query BulkInner {
          companies {
            edges {
              node {
                id
                companyLocations {
                  edges {
                    node {
                      id
                    }
                  }
                }
              }
            }
          }
        }
      `;
      const parsed = parse(query);
      const errors = validateBulkQueryRulesAST(parsed, "TEST_QUERY");

      expect(errors).toHaveLength(0);
    });

    it("accepts paymentSchedules connection field", () => {
      const query = `
        query BulkInner {
          orders {
            edges {
              node {
                id
                paymentTerms {
                  paymentSchedules {
                    edges {
                      node {
                        id
                        dueAt
                      }
                    }
                  }
                }
              }
            }
          }
        }
      `;
      const parsed = parse(query);
      const errors = validateBulkQueryRulesAST(parsed, "TEST_QUERY");

      expect(errors).toHaveLength(0);
    });

    it("rejects paymentSchedules without edges/node pattern", () => {
      const query = `
        query BulkInner {
          orders {
            edges {
              node {
                id
                paymentTerms {
                  paymentSchedules {
                    id
                    dueAt
                  }
                }
              }
            }
          }
        }
      `;
      const parsed = parse(query);
      const errors = validateBulkQueryRulesAST(parsed, "TEST_QUERY");

      expect(errors).toHaveLength(1);
      expect(errors[0].message).toContain("paymentSchedules");
      expect(errors[0].message).toContain("should use edges { node { ... } } pattern");
    });
  });

  describe("schema validation integration", () => {
    it("validates orders query fields against schema", () => {
      const query = `
        query BulkInner {
          orders {
            edges {
              node {
                id
                name
                createdAt
                processedAt
              }
            }
          }
        }
      `;
      const parsed = parse(query);
      const schemaErrors = validate(schema, parsed);

      expect(schemaErrors).toHaveLength(0);
    });

    it("detects invalid field in orders query", () => {
      const query = `
        query BulkInner {
          orders {
            edges {
              node {
                id
                nonExistentField
              }
            }
          }
        }
      `;
      const parsed = parse(query);
      const schemaErrors = validate(schema, parsed);

      expect(schemaErrors.length).toBeGreaterThan(0);
      expect(schemaErrors[0].message).toContain("Cannot query field");
    });
  });
});
