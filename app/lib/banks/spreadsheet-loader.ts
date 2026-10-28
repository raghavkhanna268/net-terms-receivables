/**
 * Spreadsheet loader for bank statements.
 * Lazy-loads SheetJS to avoid bloating the main bundle.
 *
 * Part of S14/S15: Net Terms Receivables bank statement parsing.
 *
 * Supported formats:
 * - XLSX (.xlsx, .xlsm) - via SheetJS
 * - XLS (.xls) - via SheetJS (BIFF8 format, common HDFC export)
 * - CSV (.csv) - via SheetJS (handles quoted multi-line fields)
 * - Delimited text (.txt) - via SheetJS
 *
 * Library:
 * - SheetJS Community Edition 0.20.3 from official CDN
 * - Source: https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz
 * - NOT using npm xlsx@0.18.5 which has known CVEs
 *
 * Why SheetJS:
 * - Handles XLS (BIFF8) which HDFC commonly exports
 * - Handles XLSX
 * - Handles CSV with proper quoted field support (multi-line, commas in values)
 * - Well-maintained, widely used, official CDN distribution
 * - Single dependency for all formats
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
 * Lazy-loads SheetJS for all formats.
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
  // Use SheetJS for all formats - it handles CSV quoted fields properly
  return loadWithSheetJS(content, fileType, sheetIndex);
}

/**
 * Load file using SheetJS.
 * Dynamically imported to enable tree-shaking and lazy loading.
 *
 * SheetJS 0.20.3 from official CDN (not npm xlsx@0.18.5 with CVEs).
 */
async function loadWithSheetJS(
  content: ArrayBuffer,
  fileType: FileType,
  sheetIndex: number
): Promise<SheetData> {
  // Dynamic import for lazy loading - keeps SheetJS out of main bundle
  const XLSX = await import("xlsx");

  const isTextFormat = fileType === "csv" || fileType === "txt";

  // Options for reading
  // For CSV/TXT: raw:true keeps all values as strings (no type guessing)
  // This preserves leading zeros (000123), prevents scientific notation (123456789012),
  // and keeps date strings verbatim (05/03/2026 stays as "05/03/2026")
  // For XLSX/XLS: cellDates:true parses Excel dates, cellText:true keeps formatted text
  const readOptions: Parameters<typeof XLSX.read>[1] = {
    type: "array",
    raw: isTextFormat, // CSV/TXT: no type guessing; XLSX/XLS: parse types
    cellDates: !isTextFormat, // Only for XLSX/XLS
    cellText: !isTextFormat, // Keep formatted text for XLSX/XLS (for refs with leading zeros)
    cellNF: false,
  };

  const workbook = XLSX.read(content, readOptions);

  if (!workbook.SheetNames || workbook.SheetNames.length === 0) {
    throw new Error("No sheets found in spreadsheet file");
  }

  const idx = Math.min(sheetIndex, workbook.SheetNames.length - 1);
  const sheetName = workbook.SheetNames[idx];
  const sheet = workbook.Sheets[sheetName];

  // Convert sheet to array of arrays
  // For CSV/TXT: raw:true keeps strings as-is
  // For XLSX/XLS: raw:true preserves numeric types (for Excel serial dates) and Date objects;
  // text cells with leading zeros are preserved as strings
  const toJsonOptions: Parameters<typeof XLSX.utils.sheet_to_json>[1] = {
    header: 1,
    raw: true, // Always use raw values to preserve numbers and Date objects
    defval: null,
  };

  const rows = XLSX.utils.sheet_to_json<(string | number | Date | boolean | null)[]>(
    sheet,
    toJsonOptions
  );

  return {
    name: sheetName,
    rows: rows.map((row) =>
      row.map((cell) => {
        if (cell === null || cell === undefined) return null;
        if (typeof cell === "boolean") return cell;

        // Handle Date objects (XLSX/XLS only - CSV returns strings)
        if (cell instanceof Date) {
          if (isNaN(cell.getTime())) return null;
          // Return the Date object; the normaliser will use UTC getters
          return cell;
        }

        if (typeof cell === "number") return cell;
        return String(cell);
      })
    ),
  };
}

/**
 * Get sheet names from a spreadsheet file.
 * Useful for showing a sheet selector UI.
 */
export async function getSheetNames(content: ArrayBuffer, _fileType: FileType): Promise<string[]> {
  const XLSX = await import("xlsx");

  const readOptions: Parameters<typeof XLSX.read>[1] = {
    type: "array",
    bookSheets: true, // Only read sheet names, not data
  };

  const workbook = XLSX.read(content, readOptions);
  return workbook.SheetNames || [];
}
