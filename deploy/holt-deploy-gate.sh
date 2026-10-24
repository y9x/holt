#!/usr/bin/env bash
# holt deploy gate: the forced command for holt's CI key on amph. Installed by hand (never by CI) as
# /usr/local/sbin/holt-deploy-gate, with the key restricted in /root/.ssh/authorized_keys:
#
#   restrict,command="/usr/local/sbin/holt-deploy-gate" ssh-ed25519 AAAA… holt-ci@y9x/holt
#
# The key can do exactly two things, and nothing else (no shell, no pty, no forwarding):
#
#   rsync into /opt/holt   `rsync --server` receiving only (never --sender), destination under
#                          /opt/holt, only the flags deploy/deploy.sh sends.
#   activate               npm ci, install the two unit files, restart holt, restart the bot, and
#                          prove both are healthy. If the bot does not log in, abulxt-discord is
#                          started again (Conflicts= stops holt-discord) and the deploy fails.
#
# This limits what a leaked key can do to "deploy holt", which still means running repo code as
# root: holt's services run as root, like abulxt's. A dedicated user is a separate hardening step.

set -euo pipefail
ROOT=/opt/holt
log() { logger -t holt-deploy -- "$*"; echo "holt-deploy: $*" >&2; }

cmd=${SSH_ORIGINAL_COMMAND:-}
read -r -a args <<< "$cmd"

deny() {
  log "refused: ${cmd:0:200}"
  exit 1
}

if [[ ${args[0]:-} == rsync ]]; then
  (( ${#args[@]} >= 4 )) || deny
  [[ ${args[1]} == --server ]] || deny
  dest=${args[-1]}
  [[ ${args[-2]} == . ]] || deny
  # Exactly the destinations deploy.sh writes. --delete only where the whole directory is ours, never
  # /opt/holt itself (config.js, node_modules).
  case $dest in
    /opt/holt/src/ | /opt/holt/dist/ | /opt/holt/loader/) may_delete=1 ;;
    /opt/holt/ | /opt/holt/deploy/) may_delete=0 ;;
    *) deny ;;
  esac
  for arg in "${args[@]:2:${#args[@]}-4}"; do
    # The option letters `rsync -az` sends (rlptgoD + z), then `e.` and the protocol capability
    # letters. Anything else (-K follows directory symlinks, -R, --log-file=, ...) is refused.
    if [[ $arg =~ ^-[rlptgoDz]+e\.[A-Za-z]+$ ]]; then continue; fi
    if [[ $arg == --delete && $may_delete == 1 ]]; then continue; fi
    deny
  done
  mkdir -p "$dest"
  # No symlink anywhere on the way: a link planted earlier must not carry a later write elsewhere.
  [[ $(realpath -e "$dest")/ == "$dest" ]] || deny
  log "rsync -> $dest"
  exec "${args[@]}"
fi

if [[ $cmd == activate ]]; then
  cd "$ROOT"
  [[ -f config.js ]] || { log 'config.js is missing; set up the host first (docs/DEPLOY.md)'; exit 1; }
  log 'activate: npm ci'
  npm ci --no-audit --no-fund --loglevel=error
  install -m 0644 deploy/holt.service /etc/systemd/system/holt.service
  install -m 0644 deploy/holt-discord.service /etc/systemd/system/holt-discord.service
  systemctl daemon-reload
  systemctl enable holt holt-discord >/dev/null 2>&1

  log 'activate: restart holt'
  systemctl restart holt
  for _ in $(seq 1 40); do
    curl -fsS -o /dev/null http://127.0.0.1:8830/healthz && break
    sleep 0.5
  done
  curl -fsS -o /dev/null http://127.0.0.1:8830/healthz || { log 'holt did not become healthy'; journalctl -u holt -n 30 --no-pager >&2; exit 1; }

  # The bot exits cleanly when config.js has no discord.botToken; nothing to cut over then.
  if ! node --input-type=module -e "const c = (await import('file://$ROOT/config.js')).default; process.exit(c?.discord?.botToken ? 0 : 1)"; then
    log 'activate: no discord.botToken in config.js; bot not started'
    exit 0
  fi
  # abulxt's deploy re-enables its copy on every run until it stops shipping the unit; keep it from
  # racing holt-discord at boot.
  systemctl disable abulxt-discord >/dev/null 2>&1 || true

  log 'activate: restart holt-discord'
  since=$(date '+%Y-%m-%d %H:%M:%S')
  systemctl restart holt-discord
  for _ in $(seq 1 60); do
    if journalctl -u holt-discord --since "$since" --no-pager -o cat 2>/dev/null | grep -q 'logged in as'; then
      log 'holt-discord logged in'
      exit 0
    fi
    sleep 1
  done
  log 'holt-discord did not log in within 60s; handing the bot back to abulxt-discord'
  journalctl -u holt-discord --since "$since" --no-pager -o cat | tail -30 >&2
  if systemctl cat abulxt-discord >/dev/null 2>&1; then
    systemctl enable abulxt-discord >/dev/null 2>&1 || true
    systemctl start abulxt-discord
  fi
  exit 1
fi

deny
