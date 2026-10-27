#!/usr/bin/env bash
# Public-log filter for seed-e2e-store.yml and seed-dev-store.yml: seed.ts
# prints Shopify GIDs, seed externalIds, company names, order names and amounts
# for local debugging. In public Actions logs only counts, enums and booleans
# may appear, so redact those (and any email/domain) on stdin -> stdout.
# Line-buffered so progress still streams.
#
# Seed company names are read from scripts/seed.ts (COMPANY_SEEDS and
# REVIEWER_DEMO_COMPANY_SEED), not hard-coded here. If none can be read the
# filter fails closed (non-zero exit, nothing echoed), so a pipefail step fails.
set -euo pipefail

SEED_TS="${SEED_TS:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)/scripts/seed.ts}"

seed_names() {
  [ -f "$SEED_TS" ] || return 0
  awk '
    /^export const (COMPANY_SEEDS|REVIEWER_DEMO_COMPANY_SEED) = / { inblk = 1 }
    inblk { print }
    inblk && /^[]}] as const;/ { inblk = 0 }
  ' "$SEED_TS" | grep -oE '\bname: "[^"]+"' | sed -E 's/^name: "(.*)"$/\1/' | sort -u
}

NAME_ARGS=()
n_names=0
while IFS= read -r name; do
  [ -n "$name" ] || continue
  # Escape ERE metacharacters and the s### delimiter.
  esc=$(printf '%s' "$name" | sed -E 's/[][\.^$*+?(){}|#&/]/\\&/g')
  NAME_ARGS+=(-e "s#${esc}#<company>#g")
  n_names=$((n_names + 1))
done < <(seed_names)

if [ "$n_names" -eq 0 ]; then
  echo "redact-seed-output: seed_names_unavailable" >&2
  exit 1
fi

exec sed -u -E \
  -e 's#gid://shopify/[A-Za-z]+(/[^[:space:]"'"'"',;)>]*)?#<gid>#g' \
  -e 's#ntr-seed-[A-Za-z0-9_.-]*#<seed-id>#g' \
  "${NAME_ARGS[@]}" \
  -e 's#[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}#<email>#g' \
  -e 's#[A-Za-z0-9-]+\.myshopify\.com#<shop>#g' \
  -e 's#\b[A-Z]{3} -?[0-9][0-9,]*(\.[0-9]+)?#<money>#g' \
  -e 's%#[A-Za-z]*[0-9]+%#<order>%g' \
  -e 's#\b[0-9]{8,}\b#<id>#g'
