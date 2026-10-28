#!/usr/bin/env bash
# check-migrations.sh - run supabase/migrations on a real PostgreSQL 16 engine.
#
#   npm run check:migrations        (or: bash scripts/check-migrations.sh)
#
# What it does
#   1. initdb + starts a throwaway PostgreSQL 16 cluster (temp data dir, free
#      loopback port, torn down on exit - success, failure or Ctrl-C).
#   2. Creates the minimum a Supabase project would already provide (STAND-INS,
#      see "Stubs" below), then applies EVERY file in supabase/migrations in
#      filename order, each with ON_ERROR_STOP in one transaction. A failing file
#      is named and the run stops.
#   3. Asserts the resulting schema in SQL (columns/types, checkpoints,
#      structures key, realtime publication membership, and the persisted
#      villager state: agents.inventory/inbox NOT NULL DEFAULT '[]' backfilled
#      onto a villager that existed before, sessions.last_actor_id/index nullable).
#   4. Applies the whole set a second time and asserts it is a no-op (every file
#      applies cleanly and the schema dump is byte-identical).
#   5. Checks the documented legacy-row DELETE of the respawn_tick migration:
#      migrations up to it, seed rows, then the rest.
#   6. Single-driver lease (R7.6), judged by the DATABASE clock: the four functions of
#      20261027210000_add_server_timed_lease_functions.sql (claim/renew/release_session_lease,
#      session_lease_state) are called on the scratch database - free, fresh, 29 s / 29.999 s / exactly 30 s /
#      31 s old, no heartbeat, own lease, non-owner renew/release, the three states, an explicit TTL, an unknown
#      era - with the heartbeat set relative to now() inside one transaction so the boundary is exact; they are
#      checked to be SECURITY INVOKER with a pinned search_path and to work as role `anon`; and two separate psql
#      sessions race claim_session_lease many times.
#
# What it proves: the SQL files are valid on PostgreSQL 16, give the schema the
# app expects, are re-runnable, and the lease functions have the intended semantics
# and let exactly one of two competing sessions claim the lease.
# What it does NOT prove: this is NOT a Supabase project. It does not run
# PostgREST (how /rest/v1/rpc/<name> maps arguments is covered by `npm run e2e`, not here), RLS is only
# exercised through the lease functions as `anon` (the stub roles are bare; everything else here runs as the
# superuser), and it does not exercise realtime (the publication is an empty stand-in; we only check which
# tables the migrations add to it).
#
# Stubs (stand-ins for what a Supabase project provides, discovered by running
# the migrations - nothing else was needed):
#   - roles anon, authenticated, service_role: NOLOGIN roles, no special
#     attributes. The migrations only GRANT to / create policies for them.
#   - publication supabase_realtime: created empty; the migrations
#     ALTER PUBLICATION ... ADD TABLE into it.
#
# Needs: PostgreSQL 16 binaries (PG_BIN, default /usr/lib/postgresql/16/bin),
# node (only to pick a free port), bash, and
# either a non-root user or root with `runuser` (the server must not run as
# root: it uses the `postgres` OS user if present, else a throwaway user that is
# deleted on exit). Not part of `npm test`.
#
# Env: PG_BIN, ROUNDS (concurrency rounds, default 50), PG_OS_USER.

set -euo pipefail
export LC_ALL=C

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MIG_DIR="$ROOT/supabase/migrations"
PG_BIN="${PG_BIN:-/usr/lib/postgresql/16/bin}"
ROUNDS="${ROUNDS:-50}"
SPLIT_MIGRATION="add_depleted_respawn_tick"   # the one whose legacy DELETE we probe
SESSION_ID="00000000-0000-0000-0000-0000000000a1"

for b in initdb pg_ctl psql pg_dump; do
  [ -x "$PG_BIN/$b" ] || { echo "FAIL  PostgreSQL 16 binary not found: $PG_BIN/$b (set PG_BIN)"; exit 2; }
done
command -v node >/dev/null || { echo "FAIL  node not found"; exit 2; }

WORK=""
CREATED_USER=""
PG_USER=""
PORT=""
FAILS=0
PASSES=0
RUN_AS=()

cleanup() {
  local rc=$?
  trap - EXIT INT TERM
  jobs -p | xargs -r kill 2>/dev/null || true
  if [ -n "$WORK" ] && [ -d "$WORK/data" ]; then
    "${RUN_AS[@]}" "$PG_BIN/pg_ctl" -D "$WORK/data" -m immediate -w stop >/dev/null 2>&1 || true
  fi
  [ -n "$WORK" ] && rm -rf "$WORK"
  [ -n "$CREATED_USER" ] && userdel "$CREATED_USER" >/dev/null 2>&1 || true
  exit "$rc"
}
trap cleanup EXIT INT TERM

