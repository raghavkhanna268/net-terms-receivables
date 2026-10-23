#!/usr/bin/env tsx
/**
 * CI check: Verify that shopify.app.toml scopes and wrangler.jsonc SCOPES are identical.
 *
 * This ensures the production Shopify app and the Cloudflare Worker always request
 * the same OAuth scopes from merchants.
 *
 * Exit codes:
 *   0 - Scopes are identical
 *   1 - Scopes differ or parsing failed
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");

function extractTomlScopes(content: string): string | null {
  // Match: scopes = "..." (with optional whitespace)
  const match = content.match(/^scopes\s*=\s*"([^"]*)"/m);
  return match ? match[1] : null;
}

function extractJsoncScopes(content: string): string | null {
  // Remove comments (// ... and /* ... */)
  const withoutComments = content
    .replace(/\/\/.*$/gm, "")
    .replace(/\/\*[\s\S]*?\*\//g, "");
  
  // Match: "SCOPES": "..."
  const match = withoutComments.match(/"SCOPES"\s*:\s*"([^"]*)"/);
  return match ? match[1] : null;
}

function normalizeScopes(scopes: string): string {
  // Sort scopes alphabetically for comparison
  return scopes.split(",").sort().join(",");
}

function main(): void {
  const tomlPath = resolve(ROOT, "shopify.app.toml");
  const wranglerPath = resolve(ROOT, "wrangler.jsonc");

  let tomlContent: string;
  let wranglerContent: string;

  try {
    tomlContent = readFileSync(tomlPath, "utf-8");
  } catch {
    console.error(`❌ Failed to read ${tomlPath}`);
    process.exit(1);
  }

  try {
    wranglerContent = readFileSync(wranglerPath, "utf-8");
  } catch {
    console.error(`❌ Failed to read ${wranglerPath}`);
    process.exit(1);
  }

  const tomlScopes = extractTomlScopes(tomlContent);
  const wranglerScopes = extractJsoncScopes(wranglerContent);

  if (tomlScopes === null) {
    console.error("❌ Could not parse scopes from shopify.app.toml");
    console.error("   Expected format: scopes = \"scope1,scope2,...\"");
    process.exit(1);
  }

  if (wranglerScopes === null) {
    console.error("❌ Could not parse SCOPES from wrangler.jsonc");
    console.error('   Expected format: "SCOPES": "scope1,scope2,..."');
    process.exit(1);
  }

  const normalizedToml = normalizeScopes(tomlScopes);
  const normalizedWrangler = normalizeScopes(wranglerScopes);

  if (normalizedToml !== normalizedWrangler) {
    console.error("❌ Scope mismatch detected!");
    console.error("");
    console.error("shopify.app.toml scopes:");
    console.error(`  ${tomlScopes}`);
    console.error("");
    console.error("wrangler.jsonc SCOPES:");
    console.error(`  ${wranglerScopes}`);
    console.error("");
    console.error("These must be identical. See docs/scopes.md for the audit.");
    process.exit(1);
  }

  console.log("✅ Scope sync check passed");
  console.log(`   ${tomlScopes.split(",").length} scopes in both files`);
  console.log(`   ${tomlScopes}`);
}

main();
