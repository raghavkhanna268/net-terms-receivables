#!/usr/bin/env npx tsx
/**
 * AST-based CI logging guard for PII/domain leak prevention.
 *
 * Checks app/**, workers/**, scripts/** files for:
 * 1. console.*, safeLog, Sentry.* calls with sensitive data
 * 2. Template literals interpolating shop/domain identifiers
 * 3. captureException with raw catch variables
 * 4. Script files (.sh/.mjs) with domain literals or token prefixes
 * 5. Test files mocking the logger (no-mock-logger rule)
 *
 * Maintains burn-down allowlist format: file:rule:count
 */

import * as ts from "typescript";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath, pathToFileURL } from "url";

// ============================================================================
// Configuration
// ============================================================================

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Allow overriding via environment for testing
const REPO_ROOT = process.env.LOGGING_GUARD_ROOT ?? path.resolve(__dirname, "../..");
const ALLOWLIST_FILE = process.env.LOGGING_GUARD_ALLOWLIST ?? path.join(__dirname, "logging-allowlist.txt");
const LOGGER_MOCK_ALLOWLIST_FILE = process.env.LOGGING_GUARD_MOCK_ALLOWLIST ?? path.join(__dirname, "logger-mock-allowlist.txt");

/**
 * Primary sensitive key/value pattern - unanchored substring matching.
 * Matches any key/identifier containing these substrings (case-insensitive):
 * - Financial: amount, paise, total, outstanding, balance
 * - Merchant: shop, domain (catches shopDomain, myshopifyDomain, shop_domain)
 * - PII: email, name, narration, payer, remitter, phone, address, note
 *
 * Applied to both camelCase and snake_case after normalization.
 */
const SENSITIVE_PATTERN = /amount|paise|total|outstanding|balance|shop|domain|email|name|narration|payer|remitter|phone|address|note/i;

/**
 * Token patterns that are always sensitive (exact match).
 */
const TOKEN_KEY_PATTERNS = [
  /^accessToken$/i,
  /^refreshToken$/i,
  /^access_token$/i,
  /^refresh_token$/i,
];

/**
 * Token prefix patterns for text-based scanning of scripts and test files.
 * P2: Must include shpca_/shppa_ (customer/partner access tokens).
 */
const TOKEN_PREFIX_PATTERN = /shpat_|shpua_|shpss_|shpca_|shppa_/;

/**
 * Explicitly banned keys in logging contexts (#332).
 * These keys must NEVER appear in safeLog, console.*, Sentry.*, or AuditEvent metadata.
 * Unlike SENSITIVE_PATTERN which uses substring matching, these are exact matches.
 */
const BANNED_LOG_KEYS = new Set([
  "webhookId",
  "webhook_id",
]);

/**
 * Check if a key is explicitly banned in logging contexts.
 */
function isBannedLogKey(key: string): boolean {
  return BANNED_LOG_KEYS.has(key);
}

/**
 * Normalize a key for matching: convert snake_case to camelCase equivalent
 * for consistent pattern matching.
 */
function normalizeKey(key: string): string {
  // Convert snake_case to lowercase for matching
  // shop_domain -> shopdomain (matches "shop" and "domain")
  return key.toLowerCase().replace(/_/g, "");
}

/**
 * Check if a key matches any sensitive pattern.
 */
function isSensitiveKey(key: string): boolean {
  // Check token patterns first (exact match)
  if (TOKEN_KEY_PATTERNS.some((pattern) => pattern.test(key))) {
    return true;
  }
  // Check normalized key against sensitive pattern
  const normalized = normalizeKey(key);
  return SENSITIVE_PATTERN.test(normalized);
}

/**
 * Check if an identifier name (variable, property) is sensitive.
 * Used for checking values like { store: shop } or { x: shopDomain }.
 */
function isSensitiveIdentifier(name: string): boolean {
  const normalized = normalizeKey(name);
  return SENSITIVE_PATTERN.test(normalized);
}

/**
 * Allowlisted keys that are safe even if they match the sensitive pattern.
 * ONLY include keys that actually match SENSITIVE_PATTERN and are genuinely safe.
 * Each entry must have a documented reason.
 *
 * Criteria for inclusion:
 * - Must match the deny regex (otherwise it's noise)
 * - Must NEVER carry: domain, email, person/company name, or money amount
 * - IDs, hashes, counts, and code-controlled enum values are OK
 */
const SAFE_KEY_ALLOWLIST: Record<string, string> = {
  // Hashed identifiers (not the raw domain)
  shopHash: "SHA-256 hash prefix of domain, not PII",

  // Internal database IDs (UUIDs, not domains or names)
  shopId: "Internal UUID primary key, not the domain string",
  shop_id: "Internal UUID primary key (snake_case), not the domain string",
  shopFilter: "Numeric shop index for filtering (credit-status-metafield-backfill.ts)",
  shop_filter: "Numeric shop index for filtering (snake_case)",
  shopIndex: "Numeric shop index, not the domain",
  shop_index: "Numeric shop index (snake_case)",

  // Count/total metrics (aggregate numbers, not individual money amounts)
  totalCount: "Aggregate count of items, not a money amount",
  total_count: "Aggregate count of items (snake_case), not a money amount",
  totalOrders: "Count of orders processed, not money",
  totalTaggedOrders: "Count of tagged orders, not money",
  totalUpserted: "Count of upserted records, not money",
  totalProcessed: "Count of processed items, not money",
  totalSkipped: "Count of skipped items, not money",
  totalFailures: "Count of failures, not money",
  totalAccountSources: "Count of account sources, not money",
  orderCount: "Count of orders, not a money amount",
  invoiceCount: "Count of invoices, not a money amount",
  outstandingCount: "Count of outstanding items, not a money amount",
  balanceCount: "Count of balance entries, not a money amount",
  amountCount: "Count of amount entries, not a money amount",

  // Code-controlled enum/metadata values (never user-supplied)
  topicName: "Webhook topic identifier (code-controlled enum)",
  topic_name: "Webhook topic identifier (snake_case, code-controlled enum)",
  queueName: "Queue identifier (code-controlled infrastructure name)",
  queue_name: "Queue identifier (snake_case, code-controlled)",
  functionName: "Function identifier (code-controlled, not user name)",
  function_name: "Function identifier (snake_case, code-controlled)",
  domainEvent: "Domain-driven design event type (code-controlled enum)",
  domain_event: "Domain-driven design event type (snake_case)",
  mutationName: "GraphQL mutation name (code-controlled)",
  roleName: "Contact role enum (code-controlled, not person name)",
  namespace: "Metafield namespace (code-controlled, e.g. $app)",
  subscriptionName: "Shopify plan name (e.g. Growth, Basic), not person name",
};

/**
 * Pattern to match sensitive identifiers in template literal last property.
 * Matches: shop, shopDomain, domain, myshopifyDomain, payloadShop, etc.
 */
const SENSITIVE_TEMPLATE_LAST_PROP = /(?:^|\.)(shop|shopDomain|domain|myshopifyDomain|payloadShop|shop_domain)$/i;

/**
 * Literal domain patterns in strings.
 */
const DOMAIN_LITERAL_PATTERN = /myshopify\.com/i;

/**
 * Shopify resource GID literal pattern (e.g. "gid://shopify/Order/123").
 * Flagged when it appears inside a console.*, safeLog, or Sentry call argument.
 */
const GID_LITERAL_PATTERN = /gid:\/\//i;

/**
 * Check if an identifier/property name holds a Shopify resource GID.
 * Matches names ending in Gid/gid (resourceGid, orderGid, customerGid, ...)
 * and the adminGraphqlApiId payload field (camelCase or snake_case).
 */
function isGidIdentifier(name: string): boolean {
  const normalized = name.toLowerCase().replace(/_/g, "");
  return /gid$/.test(normalized) || normalized === "admingraphqlapiid";
}

/**
 * Check if a specific myshopify.com occurrence is protected by a validation pattern.
 * For NON-TEST paths (script scan, log args, Sentry args), only ONE exemption:
 * - The escaped-regex form: `\.myshopify\.com` (backslash immediately before the dot)
 *
 * NO fake subdomain exemptions in non-test paths - those are test-file only.
 * NO isValidShopDomain exemption - string literal values don't have that context.
 *
 * @param text The full line/text being checked
 * @param matchIndex The position where `myshopify.com` starts in the text
 * @returns true if this specific occurrence is protected (exempt from flagging)
 */
function isMyshopifyComProtected(text: string, matchIndex: number): boolean {
  if (matchIndex > 0 && text[matchIndex - 1] === "\\") {
    const lookback = text.slice(Math.max(0, matchIndex - 20), matchIndex);
    if (!/[a-z0-9][-_a-z0-9]*\\$/i.test(lookback)) {
      return true;
    }
  }

  return false;
}

/**
 * Check if a line/text has any unprotected myshopify.com occurrences.
 * Iterates EVERY /myshopify\.com/gi occurrence, not just <sub>.myshopify.com.
 * For non-test paths: no FAKE_SUBDOMAINS, no fake prefixes, no UPPER_SNAKE exemptions.
 *
 * @param text The line or argument text to check
 * @returns true if there are unprotected occurrences (should be flagged)
 */
function hasUnprotectedMyshopifyCom(text: string): boolean {
  const allOccurrences = /myshopify\.com/gi;
  let match;

  while ((match = allOccurrences.exec(text)) !== null) {
    if (!isMyshopifyComProtected(text, match.index)) {
      return true;
    }
  }

  return false;
}

const CONSOLE_METHODS = new Set([
  "console.log",
  "console.warn",
  "console.error",
  "console.info",
  "console.debug",
]);

/**
 * Sentry methods that can leak PII through their arguments.
 */
const SENTRY_METHODS = new Set([
  "captureException",
  "captureMessage",
  "addBreadcrumb",
  "setExtra",
  "setExtras",
  "setContext",
  "setTag",
  "setTags",
  "setUser",
]);

// ============================================================================
// Types
// ============================================================================

interface Violation {
  file: string;
  line: number;
  column: number;
  rule: string;
  message: string;
  snippet: string;
}

interface TestFile {
  fullPath: string;
  relPath: string;
}

// ============================================================================
// File Discovery
// ============================================================================

interface SourceFiles {
  tsFiles: string[];
  scriptFiles: string[];
  testFiles: TestFile[];
}

function findSourceFiles(rootDir: string): SourceFiles {
  const tsFiles: string[] = [];
  const scriptFiles: string[] = [];
  const testFiles: TestFile[] = [];
  const dirsToSearch = ["app", "workers", "scripts"];

  for (const dir of dirsToSearch) {
    const fullPath = path.join(rootDir, dir);
    if (fs.existsSync(fullPath)) {
      walkDirectory(fullPath, tsFiles, scriptFiles, testFiles, rootDir);
    }
  }

  return { tsFiles, scriptFiles, testFiles };
}

