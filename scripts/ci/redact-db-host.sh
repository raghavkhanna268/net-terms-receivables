#!/usr/bin/env bash
# Redact database host details from tool output before it reaches public
# Actions logs (this repo is public). Reads stdin, writes stdout.
#
# Default mode is exactly migrate.yml's original Prisma filter:
#   sed -E 's/ at "[^"]*"/ at "<redacted>"/g'
#
# --psql adds the extra patterns libpq/psql errors can carry:
#   - connection URIs        postgres://user:pass@host:port/db
#   - resolved IPs           (203.0.113.7) / (2001:db8::1)
#   - DNS failures           host name "db.example.com"
#   - auth failures          for user "postgres.<project-ref>"
#   - key=value conninfo     host=... hostaddr=... user=... password=...
set -euo pipefail

BASE='s/ at "[^"]*"/ at "<redacted>"/g'

case "${1:-}" in
  "")
    exec sed -u -E "$BASE"
    ;;
  --psql)
    exec sed -u -E \
      -e "$BASE" \
      -e 's#postgres(ql)?://[^[:space:]"'"'"']*#<redacted-db-url>#g' \
      -e 's/\(([0-9]{1,3}\.){3}[0-9]{1,3}\)/(<redacted>)/g' \
      -e 's/\(([0-9A-Fa-f]{0,4}:){2,7}[0-9A-Fa-f]{0,4}\)/(<redacted>)/g' \
      -e 's/host name "[^"]*"/host name "<redacted>"/g' \
      -e 's/ user "[^"]*"/ user "<redacted>"/g' \
      -e 's/(host|hostaddr|user|password)=[^[:space:]"'"'"']+/\1=<redacted>/g'
    ;;
  *)
    echo "usage: redact-db-host.sh [--psql]" >&2
    exit 2
    ;;
esac
