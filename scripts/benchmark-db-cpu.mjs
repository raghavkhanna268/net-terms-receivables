#!/usr/bin/env node
/* eslint-disable no-undef */
/**
 * DB Connection CPU Benchmark
 * 
 * Measures the CPU cost of postgres.js initialization, connection,
 * and query execution. Unlike the production environment, this runs
 * in Node.js without Hyperdrive, so:
 * 
 * - SCRAM-SHA-256 auth happens against the real DB (not Hyperdrive proxy)
 * - No Cloudflare edge caching
 * - Local network latency (not cross-region)
 * 
 * IMPORTANT: These are LOCAL benchmark numbers, not production numbers.
 * Use Cloudflare dashboard for authoritative CPU metrics.
 * 
 * Usage:
 *   node scripts/benchmark-db-cpu.mjs [--iterations N] [--connection-string URL]
 * 
 * Default connection string: postgresql://postgres:password@localhost:5432/net_terms
 */

import postgres from 'postgres';

const args = process.argv.slice(2);
const getArg = (name, defaultValue) => {
  const idx = args.indexOf(`--${name}`);
  return idx >= 0 && args[idx + 1] ? args[idx + 1] : defaultValue;
};

const ITERATIONS = parseInt(getArg('iterations', '10'), 10);
const CONNECTION_STRING = getArg('connection-string', 
  'postgresql://postgres:password@localhost:5432/net_terms');

// CPU time measurement (Node.js process.cpuUsage)
function getCpuTime() {
  const usage = process.cpuUsage();
  return (usage.user + usage.system) / 1000; // Convert to ms
}

function measureCpuDelta(startCpu) {
  return getCpuTime() - startCpu;
}

// Wall time for comparison
function getWallTime() {
  return performance.now();
}

function stats(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const sum = sorted.reduce((a, b) => a + b, 0);
  return {
    min: sorted[0],
    max: sorted[sorted.length - 1],
    avg: sum / sorted.length,
    p50: sorted[Math.floor(sorted.length * 0.5)],
    p90: sorted[Math.floor(sorted.length * 0.9)],
    count: sorted.length,
  };
}

function formatMs(ms) {
  return `${ms.toFixed(2)}ms`;
}

function printStats(label, cpuStats, wallStats) {
  console.log(`\n  ${label}:`);
  console.log(`    CPU Time:  min=${formatMs(cpuStats.min)}  p50=${formatMs(cpuStats.p50)}  p90=${formatMs(cpuStats.p90)}  max=${formatMs(cpuStats.max)}  avg=${formatMs(cpuStats.avg)}`);
  console.log(`    Wall Time: min=${formatMs(wallStats.min)}  p50=${formatMs(wallStats.p50)}  p90=${formatMs(wallStats.p90)}  max=${formatMs(wallStats.max)}  avg=${formatMs(wallStats.avg)}`);
}

async function benchmarkCurrentApproach() {
  console.log('\n  Current approach: createSql per request with full URL parsing');
  
  const cpuTimes = [];
  const wallTimes = [];
  
  for (let i = 0; i < ITERATIONS; i++) {
    const cpuStart = getCpuTime();
    const wallStart = getWallTime();
    
    // This is what the current code does
    const sql = postgres(CONNECTION_STRING, {
      max: 1,
      transform: { undefined: null },
      connect_timeout: 10,
      fetch_types: false,
    });
    
    try {
      // Run a simple query
      await sql`SELECT 1 as test`;
    } finally {
      // Current code calls end()
      await sql.end();
    }
    
    cpuTimes.push(measureCpuDelta(cpuStart));
    wallTimes.push(getWallTime() - wallStart);
  }
  
  return { cpuStats: stats(cpuTimes), wallStats: stats(wallTimes) };
}

async function benchmarkCloudflareRecommended() {
  console.log('\n  Cloudflare recommended: max=5, no explicit end()');
  
  const cpuTimes = [];
  const wallTimes = [];
  
  for (let i = 0; i < ITERATIONS; i++) {
    const cpuStart = getCpuTime();
    const wallStart = getWallTime();
    
    const sql = postgres(CONNECTION_STRING, {
      max: 5,
      transform: { undefined: null },
      connect_timeout: 10,
      fetch_types: false,
      prepare: true,
    });
    
    try {
      await sql`SELECT 1 as test`;
    } finally {
      // Cloudflare docs say not to call end() - but we need to clean up for benchmark
      // In Workers, this is automatic. We'll call it here to avoid connection leaks.
      await sql.end();
    }
    
    cpuTimes.push(measureCpuDelta(cpuStart));
    wallTimes.push(getWallTime() - wallStart);
  }
  
  return { cpuStats: stats(cpuTimes), wallStats: stats(wallTimes) };
}

