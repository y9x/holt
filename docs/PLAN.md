# holt — plan

holt is the abulxt community chatbox as its own service: one deployment on amph, one database, embedded
by any **platform** (abulxt, the Abstract AI site, nocturne.lol, …) through an iframe. holt owns
channels, messages, moderation, roles and the Discord bridge. It never owns accounts: every identity
belongs to a platform, and every account action in the UI is a redirect to that platform's own pages.

Decided 2026-10-24. Source of the current chatbox: `~/src/abulxt/main/src/pages/chat/` (client) and
`~/src/abulxt/main/src/server/discord-*.ts` plus `events.ts`, `rt-api.ts`, `presence.ts`, avatars
(server), about 39k lines.

## Embedding (decided 2026-10-24: proxy first)

The owner wants embedding "stupidly simple": a platform proxies `/chat/` on its own site to
`holt.abstracteducation.loan/<platform id>/` and `/chat/api/` to its own user-state endpoint. holt is
then same-origin with the platform (no iframe, no third-party cookies, no tokens or secrets), and
resolves the visitor server-side by calling the platform's configured user-state URL with the
forwarded cookies (`main/src/server/forward-auth.ts`, partner guide `docs/EMBEDDING.md`). The iframe +
identity-token mode below stays for platforms that cannot proxy.

## Shape

```
 platform page (https://nocturne.lol/…)            holt (https://holt.…, amph :8830 behind OpenResty)
 ┌──────────────────────────────────┐              ┌──────────────────────────────────────────┐
 │ <script src=holt/holt-embed.js>  │  postMessage │ GET /embed?platform=nocturne  (CSP        │
 │ Holt.mount({platform, getToken}) │◄────────────►│   frame-ancestors = platform origins)     │
 │   ▲ GET /api/holt-token          │   token /    │ POST /api/session  token -> holt session  │
 │   │ (platform backend mints a    │   navigate   │ /api/chat/*, /api/rt   Bearer session     │
 │   │  10-min HS256 JWT)           │              │ Discord bridge bot, Postgres `holt`        │
 └───┴──────────────────────────────┘              └──────────────────────────────────────────┘
```

- **Identity** = `<namespace>:<subject>`. Platforms sharing an account system share a namespace:
  the abulxt main site and the Abstract AI site are two platforms, one namespace `abulxt`, so one
  account is one webhook identity in both. `discord:<id>` and `guest:<ip>` stay holt's own.
- **Identity token** (`main/src/server/identity-token.ts`): the platform backend signs
  `{iss, aud:"holt", sub, iat, exp(≤10 min), jti?, name, email_verified, avatar?, tier?}` with its
  per-platform secret. holt verifies it in `POST /api/session` and issues a 12 h **holt session**
  (`main/src/server/session.ts`) that the frame keeps in memory and sends as `Authorization: Bearer`.
  No cookies: inside a partner's iframe holt's cookies are third-party and blocked
  (Safari, Firefox, Chrome 3PCD). This replaces abulxt's `wcs` cookie seed for holt.
- **Links** (`platform.links`): `account`, `settings`, `verifyEmail?`, `signIn?`. The frame posts
  `navigate {target, url}` and the host navigates the top page (`main/loader/holt-embed.js`). holt has no
  account UI of its own.
- **No admin claim.** `config.admins` lists principal keys. Site-admin behaviour in the chat
  (`users.admin` today) maps to this list, nothing else.
- **Embedding is enforced by the browser**: `/embed` sends `Content-Security-Policy: frame-ancestors
  <platform origins>`; `/api/*` CORS allows only a platform's own origins, and a page may exchange
  tokens only for the platform its origin belongs to.

## What moves, what stays

