# Vendored from abulxt

Vendored from abulxt commit `a8ed58dff528b634cc3e685ae2f173c23ba23f8d`

holt reuses abulxt's client-protection pipeline unchanged: the shield VM (every chunk compiled to
encrypted bytecode), the post-build string obfuscator, the canary guardrail, the dist reference
verifier, and the HolyText family. The files listed in `scripts/vendor-manifest.json` sit at the
same path in both repos and stay byte-identical.

- **Change abulxt first, then pull.** Never patch a vendored file in holt alone.
  `node scripts/vendor-sync.mjs --pull` copies them from `ABULXT_DIR` (default `../abulxt`) and
  records the commit above. `--check` fails when a copy differs; `make check` runs it.
- **holt owns** the files that only borrow abulxt's shape: `scripts/canary-list.json` (holt's own
  canaries), `main/src/server/obfuscation-strings.ts` (holt's string list), and
  `main/src/lib/config.ts` (the two functions `holy-decrypt.ts` imports).
- **Names stay abulxt's.** The vendored code reads `window.__ABULXT_EC_KEY__`,
  `__ABULXT_STRINGS__` and `#eckey`. Renaming them would fork the copies, so holt keeps them.
- The rules in abulxt's AGENTS.md "Obfuscation and security" apply here as written: compile mode
  only (`SHIELD_MODE=manifest` is a local debug opt-out, never committed), every build passes the
  obfuscator then the canary check (exit 2 on a hit, no opt-out), every user-visible string is
  wrapped (see `main/src/components/common/HOLYTEXT.md`).

## What holt owns outright

The chat API moved to holt on 2026-10-24 and was deleted from abulxt: `discord-bridge-api.ts`,
`discord-onboarding-api.ts`, `discord-unfurl.ts`, `discord-author-style.ts`, `discord-cdn-refresh.ts`,
`discord-embed-suppress.ts`, `discord-guild-tag.ts`, `discord-mention-limits.ts`. Change them here. The
modules they import that abulxt still uses (database, events, permissions, channel access, presence)
stay vendored: change those in abulxt first.
