#!/usr/bin/env bash
# CI guard: Check for PII/domain leaks in logging statements
#
# Checks app/ and workers/ (excluding tests) for:
# 1. Literal myshopify.com in console/safeLog/captureMessage/error: strings (except validation regexes)
# 2. ${shop}/${shopDomain}/${payloadShop}/${message.shop} in log/error templates
# 3. captureException(err|error) on raw catch variables
# 4. Amount fields in log calls
# 5. Sensitive keys (narration, payerText, etc.) in log arguments
#
# Uses a burn-down allowlist for existing violations.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
ALLOWLIST_FILE="$SCRIPT_DIR/logging-allowlist.txt"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Track violations
VIOLATIONS=0
VIOLATION_DETAILS=""

add_violation() {
  local file="$1"
  local line="$2"
  local rule="$3"
  local content="$4"
  VIOLATIONS=$((VIOLATIONS + 1))
  VIOLATION_DETAILS="${VIOLATION_DETAILS}  ${file}:${line} [${rule}] ${content}\n"
}

# Check if a file:line is in the allowlist
is_allowlisted() {
  local file="$1"
  local line="$2"
  
  if [[ ! -f "$ALLOWLIST_FILE" ]]; then
    return 1
  fi
  
  # Match exact file:line or file:* (whole file)
  local rel_file="${file#$REPO_ROOT/}"
  if grep -qE "^${rel_file}:${line}$|^${rel_file}:\*$" "$ALLOWLIST_FILE" 2>/dev/null; then
    return 0
  fi
  return 1
}

echo "=== Logging Guard Check ==="
echo ""

# Find all non-test .ts/.tsx files in app/ and workers/
FILES=$(find "$REPO_ROOT/app" "$REPO_ROOT/workers" \
  -type f \( -name "*.ts" -o -name "*.tsx" \) \
  ! -path "*/__tests__/*" \
  ! -path "*/test/*" \
  ! -name "*.test.ts" \
  ! -name "*.test.tsx" \
  2>/dev/null || true)

# Rule 1: Literal myshopify.com in log statements (except validation regexes)
echo "Checking for literal myshopify.com in logs..."
while IFS= read -r file; do
  [[ -z "$file" ]] && continue
  
  # Use grep to find matches with line numbers
  while IFS=: read -r line_num content; do
    [[ -z "$line_num" ]] && continue
    
    # Skip validation regex patterns (these are allowed)
    if echo "$content" | grep -qE '\.test\(|RegExp\(|/\\\.myshopify\\\.com/|isValidShopDomain'; then
      continue
    fi
    
    # Skip import statements
    if echo "$content" | grep -qE '^[[:space:]]*import\s'; then
      continue
    fi
    
    # Check if console/safeLog/captureMessage/error: statement
    if echo "$content" | grep -qE 'console\.(log|warn|error|info|debug)\(|safeLog\(|captureMessage\(|captureException\(|error:\s*[`"'"'"']'; then
      if ! is_allowlisted "$file" "$line_num"; then
        add_violation "$file" "$line_num" "domain-literal" "$(echo "$content" | head -c 100)"
      fi
    fi
  done < <(grep -n 'myshopify\.com' "$file" 2>/dev/null || true)
done <<< "$FILES"

# Rule 2: ${shop}/${shopDomain}/${payloadShop}/${message.shop} in templates
echo "Checking for shop domain interpolation in logs..."
while IFS= read -r file; do
  [[ -z "$file" ]] && continue
  
  while IFS=: read -r line_num content; do
    [[ -z "$line_num" ]] && continue
    
    # Check if in a log/error context
    if echo "$content" | grep -qE 'console\.|safeLog|captureMessage|error:\s*`|error:\s*"'; then
      if ! is_allowlisted "$file" "$line_num"; then
        add_violation "$file" "$line_num" "shop-interpolation" "$(echo "$content" | head -c 100)"
      fi
    fi
  done < <(grep -nE '\$\{(shop|shopDomain|payloadShop|message\.shop)\}' "$file" 2>/dev/null || true)
done <<< "$FILES"