function walkDirectory(
  dir: string,
  tsFiles: string[],
  scriptFiles: string[],
  testFiles: TestFile[],
  rootDir: string
): void {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const relDir = path.relative(rootDir, dir);

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      // Skip node_modules everywhere
      if (entry.name === "node_modules") continue;

      // Skip scripts/ci (self) and scripts/ci/__tests__/fixtures specifically
      if (relDir === "scripts" && entry.name === "ci") continue;

      walkDirectory(fullPath, tsFiles, scriptFiles, testFiles, rootDir);
    } else if (entry.isFile()) {
      const relPath = path.relative(rootDir, fullPath);
      const isTestFile = entry.name.endsWith(".test.ts") || entry.name.endsWith(".test.tsx");
      // P3 fix: Match "/test/" as a path segment, not substring. Also match "test" at start/end.
      const pathSegments = relDir.split(path.sep);
      const isInTestDir = relDir.includes("__tests__") || pathSegments.includes("test");
      const isTestOrTestDir = isTestFile || isInTestDir;

      // TypeScript files
      if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) {
        if (isTestOrTestDir) {
          // Test files: collect for no-mock-logger and limited scanning
          testFiles.push({ fullPath, relPath });
        } else {
          // Non-test files: full logging check
          tsFiles.push(fullPath);
        }
      }

      // Shell and mjs scripts (for text-based scanning)
      if (entry.name.endsWith(".sh") || entry.name.endsWith(".mjs")) {
        scriptFiles.push(fullPath);
      }
    }
  }
}

// ============================================================================
// Text-based Script Analysis (P1.2 regression fix)
// ============================================================================

function analyzeScriptFile(filePath: string, rootDir: string): Violation[] {
  const violations: Violation[] = [];
  const content = fs.readFileSync(filePath, "utf-8");
  const lines = content.split("\n");
  const relPath = path.relative(rootDir, filePath);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNum = i + 1;

    // Skip comments
    if (line.trim().startsWith("#") || line.trim().startsWith("//")) continue;

    // Check for myshopify.com domain literal (per-match, not line-wide)
    if (DOMAIN_LITERAL_PATTERN.test(line)) {
      // Skip if it's in a help/usage message context
      if (!line.includes("e.g.") && !line.includes("example") && !line.includes("placeholder")) {
        // Per-match check: only exempt escaped-regex and isValidShopDomain(identifier)
        // NO fake subdomain exemptions in script files
        if (hasUnprotectedMyshopifyCom(line)) {
          violations.push({
            file: relPath,
            line: lineNum,
            column: 1,
            rule: "script-domain",
            message: "Literal myshopify.com domain in script",
            snippet: truncate(line, 100),
          });
        }
      }
    }

    // Check for token prefixes (shpat_, shpua_, shpss_)
    if (TOKEN_PREFIX_PATTERN.test(line)) {
      violations.push({
        file: relPath,
        line: lineNum,
        column: 1,
        rule: "script-token",
        message: "Token prefix pattern in script (shpat_/shpua_/shpss_)",
        snippet: truncate(line, 100),
      });
    }

    // Check for echo/print of $SHOP-style variables
    if (/echo\s.*\$\{?(SHOP|shop|SHOP_DOMAIN|shop_domain)\}?/i.test(line) ||
        /print.*\$\{?(SHOP|shop|SHOP_DOMAIN|shop_domain)\}?/i.test(line)) {
      violations.push({
        file: relPath,
        line: lineNum,
        column: 1,
        rule: "script-shop-var",
        message: "Shell variable with shop/domain echoed",
        snippet: truncate(line, 100),
      });
    }
  }

  return violations;
}

// ============================================================================
// AST Analysis
// ============================================================================

function analyzeFile(filePath: string, rootDir: string): Violation[] {
  const violations: Violation[] = [];
  const sourceText = fs.readFileSync(filePath, "utf-8");
  const sourceFile = ts.createSourceFile(
    filePath,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    filePath.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  );

  const relPath = path.relative(rootDir, filePath);

  // Also check for token prefixes in TS files (but not in safeLog helper or regex patterns)
  const lines = sourceText.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (TOKEN_PREFIX_PATTERN.test(line)) {
      // Skip comments
      if (line.trim().startsWith("//") || line.trim().startsWith("*")) continue;
      // Skip regex patterns (used for validation/redaction)
      if (/\/.*shp[atu]{2}_/.test(line) || /RegExp|\.test\(|\.replace\(/.test(line)) continue;
      // Skip if it's in a file that handles token redaction (anchored on /log.server or lib/log)
      if (/\/log\.server|lib\/log/i.test(relPath) || relPath.includes("sentry")) continue;

      violations.push({
        file: relPath,
        line: i + 1,
        column: 1,
        rule: "token-prefix",
        message: "Token prefix pattern found (shpat_/shpua_/shpss_)",
        snippet: truncate(line, 100),
      });
    }
  }

  function visit(node: ts.Node): void {
    if (ts.isCallExpression(node)) {
      checkCallExpression(node, sourceFile, relPath, violations);
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return violations;
}

function checkCallExpression(
  call: ts.CallExpression,
  sourceFile: ts.SourceFile,
  relPath: string,
  violations: Violation[]
): void {
  const callName = getCallName(call);
  if (!callName) return;

  // Check console.* calls
  if (CONSOLE_METHODS.has(callName) || callName === "safeLog") {
    checkLogCall(call, sourceFile, relPath, violations);
  }

  // Check Sentry methods
  const methodName = callName.split(".").pop() ?? callName;
  if (SENTRY_METHODS.has(methodName)) {
    checkSentryCall(call, methodName, sourceFile, relPath, violations);
  }

  // Check sql.json / tx.json for AuditEvent metadata (#332)
  // These calls are used to serialize metadata in AuditEvent inserts.
  // We flag webhookId in these calls because it could end up in AuditEvent.data.
  // Note: We cannot statically determine if the call is actually within an AuditEvent
  // INSERT (the INSERT is in the parent tagged template, and the json call is an
  // interpolated expression). For safety, we flag all sql.json/tx.json objects
  // containing banned keys. This may produce false positives if sql.json is used
  // for non-AuditEvent data, but in this codebase sql.json is primarily used for
  // AuditEvent.data fields.
  if (callName === "sql.json" || callName === "tx.json" || callName === "json") {
    const firstArg = call.arguments[0];
    if (firstArg && ts.isObjectLiteralExpression(firstArg)) {
      checkAuditEventMetadata(firstArg, sourceFile, relPath, violations);
    }
  }
}

/**
 * Check AuditEvent metadata objects for banned keys (#332).
 * Called for sql.json / tx.json arguments which serialize AuditEvent.data.
 */
function checkAuditEventMetadata(
  obj: ts.ObjectLiteralExpression,
  sourceFile: ts.SourceFile,
  relPath: string,
  violations: Violation[]
): void {
  for (const prop of obj.properties) {
    let keyName: string | null = null;

    if (ts.isPropertyAssignment(prop)) {
      if (ts.isIdentifier(prop.name)) {
        keyName = prop.name.text;
      } else if (ts.isStringLiteral(prop.name)) {
        keyName = prop.name.text;
      } else if (ts.isComputedPropertyName(prop.name)) {
        const nameExpr = prop.name.expression;
        if (ts.isStringLiteral(nameExpr) && isBannedLogKey(nameExpr.text)) {
          const { line, character } = sourceFile.getLineAndCharacterOfPosition(prop.getStart());
          violations.push({
            file: relPath,
            line: line + 1,
            column: character + 1,
            rule: "banned-log-key",
            message: `Banned computed key in AuditEvent metadata: ["${nameExpr.text}"] (removed per #332)`,
            snippet: truncate(prop.getText(), 100),
          });
        }
      }

      // Check value for banned identifiers or property access
      const value = prop.initializer;
      if (ts.isIdentifier(value) && isBannedLogKey(value.text)) {
        const { line, character } = sourceFile.getLineAndCharacterOfPosition(value.getStart());
        violations.push({
          file: relPath,
          line: line + 1,
          column: character + 1,
          rule: "banned-log-key",
          message: `Banned identifier as AuditEvent metadata value: ${value.text} (removed per #332)`,
          snippet: truncate(prop.getText(), 100),
        });
      }
      if (ts.isPropertyAccessExpression(value) && isBannedLogKey(value.name.text)) {
        const { line, character } = sourceFile.getLineAndCharacterOfPosition(value.getStart());
        violations.push({
          file: relPath,
          line: line + 1,
          column: character + 1,
          rule: "banned-log-key",
          message: `Banned property access as AuditEvent metadata value: .${value.name.text} (removed per #332)`,
          snippet: truncate(prop.getText(), 100),
        });
      }
    }

    if (ts.isShorthandPropertyAssignment(prop)) {
      keyName = prop.name.text;
    }

    if (keyName && isBannedLogKey(keyName)) {
      const { line, character } = sourceFile.getLineAndCharacterOfPosition(prop.getStart());
      violations.push({
        file: relPath,
        line: line + 1,
        column: character + 1,
        rule: "banned-log-key",
        message: `Banned key in AuditEvent metadata: ${keyName} (removed per #332)`,
        snippet: truncate(prop.getText(), 100),
      });
    }
  }
}

function getCallName(call: ts.CallExpression): string | null {
  const expr = call.expression;

  if (ts.isPropertyAccessExpression(expr)) {
    const obj = expr.expression;
    const prop = expr.name.text;

    if (ts.isIdentifier(obj)) {
      return `${obj.text}.${prop}`;
    }

    return prop;
  }

  if (ts.isIdentifier(expr)) {
    return expr.text;
  }

  return null;
}

function checkLogCall(
  call: ts.CallExpression,
  sourceFile: ts.SourceFile,
  relPath: string,
  violations: Violation[]
): void {
  for (let i = 0; i < call.arguments.length; i++) {
    const arg = call.arguments[i];
    checkArgument(arg, sourceFile, relPath, violations, i);
  }
}

function checkArgument(
  arg: ts.Node,
  sourceFile: ts.SourceFile,
  relPath: string,
  violations: Violation[],
  _argIndex: number
): void {
  // Check template literals for shop interpolation and bare error identifiers (Gap 3)
  if (ts.isTemplateExpression(arg) || ts.isTaggedTemplateExpression(arg)) {
    const templateViolations = checkTemplateLiteral(arg, sourceFile);
    for (const v of templateViolations) {
      violations.push({
        file: relPath,
        line: v.line,
        column: v.column,
        rule: v.rule ?? "shop-interpolation",
        message: v.message ?? `Template literal interpolates sensitive variable: ${v.expr}`,
        snippet: v.snippet,
      });
    }
  }

  // Check string concatenation (P2.7)
  if (ts.isBinaryExpression(arg) && arg.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    checkStringConcatenation(arg, sourceFile, relPath, violations);
  }

  // Check for literal domain strings
  if (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg)) {
    const text = arg.text;
    if (DOMAIN_LITERAL_PATTERN.test(text) && !isValidationPattern(text)) {
      const { line, character } = sourceFile.getLineAndCharacterOfPosition(arg.getStart());
      violations.push({
        file: relPath,
        line: line + 1,
        column: character + 1,
        rule: "domain-literal",
        message: "Literal myshopify.com domain in log statement",
        snippet: truncate(arg.getText(), 100),
      });
    }
    if (GID_LITERAL_PATTERN.test(text)) {
      const { line, character } = sourceFile.getLineAndCharacterOfPosition(arg.getStart());
      violations.push({
        file: relPath,
        line: line + 1,
        column: character + 1,
        rule: "resource-gid",
        message: "Literal gid:// resource identifier in log statement",
        snippet: truncate(arg.getText(), 100),
      });
    }
  }

  // Check object literals for sensitive keys and values
  if (ts.isObjectLiteralExpression(arg)) {
    checkObjectLiteral(arg, sourceFile, relPath, violations);
  }

  // Check array literals (P3.10)
  if (ts.isArrayLiteralExpression(arg)) {
    checkArrayLiteral(arg, sourceFile, relPath, violations);
  }

  // Gap 2: Unwrap wrappers and check underlying values
  const unwrapped = unwrapExpression(arg);
  for (const node of unwrapped) {
    // Skip if it's the same as the original (already checked above or will be checked below)
    if (node === arg) continue;
    
    // Check the unwrapped node recursively
    checkUnwrappedArgument(node, sourceFile, relPath, violations);
  }

  // Check identifier arguments (P2.4) - e.g., console.error(err), console.log(shopDomain)
  // No argIndex > 0 condition - check ALL arguments
  if (ts.isIdentifier(arg)) {
    const name = arg.text;
    // Check for banned identifiers (#332) - e.g., console.log("x", webhookId)
    if (isBannedLogKey(name)) {
      const { line, character } = sourceFile.getLineAndCharacterOfPosition(arg.getStart());
      violations.push({
        file: relPath,
        line: line + 1,
        column: character + 1,
        rule: "banned-log-key",
        message: `Banned identifier passed as argument: ${name} (removed per #332)`,
        snippet: truncate(arg.getText(), 100),
      });
    }
    // Check for error-like identifiers
    if (isErrorLikeIdentifier(name)) {
      const { line, character } = sourceFile.getLineAndCharacterOfPosition(arg.getStart());
      violations.push({
        file: relPath,
        line: line + 1,
        column: character + 1,
        rule: "raw-error-arg",
        message: `Raw error identifier passed to log: ${name}`,
        snippet: truncate(arg.getText(), 100),
      });
    }
    // Check for sensitive identifiers as values
    if (isSensitiveIdentifier(name) && !SAFE_KEY_ALLOWLIST[name]) {
      const { line, character } = sourceFile.getLineAndCharacterOfPosition(arg.getStart());
      violations.push({
        file: relPath,
        line: line + 1,
        column: character + 1,
        rule: "sensitive-value",
        message: `Sensitive identifier passed as argument: ${name}`,
        snippet: truncate(arg.getText(), 100),
      });
    }
  }

  // Check property access arguments (P2.4) - e.g., console.error("x", err.message), console.log("x", session.shop)
  if (ts.isPropertyAccessExpression(arg)) {
    const propName = arg.name.text;
    // Check for banned property names (#332) - e.g., console.log("x", m.webhookId)
    if (isBannedLogKey(propName)) {
      const { line, character } = sourceFile.getLineAndCharacterOfPosition(arg.getStart());
      violations.push({
        file: relPath,
        line: line + 1,
        column: character + 1,
        rule: "banned-log-key",
        message: `Banned property access passed as argument: .${propName} (removed per #332)`,
        snippet: truncate(arg.getText(), 100),
      });
    }
    // Check for .message/.stack
    if (propName === "message" || propName === "stack") {
      const { line, character } = sourceFile.getLineAndCharacterOfPosition(arg.getStart());
      violations.push({
        file: relPath,
        line: line + 1,
        column: character + 1,
        rule: "error-message",
        message: `Error .${propName} passed as argument`,
        snippet: truncate(arg.getText(), 100),
      });
    }
    // Check for sensitive last property name
    if (isSensitiveIdentifier(propName) && !SAFE_KEY_ALLOWLIST[propName]) {
      const { line, character } = sourceFile.getLineAndCharacterOfPosition(arg.getStart());
      violations.push({
        file: relPath,
        line: line + 1,
        column: character + 1,
        rule: "sensitive-value",
        message: `Property access to sensitive field as argument: .${propName}`,
        snippet: truncate(arg.getText(), 100),
      });
    }
  }

  // Check call expression arguments (P2.4) - e.g., console.error("x", String(err))
  if (ts.isCallExpression(arg)) {
    const callName = getCallName(arg);
    if (callName === "String" || callName === "JSON.stringify") {
      const firstArg = arg.arguments[0];
      if (firstArg && ts.isIdentifier(firstArg) && isErrorLikeIdentifier(firstArg.text)) {
        const { line, character } = sourceFile.getLineAndCharacterOfPosition(arg.getStart());
        violations.push({
          file: relPath,
          line: line + 1,
          column: character + 1,
          rule: "error-stringify",
          message: `Error stringified in argument: ${callName}(${firstArg.text})`,
          snippet: truncate(arg.getText(), 100),
        });
      }
    }
  }
}

/**
 * Gap 2: Check an unwrapped argument node for sensitive values.
 * Called after unwrapping JSON.stringify, String, ternary, ??, ||, parens, as casts.
 */
function checkUnwrappedArgument(
  node: ts.Node,
  sourceFile: ts.SourceFile,
  relPath: string,
  violations: Violation[]
): void {
  // Check identifier
  if (ts.isIdentifier(node)) {
    const name = node.text;
    if (isErrorLikeIdentifier(name)) {
      const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart());
      violations.push({
        file: relPath,
        line: line + 1,
        column: character + 1,
        rule: "raw-error-arg",
        message: `Raw error identifier in wrapped expression: ${name}`,
        snippet: truncate(node.getText(), 100),
      });
    }
    if (isSensitiveIdentifier(name) && !SAFE_KEY_ALLOWLIST[name]) {
      const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart());
      violations.push({
        file: relPath,
        line: line + 1,
        column: character + 1,
        rule: "sensitive-value",
        message: `Sensitive identifier in wrapped expression: ${name}`,
        snippet: truncate(node.getText(), 100),
      });
    }
  }

  // Check property access
  if (ts.isPropertyAccessExpression(node)) {
    const propName = node.name.text;
    if (propName === "message" || propName === "stack") {
      const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart());
      violations.push({
        file: relPath,
        line: line + 1,
        column: character + 1,
        rule: "error-message",
        message: `Error .${propName} in wrapped expression`,
        snippet: truncate(node.getText(), 100),
      });
    }
    if (isSensitiveIdentifier(propName) && !SAFE_KEY_ALLOWLIST[propName]) {
      const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart());
      violations.push({
        file: relPath,
        line: line + 1,
        column: character + 1,
        rule: "sensitive-value",
        message: `Property access to sensitive field in wrapped expression: .${propName}`,
        snippet: truncate(node.getText(), 100),
      });
    }
  }
}

