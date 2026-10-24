# Adding holt chat to your site

Two proxy rules and a license. No SDK, no user tokens, no iframe.

```nginx
# 1. Your own "who is signed in?" endpoint (any backend route you already have).
location /chat/api/ {
    proxy_pass http://127.0.0.1:3000/api/;      # -> your app's /api/me
}

# 2. Everything else under /chat/ is holt. Use your platform id and license from us.
location /chat/ {
    proxy_pass https://holt.abstracteducation.loan/<your-platform-id>/;
    proxy_ssl_server_name on;
    proxy_set_header X-Holt-License "<your license>";
}
```

## Your license

Embedding needs a license from us. It is a signed token bound to your platform id, with an expiry date
(or none), that we can revoke. Your proxy adds it to every request it forwards (`X-Holt-License`
above), so visitors never see it. Without a valid license holt answers 403 to everything under your
platform, including a direct visit to `holt.abstracteducation.loan/<your-platform-id>/`.

- Keep it out of public repos: it lets a proxy act as your site. Put the `proxy_set_header` line in a
  file only your server reads (`include /etc/nginx/holt-license.conf;`).
- When it is renewed, replace the value and reload your proxy. There is nothing else to change.

Open `https://your-site/chat/`. That's it.

## What your user-state endpoint returns

`GET /chat/api/me` with the visitor's own cookies:

| Visitor | Answer |
|---|---|
| Signed in | `200` with JSON, for example `{"id": 77, "username": "neo", "email_verified": true, "avatar": "https://…"}` |
| Signed out | `401` (or `403`, `404`, `204`, or a body without an id) |

Only `id` (a stable account id, not the username) and `username` are needed. Field names are
configurable, including nested ones (`user.id`), if your endpoint already returns a different shape.
`email_verified: true` lets the user post; `avatar` must be https.

## Tell us

- The URL of your user-state endpoint as seen from the internet (normally
  `https://your-site/chat/api/me`).
- The cookie name(s) that identify a session, if you want holt to forward only those (recommended).
- **Login kept in localStorage instead of a cookie?** Tell us the storage key (abulxt uses
  `abulxt:auth-token`). The chat page runs on your origin, so it reads the token there and holt sends it
  to your user-state URL as `Authorization: Bearer …`, the same way it forwards cookies. Nothing to
  change on your side.
- Where your account and settings pages are, and optionally your sign-in and verify-email pages. Every
  account button in the chat goes there; the chat has no account pages of its own.

## How it works, and why it is safe

The browser sees one site: yours. Because `/chat/` is on your origin, your cookies come along with every
chat request and your proxy passes them to holt. To find out who the visitor is, holt calls the
user-state URL **you registered** with those cookies, server to server, and uses your answer. It never
trusts anything the page says about who is signed in, and never calls a URL taken from the request.

- holt forwards your cookies (or your bearer token, for localStorage logins) only to your registered
  URL (only the cookie names you list, if you list them), never logs or stores them, and caches each
  answer for at most 30 seconds.
- The chat page runs on your origin, so its code can read what any script there can (that is how it
  finds a localStorage token). Proxy `/chat/` only if you trust holt's code on your site; otherwise use
  iframe embedding below.
- A redirect from your endpoint (a login page) counts as signed out and is never followed.
- If your endpoint is down, the chat says it cannot check who you are; it does not sign the user out.
- holt's own requests carry an `X-Holt` header that other sites cannot add, so a page elsewhere
  cannot act as your visitor.

## Your users in the chat

Your signed-in visitors chat as themselves, as equals with every other site's users and with Discord:
they read, post, edit and delete their own messages, react, see typing and new messages live, and answer
each Discord server's onboarding (which gives them that server's roles, so the same channels open up as for
anyone else). Their chat identity is `<your platform id>:<your user id>`; moderation (timeouts, bans,
channel overrides) applies to it like to anyone. Every bridged server shows in the server rail; your
site's own server, if you have one, is where the chat opens first.

Nothing extra to proxy: the chat calls its API and realtime socket under `/chat/_holt/`, which your
`/chat/` rule already sends to holt. holt asks your user-state endpoint who is signed in when the chat
loads (and every few minutes), and hands the chat a short session of its own; your cookies and tokens go
only to your endpoint, never to the chat service. Signing out on your site signs the chat out within a
few minutes (at once in other tabs if your login lives in localStorage).

Posting needs `email_verified: true` (or your equivalent field). Profiles show the name your endpoint
returns; avatars are Discord's defaults for now.

## Can't proxy? Iframe embedding

Sites that cannot add proxy rules can embed with an iframe and a signed identity token instead (more
work on your side): see the "Embedding" section of the README. The license goes in
`Holt.mount({ license })`; it is visible in your page there, which is fine: it only works for your
platform, and only your allowed origins can frame it.
