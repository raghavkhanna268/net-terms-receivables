#!/usr/bin/env node
/**
 * Baseline CPU measurement script
 * Records timing for various request types to establish baseline performance
 */

import { writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const RESULTS_DIR = join(__dirname, '../perf-results');
mkdirSync(RESULTS_DIR, { recursive: true });

const BASE_URL = process.env.BASE_URL || 'http://localhost:8787';

async function timeRequest(url, options = {}) {
  const start = performance.now();
  try {
    const response = await fetch(url, { 
      ...options,
      redirect: 'manual' // Don't follow redirects
    });
    const body = await response.text();
    const end = performance.now();
    return {
      time: end - start,
      status: response.status,
      bodySize: body.length,
    };
  } catch (error) {
    return { time: performance.now() - start, error: error.message };
  }
}

async function measureEndpoint(name, url, options = {}, iterations = 20) {
  // Warmup
  for (let i = 0; i < 3; i++) {
    await timeRequest(url, options);
  }

  // Measure
  const times = [];
  for (let i = 0; i < iterations; i++) {
    const result = await timeRequest(url, options);
    if (!result.error) {
      times.push(result.time);
    }
  }

  const sorted = times.sort((a, b) => a - b);
  const avg = times.reduce((a, b) => a + b, 0) / times.length;
  const p50 = sorted[Math.floor(times.length * 0.5)];
  const p95 = sorted[Math.floor(times.length * 0.95)];
  const p99 = sorted[Math.floor(times.length * 0.99)];
  const min = sorted[0];
  const max = sorted[sorted.length - 1];

  return { name, iterations: times.length, avg, p50, p95, p99, min, max };
}

async function main() {
  console.log('='.repeat(60));
  console.log('BASELINE CPU PERFORMANCE MEASUREMENT');
  console.log('='.repeat(60));
  console.log(`\nBase URL: ${BASE_URL}`);
  console.log('Measuring 20 iterations per endpoint (after 3 warmup)\n');

  const results = {
    timestamp: new Date().toISOString(),
    baseUrl: BASE_URL,
    note: 'Local wall-clock times (ms). Real CF CPU excludes I/O wait.',
    endpoints: [],
  };

  // Measure each endpoint
  const endpoints = [
    { name: 'GET /', url: `${BASE_URL}/` },
    { name: 'GET /app', url: `${BASE_URL}/app` },
    { name: 'GET /auth/login', url: `${BASE_URL}/auth/login` },
    { 
      name: 'POST /auth/login', 
      url: `${BASE_URL}/auth/login`,
      options: {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'shop=test-shop.myshopify.com',
      }
    },
    { 
      name: 'POST /webhooks/app/uninstalled',
      url: `${BASE_URL}/webhooks/app/uninstalled`,
      options: {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Shopify-Topic': 'app/uninstalled',
          'X-Shopify-Hmac-Sha256': 'invalid',
          'X-Shopify-Shop-Domain': 'test.myshopify.com',
        },
        body: JSON.stringify({ shop: 'test.myshopify.com' }),
      }
    },
  ];

  for (const endpoint of endpoints) {
    const result = await measureEndpoint(
      endpoint.name,
      endpoint.url,
      endpoint.options || {}
    );
    results.endpoints.push(result);
    
    console.log(`${endpoint.name}:`);
    console.log(`  avg: ${result.avg.toFixed(2)}ms, p50: ${result.p50.toFixed(2)}ms, p95: ${result.p95.toFixed(2)}ms`);
    console.log(`  min: ${result.min.toFixed(2)}ms, max: ${result.max.toFixed(2)}ms`);
    console.log();
  }

  // Save results
  const filename = `baseline_${Date.now()}.json`;
  writeFileSync(join(RESULTS_DIR, filename), JSON.stringify(results, null, 2));
  console.log(`\nResults saved to: ${RESULTS_DIR}/${filename}`);

  // Print summary table
  console.log('\n' + '='.repeat(60));
  console.log('SUMMARY TABLE (all times in ms, local wall-clock)');
  console.log('='.repeat(60));
  console.log('\n| Endpoint | Avg | P50 | P95 | Min | Max |');
  console.log('|----------|-----|-----|-----|-----|-----|');
  for (const r of results.endpoints) {
    console.log(`| ${r.name.padEnd(30)} | ${r.avg.toFixed(1).padStart(5)} | ${r.p50.toFixed(1).padStart(5)} | ${r.p95.toFixed(1).padStart(5)} | ${r.min.toFixed(1).padStart(5)} | ${r.max.toFixed(1).padStart(5)} |`);
  }
  console.log();

  return results;
}

main().catch(console.error);