/**
 * Check if an identifier name looks like an error variable.
 */
function isErrorLikeIdentifier(name: string): boolean {
  const lower = name.toLowerCase();

  // Exclude boolean indicator prefixes with proper camelCase/snake_case boundary.
  // Match original name (not lowercased) to detect camelCase boundary.
  // Examples that should be EXCLUDED (boolean flags, not error objects):
  //   isRetryableError, hasError, wasHandled, canRetry
  // Examples that should NOT be excluded (real error variables):
  //   issueError, cancelError, hashErr, wasmError, hashError, canonicalError
  if (/^(is|has|was|can|should|will|did)[A-Z_]/.test(name)) {
    return false;
  }

  return (
    lower === "err" ||
    lower === "error" ||
    lower === "e" ||
    lower === "ex" ||
    lower === "exc" ||
    lower === "caught" ||
    lower === "exception" ||
    lower.endsWith("error") ||
    lower.endsWith("err")
  );
}

// ============================================================================
// Gap 1: Resolve const identifiers in same scope
// ============================================================================

/**
 * Try to resolve an identifier to its const initializer in the same scope.
 * Returns the initializer node if found, or null otherwise.
 */
function resolveConstInitializer(
  identifier: ts.Identifier,
  _sourceFile: ts.SourceFile
): ts.Expression | null {
  const name = identifier.text;
  
  // Walk up to find the containing block/function
  let current: ts.Node = identifier;
  while (current.parent) {
    current = current.parent;
    
    // Check variable statements in the same block
    if (ts.isBlock(current) || ts.isSourceFile(current)) {
      const statements = ts.isBlock(current) ? current.statements : current.statements;
      for (const stmt of statements) {
        if (ts.isVariableStatement(stmt)) {
          for (const decl of stmt.declarationList.declarations) {
            if (ts.isIdentifier(decl.name) && decl.name.text === name) {
              // Only resolve const declarations
              if (stmt.declarationList.flags & ts.NodeFlags.Const) {
                return decl.initializer ?? null;
              }
            }
          }
        }
      }
    }
    
    // Check function/arrow function parameters and body
    if (ts.isFunctionDeclaration(current) || ts.isFunctionExpression(current) || 
        ts.isArrowFunction(current) || ts.isMethodDeclaration(current)) {
      const body = current.body;
      if (body && ts.isBlock(body)) {
        for (const stmt of body.statements) {
          if (ts.isVariableStatement(stmt)) {
            for (const decl of stmt.declarationList.declarations) {
              if (ts.isIdentifier(decl.name) && decl.name.text === name) {
                if (stmt.declarationList.flags & ts.NodeFlags.Const) {
                  return decl.initializer ?? null;
                }
              }
            }
          }
        }
      }
    }
  }
  
  return null;
}

// ============================================================================
// Gap 2: Unwrap wrappers recursively
// ============================================================================

/**
 * Unwrap wrapper expressions and return the underlying expression(s).
 * Handles: JSON.stringify(x), String(x), ternary, ??, ||, parentheses, as casts
 * Returns an array because ternary/nullish/or have multiple branches.
 */
