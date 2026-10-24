/**
 * Build output test: verify xlsx is NOT in server/Worker bundle.
 *
 * xlsx (~1MB) must stay client-only via parse.client.ts dynamic import.
 * This test runs against the built artifacts to catch any bundler config
 * or import path changes that would pull xlsx into the server.
 *
 * IMPORTANT: In CI, this test FAILS if dist/ is absent.
 * Locally, it skips gracefully to allow running tests without building.
 * Run `npm run build` before running tests locally to verify the bundle.
 */

import { describe, it, expect } from "vitest";
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";

const DIST_SERVER_DIR = join(process.cwd(), "dist/server/assets");

/**
 * Check if we're running in CI (GitHub Actions, etc.)
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
      if (isCI()) {
        throw new Error(
          "FAIL: dist/server not found in CI. " +
          "This test must run after `npm run build`. " +
          "Ensure the build step runs before tests in CI workflow."
        );
      }
      console.log("Skipping: dist/server not found. Run `npm run build` first.");
      return;
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
      if (isCI()) {
        throw new Error(
          "FAIL: dist/server not found in CI. " +
          "This test must run after `npm run build`. " +
          "Ensure the build step runs before tests in CI workflow."
        );
      }
      console.log("Skipping: dist/server not found. Run `npm run build` first.");
      return;
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
      if (isCI()) {
        throw new Error(
          "FAIL: dist/client not found in CI. " +
          "This test must run after `npm run build`."
        );
      }
      console.log("Skipping: dist/client not found. Run `npm run build` first.");
      return;
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
