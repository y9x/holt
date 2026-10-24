# Deploying holt

CI deploys on every push to `main` (`.github/workflows/deploy.yml`): typecheck, tests, `make build`
(shield compile mode, obfuscator, canary check, dist refs), `make e2e` in Chrome, then
`deploy/deploy.sh` rsyncs to amph and runs `activate` through the deploy gate. Nobody deploys by hand.

## What runs where

| Piece | Where |
|---|---|
| `holt.service` | amph, `127.0.0.1:8830`, `/opt/holt` (embed page, loader, identity exchange) |
| `holt-discord.service` | amph, `/opt/holt` (the bot; verify callback on `discord.port`, 8823) |
| `holt.abstracteducation.loan` | DNS-only CNAME to `byod.abstracteducation.loan` (Cloudflare). The edges terminate TLS with a shared on-demand certificate and relay to amph `:9080` |
| `/etc/openresty/conf.d/55-holt.conf` | amph; routes the name to `:8830` (`deploy/openresty/55-holt.conf`) |
| `/usr/local/sbin/holt-deploy-gate` | amph; forced command for CI's key (`deploy/holt-deploy-gate.sh`) |

## The bot and abulxt

The bot moved here from abulxt (bot-only files are holt's; the code it shares with abulxt's app server
is vendored, see `VENDOR.md`). It still uses abulxt's database and Discord application, so
`/opt/holt/config.js` spreads `/opt/abulxt-main-site/config.js`.

One gateway client per token: `holt-discord.service` has `Conflicts=abulxt-discord.service`, so
whichever starts last is the only one running. Until abulxt's deploy stops installing and restarting
`abulxt-discord`, every abulxt deploy hands the bot back to abulxt's copy, and the next holt deploy
takes it again. `activate` disables `abulxt-discord` and, if `holt-discord` does not log in within
60 s, starts `abulxt-discord` again and fails the deploy.

## Licenses

Every embed needs a license (`src/server/license.ts`): `licensing.secret` in `/opt/holt/config.js` signs
them, and nothing else does. On amph:

```sh
cd /opt/holt
npm run license -- mint --platform nocturne --days 365 --note "Nocturne, annual" > /root/nocturne.license
npm run license -- inspect "$(cat /root/nocturne.license)"
```

Hand the license to the site out of band. To revoke one, add its `lid` to `licensing.revoked` and
restart holt (`systemctl restart holt`); new page loads are refused at once, and an iframe session already
issued ends within 12 hours. abulxt's own license lives in `/etc/openresty/holt-license.conf` (root, 600),
included by its `/chat/` location.

## abulxt's mount

- `/opt/holt/config.js`: the `abulxt` platform is proxy-only (`userState` at
  `http://127.0.0.1:8820/api/auth/me`, `tokenStorageKey: "abulxt:auth-token"`), `chat: true`, path links
  (`/#/account`), origin `https://abstracteducation.loan`.
- `/etc/openresty/snippets/routes-common.conf` (abulxt repo: `deploy/openresty/snippets/routes-common.conf`):
  `location ^~ /chat/` -> `http://127.0.0.1:8830/abulxt/`, plus a relative `/chat` redirect. The location
  includes `/etc/openresty/holt-license.conf` (`proxy_set_header X-Holt-License …`), so OpenResty refuses
  to start without that file.
- Proxy pages send `Cross-Origin-Embedder-Policy: credentialless`: abulxt's page is cross-origin isolated
  and may only frame documents that send COEP.
- Fallback: `client.holtChat: false` in abulxt's config.js renders abulxt's built-in chatbox.

## One-time host setup (done 2026-10-24; repeat only on a new host)

1. `install -d /opt/holt`; write `/opt/holt/config.js` from `main/config.example.js` with the amph
   import, `publicOrigin: 'https://holt.abstracteducation.loan'`, generated `sessionSecret` and
   platform secrets (`openssl rand -base64 48`), and abulxt's `discord` block kept (drop the
   `discord: undefined` line). Mode 600.
2. `install -m 0755 deploy/holt-deploy-gate.sh /usr/local/sbin/holt-deploy-gate`.
3. Generate an ed25519 key for CI; add the public half to `/root/.ssh/authorized_keys` as
   `restrict,command="/usr/local/sbin/holt-deploy-gate" ssh-ed25519 … holt-ci@y9x/holt`. Store the
   private half as the repo secret `HOLT_DEPLOY_KEY`; set the variables `HOLT_DEPLOY_HOST` and
   `HOLT_DEPLOY_KNOWN_HOSTS` (amph's host key line from `ssh-keyscan`).
4. Copy `deploy/openresty/55-holt.conf` to `/etc/openresty/conf.d/`, `openresty -t`, reload.
5. Cloudflare: `holt` CNAME `byod.abstracteducation.loan`, proxy off.
6. Push to `main` (or run the workflow) and watch `activate`.

## Checks

```sh
curl -fsS https://holt.abstracteducation.loan/healthz          # ok, through an edge
ssh amph 'systemctl is-active holt holt-discord abulxt-discord'  # active active inactive
ssh amph 'journalctl -t holt-deploy -n 20 --no-pager'            # gate log
```
