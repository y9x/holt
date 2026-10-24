import { promises as fs } from 'node:fs'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Pool, type QueryResult, type QueryResultRow } from 'pg'

// One pool per process. The pool lives on globalThis: in dev, Vite re-runs this module on hot reloads, and a plain
// module-level variable would start a new pool each time while the old pool's connections stayed open.
const poolHolder = globalThis as typeof globalThis & { __abulxtPool?: Pool }
let connectionString: string | null = null

export function configureDatabase(url: string | undefined | null) {
  const value = (url || '').trim()
  if (value) connectionString = value
}

function resolvedConnectionString(): string | null {
  if (connectionString) return connectionString
  const fromEnv = (process.env.DATABASE_URL || '').trim()
  if (fromEnv) connectionString = fromEnv
  return connectionString
}

export function dbConfigured(): boolean {
  return Boolean(resolvedConnectionString())
}

export function getPool(): Pool {
  if (poolHolder.__abulxtPool) return poolHolder.__abulxtPool
  const connStr = resolvedConnectionString()
  if (!connStr) {
    throw new Error('DATABASE_URL is not set. Point it at the abulxt Postgres (see .env.example).')
  }
  const pool = new Pool({
    connectionString: connStr,
    max: 10,
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 30000,
  })

  pool.on('error', () => {})
  poolHolder.__abulxtPool = pool
  return pool
}

export async function query<T extends QueryResultRow = QueryResultRow>(text: string, params?: unknown[]): Promise<QueryResult<T>> {
  return getPool().query<T>(text, params as never)
}

const MIGRATION_MARKER = /^\s*--\s*migration:\s*([0-9]+_[A-Za-z0-9_]+)\s*$/m
const BASELINE_ID = '001_baseline'

type Migration = { id: string; sql: string }

function schemaCandidates(): string[] {
  const here = path.dirname(fileURLToPath(import.meta.url))
  const cwd = process.cwd()
  return [
    (process.env.ABULXT_SCHEMA_PATH || '').trim(),

    path.resolve(cwd, '..', 'schema.sql'),
    path.resolve(here, '..', '..', '..', '..', 'schema.sql'),

    path.resolve(cwd, 'schema.sql'),
  ].filter(Boolean)
}

async function resolveSchemaPath(): Promise<string | null> {
  const candidates = schemaCandidates()
  for (const p of candidates) {
    if (existsSync(p)) return p
  }

  const rootCopy = path.resolve(process.cwd(), '..', 'schema.sql')
  const localCopy = path.resolve(process.cwd(), 'schema.sql')
  if (existsSync(rootCopy) && !existsSync(localCopy)) {
    try {
      await fs.copyFile(rootCopy, localCopy)
      return localCopy
    } catch {  }
  }
  return null
}

function parseSchema(sql: string): { baseline: string; migrations: Migration[] } {
  const lines = sql.split('\n')
  const migrations: Migration[] = []
  const baselineLines: string[] = []
  let current: Migration | null = null
  for (const line of lines) {
    const m = MIGRATION_MARKER.exec(line)
    if (m) {
      current = { id: m[1], sql: '' }
      migrations.push(current)
      continue
    }
    if (current) current.sql += line + '\n'
    else baselineLines.push(line)
  }
  return { baseline: baselineLines.join('\n'), migrations }
}

let schemaSqlCache: string | null = null

async function loadSchemaSql(): Promise<string> {
  if (schemaSqlCache) return schemaSqlCache
  const schemaPath = await resolveSchemaPath()
  if (!schemaPath) {
    throw new Error(
      'schema.sql not found. Expected it at the repo root (one level above main/) ' +
      'or next to the app. Set ABULXT_SCHEMA_PATH to override.',
    )
  }
  schemaSqlCache = await fs.readFile(schemaPath, 'utf8')
  return schemaSqlCache
}