pass() { PASSES=$((PASSES + 1)); printf 'PASS  %s\n' "$1"; }
fail() { FAILS=$((FAILS + 1)); printf 'FAIL  %s\n' "$1"; }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/check-migrations.XXXXXX")"
cd "$WORK"   # the server user must be able to read its working directory

# --- OS user for the server (PostgreSQL refuses to run as root) ----------------
if [ "$(id -u)" -eq 0 ]; then
  command -v runuser >/dev/null || { echo "FAIL  running as root needs runuser"; exit 2; }
  PG_USER="${PG_OS_USER:-}"
  if [ -z "$PG_USER" ]; then
    if id postgres >/dev/null 2>&1; then
      PG_USER=postgres
    else
      PG_USER="pgcheck$$"
      useradd --system --no-create-home --shell /usr/sbin/nologin "$PG_USER"
      CREATED_USER="$PG_USER"
    fi
  fi
  chown "$PG_USER" "$WORK"
  RUN_AS=(runuser -u "$PG_USER" --)
fi

PORT="$(node -e "const s=require('net').createServer();s.listen(0,'127.0.0.1',()=>{console.log(s.address().port);s.close()})")"

"${RUN_AS[@]}" "$PG_BIN/initdb" -D "$WORK/data" -U postgres --auth=trust --locale=C -E UTF8 >"$WORK/initdb.log" 2>&1 \
  || { cat "$WORK/initdb.log"; echo "FAIL  initdb"; exit 2; }
"${RUN_AS[@]}" "$PG_BIN/pg_ctl" -D "$WORK/data" -w -l "$WORK/server.log" \
  -o "-p $PORT -k $WORK -c listen_addresses=127.0.0.1 -c fsync=off -c full_page_writes=off -c wal_level=logical" start >/dev/null \
  || { cat "$WORK/server.log"; echo "FAIL  could not start the scratch cluster"; exit 2; }

export PGHOST=127.0.0.1 PGPORT="$PORT" PGUSER=postgres PGDATABASE=postgres
export PGOPTIONS='-c client_min_messages=warning'

sql()  { "$PG_BIN/psql" -X -q -tA -v ON_ERROR_STOP=1 "$@"; }
# one value from one query
val()  { sql -c "$1"; }
# assertion: query must return exactly 't'
check() {
  local name="$1" query="$2" got
  if got="$(val "$query" 2>&1)" && [ "$got" = "t" ]; then pass "$name"; else fail "$name (got: ${got:-nothing})"; fi
}

echo "PostgreSQL $("$PG_BIN/postgres" --version | awk '{print $3}') scratch cluster on 127.0.0.1:$PORT (not a Supabase project)"

# --- stubs ----------------------------------------------------------------------
sql <<'SQL'
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN;
CREATE PUBLICATION supabase_realtime;
SQL

# --- migrations -------------------------------------------------------------------
mapfile -t FILES < <(find "$MIG_DIR" -maxdepth 1 -type f -name '*.sql' | sort)
[ "${#FILES[@]}" -gt 0 ] || { echo "FAIL  no migrations found in $MIG_DIR"; exit 2; }

SPLIT_AT=-1
for i in "${!FILES[@]}"; do
  case "${FILES[$i]}" in *"_${SPLIT_MIGRATION}"*) SPLIT_AT=$i ;; esac
done
[ "$SPLIT_AT" -ge 0 ] || { echo "FAIL  migration '$SPLIT_MIGRATION' not found"; exit 2; }

# apply one file; returns non-zero (and prints the error) on failure
apply_file() {
  local out
  if ! out="$("$PG_BIN/psql" -X -q -v ON_ERROR_STOP=1 --single-transaction -f "$1" 2>&1)"; then
    printf '%s\n' "$out" | sed 's/^/        /'
    return 1
  fi
}

apply_first_pass() { # $1.. = indices
  local i
  for i in "$@"; do
    if ! apply_file "${FILES[$i]}"; then
      fail "migration $(basename "${FILES[$i]}") failed to apply"
      echo "${PASSES} passed, ${FAILS} failed"
      exit 1
    fi
  done
}

# part 1: everything before the respawn_tick migration
apply_first_pass $(seq 0 $((SPLIT_AT - 1)))
pass "migrations 1-${SPLIT_AT} applied (each file in one transaction, ON_ERROR_STOP)"

