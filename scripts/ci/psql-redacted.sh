# shellcheck shell=bash
# Source this in a workflow step to route every psql call's stderr through
# scripts/ci/redact-db-host.sh --psql. stdout (query results) and stdin
# (heredocs) are untouched, and psql's exit code is returned unchanged, so
# `set -e` and ON_ERROR_STOP failures still fail the step.
#
#   source scripts/ci/psql-redacted.sh
#   psql -v ON_ERROR_STOP=1 "$DATABASE_URL" <<'EOSQL' ... EOSQL

_PSQL_REDACT_FILTER="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/redact-db-host.sh"

psql() {
  local err rc=0
  err="$(mktemp "${RUNNER_TEMP:-/tmp}/psql-stderr.XXXXXX")"
  command psql "$@" 2>"$err" || rc=$?
  bash "$_PSQL_REDACT_FILTER" --psql <"$err" >&2 || true
  rm -f "$err"
  return "$rc"
}
