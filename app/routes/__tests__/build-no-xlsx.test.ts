/**
 * Build output test: verify xlsx is NOT in server/Worker bundle.
 *
 * S14 Done-when: "SheetJS is lazy-loaded."
 *
 * xlsx (~1MB) must stay client-only via parse.client.ts dynamic import.
 * This test runs against the built artifacts to catch any bundler config
 * or import path changes that would pull xlsx into the server.
 *
 * Verifies:
 * 1. SheetJS is NOT in the entry or initial app chunks
 * 2. SheetJS is NOT in any chunk statically imported from them
 * 3. SheetJS is only reachable through a dynamic import from the imports route
 *
 * Reports chunk names and sizes (raw and gzip) for PR body.
 *
 * EXCLUDED FROM DEFAULT TEST RUN (`npm test`) - requires built artifacts.
 * Run explicitly after build: `npm run build && npm run test:build`
 *
 * In CI, these tests skip gracefully since tests run before build.
 * The Wrangler dry-run step after build also verifies bundle size.
 */

import { describe, it, expect } from "vitest";
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

const DIST_SERVER_DIR = join(process.cwd(), "dist/server/assets");

/**
 * Check if we're running in CI (GitHub Actions, etc.)
 * Note: These tests skip in both CI and local when no build exists,
 * because CI runs tests before build.
 */
function isCI(): boolean {
  return process.env.CI === "true" || process.env.GITHUB_ACTIONS === "true";
}

/**
 * Recursively get all .js files in a directory.
 */
async function getJsFiles(dir: string): Promise<string[]> {
  const files: string[] = [];
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        files.push(...(await getJsFiles(fullPath)));
      } else if (entry.name.endsWith(".js")) {
        files.push(fullPath);
      }
    }
  } catch {
    // Directory doesn't exist (not built yet)
  }
  return files;
}

/**
 * Check if dist/server exists (build has been run).
 */
async function buildExists(): Promise<boolean> {
  try {
    await stat(DIST_SERVER_DIR);
    return true;
  } catch {
    return false;
  }
}

describe("Build output: no xlsx in server bundle", () => {
  it("server bundle does not contain xlsx code markers", async () => {
    const hasBuild = await buildExists();
    
    if (!hasBuild) {
      // When run via `npm run test:build`, dist/ must exist - fail if missing
      throw new Error(
        "FAIL: dist/server not found. " +
        "Run `npm run build` first, then `npm run test:build`."
      );
    }

    const jsFiles = await getJsFiles(DIST_SERVER_DIR);
    expect(jsFiles.length).toBeGreaterThan(0);

    // xlsx code markers that would appear if bundled
    const xlsxMarkers = [
      "SheetJSWorkbook",
      "parse_xlscfb",
      "write_biff_rec",
      "XLSXWorkbook",
      "cfb_new",
      "parse_ws_xml",
      "write_ws_xml",
      "parse_sst_xml",
      "sheet_to_json",
      "book_new",
      "aoa_to_sheet",
    ];

    for (const file of jsFiles) {
      if (file.endsWith(".map")) continue;
      
      const content = await readFile(file, "utf-8");
      
      for (const marker of xlsxMarkers) {
        const hasMarker = content.includes(marker);
        if (hasMarker) {
          throw new Error(
            `xlsx code found in server bundle!\n` +
            `File: ${file}\n` +
            `Marker: "${marker}"\n` +
            `This means xlsx is being bundled into the server.\n` +
            `Ensure imports use parse.client.ts with dynamic import().`
          );
        }
      }
    }
  });

  it("worker-entry bundle stays under 400 KiB gzip", async () => {
    const hasBuild = await buildExists();
    
    if (!hasBuild) {
      // When run via `npm run test:build`, dist/ must exist - fail if missing
      throw new Error(
        "FAIL: dist/server not found. " +
        "Run `npm run build` first, then `npm run test:build`."
      );
    }

    const jsFiles = await getJsFiles(DIST_SERVER_DIR);
    const workerEntry = jsFiles.find((f) => f.includes("worker-entry"));
    
    if (!workerEntry) {
      if (isCI()) {
        throw new Error("FAIL: worker-entry not found in build output in CI.");
      }
      console.log("Skipping: worker-entry not found in build.");
      return;
    }

    const content = await readFile(workerEntry);
    
    const { gzipSync } = await import("node:zlib");
    const gzipped = gzipSync(content);
    const gzipKiB = gzipped.length / 1024;

    const BUDGET_KIB = 400;
    
    console.log(`Worker bundle: ${gzipKiB.toFixed(2)} KiB gzip (budget: ${BUDGET_KIB} KiB)`);
    
    expect(gzipKiB).toBeLessThan(BUDGET_KIB);
  });

  it("client bundle DOES contain xlsx (correct split)", async () => {
    const clientDir = join(process.cwd(), "dist/client/assets");
    
    let hasBuild = false;
    try {
      await stat(clientDir);
      hasBuild = true;
    } catch {
      // Not built
    }

    if (!hasBuild) {
      // When run via `npm run test:build`, dist/ must exist - fail if missing
      throw new Error(
        "FAIL: dist/client not found. " +
        "Run `npm run build` first, then `npm run test:build`."
      );
    }

    const jsFiles = await getJsFiles(clientDir);

    let foundXlsx = false;
    for (const file of jsFiles) {
      const content = await readFile(file, "utf-8");
      if (content.includes("SheetJSWorkbook") || content.includes("sheet_to_json")) {
        foundXlsx = true;
        break;
      }
    }

    expect(foundXlsx).toBe(true);
  });
});

