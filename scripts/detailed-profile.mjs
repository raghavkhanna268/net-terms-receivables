#!/usr/bin/env node
/**
 * Detailed CPU analysis script
 * Breaks down CPU time by component
 */

import WebSocket from 'ws';
import { writeFileSync, mkdirSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROFILES_DIR = join(__dirname, '../profiles');
const INSPECTOR_URL = 'ws://localhost:9229/ws';

mkdirSync(PROFILES_DIR, { recursive: true });

class DetailedProfiler {
  constructor() {
    this.ws = null;
    this.messageId = 0;
    this.pendingMessages = new Map();
  }

  async connect() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(INSPECTOR_URL);
      this.ws.on('open', () => resolve());
      this.ws.on('error', reject);
      this.ws.on('message', (data) => {
        const msg = JSON.parse(data.toString());
        if (msg.id && this.pendingMessages.has(msg.id)) {
          this.pendingMessages.get(msg.id)(msg);
          this.pendingMessages.delete(msg.id);
        }
      });
    });
  }

  send(method, params = {}) {
    const id = ++this.messageId;
    return new Promise((resolve) => {
      this.pendingMessages.set(id, resolve);
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async enableProfiler() {
    await this.send('Profiler.enable');
    await this.send('Profiler.setSamplingInterval', { interval: 100 }); // 100µs sampling
  }

  async profile(name, fn) {
    await this.send('Profiler.start');
    const start = performance.now();
    await fn();
    const elapsed = performance.now() - start;
    const result = await this.send('Profiler.stop');
    
    const profile = result.result?.profile;
    if (profile) {
      const filename = `detailed_${name}_${Date.now()}.cpuprofile`;
      writeFileSync(join(PROFILES_DIR, filename), JSON.stringify(profile, null, 2));
      
      return { elapsed, profile, filename };
    }
    return { elapsed, profile: null };
  }

  analyzeByCategory(profile) {
    if (!profile?.nodes) return {};

    const categories = {
      'React SSR': 0,
      'React Router': 0,
      'Shopify API': 0,
      'Prisma': 0,
      'Sentry': 0,
      'WASM': 0,
      'Native/V8': 0,
      'Other': 0,
    };

    const nodeTime = new Map();
    const samples = profile.samples || [];
    const timeDeltas = profile.timeDeltas || [];
    
    samples.forEach((nodeId, idx) => {
      nodeTime.set(nodeId, (nodeTime.get(nodeId) || 0) + (timeDeltas[idx] || 0));
    });

    for (const node of profile.nodes) {
      const time = nodeTime.get(node.id) || 0;
      if (time === 0) continue;

      const url = node.callFrame?.url || '';
      const funcName = node.callFrame?.functionName || '';
      const combined = `${funcName} ${url}`.toLowerCase();

      if (combined.includes('rendertoreadablestream') || combined.includes('react-dom')) {
        categories['React SSR'] += time;
      } else if (combined.includes('react-router') || combined.includes('useroutes') || combined.includes('matchpath')) {
        categories['React Router'] += time;
      } else if (combined.includes('shopify')) {
        categories['Shopify API'] += time;
      } else if (combined.includes('prisma') || combined.includes('query_compiler')) {
        categories['Prisma'] += time;
      } else if (combined.includes('sentry')) {
        categories['Sentry'] += time;
      } else if (combined.includes('wasm')) {
        categories['WASM'] += time;
      } else if (url === '(native)' || url === '' || funcName.includes('idle')) {
        categories['Native/V8'] += time;
      } else {
        categories['Other'] += time;
      }
    }

    return categories;
  }

  close() {
    this.ws?.close();
  }
}

async function makeRequest(url, options = {}) {
  return fetch(url, options).then(r => r.text());
}

async function main() {
  const profiler = new DetailedProfiler();
  const BASE_URL = 'http://localhost:8787';

  try {
    await profiler.connect();
    await profiler.enableProfiler();

    console.log('\n=================================================');
    console.log('DETAILED CPU BREAKDOWN BY COMPONENT');
    console.log('=================================================\n');

    // Warm up with a few requests
    for (let i = 0; i < 3; i++) {
      await makeRequest(`${BASE_URL}/`);
    }

    const results = [];

    // Profile single requests
    const endpoints = [
      { name: 'GET_root', url: `${BASE_URL}/`, method: 'GET' },
      { name: 'GET_app', url: `${BASE_URL}/app`, method: 'GET' },
      { name: 'GET_auth_login', url: `${BASE_URL}/auth/login`, method: 'GET' },
    ];

    for (const endpoint of endpoints) {
      // Run multiple samples
      const allCategories = [];
      
      for (let i = 0; i < 5; i++) {
        const { elapsed, profile } = await profiler.profile(`${endpoint.name}_${i}`, async () => {
          await makeRequest(endpoint.url, { method: endpoint.method });
        });

        if (profile) {
          const categories = profiler.analyzeByCategory(profile);
          allCategories.push({ elapsed, categories });
        }
      }

      // Average the results
      if (allCategories.length > 0) {
        const avgCategories = {};
        const keys = Object.keys(allCategories[0].categories);
        for (const key of keys) {
          const values = allCategories.map(c => c.categories[key]);
          avgCategories[key] = values.reduce((a, b) => a + b, 0) / values.length;
        }
        
        const avgElapsed = allCategories.reduce((a, c) => a + c.elapsed, 0) / allCategories.length;
        
        results.push({
          endpoint: endpoint.name,
          avgElapsedMs: avgElapsed.toFixed(2),
          categories: avgCategories,
        });
      }
    }

    // Print results
    for (const result of results) {
      console.log(`\n--- ${result.endpoint} (avg ${result.avgElapsedMs}ms wall time) ---`);
      
      const total = Object.values(result.categories).reduce((a, b) => a + b, 0);
      const sorted = Object.entries(result.categories)
        .filter(([_, time]) => time > 0)
        .sort((a, b) => b[1] - a[1]);

      for (const [category, time] of sorted) {
        const pct = total > 0 ? ((time / total) * 100).toFixed(1) : 0;
        console.log(`  ${category.padEnd(15)}: ${(time / 1000).toFixed(2)}ms (${pct}%)`);
      }
      console.log(`  ${'TOTAL'.padEnd(15)}: ${(total / 1000).toFixed(2)}ms`);
    }

    // Save summary
    const summary = {
      timestamp: new Date().toISOString(),
      note: 'Times are local profiling, not actual CF CPU time',
      results,
    };
    writeFileSync(
      join(PROFILES_DIR, `summary_${Date.now()}.json`),
      JSON.stringify(summary, null, 2)
    );

    console.log('\n=================================================');
    console.log('ANALYSIS COMPLETE');
    console.log(`Profiles saved to: ${PROFILES_DIR}`);
    console.log('=================================================\n');

  } finally {
    profiler.close();
  }
}

main().catch(console.error);