async function benchmarkRealQuery() {
  console.log('\n  Real query: UPDATE Session SET scope WHERE shop');
  
  const cpuTimes = [];
  const wallTimes = [];
  
  for (let i = 0; i < ITERATIONS; i++) {
    const cpuStart = getCpuTime();
    const wallStart = getWallTime();
    
    const sql = postgres(CONNECTION_STRING, {
      max: 5,
      transform: { undefined: null },
      connect_timeout: 10,
      fetch_types: false,
      prepare: true,
    });
    
    try {
      // Simulate the scopes_update query
      await sql`UPDATE "Session" SET scope = 'test_scope' WHERE shop = 'nonexistent.myshopify.com'`;
    } finally {
      await sql.end();
    }
    
    cpuTimes.push(measureCpuDelta(cpuStart));
    wallTimes.push(getWallTime() - wallStart);
  }
  
  return { cpuStats: stats(cpuTimes), wallStats: stats(wallTimes) };
}

async function benchmarkMultipleQueriesSameConnection() {
  console.log('\n  Multiple queries on same connection');
  
  const cpuTimes = [];
  const wallTimes = [];
  
  for (let i = 0; i < ITERATIONS; i++) {
    const cpuStart = getCpuTime();
    const wallStart = getWallTime();
    
    const sql = postgres(CONNECTION_STRING, {
      max: 5,
      transform: { undefined: null },
      connect_timeout: 10,
      fetch_types: false,
      prepare: true,
    });
    
    try {
      // First query
      await sql`SELECT 1 as test`;
      // Second query (should be faster if prepared statement caching works)
      await sql`SELECT 1 as test`;
      // Third query
      await sql`SELECT 1 as test`;
    } finally {
      await sql.end();
    }
    
    cpuTimes.push(measureCpuDelta(cpuStart));
    wallTimes.push(getWallTime() - wallStart);
  }
  
  return { cpuStats: stats(cpuTimes), wallStats: stats(wallTimes) };
}

async function benchmarkUrlParsingOverhead() {
  console.log('\n  Measuring URL parsing overhead (no DB connection)');
  
  const cpuTimes = [];
  const wallTimes = [];
  
  for (let i = 0; i < ITERATIONS * 10; i++) {
    const cpuStart = getCpuTime();
    const wallStart = getWallTime();
    
    // Just create the client, don't connect
    // This measures parsing overhead
    new URL(CONNECTION_STRING);
    
    cpuTimes.push(measureCpuDelta(cpuStart));
    wallTimes.push(getWallTime() - wallStart);
  }
  
  return { cpuStats: stats(cpuTimes), wallStats: stats(wallTimes) };
}

async function main() {
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('  DB Connection CPU Benchmark (LOCAL - NOT PRODUCTION NUMBERS)');
  console.log('═══════════════════════════════════════════════════════════════\n');
  
  console.log(`Connection: ${CONNECTION_STRING.replace(/:[^:@]+@/, ':****@')}`);
  console.log(`Iterations: ${ITERATIONS}`);
  console.log(`Node.js:    ${process.version}`);
  
  // Check if we can connect
  console.log('\nChecking database connection...');
  try {
    const testSql = postgres(CONNECTION_STRING, { max: 1, connect_timeout: 5 });
    await testSql`SELECT 1`;
    await testSql.end();
    console.log('✓ Database connection OK\n');
  } catch (e) {
    console.error('✗ Database connection failed:', e.message);
    console.error('\nMake sure PostgreSQL is running locally. Try:');
    console.error('  docker run -d -p 5432:5432 -e POSTGRES_PASSWORD=password -e POSTGRES_DB=net_terms postgres:16');
    process.exit(1);
  }
  
  console.log('───────────────────────────────────────────────────────────────');
  console.log('  Benchmark Results');
  console.log('───────────────────────────────────────────────────────────────');
  
  try {
    // Warmup
    console.log('\n  Warmup (3 iterations)...');
    for (let i = 0; i < 3; i++) {
      const sql = postgres(CONNECTION_STRING, { max: 1 });
      await sql`SELECT 1`;
      await sql.end();
    }
    
    const urlParsing = await benchmarkUrlParsingOverhead();
    printStats('URL Parsing Only', urlParsing.cpuStats, urlParsing.wallStats);
    
    const current = await benchmarkCurrentApproach();
    printStats('Current Approach (max=1, with end())', current.cpuStats, current.wallStats);
    
    const recommended = await benchmarkCloudflareRecommended();
    printStats('CF Recommended (max=5, prepare=true)', recommended.cpuStats, recommended.wallStats);
    
    const realQuery = await benchmarkRealQuery();
    printStats('Real UPDATE Query', realQuery.cpuStats, realQuery.wallStats);
    
    const multiple = await benchmarkMultipleQueriesSameConnection();
    printStats('3 Queries Same Connection', multiple.cpuStats, multiple.wallStats);
    
    console.log('\n═══════════════════════════════════════════════════════════════');
    console.log('  Summary');
    console.log('═══════════════════════════════════════════════════════════════');
    console.log('\n  ⚠️  These are LOCAL measurements in Node.js.');
    console.log('  Production Workers with Hyperdrive have different characteristics:');
    console.log('  - Hyperdrive handles SCRAM auth at the edge (no PBKDF2 in Worker)');
    console.log('  - Connection pooling eliminates per-request TCP/TLS setup');
    console.log('  - Single-digit ms p90 connection setup per Cloudflare docs');
    console.log('\n  Use Cloudflare dashboard for authoritative CPU metrics.\n');
    
  } catch (e) {
    console.error('\nBenchmark failed:', e);
    process.exit(1);
  }
}

main().catch(console.error);