| Moves to holt | Stays in abulxt |
|---|---|
| `pages/chat/*` (client), `lib/rt`, `lib/avatar`, `lib/guild-folders` | accounts, auth, sessions, email verification, 2FA, passkeys |
| `server/discord-bridge-*`, `discord-chat-*`, `discord-channel-access`, `discord-onboarding*`, `discord-mention-limits`, `discord-author-style`, `discord-guild-tag`, `discord-unfurl`, `discord-media`, `discord-cdn-refresh`, `discord-embed-suppress`, `discord-interactions`, `discord-roles` (bridge parts) | Stripe, plans, entitlement caches, `/#/pricing`, `/#/account`, `/#/settings` |
| `events.ts`, `rt-api.ts`, `presence.ts` (chat presence) | Discord verification gate, entitlement/holt roles, `/links`, `/ai`, link dispenser, account link |
| `avatar-*` (upload, moderation, store) — or the platform supplies `avatar` and holt only proxies; see decisions | games, browser, Wisp, AI chat, everything else |
| `discord-bridge-bot.ts` + `/bridge` slash commands (the **holt** bot) | |
| Tables: `discord_bridge_*`, `moderation_event`, `user_avatar`, onboarding tables, `users.guild_folders` → `holt_identity_prefs` | `users`, `sessions`, billing tables |

## Phases

**Phase 0 — this repo (done 2026-10-24).** Service, platform registry, identity token, session,
loader script, systemd unit, tests. abulxt's protection pipeline vendored (`VENDOR.md`): the embed
page is a React app (`main/src/embed/`) built with `make build` (shield VM compile mode → obfuscator
→ canary check → dist refs), served from `main/dist` with a hash-based `script-src` CSP, and proven
in a real browser by `make e2e` (framed cross-site; text reveals; account actions navigate the top
page; a non-listed origin is refused by `frame-ancestors`).

**abulxt integration (live 2026-10-24).** abulxt's `#/chat` is an iframe of `/chat/`, proxied on every
abulxt host to holt's `/abulxt/` (proxy embedding with abulxt's localStorage login, `chat: true`). holt
serves abulxt's chatbox, vendored byte-identical (`chatClient`, `chatAssets`), with holt-owned stand-ins
for navigation, sign-in and ads. The chatbox still calls abulxt's chat API on abulxt's origin, so phases 1
and 2 below are what make it work for a platform without that API (nocturne).

**Phase 1 — server move.** Copy the chat server into `main/src/server/` and replace `DbUser` with
`Principal` everywhere. The seams in abulxt today:

- `resolveIdentity(request)` → `{ownerKey, user: DbUser|null, isGuest, ip}` (`identity.ts`). Becomes
  `readSession(bearer)` → `Principal | guest`.
- `writeDenial(user, ip, channel, action)` and `writeDenialCore` (`discord-chat-perms.ts:844`): the
  `emailVerified` input comes from the principal (platform claim), not `users.email_verified`.
- `chatPermsForUser` / perk floor (`applyPerkFloor`): `users.plan` becomes `principal.tier` mapped
  through a per-platform `tierRoles` config (phase 3).
- Direct `users` reads (7 files; `discord-chat-perms.ts` ×4, `discord-bridge-api.ts` ×3,
  `discord-bridge-db.ts` ×2): `created` (Member Since), `username`, `pronouns`/`about_me`,
  `discord_id`, `admin`. Member Since and profile text move to `holt_identity` (first seen, profile
  text held by holt); `discord_id` linking becomes a holt-side link table keyed by principal.
- **Key format.** `user:<n>` is parsed with `Number()` in bans (`subject_type='site'`), timeouts,
  `discord_bridge_webhook_perm`, onboarding state, reactions, message authors, `parseWebhookTarget`.
  Every site becomes `<namespace>:<subject>` with a string subject. Migration rewrites `user:<n>` →
  `abulxt:<n>` across every key column and renames `subject_type 'site'` → `'web'`.
- Database: new Postgres database `holt` on amph's instance. `schema.sql` carries the baseline from
  abulxt's `discord_bridge_*` DDL plus the rewrite above as its first migrations. Messages' author
  keys are strings already, so history survives the move.
