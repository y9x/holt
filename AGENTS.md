# AGENTS.md — holt

Rules for AI coding agents in this repository. `docs/PLAN.md` says what holt is and where it is
going; `VENDOR.md` covers the pipeline borrowed from abulxt; this file says how to work here.

## Hard rules

- **Never run `git commit`** or stage for a commit unless the user asks for a commit in the current
  turn. Authorization never carries over between turns. No `Co-Authored-By` lines, ever.
- **Never deploy.** No pushing, no restarting services on amph, no editing `/opt/holt/config.js`
  without explicit authorization in the current turn. When told to apply config on a host: back up
  (`cp -p config.js config.js.bak-<topic>-$(date +%Y%m%d%H%M%S)`), edit only the affected keys,
  check it loads, restart only what reads them, verify through the real endpoint.
- **Secrets** live in this host's `main/config.js` (gitignored). `main/config.example.js` holds
  structure only. Never print, log, or commit a platform secret or `sessionSecret`.
- **Platform trust boundary.** A platform vouches for its users; holt never grants admin from a
  token (`config.admins` only), never accepts a token for a platform the page's origin does not
  belong to, and never lets a platform's secret or namespace be shared with another account system.
  Keep `verifyIdentityToken` strict; do not add claims that widen what a platform can assert without
  updating `docs/PLAN.md`.
- **No cookies or storage for identity.** Sessions are Bearer tokens held in the frame's memory and
  carried through the embed handshake. Inside partner iframes, cookies and storage are third-party.
- **Licensing stays on.** Every embed path checks `licenseRefusal` (`holt-service.ts`). Never add a route
  under a platform, or an iframe entry point, that skips it, and never log a license value.
- **No account UI in holt.** Every account action posts `navigate` with one of the platform's links.

## Client protection (same rules as abulxt)

- **Vendored files are byte-identical to abulxt** (`scripts/vendor-manifest.json`). Change abulxt
  first, then `node scripts/vendor-sync.mjs --pull`. `make check` fails on drift.
- **Compile mode only.** Never set `SHIELD_MODE=manifest` in a committed file, CI workflow, deploy
  script or Makefile. It is a local debug opt-out.
- **Every build passes the obfuscator, then the canary check** (`make build`). The canary check
  hard-fails with exit 2; do not add a gate, env flag or informational class. Add any newly
  user-visible sensitive literal to `scripts/canary-list.json`.
- **Every new user-visible string is wrapped** (`main/src/components/common/HOLYTEXT.md`) and listed
  in `main/src/server/obfuscation-strings.ts`. Attributes go through `useHolyAttr` / `<HolyInput>`.
  A plain string needs a reason next to it (data value, decorative, sole accessible name).
- **The embed page CSP stays strict.** `script-src` is `'self'` plus the hashes of the build's own
  inline scripts (computed at startup in `holt-service.ts`). Never add `'unsafe-inline'` or
  `'unsafe-eval'` to `script-src`. Page data goes in a `type="application/json"` block.
- **The partner loader (`main/loader/holt-embed.js`) ships as written**: it runs on partner pages and
  is the documented protocol. It is still canary-checked by `make build`. Nothing else may bypass
  the pipeline without a documented, specific reason in the pipeline itself.
- Chunk names (`s_*.js`, hashed `assets/*`) change every build. Never hardcode them. Never hand-edit
  `main/dist/`.

## Verification before hand-off

- `make check` (vendor sync, `tsc -b`, `node --test`). `shield/module.test.mjs` "top-level await" is
  a known failure inherited from abulxt (the test harness transforms its fixture to `cjs`); it
  fails identically there and is fixed there first.
- `make build` must end with the canary at exit 0 and dist refs OK.
- A change to the embed page or loader: `make e2e` (real Chrome, compiled build, framed cross-site).
- A server route change: run the service against a temporary config (`HOLT_CONFIG=…`) and hit the
  real endpoint.

## Style

- Server services mirror abulxt's (`tsx`, `loadConfig()`, graceful SIGINT/SIGTERM). Pure logic lives
  in its own module with a `node --test` file next to it.
- Match the surrounding comment density and naming. Header comments say what a file is for and what
  it deliberately does not do.
- Record durable facts in `docs/`, not only in chat.
