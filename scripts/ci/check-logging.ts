#!/usr/bin/env npx tsx
/**
 * AST-based CI logging guard for PII/domain leak prevention.
 *
 * Checks app/**, workers/**, scripts/** files for:
 * 1. console.*, safeLog, Sentry.* calls with sensitive data
 * 2. Template literals interpolating shop/domain identifiers
 * 3. captureException with raw catch variables
 * 4. Script files (.sh/.mjs) with domain literals or token prefixes
 *
 * Maintains burn-down allowlist format: file:rule:count
 */

import * as ts from "typescript";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

// ============================================================================
// Configuration
// ============================================================================

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Allow overriding via environment for testing
const REPO_ROOT = process.env.LOGGING_GUARD_ROOT ?? path.resolve(__dirname, "../..");
const ALLOWLIST_FILE = process.env.LOGGING_GUARD_ALLOWLIST ?? path.join(__dirname, "logging-allowlist.txt");

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
 * Token prefix patterns for text-based scanning of scripts.
 */
const TOKEN_PREFIX_PATTERN = /shpat_|shpua_|shpss_/;

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
  total: "Generic count field in stat objects",
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
 * Validation regex patterns that are safe (these test strings, not log them).
 */
const VALIDATION_PATTERNS = [
  /\.test\(/,
  /RegExp\(/,
  /isValidShopDomain/,
  /\\\.myshopify\\\.com/,
];

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

// ============================================================================
// File Discovery
// ============================================================================

interface SourceFiles {
  tsFiles: string[];
  scriptFiles: string[];
}

function findSourceFiles(rootDir: string): SourceFiles {
  const tsFiles: string[] = [];
  const scriptFiles: string[] = [];
  const dirsToSearch = ["app", "workers", "scripts"];

  for (const dir of dirsToSearch) {
    const fullPath = path.join(rootDir, dir);
    if (fs.existsSync(fullPath)) {
      walkDirectory(fullPath, tsFiles, scriptFiles, rootDir);
    }
  }

  return { tsFiles, scriptFiles };
}

function walkDirectory(
  dir: string,
  tsFiles: string[],
  scriptFiles: string[],
  rootDir: string
): void {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const relDir = path.relative(rootDir, dir);

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      // Skip node_modules everywhere
      if (entry.name === "node_modules") continue;

      // Skip __tests__ and test directories
      if (entry.name === "__tests__" || entry.name === "test") continue;

      // Skip scripts/ci (self) and scripts/ci/__tests__/fixtures specifically
      if (relDir === "scripts" && entry.name === "ci") continue;

      walkDirectory(fullPath, tsFiles, scriptFiles, rootDir);
    } else if (entry.isFile()) {
      // TypeScript files (exclude test files)
      if (
        (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) &&
        !entry.name.endsWith(".test.ts") &&
        !entry.name.endsWith(".test.tsx")
      ) {
        tsFiles.push(fullPath);
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

function analyzeScriptFile(filePath: string): Violation[] {
  const violations: Violation[] = [];
  const content = fs.readFileSync(filePath, "utf-8");
  const lines = content.split("\n");
  const relPath = path.relative(REPO_ROOT, filePath);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNum = i + 1;

    // Skip comments
    if (line.trim().startsWith("#") || line.trim().startsWith("//")) continue;

    // Check for myshopify.com domain literal
    if (DOMAIN_LITERAL_PATTERN.test(line)) {
      // Skip validation patterns
      if (!VALIDATION_PATTERNS.some((p) => p.test(line))) {
        // Skip if it's in a help/usage message context
        if (!line.includes("e.g.") && !line.includes("example") && !line.includes("placeholder")) {
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

function analyzeFile(filePath: string): Violation[] {
  const violations: Violation[] = [];
  const sourceText = fs.readFileSync(filePath, "utf-8");
  const sourceFile = ts.createSourceFile(
    filePath,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    filePath.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  );

  const relPath = path.relative(REPO_ROOT, filePath);

  // Also check for token prefixes in TS files (but not in safeLog helper or regex patterns)
  const lines = sourceText.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (TOKEN_PREFIX_PATTERN.test(line)) {
      // Skip comments
      if (line.trim().startsWith("//") || line.trim().startsWith("*")) continue;
      // Skip regex patterns (used for validation/redaction)
      if (/\/.*shp[atu]{2}_/.test(line) || /RegExp|\.test\(|\.replace\(/.test(line)) continue;
      // Skip if it's in a file that handles token redaction
      if (relPath.includes("log.server") || relPath.includes("sentry")) continue;

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
  // Check template literals for shop interpolation
  if (ts.isTemplateExpression(arg) || ts.isTaggedTemplateExpression(arg)) {
    const templateViolations = checkTemplateLiteral(arg, sourceFile);
    for (const v of templateViolations) {
      violations.push({
        file: relPath,
        line: v.line,
        column: v.column,
        rule: "shop-interpolation",
        message: `Template literal interpolates sensitive variable: ${v.expr}`,
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
  }

  // Check object literals for sensitive keys and values
  if (ts.isObjectLiteralExpression(arg)) {
    checkObjectLiteral(arg, sourceFile, relPath, violations);
  }

  // Check array literals (P3.10)
  if (ts.isArrayLiteralExpression(arg)) {
    checkArrayLiteral(arg, sourceFile, relPath, violations);
  }

  // Check identifier arguments (P2.4) - e.g., console.error(err), console.log(shopDomain)
  // No argIndex > 0 condition - check ALL arguments
  if (ts.isIdentifier(arg)) {
    const name = arg.text;
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
 * Check if an identifier name looks like an error variable.
 */
function isErrorLikeIdentifier(name: string): boolean {
  const lower = name.toLowerCase();
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

    // Check key
    if (ts.isStringLiteral(keyArg)) {
      const keyName = keyArg.text;
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

    // Check value (P2.5)
    checkSentryValue(valueArg, methodName, sourceFile, relPath, violations);
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
          rule: "shop-interpolation",
          message: `Template in Sentry call interpolates sensitive variable: ${v.expr}`,
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
    }
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
  // Check identifier values: { store: shop }
  if (ts.isIdentifier(value)) {
    const name = value.text;
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

  // Check property access: { error: err.message } or { x: foo.stack }
  if (ts.isPropertyAccessExpression(value)) {
    const propName = value.name.text;
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
 * Check string concatenation for sensitive identifiers (P2.7).
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
): Array<{ line: number; column: number; expr: string; snippet: string }> {
  const violations: Array<{ line: number; column: number; expr: string; snippet: string }> = [];

  function checkTemplateSpan(span: ts.TemplateSpan): void {
    const expr = span.expression;
    const exprText = expr.getText(sourceFile);

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

    // Also check plain identifiers
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

function isValidationPattern(text: string): boolean {
  return VALIDATION_PATTERNS.some((pattern) => pattern.test(text));
}

function truncate(text: string, maxLen: number): string {
  const singleLine = text.replace(/\s+/g, " ").trim();
  if (singleLine.length <= maxLen) return singleLine;
  return singleLine.slice(0, maxLen - 3) + "...";
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

function main(): void {
  console.log("=== AST-based Logging Guard Check ===\n");

  const { tsFiles, scriptFiles } = findSourceFiles(REPO_ROOT);
  console.log(`Scanning ${tsFiles.length} TypeScript files and ${scriptFiles.length} script files...\n`);

  const allViolations: Violation[] = [];

  // Analyze TypeScript files
  for (const file of tsFiles) {
    const violations = analyzeFile(file);
    allViolations.push(...violations);
  }

  // Analyze script files (text-based)
  for (const file of scriptFiles) {
    const violations = analyzeScriptFile(file);
    allViolations.push(...violations);
  }

  const grouped = groupViolations(allViolations);
  const allowlist = loadAllowlist(ALLOWLIST_FILE);

  let newViolations = 0;
  const overAllowlist: Array<{
    key: string;
    found: number;
    allowed: number;
    violations: Violation[];
  }> = [];
  const staleEntries: Array<{ key: string; allowed: number; found: number }> = [];

  // Check for violations exceeding allowlist
  for (const [key, violations] of grouped) {
    const found = violations.length;
    const allowed = allowlist.get(key) ?? 0;

    if (found > allowed) {
      newViolations += found - allowed;
      overAllowlist.push({ key, found, allowed, violations });
    }
  }

  // Check for stale allowlist entries (P2.6: fail on stale/over-counted)
  for (const [key, allowed] of allowlist) {
    const found = grouped.get(key)?.length ?? 0;
    if (found < allowed) {
      staleEntries.push({ key, allowed, found });
    }
  }

  // Report results
  console.log("=== Results ===\n");

  if (newViolations === 0 && staleEntries.length === 0) {
    console.log("\x1b[32m✓ No logging violations found\x1b[0m");
    process.exit(0);
  }

  let shouldFail = false;

  if (newViolations > 0) {
    shouldFail = true;
    console.log(
      `\x1b[31m✗ Found ${newViolations} NEW logging violation(s) above allowlist:\x1b[0m\n`
    );

    for (const { key, found, allowed, violations } of overAllowlist) {
      console.log(`  ${key}: found ${found}, allowed ${allowed}`);
      for (const v of violations.slice(0, 5)) {
        console.log(`    ${v.file}:${v.line} ${v.message}`);
        console.log(`      ${v.snippet}`);
      }
      if (violations.length > 5) {
        console.log(`    ... and ${violations.length - 5} more`);
      }
      console.log();
    }

    console.log("\x1b[33mTo fix: Update the code to use safeLog with shopId/shopHash.\x1b[0m");
    console.log("\x1b[33mTo allowlist (temporary): add/update entry in scripts/ci/logging-allowlist.txt\x1b[0m");
    console.log("\x1b[33mFormat: file:rule:count\x1b[0m\n");
  }

  // P2.6: Stale entries now FAIL (ratchet)
  if (staleEntries.length > 0) {
    shouldFail = true;
    console.log(
      `\x1b[31m✗ Found ${staleEntries.length} stale/over-counted allowlist entry(ies):\x1b[0m\n`
    );
    for (const { key, allowed, found } of staleEntries) {
      console.log(`  ${key}: allowed ${allowed}, found only ${found}`);
    }
    console.log("\n\x1b[33mTo fix: Reduce the count in logging-allowlist.txt to match actual violations.\x1b[0m\n");
  }

  process.exit(shouldFail ? 1 : 0);
}

main();
