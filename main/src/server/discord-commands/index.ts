import { readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

export type StructurePredicate<T> = (structure: unknown) => structure is T

async function* walk(dir: string): AsyncGenerator<string> {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry)
    if (statSync(full).isDirectory()) yield* walk(full)
    else if ((entry.endsWith('.ts') || entry.endsWith('.js')) && entry !== 'index.ts' && entry !== 'types.ts' && entry !== 'state.ts') yield full
  }
}

export async function loadStructures<T>(dir: string, predicate: StructurePredicate<T>): Promise<Map<string, T>> {
  const structures = new Map<string, T>()
  for await (const file of walk(dir)) {
    const mod = await import(pathToFileURL(file).href) as { default?: unknown }
    const structure = mod.default
    if (!predicate(structure)) continue
    structures.set(path.basename(file).replace(/\.(ts|js)$/, ''), structure as T)
  }
  return structures
}