function unwrapExpression(node: ts.Node): ts.Node[] {
  // Parentheses: (x) -> x
  if (ts.isParenthesizedExpression(node)) {
    return unwrapExpression(node.expression);
  }

  // Type assertion: x as T -> x
  if (ts.isAsExpression(node)) {
    return unwrapExpression(node.expression);
  }

  // Ternary: cond ? x : y -> [x, y]
  if (ts.isConditionalExpression(node)) {
    return [
      ...unwrapExpression(node.whenTrue),
      ...unwrapExpression(node.whenFalse),
    ];
  }

  // Nullish coalescing: x ?? y -> [x, y]
  if (ts.isBinaryExpression(node) && 
      node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken) {
    return [
      ...unwrapExpression(node.left),
      ...unwrapExpression(node.right),
    ];
  }

  // Logical OR: x || y -> [x, y]
  if (ts.isBinaryExpression(node) && 
      node.operatorToken.kind === ts.SyntaxKind.BarBarToken) {
    return [
      ...unwrapExpression(node.left),
      ...unwrapExpression(node.right),
    ];
  }

  // JSON.stringify(x), String(x) -> x
  if (ts.isCallExpression(node)) {
    const callName = getCallName(node);
    if ((callName === "JSON.stringify" || callName === "String") && node.arguments.length > 0) {
      return unwrapExpression(node.arguments[0]);
    }
  }

  // Base case: return the node itself
  return [node];
}

function checkSentryCall(
  call: ts.CallExpression,
  methodName: string,
  sourceFile: ts.SourceFile,
  relPath: string,
  violations: Violation[]
): void {
  // captureException - catch any identifier without second argument (P3.9)
  if (methodName === "captureException") {
    const firstArg = call.arguments[0];
    const secondArg = call.arguments[1];

    if (firstArg && ts.isIdentifier(firstArg) && !secondArg) {
      const fullText = call.getText(sourceFile);
      if (!fullText.includes("tags") && !fullText.includes("captureExceptionWithTags")) {
        const { line, character } = sourceFile.getLineAndCharacterOfPosition(call.getStart());
        violations.push({
          file: relPath,
          line: line + 1,
          column: character + 1,
          rule: "raw-capture",
          message: `captureException with raw variable '${firstArg.text}' (use captureExceptionWithTags)`,
          snippet: truncate(fullText, 100),
        });
      }
    }
  }

  // setUser - always flag (P2.5)
  if (methodName === "setUser" && call.arguments.length > 0) {
    const { line, character } = sourceFile.getLineAndCharacterOfPosition(call.getStart());
    violations.push({
      file: relPath,
      line: line + 1,
      column: character + 1,
      rule: "sentry-setuser",
      message: "Sentry.setUser passes user PII to error tracking",
      snippet: truncate(call.getText(sourceFile), 100),
    });
  }

  // setExtra(key, value), setTag(key, value): check both key AND value (P2.5)
  if ((methodName === "setExtra" || methodName === "setTag") && call.arguments.length >= 2) {
    const keyArg = call.arguments[0];
    const valueArg = call.arguments[1];

    // Check key for banned keys (#332)
    if (ts.isStringLiteral(keyArg)) {
      const keyName = keyArg.text;
      if (isBannedLogKey(keyName)) {
        const { line, character } = sourceFile.getLineAndCharacterOfPosition(keyArg.getStart());
        violations.push({
          file: relPath,
          line: line + 1,
          column: character + 1,
          rule: "banned-log-key",
          message: `Banned key in Sentry ${methodName}: ${keyName} (removed per #332)`,
          snippet: truncate(call.getText(sourceFile), 100),
        });
      }
      if (isSensitiveKey(keyName) && !SAFE_KEY_ALLOWLIST[keyName]) {
        const { line, character } = sourceFile.getLineAndCharacterOfPosition(keyArg.getStart());
        violations.push({
          file: relPath,
          line: line + 1,
          column: character + 1,
          rule: "sensitive-key",
          message: `Sensitive key in Sentry ${methodName}: ${keyName}`,
          snippet: truncate(call.getText(sourceFile), 100),
        });
      }
    }

    // Check value (P2.5) - also handle wrapped values (Gap 2)
    checkSentryValueWithUnwrap(valueArg, methodName, sourceFile, relPath, violations);
  }

  // Gap 1: setContext(name, data), setExtras(extras) - handle identifier/object arguments
  if (methodName === "setContext" && call.arguments.length >= 2) {
    const dataArg = call.arguments[1];
    checkSentryContextArg(dataArg, methodName, sourceFile, relPath, violations);
  }

  if (methodName === "setExtras" && call.arguments.length >= 1) {
    const extrasArg = call.arguments[0];
    checkSentryContextArg(extrasArg, methodName, sourceFile, relPath, violations);
  }

  // Check all arguments for sensitive data
  for (const arg of call.arguments) {
    if (ts.isObjectLiteralExpression(arg)) {
      checkObjectLiteral(arg, sourceFile, relPath, violations);
    }

    if (ts.isArrayLiteralExpression(arg)) {
      checkArrayLiteral(arg, sourceFile, relPath, violations);
    }

    if (ts.isTemplateExpression(arg) || ts.isTaggedTemplateExpression(arg)) {
      const templateViolations = checkTemplateLiteral(arg, sourceFile);
      for (const v of templateViolations) {
        violations.push({
          file: relPath,
          line: v.line,
          column: v.column,
          rule: v.rule ?? "shop-interpolation",
          message: v.message ?? `Template in Sentry call interpolates sensitive variable: ${v.expr}`,
          snippet: v.snippet,
        });
      }
    }

    if (ts.isBinaryExpression(arg) && arg.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      checkStringConcatenation(arg, sourceFile, relPath, violations);
    }

    if (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg)) {
      if (DOMAIN_LITERAL_PATTERN.test(arg.text) && !isValidationPattern(arg.text)) {
        const { line, character } = sourceFile.getLineAndCharacterOfPosition(arg.getStart());
        violations.push({
          file: relPath,
          line: line + 1,
          column: character + 1,
          rule: "domain-literal",
          message: "Literal myshopify.com domain in Sentry call",
          snippet: truncate(arg.getText(), 100),
        });
      }
      if (GID_LITERAL_PATTERN.test(arg.text)) {
        const { line, character } = sourceFile.getLineAndCharacterOfPosition(arg.getStart());
        violations.push({
          file: relPath,
          line: line + 1,
          column: character + 1,
          rule: "resource-gid",
          message: "Literal gid:// resource identifier in Sentry call",
          snippet: truncate(arg.getText(), 100),
        });
      }
    }
  }
}

/**
 * Gap 1: Check Sentry setContext/setExtras argument for identifier/object.
 * Resolves const initializers in same scope.
 * P2 fix: Fail closed for call expressions, property access, spread - flag as unresolved.
 */
function checkSentryContextArg(
  arg: ts.Node,
  methodName: string,
  sourceFile: ts.SourceFile,
  relPath: string,
  violations: Violation[]
): void {
  // If it's an object literal, check it and also check spread elements inside
  if (ts.isObjectLiteralExpression(arg)) {
    // Check for spread elements - they could bring in unknown properties
    for (const prop of arg.properties) {
      if (ts.isSpreadAssignment(prop)) {
        const spreadExpr = prop.expression;
        const spreadText = spreadExpr.getText(sourceFile);
        const { line, character } = sourceFile.getLineAndCharacterOfPosition(prop.getStart());
        violations.push({
          file: relPath,
          line: line + 1,
          column: character + 1,
          rule: "sentry-context-unresolved",
          message: `Sentry.${methodName} object literal contains spread '...${spreadText}' (inline all properties)`,
          snippet: truncate(arg.getText(), 100),
        });
      }
    }
    return;
  }

  // If it's an identifier, try to resolve it
  if (ts.isIdentifier(arg)) {
    const name = arg.text;

    // Check if the identifier is in SAFE_KEY_ALLOWLIST
    if (SAFE_KEY_ALLOWLIST[name]) {
      return;
    }

    // Try to resolve the const initializer
    const initializer = resolveConstInitializer(arg, sourceFile);
    if (initializer) {
      // If resolved to an object literal, check it (including spreads)
      if (ts.isObjectLiteralExpression(initializer)) {
        checkSentryContextArg(initializer, methodName, sourceFile, relPath, violations);
        checkObjectLiteral(initializer, sourceFile, relPath, violations);
        return;
      }
    }

    // Could not resolve - flag as unresolved
    const { line, character } = sourceFile.getLineAndCharacterOfPosition(arg.getStart());
    violations.push({
      file: relPath,
      line: line + 1,
      column: character + 1,
      rule: "sentry-context-unresolved",
      message: `Sentry.${methodName} called with unresolved identifier '${name}' (use inline object literal or add to SAFE_KEY_ALLOWLIST)`,
      snippet: truncate(arg.getText(), 100),
    });
    return;
  }

  // P2: Fail closed - flag call expressions, property access, and any other unknown forms
  if (ts.isCallExpression(arg)) {
    const callText = arg.getText(sourceFile);
    const { line, character } = sourceFile.getLineAndCharacterOfPosition(arg.getStart());
    violations.push({
      file: relPath,
      line: line + 1,
      column: character + 1,
      rule: "sentry-context-unresolved",
      message: `Sentry.${methodName} called with function result '${truncate(callText, 50)}' (inline the object literal)`,
      snippet: truncate(callText, 100),
    });
    return;
  }

  if (ts.isPropertyAccessExpression(arg)) {
    const propText = arg.getText(sourceFile);
    const { line, character } = sourceFile.getLineAndCharacterOfPosition(arg.getStart());
    violations.push({
      file: relPath,
      line: line + 1,
      column: character + 1,
      rule: "sentry-context-unresolved",
      message: `Sentry.${methodName} called with property access '${propText}' (inline the object literal)`,
      snippet: truncate(propText, 100),
    });
    return;
  }

  // Any other expression type - fail closed
  const argText = arg.getText(sourceFile);
  const { line, character } = sourceFile.getLineAndCharacterOfPosition(arg.getStart());
  violations.push({
    file: relPath,
    line: line + 1,
    column: character + 1,
    rule: "sentry-context-unresolved",
    message: `Sentry.${methodName} called with unresolved expression (use inline object literal)`,
    snippet: truncate(argText, 100),
  });
}

/**
 * Check a Sentry setTag/setExtra value for sensitive data with unwrapping (Gap 2).
 */
function checkSentryValueWithUnwrap(
  value: ts.Node,
  methodName: string,
  sourceFile: ts.SourceFile,
  relPath: string,
  violations: Violation[]
): void {
  // Unwrap wrappers and check each branch
  const unwrapped = unwrapExpression(value);
  for (const node of unwrapped) {
    checkSentryValue(node, methodName, sourceFile, relPath, violations);
  }
}

/**
 * Check a Sentry setTag/setExtra value for sensitive data (P2.5).
 */
