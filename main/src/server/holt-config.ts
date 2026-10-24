// Loads config.js from the repo root (or HOLT_CONFIG). The file is this host's own; CI never ships it.
// Platforms are validated by platforms.ts; everything else is read as-is with defaults.

import { pathToFileURL } from 'node:url'
import path from 'node:path'
import { parsePlatforms, type Platform } from './platforms.ts'

export interface HoltConfig {
  port: number
  publicOrigin: string
  sessionSecret: string
  admins: ReadonlySet<string>
  platforms: readonly Platform[]
}

const DEFAULT_PORT = 8830

function configPath(): string {
  const override = process.env.HOLT_CONFIG
  if (override) return path.resolve(override)
  return path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../config.js')
}

let loaded: Promise<HoltConfig> | null = null

export function loadConfig(): Promise<HoltConfig> {
  if (!loaded) loaded = readConfig()
  return loaded
}

async function readConfig(): Promise<HoltConfig> {
  const file = configPath()
  const mod = (await import(pathToFileURL(file).href)) as { default?: unknown }
  const raw = (typeof mod.default === 'object' && mod.default !== null ? mod.default : {}) as Record<string, unknown>

  const port = Number(raw.port) > 0 ? Number(raw.port) : DEFAULT_PORT
  const publicOrigin = typeof raw.publicOrigin === 'string' ? raw.publicOrigin.replace(/\/+$/, '') : ''
  if (!/^https?:\/\/[^/]+$/.test(publicOrigin)) throw new Error(`${file}: publicOrigin must be an absolute origin`)
  const sessionSecret = typeof raw.sessionSecret === 'string' ? raw.sessionSecret : ''
  if (sessionSecret.length < 32 || sessionSecret === 'CHANGE_ME') throw new Error(`${file}: sessionSecret must be at least 32 characters`)
  const admins = new Set(Array.isArray(raw.admins) ? raw.admins.filter((v): v is string => typeof v === 'string') : [])
  const platforms = parsePlatforms(raw.platforms)
  if (platforms.length === 0) throw new Error(`${file}: at least one platform is required`)
  return { port, publicOrigin, sessionSecret, admins, platforms }
}
