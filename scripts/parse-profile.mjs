#!/usr/bin/env node
/**
 * Parse and analyze a single cpuprofile file
 */

import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const profilePath = process.argv[2] || join(__dirname, '../profiles/warm_GET_root_1792682418585.cpuprofile');

const profile = JSON.parse(readFileSync(profilePath, 'utf-8'));

// Calculate time per node
const nodeTime = new Map();
const samples = profile.samples || [];
const timeDeltas = profile.timeDeltas || [];

samples.forEach((nodeId, idx) => {
  nodeTime.set(nodeId, (nodeTime.get(nodeId) || 0) + (timeDeltas[idx] || 0));
});

// Get all nodes with time
const nodesWithTime = profile.nodes
  .map(node => ({
    id: node.id,
    time: nodeTime.get(node.id) || 0,
    funcName: node.callFrame?.functionName || '(anonymous)',
    url: node.callFrame?.url || '(native)',
    lineNumber: node.callFrame?.lineNumber,
    columnNumber: node.callFrame?.columnNumber,
  }))
  .filter(n => n.time > 0)
  .sort((a, b) => b.time - a.time);

console.log(`Profile: ${profilePath}`);
console.log(`Total samples: ${samples.length}`);
console.log(`Total time: ${timeDeltas.reduce((a, b) => a + b, 0)}µs`);
console.log('\nTop 30 functions by CPU time:\n');

nodesWithTime.slice(0, 30).forEach((node, i) => {
  const pct = (node.time / timeDeltas.reduce((a, b) => a + b, 0) * 100).toFixed(1);
  let location = node.url;
  if (location.includes('worker-entry')) location = 'worker-entry.js';
  else if (location.includes('server-build')) location = 'server-build.js';
  else if (location === '(native)') location = '(native)';
  else location = location.split('/').pop();
  
  console.log(`${String(i + 1).padStart(2)}. ${(node.time / 1000).toFixed(2).padStart(7)}ms (${pct.padStart(5)}%) - ${node.funcName.slice(0, 40).padEnd(40)} @ ${location}`);
});

// Group by source file
console.log('\n\nTime by source file:\n');
const byFile = new Map();
nodesWithTime.forEach(node => {
  let file = node.url;
  if (file.includes('worker-entry')) file = 'worker-entry.js';
  else if (file.includes('server-build')) file = 'server-build.js';
  else if (file === '' || file === '(native)') file = '(native)';
  else file = file.split('/').pop();
  
  byFile.set(file, (byFile.get(file) || 0) + node.time);
});

const sortedFiles = [...byFile.entries()].sort((a, b) => b[1] - a[1]);
sortedFiles.forEach(([file, time]) => {
  const total = timeDeltas.reduce((a, b) => a + b, 0);
  const pct = (time / total * 100).toFixed(1);
  console.log(`  ${(time / 1000).toFixed(2).padStart(7)}ms (${pct.padStart(5)}%) - ${file}`);
});
