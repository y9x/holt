#!/usr/bin/env bash
# Ship a built holt to amph and activate it. Run by CI (.github/workflows/deploy.yml) after
# `make build` and `make e2e`; never by hand from an agent session.
#
# The CI key is forced through /usr/local/sbin/holt-deploy-gate on amph, which accepts only
# `rsync --server` into /opt/holt and `activate`, so this script uses nothing else.
#
#   HOLT_SSH_TARGET   user@host (default root@amph)
#   HOLT_SSH          ssh command line (default: ssh with batch mode)

set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
TARGET=${HOLT_SSH_TARGET:-root@amph}
SSH=${HOLT_SSH:-ssh -o BatchMode=yes}
REMOTE=/opt/holt

[[ -f "$ROOT/main/dist/index.html" ]] || { echo 'deploy: main/dist is missing; run make build first' >&2; exit 1; }

send() { rsync -az -e "$SSH" "$@"; }

echo "==> server code"
send --delete --exclude='*.test.mjs' "$ROOT/main/src/" "$TARGET:$REMOTE/src/"
echo "==> compiled embed"
send --delete "$ROOT/main/dist/" "$TARGET:$REMOTE/dist/"
echo "==> partner loader"
send --delete "$ROOT/main/loader/" "$TARGET:$REMOTE/loader/"
echo "==> package manifest, schema, units"
send "$ROOT/main/package.json" "$ROOT/main/package-lock.json" "$ROOT/main/vite.chat.config.ts" "$TARGET:$REMOTE/"
echo "==> chat API preview root"
send --delete "$ROOT/main/chat-api-root/" "$TARGET:$REMOTE/chat-api-root/"
# The bot runs ensureSchema() on start (vendored db.ts); it looks for schema.sql in its cwd.
send "$ROOT/schema.sql" "$TARGET:$REMOTE/"
send "$ROOT/deploy/holt.service" "$ROOT/deploy/holt-discord.service" "$ROOT/deploy/holt-chat.service" "$TARGET:$REMOTE/deploy/"

echo "==> activate"
$SSH "$TARGET" activate
