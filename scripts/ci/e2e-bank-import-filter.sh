#!/usr/bin/env bash
# Allowlist filter for scripts/e2e-bank-import.ts output in public Actions logs.
#
# Keeps ONLY lines of the form key=value where key is one of the script's
# OUTPUT_KEYS and value is a non-negative integer, true/false, or a lowercase
# enum ([a-z0-9_]). Everything else (safeLog JSON with ids, stack traces,
# driver notices, anything derived from CSV rows) is dropped and counted.
#
# Usage: npx tsx scripts/e2e-bank-import.ts 2>&1 | bash scripts/ci/e2e-bank-import-filter.sh
# (run with `set -o pipefail` so the script's exit code is preserved).
set -euo pipefail

KEYS='mode|shop_guard|shop_found|shop_currency_inr|reviewer_demo_invoices_present|fixture_bank|fixture_rows_total|fixture_rows_skipped|fixture_parse_errors|fixture_credits|fixture_debits_ignored|validation|rows_outside_date_bounds|app_would_reject|already_imported|noop|unmatched_payments_before|import_ids_created|statement_lines_inserted|statement_lines_duplicate|matcher_ran|matcher_payments_processed|matcher_matches_created|matcher_high_confidence|matcher_errors|matcher_has_more|suggestions_high|suggestions_medium|suggestions_low|suggestions_total_import|suggested_tab_total_shop|matches_not_suggested|payments_not_unmatched|payer_alias_delta|invoice_outstanding_changed|confirm_audit_events_delta|rolled_back|result|error_code'

dropped=0
while IFS= read -r line || [ -n "$line" ]; do
  if [[ "$line" =~ ^(${KEYS})=([0-9]{1,9}|true|false|[a-z0-9_]{1,64})$ ]]; then
    printf '%s\n' "$line"
  else
    dropped=$((dropped + 1))
  fi
done
printf 'filtered_lines_dropped=%s\n' "$dropped"