function checkSentryValue(
  value: ts.Node,
  methodName: string,
  sourceFile: ts.SourceFile,
  relPath: string,
  violations: Violation[]
): void {
  // Check identifier values
  if (ts.isIdentifier(value)) {
    const name = value.text;
    if (isSensitiveIdentifier(name) && !SAFE_KEY_ALLOWLIST[name]) {
      const { line, character } = sourceFile.getLineAndCharacterOfPosition(value.getStart());
      violations.push({
        file: relPath,
        line: line + 1,
        column: character + 1,
        rule: "sensitive-value",
        message: `Sensitive identifier as ${methodName} value: ${name}`,
        snippet: truncate(value.getText(), 100),
      });
    }
  }

  // Check property access (.message, .stack)
  if (ts.isPropertyAccessExpression(value)) {
    const propName = value.name.text;
    if (propName === "message" || propName === "stack") {
      const { line, character } = sourceFile.getLineAndCharacterOfPosition(value.getStart());
      violations.push({
        file: relPath,
        line: line + 1,
        column: character + 1,
        rule: "error-message",
        message: `Error .${propName} passed to Sentry ${methodName}`,
        snippet: truncate(value.getText(), 100),
      });
    }
  }
}

function checkObjectLiteral(
  obj: ts.ObjectLiteralExpression,
  sourceFile: ts.SourceFile,
  relPath: string,
  violations: Violation[],
  depth = 0
): void {
  if (depth > 5) return;

  for (const prop of obj.properties) {
    let keyName: string | null = null;

    // Property assignment: { key: value }
    if (ts.isPropertyAssignment(prop)) {
      if (ts.isIdentifier(prop.name)) {
        keyName = prop.name.text;
      } else if (ts.isStringLiteral(prop.name)) {
        keyName = prop.name.text;
      } else if (ts.isComputedPropertyName(prop.name)) {
        // Computed property name: { ["webhookId"]: x } or { [key]: x }
        const nameExpr = prop.name.expression;
        if (ts.isStringLiteral(nameExpr)) {
          const computedKey = nameExpr.text;
          if (isBannedLogKey(computedKey)) {
            const { line, character } = sourceFile.getLineAndCharacterOfPosition(prop.getStart());
            violations.push({
              file: relPath,
              line: line + 1,
              column: character + 1,
              rule: "banned-log-key",
              message: `Banned computed key in log argument: ["${computedKey}"] (removed per #332)`,
              snippet: truncate(prop.getText(), 100),
            });
          }
        }
      }

      // Check the value (P2.4)
      checkPropertyValue(prop.initializer, sourceFile, relPath, violations, depth);

      // Recurse into nested object literals
      if (ts.isObjectLiteralExpression(prop.initializer)) {
        checkObjectLiteral(prop.initializer, sourceFile, relPath, violations, depth + 1);
      }

      // Recurse into arrays (P3.10)
      if (ts.isArrayLiteralExpression(prop.initializer)) {
        checkArrayLiteral(prop.initializer, sourceFile, relPath, violations, depth + 1);
      }

      // Check template literal values
      if (ts.isTemplateExpression(prop.initializer)) {
        const templateViolations = checkTemplateLiteral(prop.initializer, sourceFile);
        for (const v of templateViolations) {
          violations.push({
            file: relPath,
            line: v.line,
            column: v.column,
            rule: "shop-interpolation",
            message: `Object property value interpolates sensitive variable: ${v.expr}`,
            snippet: v.snippet,
          });
        }
      }

      // Check string concatenation in values (P2.7)
      if (ts.isBinaryExpression(prop.initializer) &&
          prop.initializer.operatorToken.kind === ts.SyntaxKind.PlusToken) {
        checkStringConcatenation(prop.initializer, sourceFile, relPath, violations);
      }
    }

    // Shorthand property: { shop } is equivalent to { shop: shop }
    if (ts.isShorthandPropertyAssignment(prop)) {
      keyName = prop.name.text;
    }

    // Spread element: { ...obj }
    if (ts.isSpreadAssignment(prop)) {
      const spreadExpr = prop.expression;
      if (ts.isIdentifier(spreadExpr)) {
        const name = spreadExpr.text;
        if (isSensitiveKey(name) && !SAFE_KEY_ALLOWLIST[name]) {
          const { line, character } = sourceFile.getLineAndCharacterOfPosition(prop.getStart());
          violations.push({
            file: relPath,
            line: line + 1,
            column: character + 1,
            rule: "sensitive-spread",
            message: `Spread of potentially sensitive object: ${name}`,
            snippet: truncate(prop.getText(), 100),
          });
        }
      }
    }

    // Check if key is explicitly banned (#332)
    if (keyName && isBannedLogKey(keyName)) {
      const { line, character } = sourceFile.getLineAndCharacterOfPosition(prop.getStart());
      violations.push({
        file: relPath,
        line: line + 1,
        column: character + 1,
        rule: "banned-log-key",
        message: `Banned key in log argument: ${keyName} (removed per #332)`,
        snippet: truncate(prop.getText(), 100),
      });
    }

    // Check if key is sensitive
    if (keyName && isSensitiveKey(keyName) && !SAFE_KEY_ALLOWLIST[keyName]) {
      const { line, character } = sourceFile.getLineAndCharacterOfPosition(prop.getStart());
      violations.push({
        file: relPath,
        line: line + 1,
        column: character + 1,
        rule: "sensitive-key",
        message: `Sensitive key in log argument: ${keyName}`,
        snippet: truncate(prop.getText(), 100),
      });
    }
  }
}

/**
 * Check a property value for sensitive data (P2.4).
 */
function checkPropertyValue(
  value: ts.Node,
  sourceFile: ts.SourceFile,
  relPath: string,
  violations: Violation[],
  _depth: number
): void {
  // Check identifier values: { store: shop } or { id: webhookId }
  if (ts.isIdentifier(value)) {
    const name = value.text;
    // Check for banned identifiers (#332) - e.g., { id: webhookId }
    if (isBannedLogKey(name)) {
      const { line, character } = sourceFile.getLineAndCharacterOfPosition(value.getStart());
      violations.push({
        file: relPath,
        line: line + 1,
        column: character + 1,
        rule: "banned-log-key",
        message: `Banned identifier as value: ${name} (removed per #332)`,
        snippet: truncate(value.getText(), 100),
      });
    }
    if (isSensitiveIdentifier(name) && !SAFE_KEY_ALLOWLIST[name]) {
      const { line, character } = sourceFile.getLineAndCharacterOfPosition(value.getStart());
      violations.push({
        file: relPath,
        line: line + 1,
        column: character + 1,
        rule: "sensitive-value",
        message: `Sensitive identifier as value: ${name}`,
        snippet: truncate(value.getText(), 100),
      });
    }
    // Check for error identifiers
    if (isErrorLikeIdentifier(name)) {
      const { line, character } = sourceFile.getLineAndCharacterOfPosition(value.getStart());
      violations.push({
        file: relPath,
        line: line + 1,
        column: character + 1,
        rule: "raw-error-value",
        message: `Error identifier as property value: ${name}`,
        snippet: truncate(value.getText(), 100),
      });
    }
  }

  // Check property access: { error: err.message } or { x: foo.stack } or { id: m.webhookId }
  if (ts.isPropertyAccessExpression(value)) {
    const propName = value.name.text;
    // Check for banned property access (#332) - e.g., { id: m.webhookId }
    if (isBannedLogKey(propName)) {
      const { line, character } = sourceFile.getLineAndCharacterOfPosition(value.getStart());
      violations.push({
        file: relPath,
        line: line + 1,
        column: character + 1,
        rule: "banned-log-key",
        message: `Banned property access as value: .${propName} (removed per #332)`,
        snippet: truncate(value.getText(), 100),
      });
    }
    if (propName === "message" || propName === "stack") {
      const { line, character } = sourceFile.getLineAndCharacterOfPosition(value.getStart());
      violations.push({
        file: relPath,
        line: line + 1,
        column: character + 1,
        rule: "error-message",
        message: `Error .${propName} in property value`,
        snippet: truncate(value.getText(), 100),
      });
    }
    // Check if the last property name is sensitive
    if (isSensitiveIdentifier(propName) && !SAFE_KEY_ALLOWLIST[propName]) {
      const { line, character } = sourceFile.getLineAndCharacterOfPosition(value.getStart());
      violations.push({
        file: relPath,
        line: line + 1,
        column: character + 1,
        rule: "sensitive-value",
        message: `Property access to sensitive field: .${propName}`,
        snippet: truncate(value.getText(), 100),
      });
    }
  }

  // Check call expressions: { error: String(err) }
  if (ts.isCallExpression(value)) {
    const callName = getCallName(value);
    if (callName === "String" || callName === "JSON.stringify") {
      const firstArg = value.arguments[0];
      if (firstArg && ts.isIdentifier(firstArg) && isErrorLikeIdentifier(firstArg.text)) {
        const { line, character } = sourceFile.getLineAndCharacterOfPosition(value.getStart());
        violations.push({
          file: relPath,
          line: line + 1,
          column: character + 1,
          rule: "error-stringify",
          message: `Error stringified in property value: ${callName}(${firstArg.text})`,
          snippet: truncate(value.getText(), 100),
        });
      }
    }
  }
}

/**
 * Check array literals for sensitive data (P3.10).
 */
function checkArrayLiteral(
  arr: ts.ArrayLiteralExpression,
  sourceFile: ts.SourceFile,
  relPath: string,
  violations: Violation[],
  depth = 0
): void {
  if (depth > 5) return;

  for (const element of arr.elements) {
    if (ts.isObjectLiteralExpression(element)) {
      checkObjectLiteral(element, sourceFile, relPath, violations, depth + 1);
    }
    if (ts.isArrayLiteralExpression(element)) {
      checkArrayLiteral(element, sourceFile, relPath, violations, depth + 1);
    }
    if (ts.isIdentifier(element)) {
      const name = element.text;
      if (isSensitiveIdentifier(name) && !SAFE_KEY_ALLOWLIST[name]) {
        const { line, character } = sourceFile.getLineAndCharacterOfPosition(element.getStart());
        violations.push({
          file: relPath,
          line: line + 1,
          column: character + 1,
          rule: "sensitive-value",
          message: `Sensitive identifier in array: ${name}`,
          snippet: truncate(element.getText(), 100),
        });
      }
    }
  }
}

/**
 * Check string concatenation for sensitive identifiers (P2.7) and banned keys (#332).
 */
