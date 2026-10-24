#!/usr/bin/env npx tsx
/**
 * AST-based CI logging guard for PII/domain leak prevention.
 *
 * Replaces the grep-based check-logging.sh with proper multi-line handling.
 * Uses TypeScript compiler API to walk AST nodes and inspect call arguments.
 *
 * Checks app/**, workers/**, scripts/** .ts/.tsx files (excluding tests/fixtures) for:
 * 1. console.*, safeLog, Sentry.* calls with sensitive data in object literals
 * 2. Template literals interpolating shop/domain identifiers
 * 3. captureException with raw catch variables (no tags)
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
 * Sensitive key patterns that indicate PII or financial data.
 * Keys matching these are flagged unless explicitly allowlisted.
 */
const SENSITIVE_KEY_PATTERNS = [
  /^amount$/i,
  /amount$/i,
  /^paise$/i,
  /paise$/i,
  /^total$/i,
  /total$/i,
  /^outstanding$/i,
  /outstanding$/i,
  /^balance$/i,
  /balance$/i,
  /^shop$/i,
  /^shopDomain$/i,
  /^domain$/i,
  /^email$/i,
  /^name$/i,
  /^narration$/i,
  /^payer$/i,
  /^remitter$/i,
  /^payerText$/i,
  /^payerKey$/i,
  /^accessToken$/i,
  /^refreshToken$/i,
];

/**
 * Allowlisted keys that are safe even if they match sensitive patterns.
 * Each entry has a comment explaining why it's safe.
 *
 * Format: key -> reason
 */
const SAFE_KEY_ALLOWLIST: Record<string, string> = {
  // Hash of shop domain, not the domain itself
  shopHash: "SHA-256 hash prefix, not PII",
  // Database IDs, not sensitive
  shopId: "Internal UUID, not the domain",
  // Error codes, not raw errors
  errorCode: "Structured error code, not raw message",
  code: "Structured error code or enum",
  err: "Error code string from toErrorCode()",
  // Count metrics are safe (not individual amounts)
  count: "Aggregate count, not individual amount",
  totalCount: "Aggregate count metric",
  orderCount: "Aggregate count metric",
  invoiceCount: "Aggregate count metric",
  matchCount: "Aggregate count metric",
  lineCount: "Aggregate count metric",
  skippedCount: "Aggregate count metric",
  errorCount: "Aggregate count metric",
  failureCount: "Aggregate count metric",
  successCount: "Aggregate count metric",
  upsertedCount: "Aggregate count metric",
  // Status/result fields
  status: "Enum status value",
  action: "Enum action value",
  reason: "Structured reason code",
  reasonCode: "Structured reason code",
  // Timing metrics
  durationMs: "Duration in milliseconds",
  elapsedMs: "Elapsed time metric",
  // Boolean flags
  success: "Boolean flag",
  retryable: "Boolean flag",
  // Safe identifiers (internal UUIDs/GIDs)
  requestId: "Request correlation ID",
  webhookId: "Webhook correlation ID",
  jobId: "Job correlation ID",
  matchId: "Match correlation ID",
  orderId: "Internal order UUID",
  orderGid: "Shopify GID (not PII)",
  invoiceId: "Internal invoice UUID",
  customerId: "Internal customer UUID",
  companyId: "Internal company UUID",
  locationId: "Internal location UUID",
  buyerAccountId: "Internal buyer account UUID",
  sessionId: "Session correlation ID",
  operationId: "Operation correlation ID",
  bulkOperationId: "Bulk operation correlation ID",
  messageId: "Message correlation ID",
  msgId: "Message correlation ID (short)",
  // Metadata
  topic: "Webhook topic enum",
  stage: "Processing stage enum",
  origin: "Origin enum value",
  queue: "Queue name",
  version: "Version string",
  fields: "Field list metadata",
  // Bulk processing metadata
  bulkType: "Bulk operation type enum",
  offset: "Byte offset (not sensitive)",
  byteOffset: "Byte offset (not sensitive)",
  newByteOffset: "Byte offset (not sensitive)",
  chunkSize: "Chunk size in bytes",
  // HTTP metadata
  httpStatus: "HTTP status code",
  statusCode: "HTTP status code",
};

/**
 * Template literal interpolation patterns that indicate shop/domain leakage.
 */
const SENSITIVE_INTERPOLATION_PATTERNS = [
  /^\s*shop\s*$/,
  /^\s*shopDomain\s*$/,
  /^\s*payloadShop\s*$/,
  /^\s*message\.shop\s*$/,
  /^\s*domain\s*$/,
];

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

/**
 * Log/error call patterns to check.
 */
