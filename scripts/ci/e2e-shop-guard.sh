#!/usr/bin/env bash
# Fail-closed guard for seed-e2e-store.yml (throwaway INR e2e store).
#
# Inputs (env only, both from GitHub Actions secrets; never workflow inputs):
#   E2E_SHOP           - throwaway e2e store domain (secrets.E2E_SHOP)
#   MAIN_DEV_STORE     - main dev store domain (secrets.ALLOWED_DEV_STORE), used
#                        only to refuse running the e2e seed against the main store
#   GITHUB_ENV         - optional; on success SHOP and ALLOWED_DEV_STORE (seed.ts
#                        dev-store guard) are both set to E2E_SHOP there
#
# Output: ::add-mask:: lines first, then enum error codes only. Never prints
# either domain value in any other line. Exit 0 only when E2E_SHOP is set, is a
# valid *.myshopify.com domain, and differs from the main dev store.
set -euo pipefail

e2e="$(printf '%s' "${E2E_SHOP:-}" | tr -d '[:space:]')"
main_store="$(printf '%s' "${MAIN_DEV_STORE:-}" | tr -d '[:space:]')"

# Mask both values before any other output.
if [ -n "$e2e" ]; then echo "::add-mask::$e2e"; fi
if [ -n "$main_store" ]; then echo "::add-mask::$main_store"; fi

fail() { echo "::error::$1"; echo "e2e_shop_guard=$1"; exit 1; }

[ -n "$e2e" ] || fail "e2e_shop_missing"
[[ "$e2e" =~ ^[a-z0-9-]+\.myshopify\.com$ ]] || fail "e2e_shop_invalid_format"
# Without the main dev-store value we cannot prove the two differ: fail closed.
[ -n "$main_store" ] || fail "main_dev_store_missing"
[ "$e2e" != "$main_store" ] || fail "e2e_shop_equals_main_dev_store"

if [ -n "${GITHUB_ENV:-}" ]; then
  {
    echo "SHOP=$e2e"
    echo "ALLOWED_DEV_STORE=$e2e"
  } >> "$GITHUB_ENV"
fi
echo "e2e_shop_guard=ok"