function checkStringConcatenation(
  expr: ts.BinaryExpression,
  sourceFile: ts.SourceFile,
  relPath: string,
  violations: Violation[]
): void {
  function checkOperand(operand: ts.Node): void {
    if (ts.isIdentifier(operand)) {
      const name = operand.text;
      // Check for banned identifiers (#332) - e.g., "wh=" + webhookId
      if (isBannedLogKey(name)) {
        const { line, character } = sourceFile.getLineAndCharacterOfPosition(operand.getStart());
        violations.push({
          file: relPath,
          line: line + 1,
          column: character + 1,
          rule: "banned-log-key",
          message: `Banned identifier in string concatenation: ${name} (removed per #332)`,
          snippet: truncate(expr.getText(sourceFile), 100),
        });
      }
      if (isSensitiveIdentifier(name) && !SAFE_KEY_ALLOWLIST[name]) {
        const { line, character } = sourceFile.getLineAndCharacterOfPosition(operand.getStart());
        violations.push({
          file: relPath,
          line: line + 1,
          column: character + 1,
          rule: "concat-sensitive",
          message: `Sensitive identifier in string concatenation: ${name}`,
          snippet: truncate(expr.getText(sourceFile), 100),
        });
      }
    }
    if (ts.isBinaryExpression(operand) && operand.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      checkOperand(operand.left);
      checkOperand(operand.right);
    }
    if (ts.isPropertyAccessExpression(operand)) {
      const propName = operand.name.text;
      // Check for banned property access (#332) - e.g., "wh=" + m.webhookId
      if (isBannedLogKey(propName)) {
        const { line, character } = sourceFile.getLineAndCharacterOfPosition(operand.getStart());
        violations.push({
          file: relPath,
          line: line + 1,
          column: character + 1,
          rule: "banned-log-key",
          message: `Banned property access in string concatenation: .${propName} (removed per #332)`,
          snippet: truncate(expr.getText(sourceFile), 100),
        });
      }
      if (isSensitiveIdentifier(propName) && !SAFE_KEY_ALLOWLIST[propName]) {
        const { line, character } = sourceFile.getLineAndCharacterOfPosition(operand.getStart());
        violations.push({
          file: relPath,
          line: line + 1,
          column: character + 1,
          rule: "concat-sensitive",
          message: `Property access to sensitive field in concatenation: .${propName}`,
          snippet: truncate(expr.getText(sourceFile), 100),
        });
      }
    }
  }

  checkOperand(expr.left);
  checkOperand(expr.right);
}

function checkTemplateLiteral(
  node: ts.Node,
  sourceFile: ts.SourceFile
): Array<{ line: number; column: number; expr: string; snippet: string; rule?: string; message?: string }> {
  const violations: Array<{ line: number; column: number; expr: string; snippet: string; rule?: string; message?: string }> = [];

  function checkTemplateSpan(span: ts.TemplateSpan): void {
    const expr = span.expression;
    const exprText = expr.getText(sourceFile);

    // Check for banned webhookId identifier (#332)
    if (ts.isIdentifier(expr)) {
      const name = expr.text;
      if (isBannedLogKey(name)) {
        const { line, character } = sourceFile.getLineAndCharacterOfPosition(expr.getStart());
        violations.push({
          line: line + 1,
          column: character + 1,
          expr: name,
          snippet: truncate(span.getText(sourceFile), 80),
          rule: "banned-log-key",
          message: `Banned identifier in template literal: \${${name}} (removed per #332)`,
        });
        return;
      }
    }

    // Check for banned property access like ${x.webhookId} (#332)
    if (ts.isPropertyAccessExpression(expr)) {
      const propName = expr.name.text;
      if (isBannedLogKey(propName)) {
        const { line, character } = sourceFile.getLineAndCharacterOfPosition(expr.getStart());
        violations.push({
          line: line + 1,
          column: character + 1,
          expr: exprText.trim(),
          snippet: truncate(span.getText(sourceFile), 80),
          rule: "banned-log-key",
          message: `Banned property in template literal: .${propName} (removed per #332)`,
        });
        return;
      }
    }

    // Resource GID interpolation: ${resourceGid}, ${orderGid}, ${message.resourceGid}
    // Log the topic or a static message and the structured safeLog *Gid key instead.
    if (ts.isIdentifier(expr) && isGidIdentifier(expr.text)) {
      const { line, character } = sourceFile.getLineAndCharacterOfPosition(expr.getStart());
      violations.push({
        line: line + 1,
        column: character + 1,
        expr: expr.text,
        snippet: truncate(span.getText(sourceFile), 80),
        rule: "resource-gid",
        message: `Resource GID interpolated in log string: \${${expr.text}}`,
      });
      return;
    }
    if (ts.isPropertyAccessExpression(expr) && isGidIdentifier(expr.name.text)) {
      const { line, character } = sourceFile.getLineAndCharacterOfPosition(expr.getStart());
      violations.push({
        line: line + 1,
        column: character + 1,
        expr: exprText.trim(),
        snippet: truncate(span.getText(sourceFile), 80),
        rule: "resource-gid",
        message: `Resource GID interpolated in log string: .${expr.name.text}`,
      });
      return;
    }

    // Gap 3: Check for bare error-like identifiers (${err}, ${error}, etc.)
    // These should be flagged unless wrapped in a safe call like toErrorCode(err)
    if (ts.isIdentifier(expr)) {
      const name = expr.text;
      if (isErrorLikeIdentifier(name)) {
        const { line, character } = sourceFile.getLineAndCharacterOfPosition(expr.getStart());
        violations.push({
          line: line + 1,
          column: character + 1,
          expr: name,
          snippet: truncate(span.getText(sourceFile), 80),
          rule: "raw-error-arg",
          message: `Bare error identifier in template literal: \${${name}} (use toErrorCode(${name}))`,
        });
        return;
      }
    }

    // P2.3: Match on the last property name for property access
    // ${session.shop}, ${payload.shop}, ${x.shopDomain} should all fail
    if (SENSITIVE_TEMPLATE_LAST_PROP.test(exprText)) {
      const { line, character } = sourceFile.getLineAndCharacterOfPosition(expr.getStart());
      violations.push({
        line: line + 1,
        column: character + 1,
        expr: exprText.trim(),
        snippet: truncate(span.getText(sourceFile), 80),
      });
      return;
    }

    // Check property access for .message/.stack and sensitive last property name
    if (ts.isPropertyAccessExpression(expr)) {
      const propName = expr.name.text;
      // ${err.message}, ${err.stack} should fail
      if (propName === "message" || propName === "stack") {
        const { line, character } = sourceFile.getLineAndCharacterOfPosition(expr.getStart());
        violations.push({
          line: line + 1,
          column: character + 1,
          expr: exprText.trim(),
          snippet: truncate(span.getText(sourceFile), 80),
        });
        return;
      }
      // ${buyer.email}, ${company.name} should fail (sensitive last property)
      if (isSensitiveIdentifier(propName) && !SAFE_KEY_ALLOWLIST[propName]) {
        const { line, character } = sourceFile.getLineAndCharacterOfPosition(expr.getStart());
        violations.push({
          line: line + 1,
          column: character + 1,
          expr: exprText.trim(),
          snippet: truncate(span.getText(sourceFile), 80),
        });
        return;
      }
    }

    // Also check plain identifiers for sensitive values
    if (ts.isIdentifier(expr)) {
      const name = expr.text;
      if (isSensitiveIdentifier(name) && !SAFE_KEY_ALLOWLIST[name]) {
        const { line, character } = sourceFile.getLineAndCharacterOfPosition(expr.getStart());
        violations.push({
          line: line + 1,
          column: character + 1,
          expr: name,
          snippet: truncate(span.getText(sourceFile), 80),
        });
      }
    }
  }

  if (ts.isTemplateExpression(node)) {
    for (const span of node.templateSpans) {
      checkTemplateSpan(span);
    }
  }

  if (ts.isTaggedTemplateExpression(node)) {
    const template = node.template;
    if (ts.isTemplateExpression(template)) {
      for (const span of template.templateSpans) {
        checkTemplateSpan(span);
      }
    }
  }

  return violations;
}

/**
 * Check if a text is ENTIRELY a validation pattern with no real domains.
 * For non-test paths: only exempt escaped-regex and isValidShopDomain(identifier).
 * NO fake subdomain exemptions - those are test-file only.
 * Returns true only if text contains myshopify.com AND all occurrences are protected.
 */
function isValidationPattern(text: string): boolean {
  if (!DOMAIN_LITERAL_PATTERN.test(text)) {
    return false;
  }

  return !hasUnprotectedMyshopifyCom(text);
}

function truncate(text: string, maxLen: number): string {
  const singleLine = text.replace(/\s+/g, " ").trim();
  if (singleLine.length <= maxLen) return singleLine;
  return singleLine.slice(0, maxLen - 3) + "...";
}

// ============================================================================
// Gap 4: Analyze test files for token-prefix and domain-literal only
// These rules target REAL secrets/domains, not test placeholders.
// ============================================================================

/**
 * Real-looking Shopify token pattern for test-file scanning.
 * Matches shpat_/shpua_/shpss_/shpca_/shppa_ followed by 32 hex-like characters.
 * If a token matches this pattern AND isn't obviously synthetic, it's flagged.
 */
const REAL_TOKEN_PATTERN = /shp(?:at|ua|ss|ca|pa)_([0-9a-f]{32,})/gi;

/**
 * Patterns that indicate a synthetic/fake token body (not a real secret).
 * Applied to the 32+ char suffix after the prefix.
 */
function isSyntheticTokenBody(body: string): boolean {
  const lower = body.toLowerCase();
  // Repeated single character: aaaa..., 0000..., ffff...
  if (/^(.)\1+$/.test(lower)) return true;
  // Sequential patterns: 1234567890..., abcdef...
  if (/^0123456789|^123456789|^abcdef|^0{4,}|^f{4,}/.test(lower)) return true;
  // Contains 'test', 'fake', 'mock', 'xxx', 'placeholder', 'example'
  if (/test|fake|mock|xxx|placeholder|example|demo|sample/i.test(lower)) return true;
  // Too short for a real token (real tokens are 32+ chars)
  if (lower.length < 32) return true;
  // Short sequential prefixes followed by padding
  if (/^[0-9]+0{10,}$/.test(lower)) return true;
  return false;
}

/**
 * Check if a line contains a real-looking token (not synthetic test data).
 * Returns true if the line has what appears to be a real Shopify token.
 */
function hasRealLookingToken(line: string): boolean {
  const matches = line.matchAll(REAL_TOKEN_PATTERN);
  for (const match of matches) {
    const body = match[1];
    if (!isSyntheticTokenBody(body)) {
      return true;
    }
  }
  return false;
}

/**
 * Explicit set of fake subdomains that are safe in test files.
 * P1: Only exact matches from this set or prefixes with proper boundaries are allowed.
 * No heuristic substring matching - strict fail-closed approach.
 */
const FAKE_SUBDOMAINS = new Set([
  "example", "test", "fake", "placeholder", "mock", "demo", "sample",
  "sentinel", "invalid", "nonexistent", "my-store", "dev-store",
  "shop", "store", "shop1", "shop2", "shop-a", "shop-b", "shopa", "shopb", "shopc",
]);


/**
 * Check if a subdomain matches a fake prefix with proper boundary.
 * Proper boundary means: prefix followed by hyphen (-), digit, or end of string.
 * P1: No heuristic substring matching - only explicit prefixes with boundaries.
 */
function matchesFakePrefix(subdomain: string): boolean {
  const lower = subdomain.toLowerCase();
  const prefixes = ["test", "fake", "mock", "example", "sentinel"];
  for (const prefix of prefixes) {
    if (lower === prefix) return true;
    if (lower.startsWith(prefix + "-")) return true;
    if (lower.startsWith(prefix) && /^\d/.test(lower.slice(prefix.length))) return true;
  }
  if (/^s\d+(-|$)/.test(lower)) return true;
  return false;
}

