# Where holt's code came from

holt began as abulxt's community chatbox and was split out into its own service in October 2026. Until the
standalone cutover (2026-10-24), part of it was copied byte-for-byte from the abulxt repo by a vendoring script.
That is over: **holt owns every file in this repository.** Change them here; nothing is synced from abulxt.

What came from abulxt, for orientation:

- **The client-protection pipeline**: the shield VM (every chunk compiled to encrypted bytecode), the post-build
  string obfuscator, the canary guardrail, the dist reference verifier, and the HolyText family
  (`main/src/server/shield/`, `main/src/lib/holy-*`, `main/src/components/common/Holy*`, `scripts/*.mjs`). The
  rules stay the same as abulxt's: compile mode only (`SHIELD_MODE=manifest` is a local debug opt-out, never
  committed), every build passes the obfuscator then the canary check (exit 2 on a hit, no opt-out), every
  user-visible string is wrapped (`main/src/components/common/HOLYTEXT.md`). Some names are still abulxt's
  (`window.__ABULXT_EC_KEY__`, `__ABULXT_STRINGS__`, `#eckey`, `abulxt:` localStorage prefixes); they are just
  names.
- **The chatbox** (`main/src/pages/chat/`, the `main/src/lib/` modules it uses, `main/public/vendor/discord/`,
  `main/public/fonts/`).
- **The chat server**: the bridge API, permissions, onboarding, events, the Discord bot's bridge. Everything that
  read abulxt's accounts was rewritten around holt's identity directory (`chat_identity`) and platform sign-in.

abulxt's own Discord features (verification, account roles, `/links`, `/ai`, deletion requests) went back to
abulxt; holt relays them over the platform hook (`discord-platform-relay.ts`).