const _LOG_CALL_NAMES = new Set([
  "log",
  "warn",
  "error",
  "info",
  "debug",
]);

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

interface _AllowlistEntry {
  file: string;
  rule: string;
  count: number;
}

// ============================================================================
// File Discovery
// ============================================================================

function findSourceFiles(rootDir: string): string[] {
  const files: string[] = [];
  const dirsToSearch = ["app", "workers", "scripts"];

  for (const dir of dirsToSearch) {
    const fullPath = path.join(rootDir, dir);
    if (fs.existsSync(fullPath)) {
      walkDirectory(fullPath, files);
    }
  }

  return files;
}

function walkDirectory(dir: string, files: string[]): void {
  const entries = fs.readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      // Skip test directories and node_modules
      if (
        entry.name === "__tests__" ||
        entry.name === "test" ||
        entry.name === "fixtures" ||
        entry.name === "node_modules" ||
        entry.name === "ci" // Skip scripts/ci to avoid self-checking
      ) {
        continue;
      }
      walkDirectory(fullPath, files);
    } else if (entry.isFile()) {
      // Include .ts and .tsx files, exclude test files
      if (
        (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) &&
        !entry.name.endsWith(".test.ts") &&
        !entry.name.endsWith(".test.tsx")
      ) {
        files.push(fullPath);
      }
    }
  }
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
    checkLogCall(call, callName, sourceFile, relPath, violations);
  }

  // Check Sentry methods
  const methodName = callName.split(".").pop() ?? callName;
  if (SENTRY_METHODS.has(methodName)) {
    checkSentryCall(call, methodName, sourceFile, relPath, violations);
  }
}

function getCallName(call: ts.CallExpression): string | null {
  const expr = call.expression;

  // console.log, console.error, etc.
  if (ts.isPropertyAccessExpression(expr)) {
    const obj = expr.expression;
    const prop = expr.name.text;

    if (ts.isIdentifier(obj)) {
      return `${obj.text}.${prop}`;
    }

    // Sentry.captureException, etc.
    if (ts.isIdentifier(obj) && obj.text === "Sentry") {
      return `Sentry.${prop}`;
    }

    return prop;
  }

  // Direct function call: safeLog, captureException, etc.
  if (ts.isIdentifier(expr)) {
    return expr.text;
  }

  return null;
}

