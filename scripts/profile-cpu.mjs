#!/usr/bin/env node
/**
 * CPU profiler for Cloudflare Workers using V8 inspector protocol
 * Connects to wrangler dev inspector and captures CPU profiles
 */

import WebSocket from 'ws';
import { writeFileSync, mkdirSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROFILES_DIR = join(__dirname, '../profiles');

mkdirSync(PROFILES_DIR, { recursive: true });

const INSPECTOR_URL = process.env.INSPECTOR_URL || 'ws://localhost:9229/ws';

class CPUProfiler {
  constructor() {
    this.ws = null;
    this.messageId = 0;
    this.pendingMessages = new Map();
  }

  async connect() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(INSPECTOR_URL);
      this.ws.on('open', () => {
        console.log('Connected to inspector');
        resolve();
      });
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

  async send(method, params = {}) {
    const id = ++this.messageId;
    return new Promise((resolve) => {
      this.pendingMessages.set(id, resolve);
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async enableProfiler() {
    await this.send('Profiler.enable');
    console.log('Profiler enabled');
  }

  async startProfiling() {
    await this.send('Profiler.start');
    console.log('Profiling started');
  }

  async stopProfiling() {
    const result = await this.send('Profiler.stop');
    console.log('Profiling stopped');
    return result.result?.profile;
  }

  async profile(name, requestFn) {
    console.log(`\n--- Profiling: ${name} ---`);
    
    await this.startProfiling();
    
    const startTime = Date.now();
    await requestFn();
    const endTime = Date.now();
    
    const profile = await this.stopProfiling();
    
    if (profile) {
      const filename = `${name.replace(/[^a-zA-Z0-9]/g, '_')}_${Date.now()}.cpuprofile`;
      const filepath = join(PROFILES_DIR, filename);
      writeFileSync(filepath, JSON.stringify(profile, null, 2));
      console.log(`Profile saved to: ${filepath}`);
      console.log(`Wall time: ${endTime - startTime}ms`);
      
      // Analyze top functions
      this.analyzeProfile(profile, name);
    }
    
    return { wallTime: endTime - startTime, profile };
  }

  analyzeProfile(profile, name) {
    if (!profile || !profile.nodes) return;

    const nodes = profile.nodes;
    const samples = profile.samples || [];
    const timeDeltas = profile.timeDeltas || [];
    
    // Calculate total time
    const totalTime = timeDeltas.reduce((sum, d) => sum + d, 0);
    
    // Calculate time per node
    const nodeTime = new Map();
    samples.forEach((nodeId, idx) => {
      const delta = timeDeltas[idx] || 0;
      nodeTime.set(nodeId, (nodeTime.get(nodeId) || 0) + delta);
    });

    // Group by function/module
    const byFunction = new Map();
    nodes.forEach(node => {
      const time = nodeTime.get(node.id) || 0;
      if (time > 0) {
        const url = node.callFrame?.url || '(native)';
        const funcName = node.callFrame?.functionName || '(anonymous)';
        const key = `${funcName} @ ${url}`;
        byFunction.set(key, (byFunction.get(key) || 0) + time);
      }
    });

    // Sort and display top functions
    const sorted = [...byFunction.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 20);

    console.log(`\nTop functions in ${name} (total: ${totalTime}µs):`);
    sorted.forEach(([func, time], i) => {
      const pct = ((time / totalTime) * 100).toFixed(1);
      console.log(`  ${i + 1}. ${(time / 1000).toFixed(2)}ms (${pct}%) - ${func.slice(0, 80)}`);
    });

    // Group by module
    const byModule = new Map();
    nodes.forEach(node => {
      const time = nodeTime.get(node.id) || 0;
      if (time > 0) {
        const url = node.callFrame?.url || '(native)';
        let module = '(native)';
        if (url.includes('node_modules')) {
          const match = url.match(/node_modules\/(@[^/]+\/[^/]+|[^/]+)/);
          if (match) module = match[1];
        } else if (url.includes('/app/')) {
          module = 'app/*';
        } else if (url.includes('prisma')) {
          module = 'prisma';
        } else if (url.includes('react')) {
          module = 'react';
        } else if (url.includes('shopify')) {
          module = 'shopify';
        } else if (url.includes('wasm')) {
          module = 'wasm';
        } else if (url) {
          module = url.split('/').pop() || url;
        }
        byModule.set(module, (byModule.get(module) || 0) + time);
      }
    });

    const sortedModules = [...byModule.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 15);

    console.log(`\nCPU time by module:`);
    sortedModules.forEach(([mod, time]) => {
      const pct = ((time / totalTime) * 100).toFixed(1);
      console.log(`  ${(time / 1000).toFixed(2)}ms (${pct}%) - ${mod}`);
    });
  }

  close() {
    if (this.ws) {
      this.ws.close();
    }
  }
}

async function makeRequest(url, options = {}) {
  const response = await fetch(url, options);
  const body = await response.text();
  return { status: response.status, body };
}

async function main() {
  const profiler = new CPUProfiler();
  
  try {
    await profiler.connect();
    await profiler.enableProfiler();
    
    const baseUrl = process.env.BASE_URL || 'http://localhost:8787';
    
    console.log('\n========================================');
    console.log('CPU PROFILING SESSION');
    console.log('========================================');

    // 1. Cold start profile - already warmed, so skip
    
    // 2. Warm GET /
    await profiler.profile('warm_GET_root', async () => {
      for (let i = 0; i < 5; i++) {
        await makeRequest(`${baseUrl}/`);
      }
    });

    // 3. Warm GET / (single request for cleaner profile)
    await profiler.profile('single_GET_root', async () => {
      await makeRequest(`${baseUrl}/`);
    });

    // 4. GET /app (will fail auth but shows auth overhead)
    await profiler.profile('GET_app_no_session', async () => {
      await makeRequest(`${baseUrl}/app`);
    });

    // 5. GET /auth/login
    await profiler.profile('GET_auth_login', async () => {
      await makeRequest(`${baseUrl}/auth/login`);
    });

    // 6. POST /auth/login with shop
    await profiler.profile('POST_auth_login', async () => {
      await makeRequest(`${baseUrl}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'shop=test-shop.myshopify.com'
      });
    });

    // 7. Webhook POST (no valid HMAC, will fail early)
    await profiler.profile('POST_webhook_uninstalled', async () => {
      await makeRequest(`${baseUrl}/webhooks/app/uninstalled`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Shopify-Topic': 'app/uninstalled',
          'X-Shopify-Hmac-Sha256': 'invalid',
          'X-Shopify-Shop-Domain': 'test.myshopify.com'
        },
        body: JSON.stringify({ shop: 'test.myshopify.com' })
      });
    });

    console.log('\n========================================');
    console.log('PROFILING COMPLETE');
    console.log(`Profiles saved to: ${PROFILES_DIR}`);
    console.log('========================================');
    
  } catch (error) {
    console.error('Profiling error:', error);
  } finally {
    profiler.close();
  }
}

main().catch(console.error);
