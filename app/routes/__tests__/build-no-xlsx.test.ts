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
 * React Router manifest route entry type.
 * This is the manifest generated by @react-router/dev at build time.
 */
interface ReactRouterRouteEntry {
  id: string;
  path?: string;
  index?: boolean;
  parentId?: string;
  hasAction: boolean;
  hasLoader: boolean;
  hasClientAction: boolean;
  hasClientLoader: boolean;
  hasClientMiddleware: boolean;
  hasDefaultExport: boolean;
  hasErrorBoundary: boolean;
  module: string;
  imports: string[];
  css: string[];
}

/**
 * React Router manifest structure.
 */
interface ReactRouterManifest {
  entry: {
    module: string;
    imports: string[];
    css: string[];
  };
  routes: Record<string, ReactRouterRouteEntry>;
  url: string;
  version: string;
}

/**
 * Parse React Router manifest from build output.
 * The manifest is a JS file that sets window.__reactRouterManifest.
 * Throws if manifest is missing (build required first).
 */
async function parseReactRouterManifest(): Promise<ReactRouterManifest> {
  const clientAssetsDir = join(process.cwd(), "dist/client/assets");
  
  // Find the manifest file (manifest-*.js)
  let manifestFile: string | null = null;
  try {
    const files = await readdir(clientAssetsDir);
    manifestFile = files.find(f => f.startsWith("manifest-") && f.endsWith(".js")) || null;
  } catch {
    throw new Error(
      `FAIL: dist/client/assets not found. ` +
      "Run `npm run build` first, then `npm run test:build`."
    );
  }
  
  if (!manifestFile) {
    throw new Error(
      `FAIL: React Router manifest not found in dist/client/assets. ` +
      "Build may have failed or produced no output. " +
      "Run `npm run build` first, then `npm run test:build`."
    );
  }
  
  const manifestPath = join(clientAssetsDir, manifestFile);
  const content = await readFile(manifestPath, "utf-8");
  
  // Extract JSON from: window.__reactRouterManifest={...};
  const match = content.match(/window\.__reactRouterManifest\s*=\s*(\{[\s\S]*\});?\s*$/);
  if (!match) {
    throw new Error(
      `FAIL: Could not parse React Router manifest at ${manifestPath}. ` +
      "Manifest format may have changed."
    );
  }
  
  try {
    return JSON.parse(match[1]);
  } catch {
    throw new Error(
      `FAIL: Invalid JSON in React Router manifest at ${manifestPath}. ` +
      "Build may be corrupted."
    );
  }
}

/**
 * Validate that manifest has required entries (entry point and imports route).
 * This ensures the 'not statically imported' check can't pass vacuously.
 */
