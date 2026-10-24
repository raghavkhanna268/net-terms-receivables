#!/usr/bin/env bash
# Self-test for redact-db-host.sh and psql-redacted.sh (no network, fake hosts only).
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
F="$DIR/redact-db-host.sh"
fail=0
check_absent() { # $1 label, $2 output, $3 forbidden substring
  if [[ "$2" == *"$3"* ]]; then echo "FAIL: $1"; fail=1; else echo "ok: $1"; fi
}

# 1. Default mode is byte-identical to migrate.yml's original sed.
IN='Datasource "db": PostgreSQL database "postgres", schema "public" at "fake-host.example.invalid:5432"'
WANT="$(printf '%s\n' "$IN" | sed -E 's/ at "[^"]*"/ at "<redacted>"/g')"
GOT="$(printf '%s\n' "$IN" | bash "$F")"
if [ "$GOT" = "$WANT" ]; then echo "ok: default mode matches migrate.yml filter"; else echo "FAIL: default mode drift"; fail=1; fi

# 2. psql mode redacts host, IP, URI, user, conninfo.
LINES='psql: error: connection to server at "fake-host.example.invalid" (203.0.113.7), port 5432 failed: FATAL:  password authentication failed for user "postgres.fakeprojectref"
psql: error: could not translate host name "fake-host.example.invalid" to address: Name or service not known
psql: error: invalid URI: postgresql://fakeuser:fakepass@fake-host.example.invalid:6543/postgres?sslmode=require
connection to server at "fake-host.example.invalid" (2001:db8::7), port 5432 failed
psql: error: host=fake-host.example.invalid user=fakeuser password=fakepass dbname=postgres'
OUT="$(printf '%s\n' "$LINES" | bash "$F" --psql)"
for s in fake-host.example.invalid 203.0.113.7 2001:db8::7 fakeprojectref fakeuser fakepass "postgresql://"; do
  check_absent "psql mode hides $s" "$OUT" "$s"
done

# 3. Wrapper keeps exit codes, redacts stderr, leaves stdout alone.
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
cat >"$TMP/psql" <<'FAKE'
#!/usr/bin/env bash
cat >/dev/null   # consume heredoc stdin like real psql
echo "row-count|3"
echo 'psql: error: connection to server at "fake-host.example.invalid" (198.51.100.9), port 5432 failed' >&2
exit "${FAKE_PSQL_RC:-0}"
FAKE
chmod +x "$TMP/psql"
(
  export PATH="$TMP:$PATH"
  # shellcheck source=/dev/null
  source "$DIR/psql-redacted.sh"
  set +e
  STDOUT="$(FAKE_PSQL_RC=3 psql -v ON_ERROR_STOP=1 <<<'select 1' 2>"$TMP/err")"; RC=$?
  set -e
  if [ "$RC" -eq 3 ]; then echo "ok: exit code preserved (3)"; else echo "FAIL: exit code $RC"; exit 1; fi
  [ "$STDOUT" = "row-count|3" ] && echo "ok: stdout untouched" || { echo "FAIL: stdout"; exit 1; }
  ERR="$(cat "$TMP/err")"
  [[ "$ERR" != *fake-host* && "$ERR" != *198.51.100.9* && "$ERR" == *'<redacted>'* ]] \
    && echo "ok: wrapper redacts stderr" || { echo "FAIL: wrapper stderr"; exit 1; }
  # set -e still trips on failure
  # Same shell flags GitHub uses for `run:` steps (bash -e), in a fresh process.
  set +e
  OUT2="$(FAKE_PSQL_RC=2 bash -e -c 'source "$1"; psql </dev/null >/dev/null 2>&1; echo unreachable' _ "$DIR/psql-redacted.sh")"; RC2=$?
  set -e
  [ "$RC2" -eq 2 ] && [ -z "$OUT2" ] && echo "ok: set -e fails step with psql's code" || { echo "FAIL: set -e ($RC2)"; exit 1; }
) || fail=1

if [ "$fail" -eq 0 ]; then echo "ALL PASS"; else echo "SOME FAILED"; exit 1; fi
