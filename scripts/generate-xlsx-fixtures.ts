/**
 * Generate XLSX synthetic test fixtures from CSV data.
 * Run with: npx tsx scripts/generate-xlsx-fixtures.ts
 *
 * Creates XLSX versions of the synthetic CSV fixtures for testing
 * XLS/XLSX parsing support in the bank statement parser.
 */

import * as XLSX from "xlsx";
import { readFileSync, writeFileSync } from "fs";
import { join } from "path";

const FIXTURES_DIR = join(process.cwd(), "tests/fixtures/banks/synthetic");

/**
 * Parse CSV content into array of arrays, handling quoted fields.
 */
function parseCSV(content: string): string[][] {
  const lines: string[][] = [];
  let currentLine: string[] = [];
  let currentField = "";
  let inQuotes = false;

  for (let i = 0; i < content.length; i++) {
    const char = content[i];
    const nextChar = content[i + 1];

    if (inQuotes) {
      if (char === '"' && nextChar === '"') {
        currentField += '"';
        i++;
      } else if (char === '"') {
        inQuotes = false;
      } else {
        currentField += char;
      }
    } else {
      if (char === '"') {
        inQuotes = true;
      } else if (char === ",") {
        currentLine.push(currentField);
        currentField = "";
      } else if (char === "\n" || (char === "\r" && nextChar === "\n")) {
        currentLine.push(currentField);
        if (currentLine.some((f) => f.trim())) {
          lines.push(currentLine);
        }
        currentLine = [];
        currentField = "";
        if (char === "\r") i++;
      } else if (char !== "\r") {
        currentField += char;
      }
    }
  }

  if (currentField || currentLine.length > 0) {
    currentLine.push(currentField);
    if (currentLine.some((f) => f.trim())) {
      lines.push(currentLine);
    }
  }

  return lines;
}

/**
 * Convert CSV file to XLSX.
 */
function csvToXlsx(csvPath: string, xlsxPath: string, sheetName: string = "Sheet1"): void {
  const csvContent = readFileSync(csvPath, "utf-8");
  const rows = parseCSV(csvContent);

  const worksheet = XLSX.utils.aoa_to_sheet(rows);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, sheetName);

  const xlsxBuffer = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" });
  writeFileSync(xlsxPath, xlsxBuffer);

  console.log(`Created: ${xlsxPath}`);
}

// Generate XLSX fixtures
const fixtures = [
  { csv: "hdfc-retail-synthetic.csv", xlsx: "hdfc-retail-synthetic.xlsx", sheet: "Statement" },
  { csv: "icici-retail-synthetic.csv", xlsx: "icici-retail-synthetic.xlsx", sheet: "Statement" },
  { csv: "hdfc-malformed-synthetic.csv", xlsx: "hdfc-malformed-synthetic.xlsx", sheet: "Statement" },
  { csv: "icici-malformed-synthetic.csv", xlsx: "icici-malformed-synthetic.xlsx", sheet: "Statement" },
];

for (const fixture of fixtures) {
  csvToXlsx(
    join(FIXTURES_DIR, fixture.csv),
    join(FIXTURES_DIR, fixture.xlsx),
    fixture.sheet
  );
}

console.log("\nAll XLSX fixtures generated successfully.");
