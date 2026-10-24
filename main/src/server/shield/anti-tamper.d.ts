// Type declarations for anti-tamper.js (plain JS so it can double as a runtime
// template injected into the shield bootstrap). Only `integrityHash` is imported
// from TypeScript (vite-plugin.ts); the rest are declared for completeness and
// are consumed from JS / emitted runtime source.

export interface AntiTamperConfig {
  integrity: boolean
  toStringGuard: boolean
  timing: boolean
  env: boolean
  mutation: boolean
  timingIntervalMs: number
  [key: string]: unknown
}

export const ANTI_TAMPER_DEFAULTS: AntiTamperConfig

export function resolveAntiTamper(opts?: Partial<AntiTamperConfig> | null): AntiTamperConfig

/** FNV-1a-style integrity hash over a compiled program's function bytecode. */
export function integrityHash(program: { functions: Array<{ code: ArrayLike<number> }> }): number

export function createToStringGuard(thunks: ReadonlyArray<() => unknown>): () => boolean

export function createTimingMonitor(cfg?: { intervalMs?: number } | null): {
  tick: () => void
  tripped: () => boolean
}

export function isLikelyBot(globals?: unknown): boolean

export function installMutationGuard(
  roots: ReadonlyArray<Node | ShadowRoot>,
  onDetect: () => void,
  MO?: typeof MutationObserver,
): () => void