# Rule 3: captureException(err|error) with raw catch variable
echo "Checking for raw captureException calls..."
while IFS= read -r file; do
  [[ -z "$file" ]] && continue
  
  while IFS=: read -r line_num content; do
    [[ -z "$line_num" ]] && continue
    
    # Skip if it has .code or .name or tags
    if echo "$content" | grep -qE 'captureException.*tags|captureExceptionWithTags'; then
      continue
    fi
    
    if ! is_allowlisted "$file" "$line_num"; then
      add_violation "$file" "$line_num" "raw-capture" "$(echo "$content" | head -c 100)"
    fi
  done < <(grep -nE 'captureException\(\s*(err|error)\s*\)' "$file" 2>/dev/null || true)
done <<< "$FILES"

# Rule 4: Amount fields in log calls
echo "Checking for amount fields in logs..."
while IFS= read -r file; do
  [[ -z "$file" ]] && continue
  
  while IFS=: read -r line_num content; do
    [[ -z "$line_num" ]] && continue
    
    # Check if in a log context
    if echo "$content" | grep -qE 'console\.|safeLog'; then
      if ! is_allowlisted "$file" "$line_num"; then
        add_violation "$file" "$line_num" "amount-in-log" "$(echo "$content" | head -c 100)"
      fi
    fi
  done < <(grep -nE '(amount|paise|outstanding|balance|total)[=:,]' "$file" 2>/dev/null | grep -vE 'type|interface|import|//|/\*' || true)
done <<< "$FILES"

# Rule 5: Sensitive keys in log arguments (as data values, not in function/event names)
echo "Checking for sensitive keys in logs..."
# Only match when these appear as object keys being logged (key: value or {key})
SENSITIVE_PATTERN='(narration|payerText|payerKey|accessToken|refreshToken)\s*[=:,\}]'
while IFS= read -r file; do
  [[ -z "$file" ]] && continue
  
  while IFS=: read -r line_num content; do
    [[ -z "$line_num" ]] && continue
    
    # Skip type definitions and imports
    if echo "$content" | grep -qE '^\s*(type|interface|import|//|/\*|export\s+type)'; then
      continue
    fi
    
    # Skip error result objects (these aren't logged directly)
    if echo "$content" | grep -qE 'return\s*\{|error:\s*[`"'"'"']'; then
      continue
    fi
    
    # Check if in a log context
    if echo "$content" | grep -qE 'console\.|safeLog'; then
      if ! is_allowlisted "$file" "$line_num"; then
        add_violation "$file" "$line_num" "sensitive-key" "$(echo "$content" | head -c 100)"
      fi
    fi
  done < <(grep -nE "$SENSITIVE_PATTERN" "$file" 2>/dev/null || true)
done <<< "$FILES"

# Also check scripts/ for domain/token patterns
echo "Checking scripts for domain/token patterns..."
SCRIPT_FILES=$(find "$REPO_ROOT/scripts" \
  -type f \( -name "*.ts" -o -name "*.sh" -o -name "*.mjs" \) \
  ! -path "*/__tests__/*" \
  ! -path "*/ci/*" \
  ! -name "*.test.ts" \
  2>/dev/null || true)

while IFS= read -r file; do
  [[ -z "$file" ]] && continue
  
  while IFS=: read -r line_num content; do
    [[ -z "$line_num" ]] && continue
    
    # Skip validation/test patterns and help messages
    if echo "$content" | grep -qE '\.test\(|RegExp\(|ALLOWED_DEV_STORE|placeholder|e\.g\.|example'; then
      continue
    fi
    
    # Skip comments
    if echo "$content" | grep -qE '^\s*(//|#|\*)'; then
      continue
    fi
    
    if echo "$content" | grep -qE 'console\.(log|warn|error)|echo\s.*\$|print'; then
      if ! is_allowlisted "$file" "$line_num"; then
        add_violation "$file" "$line_num" "script-domain" "$(echo "$content" | head -c 100)"
      fi
    fi
  done < <(grep -nE 'myshopify\.com|shpat_|shpua_|shpss_' "$file" 2>/dev/null || true)
done <<< "$SCRIPT_FILES"

echo ""
echo "=== Results ==="

if [[ $VIOLATIONS -eq 0 ]]; then
  echo -e "${GREEN}✓ No logging violations found${NC}"
  exit 0
else
  echo -e "${RED}✗ Found $VIOLATIONS logging violation(s):${NC}"
  echo ""
  echo -e "$VIOLATION_DETAILS"
  echo ""
  echo -e "${YELLOW}To fix: Update the code to use safeLog with shopId/shopHash, or add to${NC}"
  echo -e "${YELLOW}scripts/ci/logging-allowlist.txt if this is an existing call site.${NC}"
  exit 1
fi
