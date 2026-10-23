/**
 * Spreadsheet loader for bank statements.
 * Lazy-loads parsers to avoid bloating the main bundle.
 *
 * Part of S14/S15: Net Terms Receivables bank statement parsing.
 *
 * Supported formats:
 * - XLSX (.xlsx, .xlsm) - via datareader-excel (~5KB)
 * - XLS (.xls) - via xls-reader (~4KB)
 * - CSV (.csv) - built-in parser
 * - Delimited text (.txt) - built-in parser
 *
 * Parser choice rationale:
 * - datareader-excel: Zero dependencies, browser-safe, read-only, ~5KB gzipped.
 *   Uses Web APIs (DecompressionStream, TextDecoder). Handles dates correctly.
 * - xls-reader: Zero dependencies, ~3.8KB gzipped, handles legacy BIFF8 format.
 *   Required for HDFC which exports .xls (not .xlsx).
 * - Built-in CSV: Simple parser, no dependency needed for comma/tab delimited.
 */

import type { SheetData, FileType } from "./types.js";

/**
 * Detect file type from filename and/or content.
 */
export function detectFileType(fileName: string, content?: ArrayBuffer): FileType {
  const ext = fileName.toLowerCase().split(".").pop();

  // Check by extension first
  switch (ext) {
    case "xlsx":
    case "xlsm":
      return "xlsx";
    case "xls":
      return "xls";
    case "csv":
      return "csv";
    case "txt":
      return "txt";
  }

  // If no clear extension, try to detect from content magic bytes
  if (content && content.byteLength >= 4) {
    const bytes = new Uint8Array(content, 0, 4);

    // XLSX/XLSM are ZIP files: starts with PK (0x50 0x4B)
    if (bytes[0] === 0x50 && bytes[1] === 0x4b) {
      return "xlsx";
    }

    // XLS (BIFF): starts with 0xD0 0xCF 0x11 0xE0
    if (bytes[0] === 0xd0 && bytes[1] === 0xcf && bytes[2] === 0x11 && bytes[3] === 0xe0) {
      return "xls";
    }
  }

  // Default to CSV for unknown text files
  return "csv";
}

/**
 * Load a spreadsheet file and return parsed sheet data.
 * Lazy-loads the appropriate parser.
 *
 * @param content File content as ArrayBuffer
 * @param fileType File type
 * @param sheetIndex Sheet index to parse (default: 0)
 * @returns Parsed sheet data
 */
export async function loadSpreadsheet(
  content: ArrayBuffer,
  fileType: FileType,
  sheetIndex: number = 0
): Promise<SheetData> {
  switch (fileType) {
    case "xlsx":
      return loadXlsx(content, sheetIndex);
    case "xls":
      return loadXls(content, sheetIndex);
    case "csv":
      return loadCsv(content, ",");
    case "txt":
      return loadCsv(content, "\t");
    default:
      throw new Error(`Unsupported file type: ${fileType}`);
  }
}

/**
 * Load XLSX file using datareader-excel.
 * Dynamically imported to enable tree-shaking.
 */
async function loadXlsx(content: ArrayBuffer, sheetIndex: number): Promise<SheetData> {
  // Dynamic import for lazy loading
  const { readXlsx } = await import("datareader-excel");

  const { sheets } = await readXlsx(content);

  if (sheets.length === 0) {
    throw new Error("No sheets found in XLSX file");
  }

  const idx = Math.min(sheetIndex, sheets.length - 1);
  const sheet = sheets[idx];

  return {
    name: sheet.name,
    rows: sheet.rows.map((row) =>
      row.map((cell) => {
        // Normalize cell values
        if (cell === null || cell === undefined) return null;
        if (typeof cell === "boolean") return cell;
        if (cell instanceof Date) return cell;
        if (typeof cell === "number") return cell;
        return String(cell);
      })
    ),
  };
}

/**
 * Load XLS file using xls-reader.
 * Dynamically imported to enable tree-shaking.
 */
async function loadXls(content: ArrayBuffer, sheetIndex: number): Promise<SheetData> {
  // Dynamic import for lazy loading
  const { readXls } = await import("xls-reader");

  const workbook = readXls(new Uint8Array(content));

  if (!workbook.sheets || workbook.sheets.length === 0) {
    throw new Error("No sheets found in XLS file");
  }

  const idx = Math.min(sheetIndex, workbook.sheets.length - 1);
  const sheet = workbook.sheets[idx];

  return {
    name: sheet.name || `Sheet${idx + 1}`,
    rows: sheet.rows.map((row) =>
      row.map((cell) => {
        if (cell === null || cell === undefined) return null;
        if (typeof cell === "boolean") return cell;
        if (cell instanceof Date) return cell;
        if (typeof cell === "number") return cell;
        return String(cell);
      })
    ),
  };
}

/**
 * Load CSV/delimited text file.
 * Built-in parser, no external dependency.
 */
async function loadCsv(content: ArrayBuffer, delimiter: string): Promise<SheetData> {
  const text = new TextDecoder("utf-8").decode(content);
  const rows = parseCsv(text, delimiter);

  return {
    name: "Sheet1",
    rows,
  };
}

/**
 * Parse CSV text with proper handling of quoted fields.
 */
function parseCsv(
  text: string,
  delimiter: string
): (string | number | Date | boolean | null)[][] {
  const rows: (string | number | Date | boolean | null)[][] = [];
  const lines = text.split(/\r?\n/);

  for (const line of lines) {
    if (!line.trim()) continue;

    const row: (string | number | Date | boolean | null)[] = [];
    let current = "";
    let inQuotes = false;
    let i = 0;

    while (i < line.length) {
      const char = line[i];

      if (char === '"') {
        if (inQuotes && line[i + 1] === '"') {
          // Escaped quote
          current += '"';
          i += 2;
        } else {
          // Toggle quote state
          inQuotes = !inQuotes;
          i++;
        }
      } else if (char === delimiter && !inQuotes) {
        // Field separator
        row.push(parseCell(current.trim()));
        current = "";
        i++;
      } else {
        current += char;
        i++;
      }
    }

    // Don't forget the last field
    row.push(parseCell(current.trim()));
    rows.push(row);
  }

  return rows;
}

/**
 * Parse a CSV cell value to appropriate type.
 */
function parseCell(value: string): string | number | Date | boolean | null {
  if (!value) return null;

  // Remove surrounding quotes
  if (value.startsWith('"') && value.endsWith('"')) {
    value = value.slice(1, -1);
  }

  // Check for boolean
  const lower = value.toLowerCase();
  if (lower === "true") return true;
  if (lower === "false") return false;

  // Check for number (but not Indian formatted numbers with commas)
  // Only convert if it's a simple number without Indian grouping
  if (value.match(/^-?\d+\.?\d*$/) && !value.includes(",")) {
    const num = parseFloat(value);
    if (!isNaN(num)) return num;
  }

  return value;
}

/**
 * Get sheet names from a spreadsheet file.
 * Useful for showing a sheet selector UI.
 */
export async function getSheetNames(content: ArrayBuffer, fileType: FileType): Promise<string[]> {
  switch (fileType) {
    case "xlsx": {
      const { readXlsx } = await import("datareader-excel");
      const { sheets } = await readXlsx(content);
      return sheets.map((s) => s.name);
    }
    case "xls": {
      const { readXls } = await import("xls-reader");
      const workbook = readXls(new Uint8Array(content));
      return (workbook.sheets || []).map((s, i: number) => s.name || `Sheet${i + 1}`);
    }
    default:
      return ["Sheet1"];
  }
}