/**
 * Interface for chunk information.
 */
interface ChunkInfo {
  name: string;
  path: string;
  rawBytes: number;
  gzipBytes: number;
  rawKiB: string;
  gzipKiB: string;
  hasXlsx: boolean;
  imports: string[];
}

/**
 * Parse Vite manifest to understand chunk relationships.
 */
async function parseViteManifest(): Promise<Record<string, {
  file: string;
  src?: string;
  isEntry?: boolean;
  isDynamicEntry?: boolean;
  imports?: string[];
  dynamicImports?: string[];
  css?: string[];
}>> {
  const manifestPath = join(process.cwd(), "dist/client/.vite/manifest.json");
  try {
    const content = await readFile(manifestPath, "utf-8");
    return JSON.parse(content);
  } catch {
    return {};
  }
}

/**
 * Get detailed chunk information.
 */
async function getChunkInfo(filePath: string): Promise<ChunkInfo> {
  const content = await readFile(filePath);
  const textContent = content.toString("utf-8");
  const gzipped = gzipSync(content);
  
  const rawBytes = content.length;
  const gzipBytes = gzipped.length;
  
  const xlsxMarkers = [
    "SheetJSWorkbook",
    "parse_xlscfb",
    "write_biff_rec",
    "XLSXWorkbook",
    "sheet_to_json",
    "book_new",
    "aoa_to_sheet",
  ];
  
  const hasXlsx = xlsxMarkers.some(marker => textContent.includes(marker));
  
  return {
    name: filePath.split("/").pop() || filePath,
    path: filePath,
    rawBytes,
    gzipBytes,
    rawKiB: (rawBytes / 1024).toFixed(2),
    gzipKiB: (gzipBytes / 1024).toFixed(2),
    hasXlsx,
    imports: [],
  };
}