function checkLogCall(
  call: ts.CallExpression,
  callName: string,
  sourceFile: ts.SourceFile,
  relPath: string,
  violations: Violation[]
): void {
  for (const arg of call.arguments) {
    // Check template literals for shop interpolation
    if (ts.isTemplateExpression(arg) || ts.isTaggedTemplateExpression(arg)) {
      const templateViolations = checkTemplateLiteral(arg, sourceFile);
      for (const violation of templateViolations) {
        violations.push({
          file: relPath,
          line: violation.line,
          column: violation.column,
          rule: "shop-interpolation",
          message: `Template literal interpolates sensitive variable: ${violation.expr}`,
          snippet: violation.snippet,
        });
      }
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

    // Check object literals for sensitive keys
    if (ts.isObjectLiteralExpression(arg)) {
      checkObjectLiteral(arg, sourceFile, relPath, violations);
    }
  }
}

function checkSentryCall(
  call: ts.CallExpression,
  methodName: string,
  sourceFile: ts.SourceFile,
  relPath: string,
  violations: Violation[]
): void {
  // captureException(err) without tags
  if (methodName === "captureException") {
    const firstArg = call.arguments[0];
    const secondArg = call.arguments[1];

    // Check if it's a raw catch variable without options
    if (firstArg && ts.isIdentifier(firstArg)) {
      const name = firstArg.text;
      if ((name === "err" || name === "error") && !secondArg) {
        // No second argument with tags - this is raw capture
        const fullText = call.getText(sourceFile);
        if (!fullText.includes("tags") && !fullText.includes("captureExceptionWithTags")) {
          const { line, character } = sourceFile.getLineAndCharacterOfPosition(call.getStart());
          violations.push({
            file: relPath,
            line: line + 1,
            column: character + 1,
            rule: "raw-capture",
            message: "captureException with raw catch variable (use captureExceptionWithTags)",
            snippet: truncate(fullText, 100),
          });
        }
      }
    }
  }

  // setExtra(key, value), setTag(key, value): first argument is the key
  if ((methodName === "setExtra" || methodName === "setTag") && call.arguments.length >= 1) {
    const keyArg = call.arguments[0];
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
  }

  // setContext(name, context): check the context object (second argument)
  if (methodName === "setContext" && call.arguments.length >= 2) {
    const contextArg = call.arguments[1];
    if (ts.isObjectLiteralExpression(contextArg)) {
      checkObjectLiteral(contextArg, sourceFile, relPath, violations);
    }
  }

  // Check all arguments for sensitive data
  for (const arg of call.arguments) {
    // Check object literals (extras, context, tags)
    if (ts.isObjectLiteralExpression(arg)) {
      checkObjectLiteral(arg, sourceFile, relPath, violations);
    }

    // Check template literals
    if (ts.isTemplateExpression(arg) || ts.isTaggedTemplateExpression(arg)) {
      const templateViolations = checkTemplateLiteral(arg, sourceFile);
      for (const violation of templateViolations) {
        violations.push({
          file: relPath,
          line: violation.line,
          column: violation.column,
          rule: "shop-interpolation",
          message: `Template literal in Sentry call interpolates sensitive variable: ${violation.expr}`,
          snippet: violation.snippet,
        });
      }
    }

    // Check string literals for domain
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

function checkObjectLiteral(
  obj: ts.ObjectLiteralExpression,
  sourceFile: ts.SourceFile,
  relPath: string,
  violations: Violation[],
  depth = 0
): void {
  if (depth > 5) return; // Prevent infinite recursion

  for (const prop of obj.properties) {
    let keyName: string | null = null;

    // Property assignment: { key: value }
    if (ts.isPropertyAssignment(prop)) {
      if (ts.isIdentifier(prop.name)) {
        keyName = prop.name.text;
      } else if (ts.isStringLiteral(prop.name)) {
        keyName = prop.name.text;
      }

      // Recurse into nested object literals
      if (ts.isObjectLiteralExpression(prop.initializer)) {
        checkObjectLiteral(prop.initializer, sourceFile, relPath, violations, depth + 1);
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
    }

    // Shorthand property: { shop } is equivalent to { shop: shop }
    if (ts.isShorthandPropertyAssignment(prop)) {
      keyName = prop.name.text;
    }

    // Spread element: { ...obj }
    if (ts.isSpreadAssignment(prop)) {
      // Check if spreading a known sensitive object
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

function checkTemplateLiteral(
  node: ts.Node,
  sourceFile: ts.SourceFile
): Array<{ line: number; column: number; expr: string; snippet: string }> {
  const violations: Array<{ line: number; column: number; expr: string; snippet: string }> = [];

  function checkTemplateSpan(span: ts.TemplateSpan): void {
    const expr = span.expression;
    const exprText = expr.getText(sourceFile);

    // Check if expression matches sensitive patterns
    for (const pattern of SENSITIVE_INTERPOLATION_PATTERNS) {
      if (pattern.test(exprText)) {
        const { line, character } = sourceFile.getLineAndCharacterOfPosition(expr.getStart());
        violations.push({
          line: line + 1,
          column: character + 1,
          expr: exprText.trim(),
          snippet: truncate(span.getText(sourceFile), 80),
        });
        break;
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

function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY_PATTERNS.some((pattern) => pattern.test(key));
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

  const files = findSourceFiles(REPO_ROOT);
  console.log(`Scanning ${files.length} source files...\n`);

  const allViolations: Violation[] = [];
  for (const file of files) {
    const violations = analyzeFile(file);
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
  const staleEntries: string[] = [];

  // Check for violations exceeding allowlist
  for (const [key, violations] of grouped) {
    const found = violations.length;
    const allowed = allowlist.get(key) ?? 0;

    if (found > allowed) {
      newViolations += found - allowed;
      overAllowlist.push({ key, found, allowed, violations });
    }
  }

  // Check for stale allowlist entries (entries with no violations)
  for (const [key, count] of allowlist) {
    if (!grouped.has(key)) {
      staleEntries.push(`${key}:${count}`);
    } else {
      const found = grouped.get(key)!.length;
      if (found < count) {
        staleEntries.push(`${key}:${count} (found only ${found})`);
      }
    }
  }

  // Report results
  console.log("=== Results ===\n");

  if (newViolations === 0 && staleEntries.length === 0) {
    console.log("\x1b[32m✓ No logging violations found\x1b[0m");
    process.exit(0);
  }

  if (newViolations > 0) {
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

  if (staleEntries.length > 0) {
    console.log(
      `\x1b[33m⚠ Found ${staleEntries.length} stale allowlist entry(ies):\x1b[0m\n`
    );
    for (const entry of staleEntries) {
      console.log(`  ${entry}`);
    }
    console.log("\n\x1b[33mThese entries can be removed or reduced in logging-allowlist.txt\x1b[0m\n");
  }

  if (newViolations > 0) {
    process.exit(1);
  }

  // Stale entries alone don't fail (to allow gradual cleanup)
  process.exit(0);
}

main();