- `events.ts` NOTIFY relay stays as is (bot process → app process). `rt-api.ts` authenticates
  sockets with the Bearer session passed as a subprotocol/first frame, not the `wcs` cookie.

**Phase 1 execution order** (written 2026-10-24, after licensing shipped). Each step ships on its own
and keeps abulxt's chat working; steps marked ⚠ change production data or traffic and need the owner's go.

   **Seam map (measured 2026-10-24).** The chat code already takes narrow structural types, not
   `DbUser` (only `discord-bridge-api.ts` names it, 7×): `{ id, discord_id, admin }`, `userId: number`,
   `WebhookIdentity { userId, discordId }`, `ChannelViewer`. What ties it to abulxt is that a web identity
   is a **number**: ~21 places build or parse `user:<n>` (bridge-api 7, channel-access 4, chat-perms 3,
   presence 2, rt-api, identity, mention-limits, bridge-db, avatar-api), ~22 signatures take
   `userId: number` (presence 9, roles 4, bridge-api 4, chat-perms 3, channel-access 2), and
   `discord-chat-perms.ts` matches bans, timeouts and member overwrites on `subject_type 'site'` (15×).
   Fields read off the user: `id` 35, `discord_id` 26, `username` 22, `discord_avatar` 8,
   `chat_display_name` 8, `discord_name` 3, `admin` 3, `email_verified` 2. **Steps 1 and 2 are one
   change in practice: turn the numeric web id into a string key.** Do the ban/timeout/overwrite matching
   (`subject_type 'site'`) first and fail closed: an unrecognised key must never match "not banned".
   **Steps 1-2 done 2026-10-24** (abulxt 219480c8): `WebhookTarget` `ext` kind + `WebhookSubject.extKey`;
   bans, timeouts, untimeouts and member overwrites match it (fail closed); `abulxt:<n>` parses as the site
   account. Writes of `ext` rows wait for step 3's CHECK widening and fail loudly until then.
   **Step 3 done 2026-10-24.** Migration 036 (abulxt 391bbf64) widened the subject_type CHECKs to allow
   'ext'. Migration 037 (abulxt 3f1e989c) rewrote chat identity keys `user:<n>` -> `abulxt:<n>` in
   message authors, reactors and onboarding state; `server/chat-identity-key.ts` writes the new form
   and reads both. Account event channels, rate limits and AI chat thread ownership keep `user:<n>`
   (they are not chat identity). Backup: amph `/root/db-backups/abulxt-before-036-20261024082628.dump`.
   Next: step 4 (holt serves the chat API).
   **Steps 4-5 done 2026-10-24.** holt-chat (vite.chat.config.ts) runs the bridge API; abulxt's
   OpenResty routes `/api/discord/bridge/*` to it through holt's licensed proxy (verified with the
   holt-test account: signed-in send/edit/react/delete, live delivery to a guest browser). holt now owns
   the bridge API and its helpers (deleted from abulxt); the realtime socket stays on abulxt. Next:
   federation (ext identities in the bridge API, holt-owned now) and nocturne.
1. *Identity seam in abulxt.* A `ChatIdentity` (`key`, `name`, `emailVerified`, `siteAdmin`, `tierFloor`,
   `discordId?`, `createdAt`, `avatarUrl`) built from `DbUser` in one adapter; every chat route,
   `writeDenialCore`, `chatPermsForUser`, onboarding, presence and `rt-api` take it instead of `DbUser`.
   Pure refactor in abulxt (owner of the code), typecheck + chat parity harness, then vendor-pull.
2. *String keys.* Code accepts `<namespace>:<subject>` keys alongside `user:<n>` everywhere a key is parsed
   (`parseWebhookTarget`, bans, timeouts, overwrites, reactions, onboarding). Reads both, writes old. Safe.
3. ⚠ *Key migration.* `schema.sql` migration rewriting `user:<n>` → `abulxt:<n>` and `subject_type
   'site'` → `'web'`; code then writes new keys. One-way: back up the database first.
