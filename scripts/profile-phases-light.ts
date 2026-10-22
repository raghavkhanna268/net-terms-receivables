/**
 * Phase-by-phase CPU profiling for the Shopify app with postgres.js session storage.
 * 
 * Usage: npx tsx scripts/profile-phases-light.ts
 */

import { performance } from 'node:perf_hooks';
import { existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, '..');

// Set up required env vars for Shopify app
process.env.SHOPIFY_API_KEY = process.env.SHOPIFY_API_KEY || 'test-api-key';
process.env.SHOPIFY_API_SECRET = process.env.SHOPIFY_API_SECRET || 'test-api-secret';
process.env.SHOPIFY_APP_URL = process.env.SHOPIFY_APP_URL || 'https://test.example.com';
process.env.SCOPES = process.env.SCOPES || 'read_orders';

interface PhaseResult {
  duration_ms: number;
}

interface Results {
  timestamp: string;
  phases: Record<string, PhaseResult>;
  totals: Record<string, number>;
}

const results: Results = {
  timestamp: new Date().toISOString(),
  phases: {},
  totals: {},
};

function recordPhase(name: string, duration: number): void {
  results.phases[name] = { duration_ms: parseFloat(duration.toFixed(3)) };
  console.log(`[${name}] ${duration.toFixed(3)}ms`);
}

async function main() {
  console.log('\n=== Phase-by-phase CPU Profiling (After: postgres.js) ===\n');
  
  // Phase 1: Module imports
  console.log('--- Phase 1: Module Imports ---');
  
  const postgresImportStart = performance.now();
  await import('postgres');
  recordPhase('import postgres.js', performance.now() - postgresImportStart);

  const shopifyImportStart = performance.now();
  const { getShopifyApp, _resetShopifyAppForTesting } = await import('../app/shopify.server');
  recordPhase('import shopify.server (with LightSessionStorage)', performance.now() - shopifyImportStart);

  // Phase 2: SQL client construction
  console.log('\n--- Phase 2: SQL Client Construction ---');
  
  const connectionString = process.env.TEST_DATABASE_URL || 'postgresql://localhost:5432/test';
  
  const { default: postgres } = await import('postgres');
  const sqlConstructStart = performance.now();
  const sql = postgres(connectionString, { max: 1 });
  recordPhase('construct postgres.js client', performance.now() - sqlConstructStart);

  // Phase 3: shopifyApp singleton
  console.log('\n--- Phase 3: shopifyApp Singleton ---');
  
  _resetShopifyAppForTesting();
  
  const coldShopifyStart = performance.now();
  getShopifyApp();
  recordPhase('shopifyApp cold', performance.now() - coldShopifyStart);

  const warmShopifyStart = performance.now();
  getShopifyApp();
  recordPhase('shopifyApp warm', performance.now() - warmShopifyStart);

  // Phase 4: Session Storage imports (no DB operations)
  console.log('\n--- Phase 4: Session Storage ---');
  
  const storageImportStart = performance.now();
  const { LightSessionStorage } = await import('../app/lib/session-storage-light.server');
  recordPhase('import LightSessionStorage', performance.now() - storageImportStart);

  // Phase 5: React SSR imports
  console.log('\n--- Phase 5: React SSR Imports ---');
  
  const reactImportStart = performance.now();
  await import('react-dom/server');
  await import('react-router');
  recordPhase('import react-dom/server + react-router', performance.now() - reactImportStart);

  // Summary
  console.log('\n=== Summary ===\n');
  
  let total = 0;
  for (const data of Object.values(results.phases)) {
    total += data.duration_ms;
  }
  results.totals.all_phases_ms = parseFloat(total.toFixed(3));
  
  console.log(`Total measured time: ${total.toFixed(3)}ms`);
  console.log('\nPhase breakdown:');
  for (const [phase, data] of Object.entries(results.phases)) {
    const pct = ((data.duration_ms / total) * 100).toFixed(1);
    console.log(`  ${phase}: ${data.duration_ms}ms (${pct}%)`);
  }

  // Write results to file
  const perfDir = join(rootDir, 'perf-results');
  if (!existsSync(perfDir)) {
    mkdirSync(perfDir, { recursive: true });
  }
  const outputPath = join(perfDir, `phase-profile-light-${Date.now()}.json`);
  writeFileSync(outputPath, JSON.stringify(results, null, 2));
  console.log(`\nResults written to: ${outputPath}`);

  await sql.end();
}

main().catch(console.error);
