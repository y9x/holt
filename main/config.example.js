// holt config template. Copy to config.js on each host and fill in the values.
// config.js is gitignored and holds this host's real secrets; this file holds structure only.
//
// Two loaders read the same file: src/server/holt-config.ts (platforms, licensing, bridge, sessions) and
// src/server/config.ts (database, Discord, response sealing, captcha) for holt-chat and the bot. holt is
// standalone: nothing here comes from another service's config.

export default {
  // holt's own Postgres database (schema.sql, applied at startup).
  db: { url: 'postgres://holt:CHANGE_ME@127.0.0.1:5432/holt' },

  // The Discord bot (holt-discord) and the chat's Discord reads. Never run the bot locally with the
  // production token: two gateway clients on one token handle every event twice. Leave `discord` out locally
  // (the bot then exits cleanly).
  discord: {
    botToken: 'CHANGE_ME',
    clientId: '000000000000000000',
    // The home guild: ban scope for site admins, and where platforms' relayed commands are registered.
    guildId: '000000000000000000',
    // Guild role ids -> chat tiers (any bridged guild). Synced into discord_bridge_chat_role at startup.
    chatRoles: { member: [], mod: [], admin: [], owner: [] },
    bridge: {
      // mentionLimits: { perMessage: 10, ... }   (discord-mention-limits.ts)
      // mediaChannels: false,                    bridge media channels (Discord beta) like forums
      // forumBackfill: { posts: 200, days: 90 }, archived forum posts synced per forum
    },
  },

  // Seal read-only chat API responses and realtime frames per session (abulxt's PLAN-API.md scheme).
  apiCrypto: { enabled: false },
  rtCrypto: { enabled: false },

  // Captcha on chat API writes (api-guard.ts). Off unless enabled.
  captcha: { enabled: false },

  // Loopback port OpenResty proxies to. Never exposed directly.
  port: 8830,

  // Where holt is served from, as the browser sees it.
  publicOrigin: 'https://holt.example.com',

  // Signs the sessions the embed page holds after a successful identity exchange.
  // Any long random string (48+ characters). Rotating it signs every embed out.
  sessionSecret: 'CHANGE_ME',

  // Embed licensing (src/server/license.ts). Every embed must present a license minted with this secret:
  // proxy embedding in the X-Holt-License header its proxy adds, iframe embedding via Holt.mount({ license }).
  // Mint one with `npm run license -- mint --platform <id> [--days <n>] [--note <text>]`.
  // Revoke one by adding its lid (shown at mint, or by `npm run license -- inspect <license>`) to `revoked`.
  // Leave the block out to turn licensing off (every configured platform may embed).
  licensing: {
    secret: 'CHANGE_ME',
    revoked: [],
  },

  // The bridge (src/server/bridge-config.ts): one entry per platform, with its embed license and the
  // Discord guild its chatbox belongs to, plus what is bridged from that guild.
  //   license     The platform's license token (`npm run license -- mint ...`). With a `bridge` key, holt
  //               honours ONLY licenses listed here: this is the register of who is licensed. Revoke by
  //               deleting the line (or listing its lid in licensing.revoked).
  //   guild       The guild this site's chatbox opens on. Every bridged guild still shows in the server
  //               rail, so users can switch and chat in each.
  //   channels    Individual text/announcement channels of that guild.
  //   categories  Every text channel in these categories of that guild (also ones added later).
  // A channel or category that is not in the entry's guild is skipped (logged), never bridged elsewhere.
  // Replaces discord.bridgeChannels / discord.bridgeCategories, which are read only when `bridge` is absent.
  bridge: {
    abulxt: { license: 'CHANGE_ME', guild: '000000000000000000', channels: [], categories: [] },
    abstract: { license: 'CHANGE_ME' },
    nocturne: { license: 'CHANGE_ME' },
  },

  // Principal keys (`<namespace>:<subject>`) reported as admins on holt's own identity endpoints. Never
  // granted from a platform token. (Chat site-admin comes from a trusted platform's `admin` field.)
  admins: [],

  // Platforms: the sites that may embed holt and vouch for their own users.
  //
  //   id                 Slug. Also the default identity namespace.
  //   name               Shown to users ("Account on <name>").
  //   identityNamespace  Optional. Two platforms sharing one account system share a
  //                      namespace, so the same account is ONE identity in both. The
  //                      Abstract AI site and the abulxt main site share `abulxt`.
  //   userState          Proxy embedding (docs/EMBEDDING.md): the platform proxies `/chat/` to
  //                      holt `/<id>/` and answers "who is signed in?" itself.
  //     url              Its user-state endpoint, called server-side with the forwarded cookies.
  //     cookies          Optional: forward only these cookie names (recommended).
  //     fields           Optional: { id, name, emailVerified, avatar } field names in its JSON
  //                      (defaults id, username, email_verified, avatar; dotted paths allowed). Trusted
  //                      platforms also: discordId, admin, displayName. avatar is used only when trusted.
  //     tokenStorageKey  Optional, for logins kept in localStorage instead of a cookie (abulxt):
  //                      the page reads this key on the platform's origin and holt forwards the
  //                      token to `url` as `Authorization: Bearer`. Unset: cookies only.
  //   chat               Optional, proxy platforms: the full chatbox. Its users chat through holt
  //                      (`/chat/_holt/api/...`, no extra proxy rule), as `<namespace>:<id>`.
  //   trusted            Optional, only for platforms the operator runs: userState.fields may then also
  //                      name discordId (linked Discord account), admin (site admin), displayName, and
  //                      avatar is used (it must be one the platform moderates). Never for partners.
  //   hook               Optional { url, secret }: the platform's private hook (loopback or https).
  //                      holt relays the platform's own Discord commands/buttons/member events to it,
  //                      and the platform pushes identity changes to /api/platform/<id>/identities|forget.
  //   issuer             Iframe embedding: the `iss` claim of the platform's identity tokens.
  //   secret             HS256 secret the platform signs identity tokens with. Per account
  //                      system; never shared with a platform in another namespace.
  //                      A platform needs userState, or issuer + secret, or both.
  //   allowedOrigins     Page origins that may embed holt (CSP frame-ancestors) and call
  //                      /api/* from the embed handshake. Absolute https origins.
  //   links              Where the embed sends users for things holt does not own. Every
  //                      account action in holt is a redirect to one of these.
  //     account          Account overview / profile.
  //     settings         Account settings (username, email, avatar...).
  //     verifyEmail      Where an unverified user goes to verify. Optional.
  //     signIn           Sign-in page for guests. Optional.
  platforms: [
    {
      // A platform the operator runs: trusted, so its sign-in answer may vouch for a linked Discord account,
      // site admin, chat display name and its moderated avatar. Its hook carries its own Discord features.
      id: 'abulxt',
      name: 'abulxt',
      trusted: true,
      allowedOrigins: ['https://abulxt.example.com'],
      userState: {
        url: 'http://127.0.0.1:8820/api/auth/me',
        tokenStorageKey: 'abulxt:auth-token',
        fields: {
          id: 'user.id', name: 'user.username', emailVerified: 'user.emailVerified', avatar: 'user.chat.avatar',
          discordId: 'user.discord.id', admin: 'user.admin', displayName: 'user.chatDisplayName',
        },
      },
      chat: true,
      hook: { url: 'http://127.0.0.1:8825/holt-hook', secret: 'CHANGE_ME' },
      links: {
        account: '/#/account',
        settings: '/#/settings',
        verifyEmail: '/#/verify-email',
        signIn: '/#/account',
      },
    },
    {
      // Same account system as abulxt on another host: proxy embedding, shared namespace, links to the
      // main site (that host has no sign-in of its own).
      id: 'abstract',
      name: 'Abstract AI',
      identityNamespace: 'abulxt',
      allowedOrigins: ['https://chat.example.com'],
      userState: {
        url: 'http://127.0.0.1:8820/api/auth/me',
        fields: { id: 'user.id', name: 'user.username', emailVerified: 'user.emailVerified', avatar: null },
        tokenStorageKey: 'abulxt:auth-token',
      },
      chat: true,
      links: {
        account: 'https://abulxt.example.com/#/account',
        settings: 'https://abulxt.example.com/#/settings',
      },
    },
    {
      // Proxy embedding only: no token secret.
      id: 'nocturne',
      name: 'Nocturne',
      allowedOrigins: ['https://nocturne.lol'],
      userState: { url: 'https://nocturne.lol/chat/api/me', cookies: ['session'] },
      links: {
        account: 'https://nocturne.lol/',
        settings: 'https://nocturne.lol/',
      },
      chat: true,
    },
  ],
}