async function applySchema(): Promise<void> {
  const { baseline, migrations } = await parseSchema(await loadSchemaSql())

  await query(baseline)
  await query(
    `INSERT INTO schema_migrations (id) VALUES ($1) ON CONFLICT (id) DO NOTHING`,
    [BASELINE_ID],
  )

  const { rows } = await query<{ id: string }>(`SELECT id FROM schema_migrations`)
  const applied = new Set(rows.map((r) => r.id))
  const ordered = migrations
    .filter((m) => m.id !== BASELINE_ID)
    .sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }))
  for (const migration of ordered) {
    if (applied.has(migration.id)) continue
    const sql = migration.sql.trim()
    if (sql) await query(sql)
    await query(
      `INSERT INTO schema_migrations (id) VALUES ($1) ON CONFLICT (id) DO NOTHING`,
      [migration.id],
    )
  }
}

let migrated = false

function isTransientDbError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const e = error as { code?: string; message?: string }
  const code = String(e.code || '')
  const message = String(e.message || '').toLowerCase()
  return (
    code === '57P03' || // recovery mode / not accepting connections yet
    code === 'ECONNREFUSED' ||
    code === 'ETIMEDOUT' ||
    code === 'ECONNRESET' ||
    code === '57P01' || // admin shutdown
    code === '57P02' || // crash shutdown
    message.includes('recovery mode') ||
    message.includes('not yet accepting connections') ||
    message.includes('the database system is starting up') ||
    message.includes('no space left on device')
  )
}

export async function ensureSchema(dataDir?: string): Promise<boolean> {
  if (migrated) return true
  if (!dbConfigured()) return false

  let lastError: unknown
  // Disk-full / Postgres recovery can take a while. Retry longer on transient
  // errors so abulxt-server does not crash-loop the whole site into 502s.
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      await applySchema()
      await migrateLegacyAuthStore(dataDir)

      await query('UPDATE thread SET generating = FALSE WHERE generating = TRUE').catch(() => {})
      migrated = true
      return true
    } catch (error) {
      lastError = error
      const msg = error instanceof Error ? error.message : String(error)
      // Bad credentials / missing role will never heal by retrying.
      if (/password authentication failed|role ".*" does not exist/i.test(msg)) {
        console.error('[db] ensureSchema hard-fail:', msg)
        return false
      }
      const transient = isTransientDbError(error)
      const delayMs = transient
        ? Math.min(15_000, 500 * 2 ** Math.min(attempt, 5))
        : 400 * (attempt + 1)
      console.error(
        `[db] ensureSchema attempt ${attempt + 1}/20 failed` +
          `${transient ? ' (transient)' : ''}; retrying in ${delayMs}ms:`,
        error instanceof Error ? error.message : error,
      )
      await new Promise((resolve) => setTimeout(resolve, delayMs))
      if (!transient && attempt >= 4) break
    }
  }
  // Keep the app process alive when Postgres is unreachable/misconfigured
  // (local preview, disk recovery, etc). Callers already treat false as "no db".
  console.error(
    '[db] ensureSchema giving up after retries:',
    lastError instanceof Error ? lastError.message : lastError,
  )
  return false
}

type LegacyUser = { username: string; salt: string; hash: string; createdAt: string }
type LegacySession = { token: string; username: string; createdAt: string }

async function migrateLegacyAuthStore(dataDir?: string): Promise<void> {
  const dir = dataDir || path.resolve(process.cwd(), '.abulxt-data')
  const storePath = path.join(dir, 'auth-store.json')
  let raw: string
  try {
    raw = await fs.readFile(storePath, 'utf8')
  } catch {
    return
  }
  let parsed: { users?: LegacyUser[]; sessions?: LegacySession[] }
  try {
    parsed = JSON.parse(raw)
  } catch {
    return
  }
  const users = Array.isArray(parsed.users) ? parsed.users : []
  const sessions = Array.isArray(parsed.sessions) ? parsed.sessions : []
  for (const u of users) {
    await query(
      `INSERT INTO users (username, password_salt, password_hash, created)
       VALUES ($1, $2, $3, COALESCE($4::timestamptz, NOW()))
       ON CONFLICT (username) DO NOTHING`,
      [u.username, u.salt, u.hash, u.createdAt || null],
    )
  }
  for (const s of sessions) {
    await query(
      `INSERT INTO session (secret, created, user_id)
       SELECT $1, COALESCE($3::timestamptz, NOW()), id FROM users WHERE lower(username) = lower($2)
       ON CONFLICT (secret) DO NOTHING`,
      [s.token, s.username, s.createdAt || null],
    )
  }

  await fs.rename(storePath, `${storePath}.migrated`).catch(() => {})
}
