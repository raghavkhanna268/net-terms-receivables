#!/usr/bin/env node
/* eslint-disable no-undef */
/**
 * CPU Breakdown Benchmark
 * 
 * Measures CPU time at each step:
 * 1. Client construction only (URL parse + option merge, no connect)
 * 2. Connect + first query
 * 3. Second query on same client
 * 
 * This helps identify where the ~6ms CPU overhead goes.
 * 
 * IMPORTANT: Local Node.js numbers, not Workers production numbers.
 */

import postgres from 'postgres';

const CONNECTION_STRING = process.env.DATABASE_URL || 
  'postgresql://postgres:password@127.0.0.1:5432/net_terms';

const ITERATIONS = parseInt(process.argv[2] || '100', 10);

function getCpuTime() {
  const usage = process.cpuUsage();
  return (usage.user + usage.system) / 1000; // ms
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
  };
}

function fmt(ms) {
  return ms.toFixed(3) + 'ms';
}

function printStats(label, cpuStats) {
  console.log(`  ${label}:`);
  console.log(`    p50=${fmt(cpuStats.p50)}  p90=${fmt(cpuStats.p90)}  max=${fmt(cpuStats.max)}  avg=${fmt(cpuStats.avg)}`);
}

// Options matching current code (before change)
const optionsBefore = {
  max: 1,
  transform: { undefined: null },
  connect_timeout: 10,
  fetch_types: false,
};

// Options matching Cloudflare recommended (after change)
const optionsAfter = {
  max: 5,
  prepare: true,
  transform: { undefined: null },
  connect_timeout: 10,
  fetch_types: false,
};

async function measureClientConstruction(options, iterations) {
  const cpuTimes = [];
  
  for (let i = 0; i < iterations; i++) {
    const cpuStart = getCpuTime();
    
    // Just construct the client, don't connect or query
    const sql = postgres(CONNECTION_STRING, options);
    
    const cpuEnd = getCpuTime();
    cpuTimes.push(cpuEnd - cpuStart);
    
    // Clean up without measuring
    await sql.end();
  }
  
  return stats(cpuTimes);
}

async function measureConnectPlusFirstQuery(options, iterations) {
  const cpuTimes = [];
  
  for (let i = 0; i < iterations; i++) {
    const cpuStart = getCpuTime();
    
    const sql = postgres(CONNECTION_STRING, options);
    await sql`SELECT 1 as test`;
    
    const cpuEnd = getCpuTime();
    cpuTimes.push(cpuEnd - cpuStart);
    
    // Clean up without measuring
    await sql.end();
  }
  
  return stats(cpuTimes);
}

async function measureSecondQuery(options, iterations) {
  const cpuTimes = [];
  
  for (let i = 0; i < iterations; i++) {
    const sql = postgres(CONNECTION_STRING, options);
    await sql`SELECT 1 as test`; // First query (not measured)
    
    const cpuStart = getCpuTime();
    await sql`SELECT 1 as test`; // Second query (measured)
    const cpuEnd = getCpuTime();
    cpuTimes.push(cpuEnd - cpuStart);
    
    await sql.end();
  }
  
  return stats(cpuTimes);
}

async function measureRealUpdateQuery(options, iterations) {
  const cpuTimes = [];
  
  for (let i = 0; i < iterations; i++) {
    const cpuStart = getCpuTime();
    
    const sql = postgres(CONNECTION_STRING, options);
    // Simulate the scopes_update UPDATE query
    await sql`UPDATE "Session" SET scope = 'test_scope' WHERE shop = 'nonexistent.myshopify.com'`;
    
    const cpuEnd = getCpuTime();
    cpuTimes.push(cpuEnd - cpuStart);
    
    await sql.end();
  }
  
  return stats(cpuTimes);
}

async function measureWithEndCall(options, iterations) {
  const cpuTimes = [];
  
  for (let i = 0; i < iterations; i++) {
    const cpuStart = getCpuTime();
    
    const sql = postgres(CONNECTION_STRING, options);
    await sql`SELECT 1 as test`;
    await sql.end(); // Include end() in measurement
    
    const cpuEnd = getCpuTime();
    cpuTimes.push(cpuEnd - cpuStart);
  }
  
  return stats(cpuTimes);
}

async function measureWithoutEndCall(options, iterations) {
  const cpuTimes = [];
  const clients = [];
  
  for (let i = 0; i < iterations; i++) {
    const cpuStart = getCpuTime();
    
    const sql = postgres(CONNECTION_STRING, options);
    await sql`SELECT 1 as test`;
    // Don't call end() - measure only query
    
    const cpuEnd = getCpuTime();
    cpuTimes.push(cpuEnd - cpuStart);
    clients.push(sql);
  }
  
  // Clean up after measurement
  await Promise.all(clients.map(sql => sql.end()));
  
  return stats(cpuTimes);
}

