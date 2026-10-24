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
import { fileURLToPath } from "url";

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
      const isInTestDir = relDir.includes("__tests__") || relDir.includes("/test/");
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
  sourceFile: ts.SourceFile
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
 * Gap 1: Check Sentry setContext/setExtras argument for identifier/object.
 * Resolves const initializers in same scope.
 */
function checkSentryContextArg(
  arg: ts.Node,
  methodName: string,
  sourceFile: ts.SourceFile,
  relPath: string,
  violations: Violation[]
): void {
  // If it's an object literal, the existing checkObjectLiteral handles it
  if (ts.isObjectLiteralExpression(arg)) {
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
      // If resolved to an object literal, check it
      if (ts.isObjectLiteralExpression(initializer)) {
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
  }
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
): Array<{ line: number; column: number; expr: string; snippet: string; rule?: string; message?: string }> {
  const violations: Array<{ line: number; column: number; expr: string; snippet: string; rule?: string; message?: string }> = [];

  function checkTemplateSpan(span: ts.TemplateSpan): void {
    const expr = span.expression;
    const exprText = expr.getText(sourceFile);

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

function isValidationPattern(text: string): boolean {
  return VALIDATION_PATTERNS.some((pattern) => pattern.test(text));
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
 * Patterns that indicate test/mock token data (not real secrets).
 * Test files frequently use fake tokens in fixture data.
 */
const TEST_TOKEN_PATTERNS = [
  // Test/mock token patterns
  /_test/i,
  /test[-_]/i,
  /mock[-_]?token/i,
  /fake[-_]?token/i,
  /[-_]token/i,
  /token[-_]/i,
  /legacy[-_]?token/i,
  /online[-_]?token/i,
  /offline[-_]?token/i,
  /valid[-_]?token/i,
  /bigint[-_]?token/i,
  /expired[-_]?token/i,
  /apply[-_]?token/i,
  /access[-_]?token/i,
  
  // Template interpolations with tokens
  /shp[atu]{2}_token_\$\{/i,
  /shp[atu]{2}_.*\$\{/i,
  
  // Any token that's clearly test data (simple names)
  /shpat_[a-z_-]+["'`]/i,
  /shpua_[a-z_-]+["'`]/i,
  /shpss_[a-z_-]+["'`]/i,
];

/**
 * Patterns that indicate test/mock domain data (not real domains).
 * Test files use these for fixtures and assertions.
 * 
 * In test files, we're very permissive - we only flag domains that look
 * like they could be REAL production domains (not test/mock data).
 * Since test files are not deployed, the risk is lower.
 */
const TEST_DOMAIN_PATTERNS = [
  // Common test patterns
  /test[-.]?.*\.myshopify\.com/i,
  /example\.myshopify\.com/i,
  /fake\.myshopify\.com/i,
  /placeholder\.myshopify\.com/i,
  /mock[-.]?.*\.myshopify\.com/i,
  /shop[12a-z]\.myshopify\.com/i,
  /qa[-.]?.*\.myshopify\.com/i,
  /dev[-.]?.*\.myshopify\.com/i,
  /staging[-.]?.*\.myshopify\.com/i,
  /demo[-.]?.*\.myshopify\.com/i,
  /sample[-.]?.*\.myshopify\.com/i,
  
  // Template interpolations
  /\$\{.*\}\.myshopify\.com/i,
  
  // Descriptive test domain names
  /[a-z]+-test.*\.myshopify\.com/i,
  /sentinel.*\.myshopify\.com/i,
  /nonexistent.*\.myshopify\.com/i,
  /unknown.*\.myshopify\.com/i,
  /deleted[-.]?.*\.myshopify\.com/i,
  /revoked[-.]?.*\.myshopify\.com/i,
  /expired[-.]?.*\.myshopify\.com/i,
  /missing[-.]?.*\.myshopify\.com/i,
  /other[-.]?.*\.myshopify\.com/i,
  /empty[-.]?.*\.myshopify\.com/i,
  /failing[-.]?.*\.myshopify\.com/i,
  /sensitive[-.]?.*\.myshopify\.com/i,
  /reinstall[-.]?.*\.myshopify\.com/i,
  /fresh[-.]?.*\.myshopify\.com/i,
  /idempotent[-.]?.*\.myshopify\.com/i,
  /retry[-.]?.*\.myshopify\.com/i,
  /error[-.]?.*\.myshopify\.com/i,
  /context[-.]?.*\.myshopify\.com/i,
  /scopes[-.]?.*\.myshopify\.com/i,
  /uninstall[-.]?.*\.myshopify\.com/i,
  /direct[-.]?.*\.myshopify\.com/i,
  /my[-.]?.*\.myshopify\.com/i,
  /no[-.]?sessions[-.]?.*\.myshopify\.com/i,
  /events[-.]?.*\.myshopify\.com/i,
  /traditional[-.]?.*\.myshopify\.com/i,
  /customer[-.]?.*\.myshopify\.com/i,
  /reconcile[-.]?.*\.myshopify\.com/i,
  /redact[-.]?.*\.myshopify\.com/i,
  
  // Known internal/dev stores
  /net-terms-receivables\.myshopify\.com/i,
  
  // Generic patterns (test fixture domains often follow these)
  /[a-z]+-[a-z]+\.myshopify\.com/i,
  /[a-z]+\.myshopify\.com/,
];

/**
 * Assertion and test description patterns.
 * These are meta-level references to domains, not actual domain usage.
 */
const ASSERTION_PATTERNS = [
  // Assertions checking domains are NOT present
  /\.not\.toContain\(/,
  /\.not\.toMatch\(/,
  /expect\(.*\)\.not\./,
  /\.toBe\(false\)/,
  /toContain\(".*myshopify\.com"\)/i,
  
  // Test descriptions mentioning domains (it("...", describe("...")
  /it\s*\(\s*["'`].*myshopify/i,
  /describe\s*\(\s*["'`].*myshopify/i,
  /test\s*\(\s*["'`].*myshopify/i,
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

    // Check for token prefixes (shpat_, shpua_, shpss_)
    if (TOKEN_PREFIX_PATTERN.test(line)) {
      // Skip regex patterns (used for validation/redaction)
      if (/\/.*shp[atu]{2}_/.test(line) || /RegExp|\.test\(|\.replace\(/.test(line)) continue;
      // Skip if it's in a file that handles token redaction
      if (testFile.relPath.includes("log.server") || testFile.relPath.includes("sentry")) continue;
      // Skip test/mock token patterns (clearly fake tokens in test data)
      if (TEST_TOKEN_PATTERNS.some((p) => p.test(line))) continue;
      // Skip assertions about tokens
      if (ASSERTION_PATTERNS.some((p) => p.test(line))) continue;

      violations.push({
        file: testFile.relPath,
        line: lineNum,
        column: 1,
        rule: "token-prefix",
        message: "Token prefix pattern found in test file (shpat_/shpua_/shpss_)",
        snippet: truncate(line, 100),
      });
    }

    // Check for myshopify.com domain literal
    if (DOMAIN_LITERAL_PATTERN.test(line)) {
      // Skip comments
      if (line.trim().startsWith("//") || line.trim().startsWith("*")) continue;
      // Skip validation patterns
      if (VALIDATION_PATTERNS.some((p) => p.test(line))) continue;
      // Skip if it's in a help/usage/example context
      if (line.includes("e.g.") || line.includes("example") || line.includes("placeholder")) continue;
      // Skip test/mock domain patterns (clearly fake domains in test data)
      if (TEST_DOMAIN_PATTERNS.some((p) => p.test(line))) continue;
      // Skip assertion patterns (tests checking domains are NOT logged)
      if (ASSERTION_PATTERNS.some((p) => p.test(line))) continue;

      violations.push({
        file: testFile.relPath,
        line: lineNum,
        column: 1,
        rule: "domain-literal",
        message: "Literal myshopify.com domain in test file",
        snippet: truncate(line, 100),
      });
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
 * Check if a call expression is mocking the logger.
 */
function checkLoggerMock(
  call: ts.CallExpression,
  sourceFile: ts.SourceFile,
  relPath: string,
  violations: Violation[]
): void {
  const callName = getCallName(call);
  
  // Check vi.mock with log.server path
  if (callName === "vi.mock") {
    const pathArg = call.arguments[0];
    if (pathArg && (ts.isStringLiteral(pathArg) || ts.isNoSubstitutionTemplateLiteral(pathArg))) {
      const pathText = pathArg.text;
      // Match various forms of log.server import path
      if (/log\.server|~\/lib\/log|\.\.\/.*lib\/log|app\/lib\/log/i.test(pathText)) {
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

    // Check vi.mock factory that replaces safeLog/toErrorCode
    const factoryArg = call.arguments[1];
    if (factoryArg && ts.isArrowFunction(factoryArg)) {
      const factoryText = factoryArg.getText(sourceFile);
      if (/safeLog\s*:|toErrorCode\s*:|shopHash\s*:/i.test(factoryText)) {
        const { line, character } = sourceFile.getLineAndCharacterOfPosition(call.getStart());
        violations.push({
          file: relPath,
          line: line + 1,
          column: character + 1,
          rule: "no-mock-logger",
          message: "Test vi.mock factory replaces safeLog/toErrorCode/shopHash. Use the real implementations instead.",
          snippet: truncate(call.getText(sourceFile), 100),
        });
        return;
      }
    }
  }

  // Check vi.spyOn with safeLog/toErrorCode/shopHash and mockImplementation/mockReturnValue
  if (callName === "vi.spyOn") {
    const methodArg = call.arguments[1];
    if (methodArg && ts.isStringLiteral(methodArg)) {
      const methodName = methodArg.text;
      if (methodName === "safeLog" || methodName === "toErrorCode" || methodName === "shopHash") {
        // Check if there's a chained mockImplementation/mockReturnValue
        let parent = call.parent;
        while (parent && ts.isPropertyAccessExpression(parent)) {
          const propName = parent.name.text;
          if (propName === "mockImplementation" || propName === "mockReturnValue") {
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
      }
    }
  }
}

// ============================================================================
// Logger Mock Allowlist
// ============================================================================

interface LoggerMockAllowlistEntry {
  path: string;
  reason: string;
}

function loadLoggerMockAllowlist(filePath: string): Map<string, string> {
  const allowlist = new Map<string, string>();

  if (!fs.existsSync(filePath)) {
    return allowlist;
  }

  const content = fs.readFileSync(filePath, "utf-8");
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    // Format: path: reason
    const colonIndex = trimmed.indexOf(":");
    if (colonIndex > 0) {
      const path = trimmed.slice(0, colonIndex).trim();
      const reason = trimmed.slice(colonIndex + 1).trim();
      if (path && reason && reason.toLowerCase() !== "legacy") {
        allowlist.set(path, reason);
      }
    }
  }

  return allowlist;
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

  const { tsFiles, scriptFiles, testFiles } = findSourceFiles(REPO_ROOT);
  console.log(`Scanning ${tsFiles.length} TypeScript files, ${scriptFiles.length} script files, and ${testFiles.length} test files...\n`);

  const allViolations: Violation[] = [];
  const loggerMockViolations: Violation[] = [];

  // Analyze TypeScript files (full logging check)
  for (const file of tsFiles) {
    const violations = analyzeFile(file);
    allViolations.push(...violations);
  }

  // Analyze script files (text-based)
  for (const file of scriptFiles) {
    const violations = analyzeScriptFile(file);
    allViolations.push(...violations);
  }

  // Gap 4: Analyze test files for token-prefix and domain-literal only
  for (const testFile of testFiles) {
    const violations = analyzeTestFile(testFile);
    allViolations.push(...violations);
  }

  // Gap 5: Analyze test files for logger mocks
  for (const testFile of testFiles) {
    const violations = analyzeTestFileForLoggerMocks(testFile);
    loggerMockViolations.push(...violations);
  }

  const grouped = groupViolations(allViolations);
  const allowlist = loadAllowlist(ALLOWLIST_FILE);

  // Load logger mock allowlist
  const loggerMockAllowlist = loadLoggerMockAllowlist(LOGGER_MOCK_ALLOWLIST_FILE);

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

  // Gap 5: Check logger mock violations against allowlist
  const newLoggerMockViolations: Violation[] = [];
  const loggerMockFilesWithViolations = new Set<string>();
  for (const v of loggerMockViolations) {
    loggerMockFilesWithViolations.add(v.file);
    if (!loggerMockAllowlist.has(v.file)) {
      newLoggerMockViolations.push(v);
    }
  }

  // Check for stale logger mock allowlist entries (ratchet)
  const staleLoggerMockEntries: Array<{ path: string; reason: string }> = [];
  for (const [path, reason] of loggerMockAllowlist) {
    if (!loggerMockFilesWithViolations.has(path)) {
      staleLoggerMockEntries.push({ path, reason });
    }
  }

  // Report results
  console.log("=== Results ===\n");

  let shouldFail = false;

  if (newViolations === 0 && staleEntries.length === 0 && 
      newLoggerMockViolations.length === 0 && staleLoggerMockEntries.length === 0) {
    console.log("\x1b[32m✓ No logging violations found\x1b[0m");
    process.exit(0);
  }

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

  // Gap 5: Report logger mock violations
  if (newLoggerMockViolations.length > 0) {
    shouldFail = true;
    console.log(
      `\x1b[31m✗ Found ${newLoggerMockViolations.length} logger mock violation(s):\x1b[0m\n`
    );
    for (const v of newLoggerMockViolations) {
      console.log(`  ${v.file}:${v.line} ${v.message}`);
      console.log(`    ${v.snippet}`);
    }
    console.log("\n\x1b[33mTo fix: Use the real safeLog/toErrorCode/shopHash instead of mocking.\x1b[0m");
    console.log("\x1b[33mTo allowlist (with justification): add entry to scripts/ci/logger-mock-allowlist.txt\x1b[0m");
    console.log("\x1b[33mFormat: path: reason (reason must not be 'legacy')\x1b[0m\n");
  }

  // Gap 5: Stale logger mock allowlist entries FAIL (ratchet)
  if (staleLoggerMockEntries.length > 0) {
    shouldFail = true;
    console.log(
      `\x1b[31m✗ Found ${staleLoggerMockEntries.length} stale logger-mock-allowlist entry(ies):\x1b[0m\n`
    );
    for (const { path, reason } of staleLoggerMockEntries) {
      console.log(`  ${path}: ${reason}`);
    }
    console.log("\n\x1b[33mTo fix: Remove the stale entry from scripts/ci/logger-mock-allowlist.txt\x1b[0m\n");
  }

  process.exit(shouldFail ? 1 : 0);
}

main();