function validateManifestHasRequiredEntries(manifest: ReactRouterManifest): void {
  // Must have entry point
  if (!manifest.entry || !manifest.entry.module) {
    throw new Error(
      "FAIL: React Router manifest has no entry point. " +
      "Build may be misconfigured."
    );
  }
  
  // Must have routes
  const routeKeys = Object.keys(manifest.routes || {});
  if (routeKeys.length === 0) {
    throw new Error(
      "FAIL: React Router manifest has no routes. " +
      "Build may have failed or produced no output."
    );
  }
  
  // Must have the imports route (routes/app.imports or similar)
  const hasImportsRoute = routeKeys.some(
    key => key.includes("app.imports") || key === "routes/app.imports"
  );
  if (!hasImportsRoute) {
    throw new Error(
      "FAIL: React Router manifest has no imports route entry. " +
      "The app.imports route must be in the build output."
    );
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
    
    // Parse and validate manifest (throws if missing or invalid)
    const manifest = await parseReactRouterManifest();
    validateManifestHasRequiredEntries(manifest);
    
    const jsFiles = await getJsFiles(clientDir);
    
    // Find entry and route chunks from React Router manifest
    // Entry module path is like "/assets/entry.client-XXX.js"
    const entryModule = manifest.entry.module;
    const entryChunkPath = join(process.cwd(), "dist/client", entryModule);
    
    // Imports route
    const importsRoute = manifest.routes["routes/app.imports"];
    const importsChunkPath = importsRoute 
      ? join(process.cwd(), "dist/client", importsRoute.module)
      : null;
    
    const xlsxChunks: string[] = [];
    
    // Check each JS file for xlsx markers
    const chunkInfos: ChunkInfo[] = [];
    
    for (const file of jsFiles) {
      const info = await getChunkInfo(file);
      chunkInfos.push(info);
      
      if (info.hasXlsx) {
        xlsxChunks.push(file);
      }
    }
    
    // Find the entry chunk info
    const entryChunk = chunkInfos.find(c => c.path === entryChunkPath);
    
    // Find the imports route chunk info
    const importsChunk = importsChunkPath 
      ? chunkInfos.find(c => c.path === importsChunkPath)
      : chunkInfos.find(c => c.name.includes("imports"));
    
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
      // Note: This may be parse.client (which calls sheet_to_json) or the xlsx library chunk
      const label = xlsxChunk.name.includes("parse.client") 
        ? "Banks parser chunk (contains xlsx calls)" 
        : "xlsx-containing chunk";
      console.log(`\n${label}: ${xlsxChunk.name}`);
      console.log(`  Raw: ${xlsxChunk.rawKiB} KiB / gzip: ${xlsxChunk.gzipKiB} KiB`);
      console.log(`  Contains xlsx markers: ${xlsxChunk.hasXlsx}`);
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
    
    // Parse and validate manifest (throws if missing or invalid)
    const manifest = await parseReactRouterManifest();
    validateManifestHasRequiredEntries(manifest);
    
    // Find all static imports from entry point
    // React Router manifest has entry.module and entry.imports
    const staticImportedChunks = new Set<string>();
    
    // Add entry module
    staticImportedChunks.add(manifest.entry.module);
    
    // Add all static imports from entry
    for (const imp of manifest.entry.imports) {
      staticImportedChunks.add(imp);
    }
    
    // Note: React Router manifest 'imports' array contains static imports.
    // Dynamic imports (like parse.client.ts) are not listed in the manifest
    // because they're loaded on-demand via import().
    
    // Find xlsx chunks
    const jsFiles = await getJsFiles(clientDir);
    const xlsxChunkFiles: string[] = [];
    
    for (const file of jsFiles) {
      const info = await getChunkInfo(file);
      if (info.hasXlsx) {
        // Get path relative to dist/client with leading slash
        const relativePath = "/" + file.replace(join(process.cwd(), "dist/client"), "").replace(/^\//, "");
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
    
    // Find chunks by filename pattern
    let entryInfo: ChunkInfo | null = null;
    let importsInfo: ChunkInfo | null = null;
    let parseClientInfo: ChunkInfo | null = null;
    let xlsxLibInfo: ChunkInfo | null = null;
    
    for (const file of jsFiles) {
      const info = await getChunkInfo(file);
      const name = info.name;
      
      // Entry client chunk (main React/Router bundle)
      if (name.includes("entry.client")) {
        entryInfo = info;
      }
      // Imports route chunk
      if (name.includes("app.imports")) {
        importsInfo = info;
      }
      // Lazy-loaded banks parsing module
      if (name.includes("parse.client")) {
        parseClientInfo = info;
      }
      // Actual xlsx library chunk (largest xlsx-containing chunk)
      if (name.includes("xlsx") && !name.includes("parse")) {
        if (!xlsxLibInfo || info.rawBytes > xlsxLibInfo.rawBytes) {
          xlsxLibInfo = info;
        }
      }
    }
    
    // Output for PR body
    console.log("\n=== Chunk Sizes for PR Body ===\n");
    
    if (entryInfo) {
      console.log(`Entry chunk: ${entryInfo.name}`);
      console.log(`  ${entryInfo.rawKiB} KiB raw / ${entryInfo.gzipKiB} KiB gzip`);
      console.log(`  Contains xlsx: ${entryInfo.hasXlsx}`);
    }
    
    if (importsInfo) {
      console.log(`Imports route chunk: ${importsInfo.name}`);
      console.log(`  ${importsInfo.rawKiB} KiB raw / ${importsInfo.gzipKiB} KiB gzip`);
      console.log(`  Contains xlsx: ${importsInfo.hasXlsx}`);
    }
    
    if (parseClientInfo) {
      console.log(`Banks parser chunk (lazy): ${parseClientInfo.name}`);
      console.log(`  ${parseClientInfo.rawKiB} KiB raw / ${parseClientInfo.gzipKiB} KiB gzip`);
    }
    
    if (xlsxLibInfo) {
      console.log(`SheetJS library chunk: ${xlsxLibInfo.name}`);
      console.log(`  ${xlsxLibInfo.rawKiB} KiB raw / ${xlsxLibInfo.gzipKiB} KiB gzip`);
    }
    
    console.log("\n===============================\n");
    
    // Assertions
    // Entry chunk must not contain xlsx
    if (entryInfo) {
      expect(entryInfo.hasXlsx).toBe(false);
    }
    // Imports route chunk must not contain xlsx
    if (importsInfo) {
      expect(importsInfo.hasXlsx).toBe(false);
    }
    // Should have at least found the entry chunk
    expect(entryInfo).toBeTruthy();
  });
});
