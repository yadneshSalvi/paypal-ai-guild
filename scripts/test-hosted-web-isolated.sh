#!/bin/sh
set -eu
# Source/controlled transport tests only. No Sandbox, browser, model or deploy.
GUILD_HOSTED_SOURCE_ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$GUILD_HOSTED_SOURCE_ROOT"
GUILD_HOSTED_TEST_NODE=${GUILD_HOSTED_TEST_NODE:-$(command -v node)}
GUILD_HOSTED_PG_BIN=${GUILD_HOSTED_PG_BIN:-$(dirname -- "$(command -v initdb)")}
case "$($GUILD_HOSTED_TEST_NODE --version)" in v22.*) ;; *) printf '%s\n' 'Use an explicit Node22 binary through GUILD_HOSTED_TEST_NODE.' >&2; exit 1;; esac
GUILD_HOSTED_RUN_ROOT=$(mktemp -d /tmp/guild-hosted-source-test.XXXXXX)
GUILD_HOSTED_SOCKET="$GUILD_HOSTED_RUN_ROOT/socket"
mkdir "$GUILD_HOSTED_SOCKET"
mkdir -p .private/hosted-checks
GUILD_HOSTED_LOG_ROOT="$GUILD_HOSTED_SOURCE_ROOT/.private/hosted-checks/$(basename "$GUILD_HOSTED_RUN_ROOT")"
mkdir "$GUILD_HOSTED_LOG_ROOT"
printf '%s\n' "Retaining hosted source-test logs: $GUILD_HOSTED_LOG_ROOT"
printf '%s\n' "$GUILD_HOSTED_RUN_ROOT" > "$GUILD_HOSTED_LOG_ROOT/private-cluster-path.txt"
"$GUILD_HOSTED_PG_BIN/initdb" -D "$GUILD_HOSTED_RUN_ROOT/data" --username=guild_hosted_test --auth=trust --encoding=UTF8 --no-locale > "$GUILD_HOSTED_LOG_ROOT/initdb.log" 2>&1
"$GUILD_HOSTED_PG_BIN/pg_ctl" -D "$GUILD_HOSTED_RUN_ROOT/data" -l "$GUILD_HOSTED_LOG_ROOT/postgres.log" -o "-k $GUILD_HOSTED_SOCKET -c listen_addresses='' -c max_connections=40" -w start > "$GUILD_HOSTED_LOG_ROOT/start.log" 2>&1
trap '"$GUILD_HOSTED_PG_BIN/pg_ctl" -D "$GUILD_HOSTED_RUN_ROOT/data" -m fast -w stop > "$GUILD_HOSTED_LOG_ROOT/stop.log" 2>&1' EXIT
trap 'exit 130' HUP INT TERM
"$GUILD_HOSTED_PG_BIN/createdb" -h "$GUILD_HOSTED_SOCKET" -U guild_hosted_test guild_hosted_source_tests
GUILD_HOSTED_TEST_PATH="$(dirname -- "$GUILD_HOSTED_TEST_NODE"):$GUILD_HOSTED_PG_BIN:/usr/bin:/bin:/usr/sbin:/sbin"
env -i PATH="$GUILD_HOSTED_TEST_PATH" TMPDIR=/tmp LANG=en_US.UTF-8 \
  DATABASE_URL="postgresql://guild_hosted_test@localhost/guild_hosted_source_tests?host=$GUILD_HOSTED_SOCKET" \
  AUTH_SECRET=synthetic-disposable-hosted-approval-key JUDGE_SESSION_SECRET=synthetic-disposable-hosted-session-key \
  OPENAI_API_KEY= OPENAI_MODEL=gpt-6.1-sol GEMINI_API_KEY= DEEPGRAM_API_KEY= BLOB_READ_WRITE_TOKEN= \
  "$GUILD_HOSTED_TEST_NODE" --import ./scripts/hosted-test-guard.mjs --import tsx --test --test-concurrency=1 \
  tests/web-hosted-*.test.ts tests/integration/web-hosted.test.ts tests/integration/web-audit-store.test.ts \
  > "$GUILD_HOSTED_LOG_ROOT/tests.log" 2>&1
printf '%s\n' "Hosted source tests passed. Retained logs: $GUILD_HOSTED_LOG_ROOT"