# seed the legacy rows (shape of depleted_objects before the migration, from
# 20261027132606_create_depleted_objects_table.sql: id text, session_id uuid, respawn_at timestamptz)
check "pre-migration depleted_objects has respawn_at and no respawn_tick" \
  "SELECT (SELECT count(*) FROM information_schema.columns WHERE table_name='depleted_objects' AND column_name='respawn_at' AND data_type='timestamp with time zone')=1
      AND (SELECT count(*) FROM information_schema.columns WHERE table_name='depleted_objects' AND column_name='respawn_tick')=0"
sql <<SQL
INSERT INTO depleted_objects (id, session_id, respawn_at) VALUES
  ('legacy_animal', '$SESSION_ID', now() + interval '1 hour'),  -- animal: respawn_at set
  ('legacy_mine',   '$SESSION_ID', NULL);                      -- mine: never respawns
-- a villager and an era that exist before the persisted-state migration (it must backfill them)
INSERT INTO agents (id, name, model, color) VALUES ('00000000-0000-0000-0000-0000000000b1', 'legacy_villager', 'stub', '#000000');
INSERT INTO sessions (id, seq, title) VALUES ('00000000-0000-0000-0000-0000000000a0', 9000, 'check-migrations legacy era');
SQL

# part 2: the rest, starting with the migration under test
apply_first_pass $(seq "$SPLIT_AT" $((${#FILES[@]} - 1)))
pass "all ${#FILES[@]} migrations applied in filename order"

check "legacy animal row (respawn_at set, no respawn_tick) removed by the respawn_tick migration" \
  "SELECT count(*)=0 FROM depleted_objects WHERE id='legacy_animal'"
check "legacy mine row (respawn_at null) survives the respawn_tick migration" \
  "SELECT count(*)=1 FROM depleted_objects WHERE id='legacy_mine' AND respawn_tick IS NULL"

check "legacy villager gets inventory '[]' and inbox '[]' from the persisted-state migration" \
  "SELECT EXISTS (SELECT 1 FROM agents WHERE name='legacy_villager' AND inventory = '[]'::jsonb AND inbox = '[]'::jsonb)"
check "legacy era gets a null turn cursor from the persisted-state migration" \
  "SELECT EXISTS (SELECT 1 FROM sessions WHERE id='00000000-0000-0000-0000-0000000000a0' AND last_actor_id IS NULL AND last_actor_index IS NULL)"

# --- schema assertions --------------------------------------------------------------
col() { # table column data_type
  check "$1.$2 is $3" \
    "SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='$1' AND column_name='$2' AND data_type='$3')"
}
col sessions driver_id text
col sessions driver_heartbeat_at 'timestamp with time zone'
col sessions parent_session_id uuid
col sessions fork_tick integer
col memories session_id uuid
col memories tick integer
col agents inventory jsonb
col agents inbox jsonb
col sessions last_actor_id uuid
col sessions last_actor_index integer
col depleted_objects respawn_tick integer
col depleted_objects respawn_at 'timestamp with time zone'
col events tick integer
col checkpoints session_id uuid
col checkpoints tick integer
col checkpoints snapshot jsonb
col agent_positions tick integer
check "agents.inventory and agents.inbox are NOT NULL with default '[]'; the cursor columns are nullable with no default" \
  "SELECT (SELECT count(*) FROM information_schema.columns WHERE table_schema='public' AND table_name='agents' AND column_name IN ('inventory','inbox')
              AND is_nullable='NO' AND column_default LIKE '''[]''::jsonb%')=2
      AND (SELECT count(*) FROM information_schema.columns WHERE table_schema='public' AND table_name='sessions' AND column_name IN ('last_actor_id','last_actor_index')
              AND is_nullable='YES' AND column_default IS NULL)=2"
check "a villager inserted without the new columns defaults to empty hands and an empty inbox; null is refused" \
  "WITH x AS (INSERT INTO agents (name, model, color) VALUES ('default_villager', 'stub', '#000000') RETURNING inventory, inbox)
   SELECT count(*)=1 AND bool_and(inventory='[]'::jsonb AND inbox='[]'::jsonb) FROM x"
if val "UPDATE agents SET inbox = NULL WHERE name='default_villager'" >/dev/null 2>&1; then
  fail "agents.inbox refuses NULL"
else
  pass "agents.inbox refuses NULL"
fi
if val "UPDATE agents SET inventory = NULL WHERE name='default_villager'" >/dev/null 2>&1; then
  fail "agents.inventory refuses NULL"
else
  pass "agents.inventory refuses NULL"
fi
check "carried items, pending chat and the turn cursor store and read back as the app writes them (jsonb round trip)" \
  "WITH a AS (UPDATE agents SET inventory='[\"wood\",\"cube\"]', inbox='[{\"fromId\":\"x\",\"fromName\":\"Bramble\",\"message\":\"hi\"}]' WHERE name='default_villager' RETURNING inventory, inbox),
        s AS (UPDATE sessions SET last_actor_id='00000000-0000-0000-0000-0000000000b1', last_actor_index=2 WHERE id='00000000-0000-0000-0000-0000000000a0' RETURNING last_actor_id, last_actor_index)
   SELECT (SELECT inventory->>1 = 'cube' AND inbox->0->>'message' = 'hi' FROM a)
      AND (SELECT last_actor_id = '00000000-0000-0000-0000-0000000000b1'::uuid AND last_actor_index = 2 FROM s)"
check "the turn cursor needs no villager row (no foreign key: a dismissed villager must not block the write)" \
  "SELECT NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.sessions'::regclass AND contype='f' AND conkey @> ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid='public.sessions'::regclass AND attname='last_actor_id')])"
check "checkpoints unique on (session_id, tick)" \
  "SELECT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.checkpoints'::regclass AND contype='u'
      AND (SELECT array_agg(a.attname::text ORDER BY k.ord) FROM unnest(conkey) WITH ORDINALITY k(attnum, ord) JOIN pg_attribute a ON a.attrelid=conrelid AND a.attnum=k.attnum) = ARRAY['session_id','tick'])"
check "memories index on (session_id, tick)" \
  "SELECT EXISTS (SELECT 1 FROM pg_indexes WHERE tablename='memories' AND indexname='idx_memories_session_tick' AND indexdef LIKE '%(session_id, tick)%')"
check "structures has a unique index on (session_id, id)" \
  "SELECT EXISTS (SELECT 1 FROM pg_index i WHERE i.indrelid='public.structures'::regclass AND i.indisunique
      AND (SELECT array_agg(a.attname::text ORDER BY k.ord) FROM unnest(i.indkey::int2[]) WITH ORDINALITY k(attnum, ord) JOIN pg_attribute a ON a.attrelid=i.indrelid AND a.attnum=k.attnum) = ARRAY['session_id','id'])"
check "structures has no primary key any more" \
  "SELECT NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.structures'::regclass AND contype='p')"
check "realtime publication holds events, memories, agents, civ (as added by the migration)" \
  "SELECT (SELECT array_agg(tablename::text ORDER BY tablename) FROM pg_publication_tables WHERE pubname='supabase_realtime') = ARRAY['agents','civ','events','memories']"
check "RLS is enabled on every public table" \
  "SELECT NOT EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='r' AND NOT c.relrowsecurity)"

# structures: the same id under two eras is accepted, a duplicate within one era is refused
sql <<SQL
INSERT INTO sessions (id, seq, title) VALUES
  ('$SESSION_ID', 9001, 'check-migrations era A'),
  ('00000000-0000-0000-0000-0000000000a2', 9002, 'check-migrations era B');
INSERT INTO structures (id, territory, position, kind, session_id) VALUES
  ('built_1', 'forest', '{"x":1,"y":1}', 'house', '$SESSION_ID');
SQL
check "structures: same id under a second era is accepted" \
  "WITH x AS (INSERT INTO structures (id, territory, position, kind, session_id)
              VALUES ('built_1', 'forest', '{\"x\":1,\"y\":1}', 'house', '00000000-0000-0000-0000-0000000000a2') RETURNING 1)
   SELECT count(*)=1 FROM x"
if val "INSERT INTO structures (id, territory, position, kind, session_id)
        VALUES ('built_1', 'forest', '{\"x\":2,\"y\":2}', 'house', '$SESSION_ID')" >/dev/null 2>&1; then
  fail "structures: duplicate (session_id, id) within one era is refused"
else
  pass "structures: duplicate (session_id, id) within one era is refused"
fi

# --- idempotence: apply the whole set a second time -----------------------------------
# a modern animal row (respawn_at AND respawn_tick set) must survive the re-run of the legacy DELETE
sql -c "INSERT INTO depleted_objects (id, session_id, respawn_at, respawn_tick)
        VALUES ('modern_animal', '$SESSION_ID', now() + interval '1 hour', 500)"
DUMP1="$WORK/schema1.sql"; DUMP2="$WORK/schema2.sql"
dump_schema() { "$PG_BIN/pg_dump" -s --no-owner | grep -v '^\\\(un\)\?restrict '; }   # pg_dump 16.x adds a random \restrict token
dump_schema >"$DUMP1"
NON_IDEMPOTENT=()
for f in "${FILES[@]}"; do
  if ! apply_file "$f"; then NON_IDEMPOTENT+=("$(basename "$f")"); fi
done
if [ "${#NON_IDEMPOTENT[@]}" -eq 0 ]; then
  pass "second pass: all ${#FILES[@]} migrations re-apply without error"
else
  fail "second pass: not re-runnable: ${NON_IDEMPOTENT[*]}"
fi
dump_schema >"$DUMP2"
if diff -q "$DUMP1" "$DUMP2" >/dev/null; then
  pass "second pass: schema dump identical before and after (no-op)"
else
  fail "second pass: schema changed (diff follows)"; { diff "$DUMP1" "$DUMP2" || true; } | head -20 | sed 's/^/        /'
fi
check "second pass: data kept (modern animal row, legacy mine row, both structures rows)" \
  "SELECT (SELECT count(*) FROM depleted_objects WHERE id IN ('modern_animal','legacy_mine'))=2 AND (SELECT count(*) FROM structures WHERE id='built_1')=2"

# --- single-driver lease: server-timed functions ---------------------------------------------
# The lease is judged by the DATABASE clock (now()) inside four functions (20261027210000_add_server_timed_lease_functions.sql);
# a client sends no time. The checks set `driver_heartbeat_at` relative to now() directly, and the boundary checks run in ONE
# transaction with the claim, where now() is frozen, so "exactly 30 s old" really is exactly 30 s.
LEASE_FNS=(
  "claim_session_lease(uuid,text,integer)"
  "renew_session_lease(uuid,text)"
  "release_session_lease(uuid,text)"
  "session_lease_state(uuid,text,integer)"
)
for fn in "${LEASE_FNS[@]}"; do
  check "lease: public.$fn exists, is SECURITY INVOKER (not DEFINER) with a pinned search_path" \
    "SELECT EXISTS (SELECT 1 FROM pg_proc WHERE oid='public.$fn'::regprocedure AND NOT prosecdef AND prolang=(SELECT oid FROM pg_language WHERE lanname='plpgsql')
        AND EXISTS (SELECT 1 FROM unnest(proconfig) c WHERE c LIKE 'search_path=%'))"
  check "lease: anon and authenticated may EXECUTE public.$fn" \
    "SELECT has_function_privilege('anon','public.$fn','EXECUTE') AND has_function_privilege('authenticated','public.$fn','EXECUTE')"
done
check "lease: session_lease_state is STABLE, the three writers are VOLATILE" \
  "SELECT (SELECT provolatile='s' FROM pg_proc WHERE oid='public.session_lease_state(uuid,text,integer)'::regprocedure)
      AND (SELECT bool_and(provolatile='v') FROM pg_proc WHERE oid IN ('public.claim_session_lease(uuid,text,integer)'::regprocedure,'public.renew_session_lease(uuid,text)'::regprocedure,'public.release_session_lease(uuid,text)'::regprocedure))"
check "lease: the TTL defaults to 30 seconds (claim and state take it as an optional third argument)" \
  "SELECT (SELECT pg_get_expr(proargdefaults, 0) FROM pg_proc WHERE oid='public.claim_session_lease(uuid,text,integer)'::regprocedure) = '30'
      AND (SELECT pg_get_expr(proargdefaults, 0) FROM pg_proc WHERE oid='public.session_lease_state(uuid,text,integer)'::regprocedure) = '30'"

# set the lease row: $1 = driver_id or NULL, $2 = SQL expression for the heartbeat (e.g. "now() - interval '5 seconds'") or NULL
set_lease() {
  local d="NULL"; [ "$1" != NULL ] && d="'$1'"
  sql -c "UPDATE sessions SET driver_id = $d, driver_heartbeat_at = $2 WHERE id = '$SESSION_ID'"
}
row() { val "SELECT coalesce(driver_id,'<null>') || '|' || coalesce(driver_heartbeat_at::text,'<null>') FROM sessions WHERE id='$SESSION_ID'"; }
holder() { val "SELECT coalesce(driver_id,'<null>') FROM sessions WHERE id='$SESSION_ID'"; }
# $1 = holder, $2 = heartbeat SQL expr, $3 = SQL call (one boolean/text expression). One transaction, so now() is the same
# instant for the heartbeat set here and for the function's own now(): prints "<result>,<holder afterwards>".
in_txn() {
  local d="NULL"; [ "$1" != NULL ] && d="'$1'"
  sql <<SQL | paste -sd, -
BEGIN;
UPDATE sessions SET driver_id = $d, driver_heartbeat_at = $2 WHERE id = '$SESSION_ID';
SELECT ($3)::text;
SELECT coalesce(driver_id, '<null>') FROM sessions WHERE id = '$SESSION_ID';
COMMIT;
SQL
}
claim_call() { printf "public.claim_session_lease('%s','%s'%s)" "$SESSION_ID" "$1" "${2:+, $2}"; }
state_call() { printf "public.session_lease_state('%s','%s'%s)" "$SESSION_ID" "$1" "${2:+, $2}"; }
expect() { # name, got, want
  if [ "$2" = "$3" ]; then pass "$1"; else fail "$1 (got: $2, want: $3)"; fi
}

# claim_session_lease
expect "lease claim: a free session (no driver, no heartbeat) is claimed" \
  "$(in_txn NULL NULL "$(claim_call claim-free)")" "true,claim-free"
expect "lease claim: a leftover heartbeat without a driver does not block" \
  "$(in_txn NULL "now()" "$(claim_call claim-free)")" "true,claim-free"
expect "lease claim: a fresh lease (5s old) held by someone else is refused and left untouched" \
  "$(in_txn other-driver "now() - interval '5 seconds'" "$(claim_call me-1)")" "false,other-driver"
expect "lease claim: a 29s-old lease is still refused" \
  "$(in_txn other-driver "now() - interval '29 seconds'" "$(claim_call me-1)")" "false,other-driver"
expect "lease claim: a 29.999s-old lease is still refused (1 ms inside the TTL)" \
  "$(in_txn other-driver "now() - interval '29.999 seconds'" "$(claim_call me-1)")" "false,other-driver"
expect "lease claim: a heartbeat EXACTLY 30s old is stale and taken over (the boundary: age >= TTL)" \
  "$(in_txn other-driver "now() - interval '30 seconds'" "$(claim_call me-1)")" "true,me-1"
expect "lease claim: a 30.001s-old lease is taken over" \
  "$(in_txn other-driver "now() - interval '30.001 seconds'" "$(claim_call me-1)")" "true,me-1"
expect "lease claim: a stale lease (31s old) is taken over" \
  "$(in_txn other-driver "now() - interval '31 seconds'" "$(claim_call me-1)")" "true,me-1"
expect "lease claim: a very stale lease (10 min) is taken over" \
  "$(in_txn other-driver "now() - interval '10 minutes'" "$(claim_call me-1)")" "true,me-1"
expect "lease claim: a driver with no heartbeat at all is taken over" \
  "$(in_txn other-driver NULL "$(claim_call me-1)")" "true,me-1"
expect "lease claim: the current driver renews its own fresh lease by claiming again" \
  "$(in_txn me-1 "now() - interval '1 second'" "$(claim_call me-1)")" "true,me-1"
expect "lease claim: the current driver re-claims its own long-stale lease" \
  "$(in_txn me-1 "now() - interval '10 minutes'" "$(claim_call me-1)")" "true,me-1"
expect "lease claim: an explicit TTL is honoured (15s-old lease: refused with a 30s TTL, taken with a 10s TTL)" \
  "$(in_txn other-driver "now() - interval '15 seconds'" "$(claim_call me-1 30)"),$(in_txn other-driver "now() - interval '15 seconds'" "$(claim_call me-1 10)")" \
  "false,other-driver,true,me-1"
expect "lease claim: an unknown session is not claimed (false, no row created)" \
  "$(val "SELECT public.claim_session_lease('00000000-0000-0000-0000-00000000dead','x')::text || ',' || (SELECT count(*) FROM sessions WHERE id='00000000-0000-0000-0000-00000000dead')")" "false,0"
set_lease NULL NULL
sql -c "SELECT public.claim_session_lease('$SESSION_ID','stamp-test')" >/dev/null
check "lease claim: the heartbeat is stamped by the database clock (within a second of the server's own clock_timestamp())" \
  "SELECT driver_id='stamp-test' AND abs(extract(epoch FROM clock_timestamp() - driver_heartbeat_at)) < 1 FROM sessions WHERE id='$SESSION_ID'"

# renew_session_lease
set_lease me-1 "now() - interval '20 seconds'"
BEFORE_HB="$(val "SELECT driver_heartbeat_at FROM sessions WHERE id='$SESSION_ID'")"
expect "lease renew: the owner renews (true)" "$(val "SELECT public.renew_session_lease('$SESSION_ID','me-1')")" "t"
check "lease renew: the owner's heartbeat moved to the database's now()" \
  "SELECT driver_id='me-1' AND driver_heartbeat_at > '$BEFORE_HB'::timestamptz AND abs(extract(epoch FROM clock_timestamp() - driver_heartbeat_at)) < 1 FROM sessions WHERE id='$SESSION_ID'"
set_lease other-driver "now() - interval '7 seconds'"
ROW_BEFORE="$(row)"
expect "lease renew: a non-owner gets false" "$(val "SELECT public.renew_session_lease('$SESSION_ID','me-1')")" "f"
expect "lease renew: a non-owner changes nothing (driver and heartbeat intact)" "$(row)" "$ROW_BEFORE"
set_lease NULL NULL
expect "lease renew: nobody can renew a free session (false, still free)" \
  "$(val "SELECT public.renew_session_lease('$SESSION_ID','me-1')::text"),$(row)" "false,<null>|<null>"

# release_session_lease
set_lease other-driver "now() - interval '7 seconds'"
ROW_BEFORE="$(row)"
expect "lease release: a non-owner gets false" "$(val "SELECT public.release_session_lease('$SESSION_ID','me-1')")" "f"
expect "lease release: a non-owner changes nothing (driver and heartbeat intact)" "$(row)" "$ROW_BEFORE"
set_lease me-1 "now()"
expect "lease release: the owner releases (true), driver_id and driver_heartbeat_at are NULL" \
  "$(val "SELECT public.release_session_lease('$SESSION_ID','me-1')::text"),$(row)" "true,<null>|<null>"
expect "lease release: releasing again is false (nothing to release)" "$(val "SELECT public.release_session_lease('$SESSION_ID','me-1')")" "f"
expect "lease release: after a release another window claims at once" \
  "$(in_txn NULL NULL "$(claim_call someone-else)")" "true,someone-else"

# session_lease_state
expect "lease state: free when nobody drives (no driver)" "$(in_txn NULL NULL "$(state_call me-1)")" "free,<null>"
expect "lease state: free when the driver has no heartbeat" "$(in_txn other-driver NULL "$(state_call me-1)")" "free,other-driver"
expect "lease state: other when someone else's heartbeat is fresh (5s)" "$(in_txn other-driver "now() - interval '5 seconds'" "$(state_call me-1)")" "other,other-driver"
expect "lease state: other at 29.999s old" "$(in_txn other-driver "now() - interval '29.999 seconds'" "$(state_call me-1)")" "other,other-driver"
expect "lease state: free at exactly 30s old (same boundary as the claim)" "$(in_txn other-driver "now() - interval '30 seconds'" "$(state_call me-1)")" "free,other-driver"
expect "lease state: free when someone else's heartbeat is 31s old" "$(in_txn other-driver "now() - interval '31 seconds'" "$(state_call me-1)")" "free,other-driver"
expect "lease state: mine when I drive (fresh)" "$(in_txn me-1 "now() - interval '1 second'" "$(state_call me-1)")" "mine,me-1"
expect "lease state: mine when I drive, even if my heartbeat is long stale" "$(in_txn me-1 "now() - interval '10 minutes'" "$(state_call me-1)")" "mine,me-1"
expect "lease state: an explicit TTL is honoured (15s-old lease: other with 30s, free with 10s)" \
  "$(in_txn other-driver "now() - interval '15 seconds'" "$(state_call me-1 30)"),$(in_txn other-driver "now() - interval '15 seconds'" "$(state_call me-1 10)")" \
  "other,other-driver,free,other-driver"
expect "lease state: an unknown session is NULL (empty), not 'free'" \
  "$(val "SELECT coalesce(public.session_lease_state('00000000-0000-0000-0000-00000000dead','x'),'<null>')")" "<null>"
set_lease other-driver "now() - interval '5 seconds'"
expect "lease state: it is a pure read (works inside a READ ONLY transaction)" \
  "$(sql <<SQL
BEGIN READ ONLY;
SELECT $(state_call me-1);
COMMIT;
SQL
)" "other"

# as anon: SECURITY INVOKER means the caller's own grants and RLS apply, and anon has them on sessions
set_lease NULL NULL
ANON_OUT="$(sql <<SQL
SET ROLE anon;
SELECT current_user;
SELECT public.session_lease_state('$SESSION_ID','anon-1');
SELECT public.claim_session_lease('$SESSION_ID','anon-1');
SELECT public.renew_session_lease('$SESSION_ID','anon-1');
SELECT public.session_lease_state('$SESSION_ID','anon-2');
SELECT public.claim_session_lease('$SESSION_ID','anon-2');
SELECT public.release_session_lease('$SESSION_ID','anon-1');
RESET ROLE;
SQL
)" || ANON_OUT="error: $ANON_OUT"
expect "lease as anon (SET ROLE anon): state free, claim, renew, a rival sees 'other' and is refused, release works (invoker rights + RLS allow it)" \
  "$(printf '%s' "$ANON_OUT" | tr '\n' ' ')" "anon free t t other f t"
expect "lease as anon: the release left the row free" "$(row)" "<null>|<null>"

# the race: two psql sessions call claim_session_lease at the same moment, released together by an advisory-lock barrier
# (even rounds: bare autocommit calls; odd rounds: each call holds its row lock for 20 ms inside a transaction so the loser
# really waits and re-checks the predicate against the winner's committed row)
claim_race_sql() { printf "SELECT public.claim_session_lease('%s','%s');" "$SESSION_ID" "$1"; }
reset_lease() { # $1 = driver_id or NULL, $2 = heartbeat age in seconds or NULL
  local h="NULL"; [ "$2" != NULL ] && h="now() - interval '$2 seconds'"
  set_lease "$1" "$h"
}
KEY=424242
winners_a=0; winners_b=0; bad_rounds=()
for ((r = 1; r <= ROUNDS; r++)); do
  case $((r % 3)) in
    0) reset_lease NULL NULL ;;
    1) reset_lease old-driver 60 ;;
    2) reset_lease old-driver NULL ;;
  esac
  A="drv-a-$r"; B="drv-b-$r"
  CLAIM_A="$(claim_race_sql "$A")"; CLAIM_B="$(claim_race_sql "$B")"
  if [ $((r % 2)) -eq 1 ]; then HOLD="SELECT pg_sleep(0.02); COMMIT;"; BEGIN_="BEGIN;"; else HOLD=""; BEGIN_=""; fi
  # controller: holds the barrier, releases it once both contenders are waiting
  "$PG_BIN/psql" -X -q -tA -v ON_ERROR_STOP=1 -c "SELECT pg_advisory_lock($KEY); DO \$\$ DECLARE n int := 0; BEGIN
    WHILE (SELECT count(*) FROM pg_locks WHERE locktype='advisory' AND NOT granted) < 2 AND n < 4000 LOOP n := n + 1; PERFORM pg_sleep(0.005); END LOOP; END \$\$;" \
    >/dev/null 2>"$WORK/ctl.err" & ctl=$!
  for _ in $(seq 1 2000); do
    [ "$(val "SELECT count(*) FROM pg_locks WHERE locktype='advisory' AND granted")" = 1 ] && break
    sleep 0.005
  done
  printf '%s\n%s\n%s\n%s\n' "SELECT pg_advisory_lock_shared($KEY);" "$BEGIN_" "$CLAIM_A" "$HOLD" | sql >"$WORK/a.out" 2>"$WORK/a.err" & pa=$!
  printf '%s\n%s\n%s\n%s\n' "SELECT pg_advisory_lock_shared($KEY);" "$BEGIN_" "$CLAIM_B" "$HOLD" | sql >"$WORK/b.out" 2>"$WORK/b.err" & pb=$!
  wait "$ctl" || bad_rounds+=("$r(controller: $(head -c 200 "$WORK/ctl.err"))")
  wait "$pa" || bad_rounds+=("$r(A: $(head -c 200 "$WORK/a.err"))")
  wait "$pb" || bad_rounds+=("$r(B: $(head -c 200 "$WORK/b.err"))")
  wa="$(grep -c '^t$' "$WORK/a.out" || true)"; wb="$(grep -c '^t$' "$WORK/b.out" || true)"
  holder="$(holder)"
  if [ $((wa + wb)) -ne 1 ]; then
    bad_rounds+=("$r(winners: A=$wa B=$wb)")
  elif { [ "$wa" = 1 ] && [ "$holder" != "$A" ]; } || { [ "$wb" = 1 ] && [ "$holder" != "$B" ]; }; then
    bad_rounds+=("$r(row holder '$holder' is not the winner)")
  fi
  winners_a=$((winners_a + wa)); winners_b=$((winners_b + wb))
done
if [ "${#bad_rounds[@]}" -eq 0 ]; then
  pass "lease race: exactly one of two parallel psql sessions won claim_session_lease in each of $ROUNDS rounds (A won $winners_a, B won $winners_b) and the row names the winner"
else
  fail "lease race: rounds without exactly one winner: ${bad_rounds[*]}"
fi
# contested fresh lease: both challengers lose
reset_lease holder-x 3
{ claim_race_sql c-a | sql >"$WORK/a.out" & claim_race_sql c-b | sql >"$WORK/b.out" & wait; } 2>/dev/null
[ "$(cat "$WORK/a.out" "$WORK/b.out" | grep -c '^t$' || true)" = 0 ] && [ "$(holder)" = holder-x ] \
  && pass "lease race: two challengers against a fresh lease both lose" \
  || fail "lease race: two challengers against a fresh lease both lose"

echo "----"
echo "$PASSES passed, $FAILS failed (scratch cluster is removed on exit)"
[ "$FAILS" -eq 0 ]