/**
 * Check if ALL domains on a line are explicitly fake (safe for test files).
 * P1 Round 4: All checks are PER-MATCH, not line-wide.
 * A domain is fake only if:
 * 1. Its subdomain EXACTLY equals a value in FAKE_SUBDOMAINS, OR
 * 2. Its subdomain starts with test-/fake-/mock-/example-/sentinel- with proper boundary, OR
 * 3. Its subdomain starts with s##- (test suite prefix), OR
 * 4. The subdomain is an ALL_CAPS constant with underscore (e.g., TEST_SHOP), OR
 * 5. The full domain uses a fake TLD (.test, .invalid, .example, .localhost)
 *
 * Template interpolations like `${x}.myshopify.com` are detected separately.
 * Returns true only if ALL domains on the line are fake. Returns false if ANY domain is real.
 */
function allDomainsAreFake(line: string): boolean {
  // P3: Added (?![-\w]) after TLD group to prevent matching partial TLDs like .testing or .myshopify.com-evil
  const domainRegex = /([a-z0-9][-_a-z0-9]*)\.(myshopify\.com|test|invalid|example|localhost)(?![-\w])/gi;
  let match;
  let foundAnyLiteralDomain = false;
  
  while ((match = domainRegex.exec(line)) !== null) {
    const subdomain = match[1].toLowerCase();
    const originalCase = match[1];
    const tld = match[2].toLowerCase();

    if (tld !== "myshopify.com") continue;

    foundAnyLiteralDomain = true;

    if (/^[A-Z][A-Z0-9]*_[A-Z0-9_]+$/.test(originalCase)) continue;

    if (FAKE_SUBDOMAINS.has(subdomain)) continue;

    if (matchesFakePrefix(subdomain)) continue;

    return false;
  }

  if (foundAnyLiteralDomain) {
    return true;
  }

  if (/\$\{[^}]+\}\.myshopify\.com/i.test(line)) {
    return true;
  }

  if (/['"`]\s*\+\s*[a-zA-Z_$][\w$]*\s*\+?\s*['"`]?[^'"]*\.myshopify\.com/i.test(line)) {
    return true;
  }

  // P1: Escaped-regex patterns like `\.myshopify\.com` or `[a-z]+\.myshopify\.com` are safe
  // (they match the domain pattern in a regex, not a literal domain)
  if (/\\\.myshopify\\\.com/i.test(line)) {
    return true;
  }

  return false;
}

/**
 * Domain skip patterns for test file scanning.
 * P1: Must be strict - only these specific patterns are allowed:
 * - .not.toContain( / .not.toMatch( - assertions checking absence
 * - Test description strings (it/describe/test) mentioning myshopify
 */
