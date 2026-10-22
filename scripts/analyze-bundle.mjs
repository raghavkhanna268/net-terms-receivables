#!/usr/bin/env node
/**
 * Bundle size analyzer
 * Analyzes the Worker bundle to understand size contributors
 */

import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';

const DIST_DIR = '/workspace/dist/server/assets';

function analyzeBundleContent(filePath) {
  const content = readFileSync(filePath, 'utf-8');
  const lines = content.split('\n');
  
  // Find imports and module boundaries
  const modulePatterns = {
    'react': /from\s*["']react["']/g,
    'react-dom': /from\s*["']react-dom["']/g,
    'react-router': /from\s*["']react-router["']/g,
    '@shopify/shopify-api': /@shopify\/shopify-api/g,
    '@shopify/shopify-app': /@shopify\/shopify-app/g,
    '@sentry/cloudflare': /@sentry\/cloudflare/g,
    'prisma': /prisma/gi,
    '@prisma': /@prisma/g,
  };

  console.log(`\nAnalyzing: ${filePath}`);
  console.log(`Total size: ${(content.length / 1024).toFixed(2)} KiB`);
  console.log(`Lines: ${lines.length}`);

  // Check for common patterns
  console.log('\nModule presence:');
  for (const [name, pattern] of Object.entries(modulePatterns)) {
    const matches = content.match(pattern);
    if (matches) {
      console.log(`  ${name}: ${matches.length} references`);
    }
  }

  // Find large string literals (often inline assets or WASM)
  const largeStrings = content.match(/"[^"]{1000,}"/g) || [];
  if (largeStrings.length > 0) {
    console.log(`\nLarge string literals: ${largeStrings.length}`);
    largeStrings.slice(0, 3).forEach((s, i) => {
      console.log(`  ${i + 1}. ${(s.length / 1024).toFixed(2)} KiB (preview: ${s.slice(0, 50)}...)`);
    });
  }

  // Find function definitions
  const funcDefs = content.match(/function\s+\w+/g) || [];
  const arrowFuncs = content.match(/const\s+\w+\s*=\s*(?:async\s*)?\(/g) || [];
  console.log(`\nFunction definitions: ${funcDefs.length} named, ${arrowFuncs.length} arrow`);

  return content.length;
}

function main() {
  console.log('=================================');
  console.log('BUNDLE ANALYSIS');
  console.log('=================================');

  const files = readdirSync(DIST_DIR).filter(f => f.endsWith('.js') || f.endsWith('.wasm'));
  
  let totalSize = 0;
  const fileSizes = [];

  for (const file of files) {
    const filePath = join(DIST_DIR, file);
    const content = readFileSync(filePath);
    const size = content.length;
    totalSize += size;
    fileSizes.push({ file, size });
  }

  fileSizes.sort((a, b) => b.size - a.size);

  console.log('\nBundle files by size:');
  for (const { file, size } of fileSizes) {
    const pct = ((size / totalSize) * 100).toFixed(1);
    console.log(`  ${(size / 1024).toFixed(2)} KiB (${pct}%) - ${file}`);
  }
  console.log(`\nTotal: ${(totalSize / 1024).toFixed(2)} KiB`);

  // Analyze the main worker entry
  const workerEntry = files.find(f => f.includes('worker-entry'));
  if (workerEntry) {
    analyzeBundleContent(join(DIST_DIR, workerEntry));
  }

  // Analyze the server build
  const serverBuild = files.find(f => f.includes('server-build'));
  if (serverBuild) {
    analyzeBundleContent(join(DIST_DIR, serverBuild));
  }
}

main();