4. *holt serves the chat API* for chat platforms under `/<id>/_holt/api/…` (licensed like the rest), with
   `ChatIdentity` from forward-auth principals. A holt stand-in for the client's `lib/api-base.ts` points
   the chatbox there. Behind a per-platform flag; abulxt keeps its own API meanwhile.
5. ⚠ *Cutover.* abulxt's platform flips to holt's chat API; abulxt's chat routes and chatbox copy are
   deleted, and holt owns `pages/chat` outright (vendoring for them ends).
6. *nocturne.* Its platform entry (`userState`, cookie names, links), a license, its Discord guild or
   category set.

**Federation (requested 2026-10-24): every platform's users in the same channels, as equals.** holt owns
the bridge API now, so this is holt work, verified at each stage with holt-test plus a test platform:

Done 2026-10-24 toward federation: forward-auth speaks nocturne's scheme (configurable token header,
field fallbacks, negated emailVerified); nocturne is configured from its live site; **holt lab**
(`lab/server.mjs`, https://holtlab.abstracteducation.loan) is a licensed test partner with its own accounts
in nocturne's scheme, used for every check below (lab users resolve as `lab:<id>`; the lab license reaches
only the lab; live revocation works).

Settled for the remaining stages:
- Federated users get roles the same way abulxt web users do: by answering the guild's onboarding, keyed
  by their ext key. `withEffectiveRoles` (abulxt `discord-channel-access.ts`, vendored) gains an identity
  key so it is not tied to a numeric site id; changed in abulxt first.
- Realtime for a partner origin is holt's: holt-chat mounts the realtime socket for ext principals
  (`/<id>/_holt/api/rt`), because a partner's own origin has no socket and abulxt's carries abulxt-only
  account and AI events.
