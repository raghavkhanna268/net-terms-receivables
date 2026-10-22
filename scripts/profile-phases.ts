/**
 * Phase-by-phase CPU profiling for the Shopify app.
 * 
 * Measures time for each phase:
 * 1. Module initialization (imports)
 * 2. Prisma/DB client construction
 * 3. shopifyApp singleton access
 * 4. Session storage operations
 * 5. React SSR imports
 * 
 * Usage: npx tsx scripts/profile-phases.ts
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

async function measureAsync<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const start = performance.now();
  const result = await fn();
  const end = performance.now();
  recordPhase(name, end - start);
  return result;
}

async function main() {
  console.log('\n=== Phase-by-phase CPU Profiling (Baseline with Prisma) ===\n');
  
  // Phase 1: Module imports
  console.log('--- Phase 1: Module Imports ---');
  
  const prismaImportStart = performance.now();
  const { PrismaClient } = await import('../app/generated/prisma-node/client');
  const { PrismaPg } = await import('@prisma/adapter-pg');
  recordPhase('import prisma client + adapter', performance.now() - prismaImportStart);

  const shopifyImportStart = performance.now();
  const { getShopifyApp, _resetShopifyAppForTesting } = await import('../app/shopify.server');
  recordPhase('import shopify.server', performance.now() - shopifyImportStart);

  // Phase 2: Prisma client construction
  console.log('\n--- Phase 2: Prisma Client Construction ---');
  
  const connectionString = process.env.TEST_DATABASE_URL || 'postgresql://localhost:5432/test';
  
  const prismaConstructStart = performance.now();
  const adapter = new PrismaPg({ connectionString });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const prisma = new PrismaClient({ adapter }) as any;
  recordPhase('construct PrismaClient', performance.now() - prismaConstructStart);

  // Phase 3: shopifyApp singleton
  console.log('\n--- Phase 3: shopifyApp Singleton ---');
  
  _resetShopifyAppForTesting();
  
  const coldShopifyStart = performance.now();
  getShopifyApp();
  recordPhase('shopifyApp cold', performance.now() - coldShopifyStart);

  const warmShopifyStart = performance.now();
  getShopifyApp();
  recordPhase('shopifyApp warm', performance.now() - warmShopifyStart);

  // Phase 4: Session Storage operations
  console.log('\n--- Phase 4: Session Storage ---');
  
  const { PrismaSessionStorage } = await import('../app/lib/session-storage.server');
  const { Session } = await import('@shopify/shopify-api');
  
  const sessionStorage = new PrismaSessionStorage(() => prisma);
  
  const testSession = new Session({
    id: 'test-session-perf',
    shop: 'test-shop.myshopify.com',
    state: 'test-state',
    isOnline: false,
    accessToken: 'test-token',
    scope: 'read_orders',
    refreshToken: 'test-refresh-token',
    refreshTokenExpires: new Date(Date.now() + 86400000),
  });
  
  if (process.env.TEST_DATABASE_URL) {
    await measureAsync('storeSession', () => sessionStorage.storeSession(testSession));
    await measureAsync('loadSession', () => sessionStorage.loadSession('test-session-perf'));
    await measureAsync('deleteSession', () => sessionStorage.deleteSession('test-session-perf'));
  } else {
    console.log('(Skipping DB operations - TEST_DATABASE_URL not set)');
  }

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
  const outputPath = join(perfDir, `phase-profile-baseline-${Date.now()}.json`);
  writeFileSync(outputPath, JSON.stringify(results, null, 2));
  console.log(`\nResults written to: ${outputPath}`);

  if (process.env.TEST_DATABASE_URL) {
    await prisma.$disconnect();
  }
}

main().catch(console.error);