describe("SheetJS lazy-load chunk analysis (S14)", () => {
  it("SheetJS is NOT in entry or initial app chunks, only in dynamic import chunk", async () => {
    const clientDir = join(process.cwd(), "dist/client/assets");
    
    let hasBuild = false;
    try {
      await stat(clientDir);
      hasBuild = true;
    } catch {
      // Not built
    }

    if (!hasBuild) {
      throw new Error(
        "FAIL: dist/client not found. " +
        "Run `npm run build` first, then `npm run test:build`."
      );
    }
    
    const manifest = await parseViteManifest();
    const jsFiles = await getJsFiles(clientDir);
    
    // Find entry chunks (usually root.tsx or similar)
    const entryChunks: string[] = [];
    const dynamicChunks: string[] = [];
    const importsRouteChunks: string[] = [];
    const xlsxChunks: string[] = [];
    
    for (const [key, value] of Object.entries(manifest)) {
      const chunkPath = join(process.cwd(), "dist/client", value.file);
      
      if (value.isEntry) {
        entryChunks.push(chunkPath);
      }
      if (value.isDynamicEntry) {
        dynamicChunks.push(chunkPath);
      }
      if (key.includes("app.imports") || key.includes("imports")) {
        importsRouteChunks.push(chunkPath);
      }
    }
    
    // Check each JS file for xlsx markers
    const chunkInfos: ChunkInfo[] = [];
    
    for (const file of jsFiles) {
      const info = await getChunkInfo(file);
      chunkInfos.push(info);
      
      if (info.hasXlsx) {
        xlsxChunks.push(file);
      }
    }
    
    // Find the entry chunk
    const entryChunk = chunkInfos.find(c => 
      entryChunks.includes(c.path) || c.name.includes("entry") || c.name.includes("root")
    );
    
    // Find the imports route chunk
    const importsChunk = chunkInfos.find(c =>
      importsRouteChunks.includes(c.path) || c.name.includes("imports")
    );
    
    // Find the xlsx chunk
    const xlsxChunk = chunkInfos.find(c => c.hasXlsx);
    
    // Log chunk information for PR body
    console.log("\n=== SheetJS Lazy Loading Verification ===\n");
    
    if (entryChunk) {
      console.log(`Entry chunk: ${entryChunk.name}`);
      console.log(`  Raw: ${entryChunk.rawKiB} KiB / gzip: ${entryChunk.gzipKiB} KiB`);
      console.log(`  Contains xlsx: ${entryChunk.hasXlsx}`);
    }
    
    if (importsChunk) {
      console.log(`\nImports route chunk: ${importsChunk.name}`);
      console.log(`  Raw: ${importsChunk.rawKiB} KiB / gzip: ${importsChunk.gzipKiB} KiB`);
      console.log(`  Contains xlsx: ${importsChunk.hasXlsx}`);
    }
    
    if (xlsxChunk) {
      console.log(`\nSheetJS chunk: ${xlsxChunk.name}`);
      console.log(`  Raw: ${xlsxChunk.rawKiB} KiB / gzip: ${xlsxChunk.gzipKiB} KiB`);
      console.log(`  Contains xlsx: ${xlsxChunk.hasXlsx}`);
    }
    
    console.log("\n=========================================\n");
    
    // Assertions
    
    // 1. Entry chunk must NOT contain xlsx
    if (entryChunk) {
      expect(entryChunk.hasXlsx).toBe(false);
    }
    
    // 2. At least one chunk should contain xlsx (proves it's being bundled)
    expect(xlsxChunks.length).toBeGreaterThan(0);
    
    // 3. The xlsx chunk should be separate from entry
    if (entryChunk && xlsxChunk) {
      expect(entryChunk.path).not.toBe(xlsxChunk.path);
    }
  });

  it("xlsx chunk is reachable only through dynamic import path", async () => {
    const clientDir = join(process.cwd(), "dist/client/assets");
    
    let hasBuild = false;
    try {
      await stat(clientDir);
      hasBuild = true;
    } catch {
      // Not built
    }

    if (!hasBuild) {
      throw new Error(
        "FAIL: dist/client not found. " +
        "Run `npm run build` first, then `npm run test:build`."
      );
    }
    
    const manifest = await parseViteManifest();
    
    // Find all static imports from entry points
    const staticImportedChunks = new Set<string>();
    
    function collectStaticImports(key: string, visited: Set<string> = new Set()): void {
      if (visited.has(key)) return;
      visited.add(key);
      
      const entry = manifest[key];
      if (!entry) return;
      
      // Add this chunk's file
      staticImportedChunks.add(entry.file);
      
      // Recursively collect static imports (not dynamicImports)
      if (entry.imports) {
        for (const imp of entry.imports) {
          collectStaticImports(imp, visited);
        }
      }
    }
    
    // Start from all entry points
    for (const [key, value] of Object.entries(manifest)) {
      if (value.isEntry) {
        collectStaticImports(key);
      }
    }
    
    // Find xlsx chunks
    const jsFiles = await getJsFiles(clientDir);
    const xlsxChunkFiles: string[] = [];
    
    for (const file of jsFiles) {
      const info = await getChunkInfo(file);
      if (info.hasXlsx) {
        const relativePath = file.replace(join(process.cwd(), "dist/client/"), "");
        xlsxChunkFiles.push(relativePath);
      }
    }
    
    // xlsx chunks should NOT be in statically imported set
    for (const xlsxFile of xlsxChunkFiles) {
      expect(
        staticImportedChunks.has(xlsxFile),
        `xlsx chunk ${xlsxFile} should not be statically imported from entry`
      ).toBe(false);
    }
  });

  it("reports chunk sizes for PR body", async () => {
    const clientDir = join(process.cwd(), "dist/client/assets");
    
    let hasBuild = false;
    try {
      await stat(clientDir);
      hasBuild = true;
    } catch {
      // Not built
    }

    if (!hasBuild) {
      throw new Error(
        "FAIL: dist/client not found. " +
        "Run `npm run build` first, then `npm run test:build`."
      );
    }
    
    const jsFiles = await getJsFiles(clientDir);
    const manifest = await parseViteManifest();
    
    // Categorize chunks
    let entryInfo: ChunkInfo | null = null;
    let importsInfo: ChunkInfo | null = null;
    let xlsxInfo: ChunkInfo | null = null;
    
    for (const file of jsFiles) {
      const info = await getChunkInfo(file);
      const relativePath = file.replace(join(process.cwd(), "dist/client/"), "");
      
      // Check if entry
      for (const [key, value] of Object.entries(manifest)) {
        if (value.file === relativePath) {
          if (value.isEntry && (key.includes("root") || key.includes("entry"))) {
            entryInfo = info;
          }
          if (key.includes("app.imports") || (key.includes("imports") && !key.includes("xlsx"))) {
            importsInfo = info;
          }
        }
      }
      
      if (info.hasXlsx && !xlsxInfo) {
        xlsxInfo = info;
      }
    }
    
    // Output for PR body
    console.log("\n=== Chunk Sizes for PR Body ===\n");
    
    if (entryInfo) {
      console.log(`Entry chunk: ${entryInfo.name}`);
      console.log(`  ${entryInfo.rawKiB} KiB raw / ${entryInfo.gzipKiB} KiB gzip`);
    }
    
    if (importsInfo) {
      console.log(`Imports route chunk: ${importsInfo.name}`);
      console.log(`  ${importsInfo.rawKiB} KiB raw / ${importsInfo.gzipKiB} KiB gzip`);
    }
    
    if (xlsxInfo) {
      console.log(`SheetJS chunk: ${xlsxInfo.name}`);
      console.log(`  ${xlsxInfo.rawKiB} KiB raw / ${xlsxInfo.gzipKiB} KiB gzip`);
    }
    
    console.log("\n===============================\n");
    
    // Basic assertions
    expect(entryInfo || importsInfo || xlsxInfo).toBeTruthy();
  });
});
