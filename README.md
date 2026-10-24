# holt

The community chatbox as a standalone service, embedded by platforms through an iframe. Platforms
(abulxt, Abstract AI, nocturne.lol, …) keep their own accounts and vouch for users with a short-lived
signed token; holt owns channels, messages, moderation and the Discord bridge. Every account action
in holt sends the user to the platform's own pages.

Read `docs/PLAN.md` first. `AGENTS.md` has the rules for agents working here; `VENDOR.md` explains
the client-protection pipeline borrowed from abulxt.

## Layout

| Path | What it is |
|------|-----------|
| `main/` | The deployable app: what lands in `/opt/holt` on amph. |
| `main/src/server/` | The service (`holt-service.ts`), platform registry, identity tokens, sessions. |
| `main/src/embed/` | The embed page client (React), compiled to shield bytecode. |
| `main/loader/holt-embed.js` | The loader script partners include. Served as written (a public SDK). |
| `main/src/server/shield/`, `main/src/lib/holy-*`, `main/src/components/common/Holy*`, `scripts/*.mjs` | Vendored from abulxt (`scripts/vendor-manifest.json`). |
| `scripts/canary-list.json` | holt's canaries. |
| `deploy/holt.service` | systemd unit. |

## Working

```sh
cd main && npm ci && cp config.example.js config.js   # fill in secrets; config.js is gitignored
cd .. && make build    # Vite build -> obfuscator -> canary check (exit 2 on a leak) -> dist refs
make check             # vendor sync + typecheck + tests
make e2e               # build, then load the compiled embed in Chrome, framed cross-site
cd main && npm run holt   # 127.0.0.1:8830; serves main/dist, so build first
```

Routes today: `GET /healthz`, `GET /holt-embed.js`, `GET /embed?platform=<id>`, the compiled assets,
`POST /api/session`, `GET /api/me`. The chat itself arrives in later phases.

## Embedding (for a partner)

**The simple way: two proxy rules on your site.** Full guide in `docs/EMBEDDING.md`.

```nginx
location /chat/api/ { proxy_pass http://127.0.0.1:3000/api/; }   # your own user-state endpoint
location /chat/     { proxy_pass https://holt.abstracteducation.loan/<platform-id>/; proxy_ssl_server_name on; }
```

holt asks your `/chat/api/me` who the visitor is, with the cookies the browser sent, server to server.

**Iframe embedding, for sites that cannot proxy:**

```html
<script src="https://HOLT_ORIGIN/holt-embed.js"></script>
<script>
  Holt.mount({
    origin: 'https://HOLT_ORIGIN',
    platform: 'your-platform-id',
    container: document.getElementById('chat'),
    getToken: () => fetch('/api/holt-token', { credentials: 'include' }).then((r) => (r.ok ? r.text() : null)),
  })
</script>
```

Your backend's `/api/holt-token` returns an HS256 JWT signed with your platform secret. The claims
are in `docs/PLAN.md` under "Onboarding a platform".