const DOMAIN_SKIP_PATTERNS = [
  /\.not\.toContain\(/,
  /\.not\.toMatch\(/,
  /^[^'"]*(?:it|describe|test)\s*\(\s*["'`][^"'`]*myshopify/i,
];

function analyzeTestFile(testFile: TestFile): Violation[] {
  const violations: Violation[] = [];
  const sourceText = fs.readFileSync(testFile.fullPath, "utf-8");
  const lines = sourceText.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNum = i + 1;

    // Skip comments
    if (line.trim().startsWith("//") || line.trim().startsWith("*")) continue;

    // Check for token prefixes (shpat_, shpua_, shpss_, shpca_, shppa_)
    // P2 Round 5: Removed regex-literal/RegExp skips - hasRealLookingToken handles patterns
    if (TOKEN_PREFIX_PATTERN.test(line)) {
      // Skip if it's in a file that handles token redaction
      if (/\/log\.server|lib\/log/i.test(testFile.relPath) || testFile.relPath.includes("sentry")) continue;

      // Check if the token VALUE looks real (32+ hex chars, not synthetic)
      // Pattern text like `shpat_[a-f0-9]{32}` has no 32 literal hex chars, so it's ignored
      if (hasRealLookingToken(line)) {
        violations.push({
          file: testFile.relPath,
          line: lineNum,
          column: 1,
          rule: "token-prefix",
          message: "Real-looking token found in test file (shpat_/shpua_/shpss_/shpca_/shppa_ + 32 hex)",
          snippet: truncate(line, 100),
        });
      }
    }

    // Check for myshopify.com domain literal
    // P1 fix: Strict fail-closed - only allow explicitly fake domains
    // P1 Round 5: Removed VALIDATION_PATTERNS line-wide skip; escaped-regex handled in allDomainsAreFake
    if (DOMAIN_LITERAL_PATTERN.test(line)) {
      // Skip comments
      if (line.trim().startsWith("//") || line.trim().startsWith("*")) continue;
      // Skip specific assertion patterns (P1: strict list only)
      if (DOMAIN_SKIP_PATTERNS.some((p) => p.test(line))) continue;

      // P1: Only allow explicitly fake domains - check EVERY domain on the line
      if (!allDomainsAreFake(line)) {
        violations.push({
          file: testFile.relPath,
          line: lineNum,
          column: 1,
          rule: "domain-literal",
          message: "Real-looking domain in test file (not in fake domain allowlist)",
          snippet: truncate(line, 100),
        });
      }
    }
  }

  return violations;
}

// ============================================================================
// Gap 5: No-mock-logger rule
// ============================================================================

/**
 * Patterns that indicate logger mocking violations:
 * 1. vi.mock with path resolving to app/lib/log.server
 * 2. vi.spyOn(<log module>, 'safeLog'|'toErrorCode'|'shopHash') with mockImplementation/mockReturnValue
 * 3. vi.mock factories that replace safeLog or toErrorCode
 */
function analyzeTestFileForLoggerMocks(testFile: TestFile): Violation[] {
  const violations: Violation[] = [];
  const sourceText = fs.readFileSync(testFile.fullPath, "utf-8");
  const sourceFile = ts.createSourceFile(
    testFile.fullPath,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    testFile.fullPath.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  );

  // P3: Clear spy tracking at the start of each file to avoid cross-file false positives
  spyOnAssignments.clear();

  function visit(node: ts.Node): void {
    if (ts.isCallExpression(node)) {
      checkLoggerMock(node, sourceFile, testFile.relPath, violations);
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return violations;
}

/**
 * Mock method patterns that indicate implementation replacement.
 */
const MOCK_METHOD_PATTERNS = new Set([
  "mockImplementation",
  "mockImplementationOnce",
  "mockReturnValue",
  "mockReturnValueOnce",
  "mockResolvedValue",
  "mockResolvedValueOnce",
  "mockRejectedValue",
  "mockRejectedValueOnce",
]);

/**
 * Logger function names that should not be mocked.
 */
const LOGGER_FUNCTIONS = new Set(["safeLog", "toErrorCode", "shopHash"]);

/**
 * Track variable assignments from vi.spyOn for two-statement mock detection.
 */
const spyOnAssignments = new Map<string, { methodName: string; node: ts.Node }>();

/**
 * Check if a call expression is mocking the logger.
 */
function checkLoggerMock(
  call: ts.CallExpression,
  sourceFile: ts.SourceFile,
  relPath: string,
  violations: Violation[]
): void {
  const callName = getCallName(call);

  // Check vi.mock / vi.doMock / jest.mock / jest.doMock with log.server path
  if (callName === "vi.mock" || callName === "vi.doMock" || 
      callName === "jest.mock" || callName === "jest.doMock") {
    const pathArg = call.arguments[0];
    if (pathArg && (ts.isStringLiteral(pathArg) || ts.isNoSubstitutionTemplateLiteral(pathArg))) {
      const pathText = pathArg.text;
      // Match log.server with proper anchoring (not catalog.server, etc.)
      if (/\/log\.server|lib\/log|^~\/lib\/log|^\.\.\/.*\/log\.server/i.test(pathText)) {
        const { line, character } = sourceFile.getLineAndCharacterOfPosition(call.getStart());
        violations.push({
          file: relPath,
          line: line + 1,
          column: character + 1,
          rule: "no-mock-logger",
          message: `Test mocks the logger module (${pathText}). Use the real safeLog/toErrorCode instead.`,
          snippet: truncate(call.getText(sourceFile), 100),
        });
        return;
      }
    }

    // Check factory argument (arrow function or function expression)
    const factoryArg = call.arguments[1];
    if (factoryArg && (ts.isArrowFunction(factoryArg) || ts.isFunctionExpression(factoryArg))) {
      const factoryText = factoryArg.getText(sourceFile);
      // Check for safeLog/toErrorCode/shopHash replacements
      if (/safeLog\s*:|toErrorCode\s*:|shopHash\s*:/i.test(factoryText)) {
        const { line, character } = sourceFile.getLineAndCharacterOfPosition(call.getStart());
        violations.push({
          file: relPath,
          line: line + 1,
          column: character + 1,
          rule: "no-mock-logger",
          message: `Test ${callName} factory replaces safeLog/toErrorCode/shopHash. Use the real implementations instead.`,
          snippet: truncate(call.getText(sourceFile), 100),
        });
        return;
      }
      // Check for importOriginal spread with overrides
      if (/importOriginal|\.\.\..*actual/i.test(factoryText) && 
          /safeLog|toErrorCode|shopHash/i.test(factoryText)) {
        const { line, character } = sourceFile.getLineAndCharacterOfPosition(call.getStart());
        violations.push({
          file: relPath,
          line: line + 1,
          column: character + 1,
          rule: "no-mock-logger",
          message: `Test ${callName} factory with importOriginal overrides safeLog/toErrorCode/shopHash.`,
          snippet: truncate(call.getText(sourceFile), 100),
        });
        return;
      }
    }
  }

  // Check vi.spyOn with safeLog/toErrorCode/shopHash
  if (callName === "vi.spyOn" || callName === "jest.spyOn") {
    const methodArg = call.arguments[1];
    if (methodArg && ts.isStringLiteral(methodArg)) {
      const methodName = methodArg.text;
      if (LOGGER_FUNCTIONS.has(methodName)) {
        // Check if there's a chained mock method
        let parent: ts.Node = call.parent;
        while (parent && ts.isPropertyAccessExpression(parent)) {
          const propName = parent.name.text;
          if (MOCK_METHOD_PATTERNS.has(propName)) {
            // Check if the parent is a call (mockImplementation())
            if (parent.parent && ts.isCallExpression(parent.parent)) {
              const { line, character } = sourceFile.getLineAndCharacterOfPosition(call.getStart());
              violations.push({
                file: relPath,
                line: line + 1,
                column: character + 1,
                rule: "no-mock-logger",
                message: `Test spies on ${methodName} with ${propName}. Use the real implementation instead.`,
                snippet: truncate(parent.parent.getText(sourceFile), 100),
              });
              return;
            }
          }
          parent = parent.parent;
        }

        // Track for two-statement form: const spy = vi.spyOn(log, "safeLog"); spy.mockImplementation(...)
        // Check if this is a variable assignment
        let assignParent: ts.Node = call.parent;
        while (assignParent) {
          if (ts.isVariableDeclaration(assignParent) && ts.isIdentifier(assignParent.name)) {
            spyOnAssignments.set(assignParent.name.text, { methodName, node: call });
            break;
          }
          assignParent = assignParent.parent;
        }
      }
    }
  }

  // Check for two-statement spy form: spy.mockImplementation(...)
  // where spy was assigned from vi.spyOn(log, "safeLog")
  if (ts.isPropertyAccessExpression(call.expression)) {
    const propName = call.expression.name.text;
    if (MOCK_METHOD_PATTERNS.has(propName)) {
      const objExpr = call.expression.expression;
      if (ts.isIdentifier(objExpr)) {
        const varName = objExpr.text;
        const spyInfo = spyOnAssignments.get(varName);
        if (spyInfo && LOGGER_FUNCTIONS.has(spyInfo.methodName)) {
          const { line, character } = sourceFile.getLineAndCharacterOfPosition(call.getStart());
          violations.push({
            file: relPath,
            line: line + 1,
            column: character + 1,
            rule: "no-mock-logger",
            message: `Test calls ${propName} on spy of ${spyInfo.methodName}. Use the real implementation instead.`,
            snippet: truncate(call.getText(sourceFile), 100),
          });
        }
      }
    }
  }
}

// ============================================================================
// Logger Mock Allowlist
// ============================================================================

interface LoggerMockAllowlistResult {
  entries: Map<string, string>;
  invalidEntries: Array<{ line: number; text: string; issue: string }>;
}

function loadLoggerMockAllowlist(filePath: string): LoggerMockAllowlistResult {
  const entries = new Map<string, string>();
  const invalidEntries: Array<{ line: number; text: string; issue: string }> = [];

  if (!fs.existsSync(filePath)) {
    return { entries, invalidEntries };
  }

  const content = fs.readFileSync(filePath, "utf-8");
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    // Format: path: reason
    const colonIndex = trimmed.indexOf(":");
    if (colonIndex > 0) {
      const entryPath = trimmed.slice(0, colonIndex).trim();
      const reason = trimmed.slice(colonIndex + 1).trim();

      // P3: Fail CI on empty or 'legacy' reason
      if (!reason) {
        invalidEntries.push({ line: i + 1, text: trimmed, issue: "empty reason" });
        continue;
      }
      if (reason.toLowerCase() === "legacy") {
        invalidEntries.push({ line: i + 1, text: trimmed, issue: "reason cannot be 'legacy'" });
        continue;
      }

      if (entryPath) {
        entries.set(entryPath, reason);
      }
    }
  }

  return { entries, invalidEntries };
}

// ============================================================================
// Allowlist Management
// ============================================================================

function loadAllowlist(filePath: string): Map<string, number> {
  const allowlist = new Map<string, number>();

  if (!fs.existsSync(filePath)) {
    return allowlist;
  }

  const content = fs.readFileSync(filePath, "utf-8");
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const parts = trimmed.split(":");
    if (parts.length >= 3) {
      const file = parts[0].trim();
      const rule = parts[1].trim();
      const count = parseInt(parts[2].trim(), 10);
      if (file && rule && !isNaN(count)) {
        allowlist.set(`${file}:${rule}`, count);
      }
    }
  }

  return allowlist;
}

function groupViolations(violations: Violation[]): Map<string, Violation[]> {
  const groups = new Map<string, Violation[]>();

  for (const v of violations) {
    const key = `${v.file}:${v.rule}`;
    const list = groups.get(key) ?? [];
    list.push(v);
    groups.set(key, list);
  }

  return groups;
}

// ============================================================================
// Main
// ============================================================================

/**
 * Result of running the logging guard analysis.
 */
export interface AnalysisResult {
  exitCode: number;
  output: string;
}

/**
 * Run the logging guard analysis on a directory.
 * This is the single implementation - main() is a thin wrapper.
 *
 * @param rootDir - Root directory to scan
 * @param allowlistFile - Path to logging allowlist file
 * @param loggerMockAllowlistFile - Path to logger mock allowlist file (required)
 * @returns Analysis result with exit code and output
 */
export function runAnalysis(
  rootDir: string,
  allowlistFile: string,
  loggerMockAllowlistFile: string
): AnalysisResult {
  const outputLines: string[] = [];
  const log = (msg: string) => outputLines.push(msg);

  const { tsFiles, scriptFiles, testFiles } = findSourceFiles(rootDir);

  log("=== AST-based Logging Guard Check ===\n");
  log(`Scanning ${tsFiles.length} TypeScript files, ${scriptFiles.length} script files, and ${testFiles.length} test files...\n`);

  const allViolations: Violation[] = [];
  const loggerMockViolations: Violation[] = [];

  for (const file of tsFiles) {
    const violations = analyzeFile(file, rootDir);
    allViolations.push(...violations);
  }

  for (const file of scriptFiles) {
    const violations = analyzeScriptFile(file, rootDir);
    allViolations.push(...violations);
  }

  for (const testFile of testFiles) {
    const violations = analyzeTestFile(testFile);
    allViolations.push(...violations);
  }

  for (const testFile of testFiles) {
    const violations = analyzeTestFileForLoggerMocks(testFile);
    loggerMockViolations.push(...violations);
  }

  const grouped = groupViolations(allViolations);
  const allowlist = loadAllowlist(allowlistFile);
  const { entries: loggerMockAllowlist, invalidEntries: invalidLoggerMockEntries } =
    loadLoggerMockAllowlist(loggerMockAllowlistFile);

  let newViolations = 0;
  const overAllowlist: Array<{
    key: string;
    found: number;
    allowed: number;
    violations: Violation[];
  }> = [];
  const staleEntries: Array<{ key: string; allowed: number; found: number }> = [];

  for (const [key, violations] of grouped) {
    const found = violations.length;
    const allowed = allowlist.get(key) ?? 0;

    if (found > allowed) {
      newViolations += found - allowed;
      overAllowlist.push({ key, found, allowed, violations });
    }
  }

  for (const [key, allowed] of allowlist) {
    const found = grouped.get(key)?.length ?? 0;
    if (found < allowed) {
      staleEntries.push({ key, allowed, found });
    }
  }

  const newLoggerMockViolations: Violation[] = [];
  const loggerMockFilesWithViolations = new Set<string>();
  for (const v of loggerMockViolations) {
    loggerMockFilesWithViolations.add(v.file);
    if (!loggerMockAllowlist.has(v.file)) {
      newLoggerMockViolations.push(v);
    }
  }

  const staleLoggerMockEntries: Array<{ path: string; reason: string }> = [];
  for (const [pathKey, reason] of loggerMockAllowlist) {
    if (!loggerMockFilesWithViolations.has(pathKey)) {
      staleLoggerMockEntries.push({ path: pathKey, reason });
    }
  }

  log("=== Results ===\n");

  let shouldFail = false;

  if (newViolations === 0 && staleEntries.length === 0 &&
      newLoggerMockViolations.length === 0 && staleLoggerMockEntries.length === 0 &&
      invalidLoggerMockEntries.length === 0) {
    log("\x1b[32m✓ No logging violations found\x1b[0m");
    return { exitCode: 0, output: outputLines.join("\n") };
  }

  if (newViolations > 0) {
    shouldFail = true;
    log(`\x1b[31m✗ Found ${newViolations} NEW logging violation(s) above allowlist:\x1b[0m\n`);

    for (const { key, found, allowed, violations } of overAllowlist) {
      log(`  ${key}: found ${found}, allowed ${allowed}`);
      for (const v of violations.slice(0, 5)) {
        log(`    ${v.file}:${v.line} ${v.message}`);
        log(`      ${v.snippet}`);
      }
      if (violations.length > 5) {
        log(`    ... and ${violations.length - 5} more`);
      }
      log("");
    }

    log("\x1b[33mTo fix: Update the code to use safeLog with shopId/shopHash.\x1b[0m");
    log("\x1b[33mTo allowlist (temporary): add/update entry in scripts/ci/logging-allowlist.txt\x1b[0m");
    log("\x1b[33mFormat: file:rule:count\x1b[0m\n");
  }

  if (staleEntries.length > 0) {
    shouldFail = true;
    log(`\x1b[31m✗ Found ${staleEntries.length} stale/over-counted allowlist entry(ies):\x1b[0m\n`);
    for (const { key, allowed, found } of staleEntries) {
      log(`  ${key}: allowed ${allowed}, found only ${found}`);
    }
    log("\n\x1b[33mTo fix: Reduce the count in logging-allowlist.txt to match actual violations.\x1b[0m\n");
  }

  if (newLoggerMockViolations.length > 0) {
    shouldFail = true;
    log(`\x1b[31m✗ Found ${newLoggerMockViolations.length} logger mock violation(s):\x1b[0m\n`);
    for (const v of newLoggerMockViolations) {
      log(`  ${v.file}:${v.line} ${v.message}`);
      log(`    ${v.snippet}`);
    }
    log("\n\x1b[33mTo fix: Use the real safeLog/toErrorCode/shopHash instead of mocking.\x1b[0m");
    log("\x1b[33mTo allowlist (with justification): add entry to scripts/ci/logger-mock-allowlist.txt\x1b[0m");
    log("\x1b[33mFormat: path: reason (reason must not be 'legacy')\x1b[0m\n");
  }

  if (staleLoggerMockEntries.length > 0) {
    shouldFail = true;
    log(`\x1b[31m✗ Found ${staleLoggerMockEntries.length} stale logger-mock-allowlist entry(ies):\x1b[0m\n`);
    for (const { path: entryPath, reason } of staleLoggerMockEntries) {
      log(`  ${entryPath}: ${reason}`);
    }
    log("\n\x1b[33mTo fix: Remove the stale entry from scripts/ci/logger-mock-allowlist.txt\x1b[0m\n");
  }

  if (invalidLoggerMockEntries.length > 0) {
    shouldFail = true;
    log(`\x1b[31m✗ Found ${invalidLoggerMockEntries.length} invalid logger-mock-allowlist entry(ies):\x1b[0m\n`);
    for (const { line, text, issue } of invalidLoggerMockEntries) {
      log(`  Line ${line}: ${text} (${issue})`);
    }
    log("\n\x1b[33mTo fix: Provide a valid reason (not 'legacy' or empty) in scripts/ci/logger-mock-allowlist.txt\x1b[0m\n");
  }

  return { exitCode: shouldFail ? 1 : 0, output: outputLines.join("\n") };
}

function main(): void {
  const result = runAnalysis(REPO_ROOT, ALLOWLIST_FILE, LOGGER_MOCK_ALLOWLIST_FILE);
  console.log(result.output);
  process.exit(result.exitCode);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main();
}
