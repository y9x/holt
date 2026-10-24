// Issue and inspect embed licenses (license.ts). Run where config.js has `licensing.secret`, which is
// only holt's host:
//
//   npm run license -- mint --platform nocturne --days 365 --note "Nocturne, annual"
//   npm run license -- mint --platform abulxt                 (no --days: does not expire)
//   npm run license -- inspect <license>
//
// mint prints the license on stdout and nothing else, so it can be piped into the site's config.
// To revoke one, add its lid to `licensing.revoked` in config.js and restart holt.

import { loadConfig } from './holt-config.ts'
import { checkLicense, mintLicense, readLicense } from './license.ts'

function usage(): never {
  console.error('usage: npm run license -- mint --platform <id> [--days <n>] [--note <text>]\n       npm run license -- inspect <license>')
  process.exit(2)
}

function flag(args: string[], name: string): string | null {
  const at = args.indexOf(`--${name}`)
  if (at === -1) return null
  const value = args[at + 1]
  if (value === undefined || value.startsWith('--')) usage()
  return value
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2)
  const config = await loadConfig()
  if (!config.licensing) {
    console.error('licensing.secret is not set in config.js; licensing is off')
    process.exit(1)
  }

  if (command === 'mint') {
    const platform = flag(args, 'platform') ?? usage()
    if (!config.platforms.some((entry) => entry.id === platform)) {
      console.error(`no platform ${platform} in config.js; add it first`)
      process.exit(1)
    }
    const daysText = flag(args, 'days')
    const { token, license } = mintLicense(config.licensing.secret, { platform, days: daysText === null ? null : Number(daysText), note: flag(args, 'note') })
    const expiry = license.expiresAt === null ? 'never' : new Date(license.expiresAt * 1000).toISOString()
    console.error(`license ${license.lid} for ${platform}, expires ${expiry}`)
    console.log(token)
    return
  }

  if (command === 'inspect') {
    const token = args[0] ?? usage()
    const license = readLicense(config.licensing.secret, token)
    if (!license) {
      console.log('invalid: not a license signed by this holt')
      process.exit(1)
    }
    const check = checkLicense(config.licensing, license.platform, token)
    console.log(JSON.stringify({
      ...license,
      issuedAt: new Date(license.issuedAt * 1000).toISOString(),
      expiresAt: license.expiresAt === null ? null : new Date(license.expiresAt * 1000).toISOString(),
      valid: check.ok,
      refused: check.ok ? null : check.reason,
    }, null, 2))
    return
  }

  usage()
}

main().then(() => process.exit(0), (error: unknown) => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})
