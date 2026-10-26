#!/usr/bin/env bash
# Public-log filter for seed-e2e-store.yml: seed.ts prints Shopify GIDs, order
# names and amounts for local debugging. In public Actions logs only counts,
# enums and booleans may appear, so redact those (and any email/domain) on
# stdin -> stdout. Line-buffered so progress still streams.
set -euo pipefail
exec sed -u -E \
  -e 's#gid://shopify/[A-Za-z]+/[0-9]+#<gid>#g' \
  -e 's#[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}#<email>#g' \
  -e 's#[A-Za-z0-9-]+\.myshopify\.com#<shop>#g' \
  -e 's#\b[A-Z]{3} -?[0-9][0-9,]*(\.[0-9]+)?#<money>#g' \
  -e 's%#[A-Za-z]*[0-9]+%#<order>%g' \
  -e 's#\b[0-9]{8,}\b#<id>#g'