async function main() {
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('  CPU Breakdown Benchmark (LOCAL NODE.JS - NOT WORKERS PROD)');
  console.log('═══════════════════════════════════════════════════════════════\n');
  
  console.log(`Connection: ${CONNECTION_STRING.replace(/:[^:@]+@/, ':****@')}`);
  console.log(`Iterations: ${ITERATIONS}`);
  console.log(`Node.js:    ${process.version}\n`);
  
  // Verify connection
  console.log('Verifying database connection...');
  try {
    const testSql = postgres(CONNECTION_STRING, { max: 1, connect_timeout: 5 });
    await testSql`SELECT 1`;
    await testSql.end();
    console.log('✓ Database OK\n');
  } catch (e) {
    console.error('✗ Database connection failed:', e.message);
    process.exit(1);
  }
  
  // Warmup
  console.log('Warming up (10 iterations)...');
  for (let i = 0; i < 10; i++) {
    const sql = postgres(CONNECTION_STRING, optionsAfter);
    await sql`SELECT 1`;
    await sql.end();
  }
  
  console.log('\n───────────────────────────────────────────────────────────────');
  console.log('  1. CLIENT CONSTRUCTION ONLY (no connect, no query)');
  console.log('───────────────────────────────────────────────────────────────\n');
  
  console.log('  Testing over', ITERATIONS * 10, 'iterations...\n');
  
  const constructBefore = await measureClientConstruction(optionsBefore, ITERATIONS * 10);
  printStats('Before (max=1)', constructBefore);
  
  const constructAfter = await measureClientConstruction(optionsAfter, ITERATIONS * 10);
  printStats('After (max=5, prepare=true)', constructAfter);
  
  console.log('\n───────────────────────────────────────────────────────────────');
  console.log('  2. CONNECT + FIRST QUERY (full cycle)');
  console.log('───────────────────────────────────────────────────────────────\n');
  
  console.log('  Testing over', ITERATIONS, 'iterations...\n');
  
  const firstQueryBefore = await measureConnectPlusFirstQuery(optionsBefore, ITERATIONS);
  printStats('Before (max=1)', firstQueryBefore);
  
  const firstQueryAfter = await measureConnectPlusFirstQuery(optionsAfter, ITERATIONS);
  printStats('After (max=5, prepare=true)', firstQueryAfter);
  
  console.log('\n───────────────────────────────────────────────────────────────');
  console.log('  3. SECOND QUERY (same connection, statement cached)');
  console.log('───────────────────────────────────────────────────────────────\n');
  
  const secondQueryBefore = await measureSecondQuery(optionsBefore, ITERATIONS);
  printStats('Before (max=1)', secondQueryBefore);
  
  const secondQueryAfter = await measureSecondQuery(optionsAfter, ITERATIONS);
  printStats('After (max=5, prepare=true)', secondQueryAfter);
  
  console.log('\n───────────────────────────────────────────────────────────────');
  console.log('  4. REAL UPDATE QUERY (scopes_update simulation)');
  console.log('───────────────────────────────────────────────────────────────\n');
  
  const updateBefore = await measureRealUpdateQuery(optionsBefore, ITERATIONS);
  printStats('Before (max=1)', updateBefore);
  
  const updateAfter = await measureRealUpdateQuery(optionsAfter, ITERATIONS);
  printStats('After (max=5, prepare=true)', updateAfter);
  
  console.log('\n───────────────────────────────────────────────────────────────');
  console.log('  5. WITH vs WITHOUT sql.end() call');
  console.log('───────────────────────────────────────────────────────────────\n');
  
  const withEnd = await measureWithEndCall(optionsAfter, ITERATIONS);
  printStats('With sql.end()', withEnd);
  
  const withoutEnd = await measureWithoutEndCall(optionsAfter, ITERATIONS);
  printStats('Without sql.end()', withoutEnd);
  
  const endOverhead = withEnd.p50 - withoutEnd.p50;
  console.log(`\n  sql.end() overhead: ~${fmt(endOverhead)} (p50 difference)`);
  
  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('  SUMMARY');
  console.log('═══════════════════════════════════════════════════════════════\n');
  
  console.log('  CPU Breakdown (p50):');
  console.log(`    Client construction:     ${fmt(constructAfter.p50)}`);
  console.log(`    Connect + first query:   ${fmt(firstQueryAfter.p50)}`);
  console.log(`    Second query (cached):   ${fmt(secondQueryAfter.p50)}`);
  console.log(`    sql.end() overhead:      ${fmt(Math.max(0, endOverhead))}`);
  
  const connectOverhead = firstQueryAfter.p50 - constructAfter.p50 - secondQueryAfter.p50;
  console.log(`\n  Estimated connect overhead: ${fmt(Math.max(0, connectOverhead))}`);
  console.log(`  (first query CPU - construction CPU - second query CPU)`);
  
  console.log('\n  ⚠️  These are LOCAL Node.js measurements.');
  console.log('  Workers + Hyperdrive have different characteristics.\n');
}

main().catch(e => {
  console.error('Benchmark failed:', e);
  process.exit(1);
});
