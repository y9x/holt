// holt config template. Copy to config.js on each host and fill in the values.
// config.js is gitignored and holds this host's real secrets; this file holds structure only.
//
// Two loaders read the same file: src/server/holt-config.ts (the keys below) and the vendored
// src/server/config.ts (abulxt's keys, for the Discord bot). Until phase 1 splits the database, the bot
// shares abulxt's database and Discord application, so its keys (db, discord, mail, ai, stripe, ...)
// come from abulxt's own config.js instead of being copied: one place to rotate them.
//
//   amph:   import abulxt from '/opt/abulxt-main-site/config.js'
//   local:  import abulxt from '../../abulxt/main/config.js'   (holt always sits next to abulxt)

import abulxt from '../../abulxt/main/config.js'

export default {
  ...abulxt,

  // Never run the bot locally with the production token: two gateway clients on one token handle every
  // event twice. Leave discord out here (the bot then exits cleanly). amph keeps abulxt's discord block.
  discord: undefined,

  // Loopback port OpenResty proxies to. Never exposed directly.
  port: 8830,

  // Where holt is served from, as the browser sees it.
  publicOrigin: 'https://holt.example.com',

  // Signs the sessions the embed page holds after a successful identity exchange.
  // Any long random string (48+ characters). Rotating it signs every embed out.
  sessionSecret: 'CHANGE_ME',

  // Principal keys (`<namespace>:<subject>`) that bypass the chat hierarchy the way site
  // admins do in abulxt today. Never granted from a platform token.
  admins: [],

  // Platforms: the sites that may embed holt and vouch for their own users.
  //
  //   id                 Slug. Also the default identity namespace.
  //   name               Shown to users ("Account on <name>").
  //   identityNamespace  Optional. Two platforms sharing one account system share a
  //                      namespace, so the same account is ONE identity in both. The
  //                      Abstract AI site and the abulxt main site share `abulxt`.
  //   issuer             The `iss` claim of the platform's identity tokens.
  //   secret             HS256 secret the platform signs identity tokens with. Per account
  //                      system; never shared with a platform in another namespace.
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
      id: 'abulxt',
      name: 'abulxt',
      issuer: 'https://abulxt.example.com',
      secret: 'CHANGE_ME',
      allowedOrigins: ['https://abulxt.example.com'],
      links: {
        account: 'https://abulxt.example.com/#/account',
        settings: 'https://abulxt.example.com/#/settings',
        verifyEmail: 'https://abulxt.example.com/#/verify-email',
        signIn: 'https://abulxt.example.com/#/account',
      },
    },
    {
      id: 'abstract',
      name: 'Abstract AI',
      identityNamespace: 'abulxt',
      issuer: 'https://chat.example.com',
      secret: 'CHANGE_ME',
      allowedOrigins: ['https://chat.example.com'],
      links: {
        account: 'https://chat.example.com/#/account',
        settings: 'https://chat.example.com/#/account',
      },
    },
    {
      id: 'nocturne',
      name: 'Nocturne',
      issuer: 'https://nocturne.lol',
      secret: 'CHANGE_ME',
      allowedOrigins: ['https://nocturne.lol'],
      links: {
        account: 'https://nocturne.lol/',
        settings: 'https://nocturne.lol/',
      },
    },
  ],
}
