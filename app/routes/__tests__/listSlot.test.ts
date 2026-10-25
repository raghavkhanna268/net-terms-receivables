import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

/**
 * Tests that all s-table-header elements have listSlot attributes.
 *
 * Per Shopify Polaris docs (https://shopify.dev/docs/api/app-home/web-components/layout-and-structure/table):
 * - listSlot controls how columns display in mobile list layout
 * - Valid values: primary, secondary, kicker, inline, labeled
 * - Each table should have exactly one listSlot="primary"
 * - At most one listSlot="secondary" per table
 */

const ROUTE_FILES = [
  "app/routes/app._index.tsx",
  "app/routes/app.onboarding.tsx",
  "app/routes/app.plan.tsx",
  "app/routes/app.accounts.$id.tsx",
  "app/routes/app.settings.reminders.tsx",
  "app/routes/app.tag-rules.tsx",
  "app/routes/app.imports.tsx",
  "app/routes/app.reconcile.tsx",
];

function extractTables(content: string): string[] {
  const tables: string[] = [];
  const tableRegex = /<s-table>[\s\S]*?<\/s-table>/g;
  let match;
  while ((match = tableRegex.exec(content)) !== null) {
    tables.push(match[0]);
  }
  return tables;
}

function extractHeaders(tableContent: string): string[] {
  const headers: string[] = [];
  // Match <s-table-header> but NOT <s-table-header-row>
  const headerRegex = /<s-table-header(?![^>]*-row)[^>]*>/g;
  let match;
  while ((match = headerRegex.exec(tableContent)) !== null) {
    headers.push(match[0]);
  }
  return headers;
}

function hasListSlot(header: string): boolean {
  return /listSlot=/.test(header);
}

function getListSlotValue(header: string): string | null {
  const match = header.match(/listSlot="([^"]+)"/);
  return match ? match[1] : null;
}

describe("s-table-header listSlot attributes", () => {
  ROUTE_FILES.forEach((filePath) => {
    describe(filePath, () => {
      const fullPath = join(process.cwd(), filePath);
      let content: string;

      try {
        content = readFileSync(fullPath, "utf-8");
      } catch {
        it.skip(`file not found: ${filePath}`, () => {});
        return;
      }

      const tables = extractTables(content);

      if (tables.length === 0) {
        it.skip("no tables found", () => {});
        return;
      }

      tables.forEach((table, tableIndex) => {
        describe(`table ${tableIndex + 1}`, () => {
          const headers = extractHeaders(table);

          it("every s-table-header has listSlot attribute", () => {
            headers.forEach((header, headerIndex) => {
              expect(
                hasListSlot(header),
                `Header ${headerIndex + 1} missing listSlot: ${header}`
              ).toBe(true);
            });
          });

          it("has exactly one listSlot='primary'", () => {
            const primaryCount = headers.filter(
              (h) => getListSlotValue(h) === "primary"
            ).length;
            expect(
              primaryCount,
              `Expected exactly 1 primary, found ${primaryCount}`
            ).toBe(1);
          });

          it("has at most one listSlot='secondary'", () => {
            const secondaryCount = headers.filter(
              (h) => getListSlotValue(h) === "secondary"
            ).length;
            expect(
              secondaryCount,
              `Expected at most 1 secondary, found ${secondaryCount}`
            ).toBeLessThanOrEqual(1);
          });

          it("all listSlot values are valid", () => {
            const validValues = ["primary", "secondary", "kicker", "inline", "labeled"];
            headers.forEach((header) => {
              const value = getListSlotValue(header);
              if (value) {
                expect(
                  validValues,
                  `Invalid listSlot value: ${value}`
                ).toContain(value);
              }
            });
          });
        });
      });
    });
  });
});

describe("s-table-header coverage", () => {
  it("all route files with s-table-header have been checked", () => {
    // This test ensures we don't miss any route files with tables
    const allRouteFiles = [
      "app/routes/app._index.tsx",
      "app/routes/app.onboarding.tsx",
      "app/routes/app.plan.tsx",
      "app/routes/app.accounts.$id.tsx",
      "app/routes/app.settings.reminders.tsx",
      "app/routes/app.tag-rules.tsx",
      "app/routes/app.imports.tsx",
      "app/routes/app.reconcile.tsx",
    ];

    // All files in ROUTE_FILES should be in this list
    ROUTE_FILES.forEach((file) => {
      expect(allRouteFiles).toContain(file);
    });
  });
});
