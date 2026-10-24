#!/usr/bin/env bash
# CI guard: AST-based check for PII/domain leaks in logging statements
#
# This is a thin wrapper that calls the TypeScript AST-based checker.
# The AST approach properly handles multi-line calls, object literals,
# template interpolations, and Sentry methods.
#
# Uses a burn-down allowlist keyed by file:rule:count (stable across line shifts).
# Adding a NEW violation will fail CI even if existing ones are allowlisted.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

exec npx tsx "$SCRIPT_DIR/check-logging.ts"
