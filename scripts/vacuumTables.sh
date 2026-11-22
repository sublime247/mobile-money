#!/usr/bin/env bash
# #2481 - targeted VACUUM (ANALYZE) maintenance for high-churn tables.
#
# Emits exactly one JSON object on stdout so the calling job can emit
# structured logs. All human-readable diagnostics go to stderr.
#
# Configuration (all optional):
#   VACUUM_TABLES                  comma-separated table names (default: transactions)
#   VACUUM_DEAD_TUPLE_THRESHOLD    minimum dead tuples before vacuuming (default: 1000)
#   VACUUM_MAX_ACTIVE_CONNECTIONS  skip when more than this many active connections (default: 50)
#   VACUUM_STATEMENT_TIMEOUT_MS    per-VACUUM statement timeout (default: 300000)
#   DATABASE_URL / PROD_DB_URL / DB_URL, or standard PG* variables

set -uo pipefail

log() {
  printf '%s\n' "$*" >&2
}

fail() {
  local message
  message=$(printf '%s' "$1" | tr -d '"\r\n')
  printf '{"event":"vacuum_analyze","status":"error","error":"%s"}\n' "$message"
  exit 2
}

json_array() {
  local result="" item
  for item in "$@"; do
    if [ -n "$result" ]; then
      result+=","
    fi
    result+="\"$item\""
  done
  printf '[%s]' "$result"
}

TABLES_RAW="${VACUUM_TABLES:-transactions}"
DEAD_TUPLE_THRESHOLD="${VACUUM_DEAD_TUPLE_THRESHOLD:-1000}"
MAX_ACTIVE_CONNECTIONS="${VACUUM_MAX_ACTIVE_CONNECTIONS:-50}"
STATEMENT_TIMEOUT_MS="${VACUUM_STATEMENT_TIMEOUT_MS:-300000}"

[[ "$DEAD_TUPLE_THRESHOLD" =~ ^[0-9]+$ ]] || fail "invalid VACUUM_DEAD_TUPLE_THRESHOLD"
[[ "$MAX_ACTIVE_CONNECTIONS" =~ ^[0-9]+$ ]] || fail "invalid VACUUM_MAX_ACTIVE_CONNECTIONS"
[[ "$STATEMENT_TIMEOUT_MS" =~ ^[0-9]+$ ]] || fail "invalid VACUUM_STATEMENT_TIMEOUT_MS"

IFS=',' read -r -a TABLES <<< "$TABLES_RAW"
for table in "${TABLES[@]}"; do
  # Allowlist-style validation: table names are interpolated into SQL, so they
  # must be plain identifiers. Never accept user input containing quotes.
  [[ "$table" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || fail "invalid table name"
done

DB_URL="${DATABASE_URL:-${PROD_DB_URL:-${DB_URL:-}}}"
PSQL_ARGS=()
if [ -n "$DB_URL" ]; then
  PSQL_ARGS+=("$DB_URL")
fi

read_active_connections() {
  psql "${PSQL_ARGS[@]}" -X -q -A -t -v ON_ERROR_STOP=1 -c \
    "SELECT count(*) FROM pg_stat_activity WHERE datname = current_database() AND state = 'active' AND pid <> pg_backend_pid();"
}

read_stats() {
  local table="$1" clear_snapshot="${2:-false}"
  local prefix=""
  if [ "$clear_snapshot" = "true" ]; then
    # Same session/transaction as the stats read, so the snapshot is truly
    # refreshed before we measure the post-vacuum result.
    prefix="SELECT pg_stat_clear_snapshot(); "
  fi
  psql "${PSQL_ARGS[@]}" -X -q -A -t -v ON_ERROR_STOP=1 -c \
    "${prefix}SELECT COALESCE(n_dead_tup, 0)::text || '|' || pg_total_relation_size('public.${table}')::text FROM pg_stat_user_tables WHERE schemaname = 'public' AND relname = '${table}';"
}

active_connections=$(read_active_connections 2>/dev/null) || fail "could not read pg_stat_activity"
[[ "$active_connections" =~ ^[0-9]+$ ]] || fail "invalid pg_stat_activity result"

if [ "$active_connections" -gt "$MAX_ACTIVE_CONNECTIONS" ]; then
  printf '{"event":"vacuum_analyze","status":"skipped","reason":"high_active_connections","activeConnections":%s,"maxActiveConnections":%s}\n' \
    "$active_connections" "$MAX_ACTIVE_CONNECTIONS"
  exit 0
fi

before_dead_total=0
after_dead_total=0
before_size_total=0
after_size_total=0
vacuumed=()
skipped=()

for table in "${TABLES[@]}"; do
  stats=$(read_stats "$table") || fail "could not read stats for ${table}"
  [ -n "$stats" ] || stats="0|0"
  dead_tuples=${stats%%|*}
  relation_size=${stats#*|}

  if [ "$dead_tuples" -lt "$DEAD_TUPLE_THRESHOLD" ]; then
    log "[vacuum] skipping ${table}: ${dead_tuples} dead tuples below threshold"
    skipped+=("$table")
    continue
  fi

  log "[vacuum] running VACUUM (ANALYZE) on public.${table}"
  PGOPTIONS="-c statement_timeout=${STATEMENT_TIMEOUT_MS}" psql "${PSQL_ARGS[@]}" \
    -X -q -A -t -v ON_ERROR_STOP=1 -c "VACUUM (ANALYZE) public.\"${table}\";" \
    > /dev/null || fail "VACUUM (ANALYZE) failed for ${table}"

  # Clear the stats snapshot and read in one session so the "after" figures
  # reflect the vacuum that just completed.
  stats_after=$(read_stats "$table" true) || fail "could not read post-vacuum stats for ${table}"
  [ -n "$stats_after" ] || stats_after="0|0"
  dead_after=${stats_after%%|*}
  size_after=${stats_after#*|}

  before_dead_total=$((before_dead_total + dead_tuples))
  after_dead_total=$((after_dead_total + dead_after))
  before_size_total=$((before_size_total + relation_size))
  after_size_total=$((after_size_total + size_after))
  vacuumed+=("$table")
done

space_reclaimed=$((before_size_total - after_size_total))
if [ "$space_reclaimed" -lt 0 ]; then
  space_reclaimed=0
fi

if [ ${#TABLES[@]} -gt 0 ]; then
  tables_json=$(json_array "${TABLES[@]}")
else
  tables_json="[]"
fi
if [ ${#vacuumed[@]} -gt 0 ]; then
  vacuumed_json=$(json_array "${vacuumed[@]}")
else
  vacuumed_json="[]"
fi
if [ ${#skipped[@]} -gt 0 ]; then
  skipped_json=$(json_array "${skipped[@]}")
else
  skipped_json="[]"
fi

printf '{"event":"vacuum_analyze","status":"ok","tables":%s,"vacuumed":%s,"skipped":%s,"deadTuplesBefore":%s,"deadTuplesAfter":%s,"spaceReclaimedBytes":%s}\n' \
  "$tables_json" "$vacuumed_json" "$skipped_json" \
  "$before_dead_total" "$after_dead_total" "$space_reclaimed"
