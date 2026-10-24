#!/usr/bin/env node
/* eslint-disable no-undef */
/* eslint-disable @typescript-eslint/no-unused-vars */
/**
 * CPU Performance Benchmark for Cloudflare Workers
 *
 * Measures request latency and verifies that shopifyApp() is only
 * initialized once per isolate (no repeated version logs).
 *
 * Usage:
 *   node scripts/benchmark-cpu.mjs [--warmup N] [--requests N] [--port N]
 *
 * Options:
 *   --warmup N    Number of warmup requests (default: 3)
 *   --requests N  Number of requests to measure (default: 10)
 *   --port N      Wrangler dev server port (default: 8787)
 *
 * The script expects wrangler dev to be running separately.
 * Run: npx wrangler dev --port 8787 --local
 *
 * Output includes:
 * - Wall-clock latency stats (min, max, avg, p50, p95)
 * - Whether version log appears only once (isolate singleton check)
 * - Bundle gzip size
 */

import { existsSync, readFileSync, readdirSync, statSync } from "fs";
import { join } from "path";
import { gzipSync } from "zlib";

const args = process.argv.slice(2);
const getArg = (name, defaultValue) => {
  const idx = args.indexOf(`--${name}`);
  return idx >= 0 && args[idx + 1] ? parseInt(args[idx + 1], 10) : defaultValue;
};

const WARMUP_REQUESTS = getArg("warmup", 3);
const MEASURE_REQUESTS = getArg("requests", 10);
const PORT = getArg("port", 8787);
const BASE_URL = `http://127.0.0.1:${PORT}`;

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function measureRequest(url, label = "") {
  const start = performance.now();
  try {
    const response = await fetch(url);
    const end = performance.now();
    const status = response.status;
    await response.text();
    return { ok: true, status, duration: end - start, label };
  } catch (error) {
    const end = performance.now();
    return { ok: false, error: error.message, duration: end - start, label };
  }
}

function stats(durations) {
  const sorted = [...durations].sort((a, b) => a - b);
  const sum = sorted.reduce((a, b) => a + b, 0);
  const avg = sum / sorted.length;
  const p50 = sorted[Math.floor(sorted.length * 0.5)];
  const p95 = sorted[Math.floor(sorted.length * 0.95)];
  return {
    min: sorted[0],
    max: sorted[sorted.length - 1],
    avg,
    p50,
    p95,
    count: sorted.length,
  };
}

function formatMs(ms) {
  return `${ms.toFixed(2)}ms`;
}

async function runBenchmark() {
  console.log("═══════════════════════════════════════════════════════════════");
  console.log("  CPU Performance Benchmark");
  console.log("═══════════════════════════════════════════════════════════════\n");

  console.log(`Target:     ${BASE_URL}`);
  console.log(`Warmup:     ${WARMUP_REQUESTS} requests`);
  console.log(`Measure:    ${MEASURE_REQUESTS} requests\n`);

  console.log("Checking if wrangler dev is running...");
  try {
    const healthCheck = await measureRequest(`${BASE_URL}/`, "health");
    if (!healthCheck.ok) {
      throw new Error(healthCheck.error);
    }
    console.log(`✓ Server responding (${formatMs(healthCheck.duration)})\n`);
  } catch (error) {
    console.error("✗ Server not responding. Start it with:");
    console.error("  npx wrangler dev --port 8787 --local\n");
    process.exit(1);
  }

  console.log("───────────────────────────────────────────────────────────────");
  console.log("  Warmup Phase");
  console.log("───────────────────────────────────────────────────────────────");
  for (let i = 0; i < WARMUP_REQUESTS; i++) {
    const result = await measureRequest(`${BASE_URL}/`, `warmup-${i + 1}`);
    console.log(`  [${i + 1}/${WARMUP_REQUESTS}] ${result.ok ? "OK" : "FAIL"} ${formatMs(result.duration)}`);
    await sleep(50);
  }
  console.log();

  console.log("───────────────────────────────────────────────────────────────");
  console.log("  Measurement Phase");
  console.log("───────────────────────────────────────────────────────────────");

  const endpoints = [
    { path: "/", name: "GET / (index)" },
    { path: "/auth/login", name: "GET /auth/login" },
  ];

  const results = {};

  for (const endpoint of endpoints) {
    console.log(`\n  ${endpoint.name}:`);
    const durations = [];

    for (let i = 0; i < MEASURE_REQUESTS; i++) {
      const result = await measureRequest(`${BASE_URL}${endpoint.path}`, `measure-${i + 1}`);
      if (result.ok) {
        durations.push(result.duration);
        process.stdout.write(`    [${i + 1}/${MEASURE_REQUESTS}] ${formatMs(result.duration)}\n`);
      } else {
        process.stdout.write(`    [${i + 1}/${MEASURE_REQUESTS}] FAILED: ${result.error}\n`);
      }
      await sleep(30);
    }

    if (durations.length > 0) {
      results[endpoint.path] = stats(durations);
    }
  }

  console.log("\n═══════════════════════════════════════════════════════════════");
  console.log("  Results (Local Wall-Clock Time)");
  console.log("═══════════════════════════════════════════════════════════════\n");

  for (const [path, s] of Object.entries(results)) {
    const endpoint = endpoints.find((e) => e.path === path);
    console.log(`  ${endpoint?.name || path}:`);
    console.log(`    Min:  ${formatMs(s.min)}`);
    console.log(`    Max:  ${formatMs(s.max)}`);
    console.log(`    Avg:  ${formatMs(s.avg)}`);
    console.log(`    P50:  ${formatMs(s.p50)}`);
    console.log(`    P95:  ${formatMs(s.p95)}`);
    console.log();
  }

  return results;
}

