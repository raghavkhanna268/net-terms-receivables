#!/usr/bin/env node
/**
 * Request timing measurement script
 * Measures wall-clock time for various request types
 */

const BASE_URL = process.env.BASE_URL || 'http://localhost:8787';

async function timeRequest(name, url, options = {}) {
  const start = performance.now();
  try {
    const response = await fetch(url, options);
    const body = await response.text();
    const end = performance.now();
    return {
      name,
      status: response.status,
      time: (end - start).toFixed(2),
      bodySize: body.length
    };
  } catch (error) {
    const end = performance.now();
    return {
      name,
      error: error.message,
      time: (end - start).toFixed(2)
    };
  }
}

async function measureColdStart() {
  console.log('\n=== COLD START MEASUREMENT ===');
  console.log('(First request after wrangler restart)\n');
  
  const result = await timeRequest('Cold GET /', `${BASE_URL}/`);
  console.log(`${result.name}: ${result.time}ms (status: ${result.status})`);
  
  return result;
}

async function measureWarmRequests() {
  console.log('\n=== WARM REQUEST MEASUREMENTS ===');
  console.log('(Average of 10 requests each)\n');

  const endpoints = [
    { name: 'GET /', url: `${BASE_URL}/` },
    { name: 'GET /app', url: `${BASE_URL}/app` },
    { name: 'GET /auth/login', url: `${BASE_URL}/auth/login` },
  ];

  const results = [];

  for (const endpoint of endpoints) {
    const times = [];
    for (let i = 0; i < 10; i++) {
      const result = await timeRequest(endpoint.name, endpoint.url);
      times.push(parseFloat(result.time));
    }
    
    const avg = times.reduce((a, b) => a + b, 0) / times.length;
    const min = Math.min(...times);
    const max = Math.max(...times);
    
    console.log(`${endpoint.name}: avg=${avg.toFixed(2)}ms, min=${min.toFixed(2)}ms, max=${max.toFixed(2)}ms`);
    results.push({ name: endpoint.name, avg, min, max });
  }

  return results;
}

async function measureAuthWithSession() {
  console.log('\n=== AUTH FLOW MEASUREMENT ===');
  
  // POST to auth/login
  const loginResult = await timeRequest('POST /auth/login', `${BASE_URL}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'shop=test-shop.myshopify.com',
    redirect: 'manual'
  });
  console.log(`POST /auth/login: ${loginResult.time}ms (status: ${loginResult.status})`);

  return loginResult;
}

async function measureWebhooks() {
  console.log('\n=== WEBHOOK MEASUREMENT ===');
  
  const webhookResult = await timeRequest('POST /webhooks/app/uninstalled', 
    `${BASE_URL}/webhooks/app/uninstalled`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Topic': 'app/uninstalled',
        'X-Shopify-Hmac-Sha256': 'invalid',
        'X-Shopify-Shop-Domain': 'test.myshopify.com'
      },
      body: JSON.stringify({ shop: 'test.myshopify.com' })
    }
  );
  console.log(`Webhook (invalid HMAC): ${webhookResult.time}ms (status: ${webhookResult.status})`);

  return webhookResult;
}

async function main() {
  console.log('====================================');
  console.log('REQUEST TIMING MEASUREMENTS');
  console.log('====================================');
  console.log(`Base URL: ${BASE_URL}`);

  // Wait for first request to establish connection
  await fetch(`${BASE_URL}/`).catch(() => {});
  
  const results = {
    warm: await measureWarmRequests(),
    auth: await measureAuthWithSession(),
    webhooks: await measureWebhooks(),
  };

  console.log('\n====================================');
  console.log('SUMMARY');
  console.log('====================================');
  console.log('\nTarget: < 10ms CPU for CF Workers Free tier');
  console.log('\nNote: These are local wall-clock times, not actual CPU time.');
  console.log('Real CF CPU time will differ due to network I/O being excluded.\n');

  return results;
}

main().catch(console.error);
