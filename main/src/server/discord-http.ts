import http from 'node:http'
import type { Client } from 'discord.js'
import { getConfig } from './config.js'
import { verificationMap } from './discord-commands/state.js'
import { syncDiscordRoles, userForDiscordId } from './discord-roles.js'
import {
  checkIp,
  clientIp,
  getIpData,
  getToken,
  getUserData,
  invalidateToken,
  logWebhook,
  setVerification,
} from './discord-verify.js'
import { parseRequestUrl } from './request-url.ts'

function page(title: string, heading: string, body: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title}</title>
  <style>
    body { margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
           background: #0d0d12; color: #e8e8ef; font-family: Inter, system-ui, sans-serif; }
    .card { max-width: 420px; padding: 40px; background: #16161e; border: 1px solid #262633;
            border-radius: 12px; text-align: center; }
    h1 { font-size: 1.4rem; margin: 0 0 12px; }
    p { color: #a0a0b0; line-height: 1.5; margin: 0; }
  </style>
</head>
<body><div class="card"><h1>${heading}</h1><p>${body}</p></div></body>
</html>`
}

const PAGES = {
  passed: page('Verified', 'Verification complete', 'You have been verified. You can close this tab and return to Discord.'),
  flagged: page('Verification failed', 'Connection not allowed', 'You cannot verify over a proxy or VPN. Disable it and try again.'),
  altflagged: page('Verification failed', 'Verification refused', 'This account cannot be verified. Contact staff if you believe this is a mistake.'),
  mobile: page('Verification failed', 'Mobile connection detected', 'You cannot verify over a mobile data connection. Try again on a residential connection.'),
  error: page('Error', 'Something went wrong', 'The verification flow failed. Please try again from the beginning.'),
}

function sendHtml(res: http.ServerResponse, status: number, html: string) {
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
  res.end(html)
}

async function hasRole(client: Client, guildId: string, discordId: string, roleId: string | undefined): Promise<boolean> {
  if (!roleId) return false
  const guild = await client.guilds.fetch(guildId).catch(() => null)
  const member = await guild?.members.fetch(discordId).catch(() => null)
  return Boolean(member?.roles.cache.has(roleId))
}

async function grantRoles(client: Client, guildId: string, discordId: string, roleIds: string[]): Promise<void> {
  if (!roleIds.length) return
  const guild = await client.guilds.fetch(guildId).catch(() => null)
  const member = await guild?.members.fetch(discordId).catch(() => null)
  if (member) await member.roles.add(roleIds).catch(() => {})
}

async function handleCallback(client: Client, req: http.IncomingMessage, res: http.ServerResponse) {
  const d = getConfig().discord || {}
  const guildId = d.guildId!
  const url = parseRequestUrl(req.url, 'http://127.0.0.1')
  const code = url.searchParams.get('code')
  if (!code) return sendHtml(res, 400, PAGES.error)

  const ip = clientIp(req.headers as Record<string, string | string[] | undefined>, req.socket.remoteAddress)
  if (!ip) return sendHtml(res, 400, PAGES.error)

  let discordId: string
  try {
    const token = await getToken(code)
    const user = await getUserData(token)
    discordId = user.id
    await invalidateToken(token)
  } catch {
    return sendHtml(res, 400, PAGES.error)
  }

  const botIdentity = { username: client.user?.username, avatarUrl: client.user?.avatarURL() || undefined }

  const state = url.searchParams.get('state')
  if (state) {
    const resolver = verificationMap.get(state)
    if (!resolver) return sendHtml(res, 400, PAGES.error)
    verificationMap.delete(state)
    resolver({ ip, id: discordId })
    return sendHtml(res, 200, PAGES.passed)
  }

  if (await hasRole(client, guildId, discordId, d.roleIds?.muted)) {
    await logWebhook(`<@!${discordId}> tried to verify while having the muted role.`, botIdentity)
    return sendHtml(res, 403, PAGES.altflagged)
  }
  if (await hasRole(client, guildId, discordId, d.roleIds?.alt)) {
    await logWebhook(`<@!${discordId}> tried to verify while having the alt role.`, botIdentity)
    return sendHtml(res, 403, PAGES.altflagged)
  }

  const existingId = await checkIp(ip)
  if (existingId && existingId !== discordId) {
    await logWebhook(`<@!${discordId}> was flagged as an alt account. Their main is <@!${existingId}>.`, botIdentity)
    if (d.roleIds?.alt) await grantRoles(client, guildId, discordId, [d.roleIds.alt])
    return sendHtml(res, 403, PAGES.altflagged)
  }

  const ipData = await getIpData(ip)
  if (ipData.mobile) {
    await logWebhook(`<@!${discordId}> is trying to verify over a potential mobile data connection.`, botIdentity)
    return sendHtml(res, 403, PAGES.mobile)
  }
  if (ipData.proxy || ipData.hosting) {
    await logWebhook(`<@!${discordId}> attempted to verify over a proxy or VPN.`, botIdentity)
    return sendHtml(res, 403, PAGES.flagged)
  }

  if (!existingId) await setVerification(discordId, ip)
  await grantRoles(client, guildId, discordId, d.roleIds?.verified || [])
  const linked = await userForDiscordId(discordId).catch(() => null)
  if (linked) await syncDiscordRoles(linked).catch(() => {})
  await logWebhook(`<@!${discordId}> has successfully verified.`, botIdentity)
  return sendHtml(res, 200, PAGES.passed)
}

export function startDiscordHttpServer(client: Client): void {
  const d = getConfig().discord || {}
  const port = Number(d.port) > 0 ? Number(d.port) : 8823

  const server = http.createServer((req, res) => {
    const url = parseRequestUrl(req.url, 'http://127.0.0.1')
    if (url.pathname === '/health') {
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
      res.end(JSON.stringify({ ok: true, service: 'abulxt-discord' }))
      return
    }
    if (url.pathname === '/callback') {
      void handleCallback(client, req, res).catch((error) => {
        console.error('[abulxt-discord] /callback failed:', error)
        sendHtml(res, 500, PAGES.error)
      })
      return
    }
    sendHtml(res, 404, PAGES.error)
  })

  server.listen(port, '127.0.0.1', () => {
    console.log(`[abulxt-discord] verification server on 127.0.0.1:${port}`)
  })
}