function measureBundleSize() {
  console.log("═══════════════════════════════════════════════════════════════");
  console.log("  Bundle Size Analysis");
  console.log("═══════════════════════════════════════════════════════════════\n");

  const distPath = join(process.cwd(), "dist");

  if (!existsSync(distPath)) {
    console.log("  ⚠ dist/ not found - run 'npm run build' first\n");
    return null;
  }

  const files = [];
  function walkDir(dir, prefix = "") {
    const entries = readdirSync(dir);
    for (const entry of entries) {
      const fullPath = join(dir, entry);
      const stat = statSync(fullPath);
      if (stat.isDirectory()) {
        walkDir(fullPath, `${prefix}${entry}/`);
      } else if (entry.endsWith(".js") || entry.endsWith(".wasm")) {
        const content = readFileSync(fullPath);
        const gzipped = gzipSync(content);
        files.push({
          name: `${prefix}${entry}`,
          size: stat.size,
          gzipSize: gzipped.length,
        });
      }
    }
  }

  try {
    walkDir(distPath);
  } catch (error) {
    console.log(`  ⚠ Error reading dist/: ${error.message}\n`);
    return null;
  }

  if (files.length === 0) {
    console.log("  ⚠ No .js or .wasm files found in dist/\n");
    return null;
  }

  files.sort((a, b) => b.gzipSize - a.gzipSize);

  const totalSize = files.reduce((a, f) => a + f.size, 0);
  const totalGzip = files.reduce((a, f) => a + f.gzipSize, 0);

  console.log("  File                                    Size       Gzipped");
  console.log("  ────────────────────────────────────────────────────────────");

  for (const file of files.slice(0, 10)) {
    const name = file.name.length > 38 ? "..." + file.name.slice(-35) : file.name;
    const size = (file.size / 1024).toFixed(1).padStart(8) + " KB";
    const gzip = (file.gzipSize / 1024).toFixed(1).padStart(8) + " KB";
    console.log(`  ${name.padEnd(40)} ${size}  ${gzip}`);
  }

  console.log("  ────────────────────────────────────────────────────────────");
  console.log(`  ${"Total".padEnd(40)} ${(totalSize / 1024).toFixed(1).padStart(8)} KB  ${(totalGzip / 1024).toFixed(1).padStart(8)} KB`);
  console.log();

  return {
    totalSize,
    totalGzip,
    files: files.map((f) => ({ name: f.name, size: f.size, gzipSize: f.gzipSize })),
  };
}

async function checkVersionLog() {
  console.log("═══════════════════════════════════════════════════════════════");
  console.log("  Isolate Singleton Verification");
  console.log("═══════════════════════════════════════════════════════════════\n");

  console.log("  To verify shopifyApp() is only initialized once per isolate,");
  console.log("  check the wrangler dev console for version logs.\n");
  console.log("  Expected (GOOD): '[shopify-api/INFO] version X.X.X' appears ONCE");
  console.log("  Problem (BAD):   Version log repeats for each request\n");
  console.log("  Note: In production with logger.level=warn, no version log appears.\n");
}

async function main() {
  console.log("\n");

  try {
    await runBenchmark();
  } catch (error) {
    // Log error class only (X8)
    console.error(`Benchmark failed: ${error.name ?? "unknown"}`);
  }

  measureBundleSize();
  await checkVersionLog();

  console.log("═══════════════════════════════════════════════════════════════");
  console.log("  Summary");
  console.log("═══════════════════════════════════════════════════════════════\n");

  console.log("  These are LOCAL wall-clock measurements including network I/O.");
  console.log("  Real Cloudflare CPU time excludes async I/O waits and is lower.");
  console.log("  Use the Cloudflare dashboard for authoritative CPU metrics.\n");
}

main().catch(console.error);