- holt-chat never trusts a platform's own `Authorization` for ext platforms: holt-service strips it and
  sends a signed principal (`X-Holt-Principal`, HMAC from holt's sessionSecret), stripping any inbound copy.

**Built 2026-10-24 (F1-F3, F5; F4 partly).** Code map: `server/chat-caller.ts` (ExtChatUser, the signed
X-Holt-Principal, avatar-path rewrite for foreign pages), holt-service `handleOwnAccounts` (`_holt/session`
sign-in exchange, `_holt/api/auth/me`, captcha passthrough) + `callerHeaders` + `handleUpgrade`,
`server/chat-rt.ts` (holt-chat `/api/rt` for these users), `lib/api-base.ts` (holt stand-in: `./_holt` base),
`embed/proxy-session.ts` (sign-in before the chatbox mounts, renewed every 10 min, on tab return, and on the
platform's login changing). abulxt shared code takes `ext_key` (`chat-identity-key.ts ChatSubjectUser`,
`chatKeyOfUser`; onboarding state and emulated roles key by it). Every "is this my message" check compares
keys (`authoredBy`): an id comparison would make every ext user the author of every other's messages.
e2e covers the hand-off (stripped Authorization/Cookie/forged principals, signed principal, realtime, license).
Decided while building, revisit if wanted:
- An ext user's avatar is Discord's default: platform-supplied avatar URLs have no moderation path, and
  only moderated avatars are shown or sent to Discord. (A fetch-and-moderate path is the fix.)
- Set Status, presence dots and server-rail folders are kept for abulxt accounts only (accepted, not stored).
- Email verification and every account action belong to the platform (`links`); holt only relays the claim.
- No platform badge yet (F4).

- **F1 Identity hand-off.** holt-service authenticates the visitor (forward-auth) and passes the principal
  to holt-chat in a header signed with a holt-only secret (`X-Holt-Principal`); holt-chat's identity layer
  accepts it only with a valid signature and only from loopback. abulxt-namespace platforms keep using
  their own login token unchanged.
- **F2 Read paths.** perms/view gate/history/channels for an ext identity: guest-equivalent VIEW, member
  floor and onboarding roles keyed by its ext key (`onboardingIdentityKey` -> string keys).
- **F3 Write paths.** send/edit/delete/react/typing with `author_key = <ns>:<sub>`, name and avatar from
  the principal, Discord webhook delivery under that name/avatar, email-verified gate from the platform's
  claim, ext moderation (already supported, migration 036).
- **F4 Federation UX.** profile popout shows the user's platform with a link to their profile there
  (platform `profileUrl` template); mentions and presence work across platforms; a small platform badge
  next to ext names so users can tell sites apart.
- **F5 Client.** the chatbox on a non-abulxt platform calls `./_holt/api/discord/bridge` (api-base
  stand-in) and takes "who am I" from holt (auth-api stand-in), with sign-in going to the platform.
- **F6 nocturne.** its userState URL + cookie name, `chat: true`, its license (issued), go live.

**Phase 2 — client move.** `pages/chat/*` moves into `main/src/` and mounts inside the embed shell
(`main/src/embed/App.tsx`). It already builds through the same pipeline, so its 88 Holy wrappers
carry over unchanged; its strings join `obfuscation-strings.ts`. Every account affordance (avatar click → profile, "Edit profile",
"Account", email-verify banner, "Sign in") emits `navigate`. Guest mode stays: read public channels,
`signIn` link to compose.

**Phase 3 — platforms go live.**
- abulxt: `GET /api/holt/token` mints an identity token for the signed-in user (`sub = users.id`,
  `name = username`, `email_verified`, `tier` from the active plan, `avatar` = approved avatar URL).
  `#/chat` becomes `Holt.mount(...)`. The Abstract AI host registers as platform `abstract`,
  namespace `abulxt`, links to its own account page.
- nocturne.lol: one backend endpoint minting tokens with its secret, the loader script on its page,
  its account URL in `links`. Nothing else.
- Discord channels per platform: a guild (or `bridgeCategories` set) per platform, bans scoped per
  guild as today.

**Phase 4 — cleanup.** Delete the chat code and tables from abulxt; outbound webhooks to platforms
(message posted, moderation action) if a platform wants them; a `tier` → chat-role map per platform.

## Open decisions

1. ~~Obfuscation.~~ **Decided 2026-10-24:** reuse abulxt's pipeline, vendored byte-identical
   (`VENDOR.md`). The partner loader ships as written; everything else goes through the pipeline.
   **Open consequence:** vendoring puts the shield VM and obfuscator source in this repo, and
   `scripts/obfuscate-build.mjs` carries part of abulxt's hide list (the proxy library names in its
   rename table). abulxt keeps all of that in a private repo; holt's repo visibility should match.
2. **Avatars.** holt keeps upload + Gemini moderation (moves `avatar-*`), or platforms supply an
   `avatar` URL and holt only displays it. Recommendation: platforms supply it; abulxt keeps its
   moderation and passes the approved URL. One fewer moderation pipeline in holt.
3. **Discord bot identity.** The bridge bot is holt. abulxt's remaining Discord features (verify
   gate, entitlement roles, `/links`, `/ai`) either keep the same application (two gateway sessions;
   global slash-command registration must then live in one place) or get a second application.
   Recommendation: holt owns the holt application; abulxt gets a second, small bot.
4. **Guests.** Keep `guest:<ip>` read access as today, or require a platform session for everything.
   Recommendation: keep guests read-only.
5. **Domain.** `holt.<something>` on amph behind OpenResty; needs a cert and an `allowedOrigins`
   entry per platform. Not chosen yet.

## Onboarding a platform (for the partner)

1. Receive a platform id and secret from holt (we add the entry to `config.js` on amph).
2. Add a backend endpoint that, for a signed-in user, returns an HS256 JWT:
   `{ iss: "<your issuer>", aud: "holt", sub: "<stable user id>", iat, exp: iat+120, jti,
   name, email_verified, avatar?, tier? }` signed with the secret. Never mint for signed-out users.
3. Put `<script src="https://holt…/holt-embed.js">` on the page and call `Holt.mount` with
   `getToken` fetching that endpoint. Tell us your `account` and `settings` URLs.
