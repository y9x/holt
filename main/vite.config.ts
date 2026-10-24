// holt's client build: the embed page, compiled through abulxt's protection pipeline (VENDOR.md).
//
// Same shape as abulxt's build: content-hashed file names (the shield and check-dist-refs expect
// them), build-obfuscator-plugin injecting the string registry, and the shield VM compiling every
// app chunk to encrypted bytecode. The post-build steps (obfuscate-build, canary check, dist refs)
// run from the Makefile, never from here, so `vite build` alone is not a shippable build.

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { buildObfuscatorPlugin } from './src/server/build-obfuscator-plugin.ts'
import { shieldPlugin } from './src/server/shield/vite-plugin.ts'

const HERE = path.dirname(fileURLToPath(import.meta.url))

// The canary list the post-build check enforces (scripts/canary-list.json), so a third-party chunk
// that would leak one stays compiled (shieldPlugin below).
const VENDOR_CANARIES: string[] = (() => {
  try {
    const list = JSON.parse(readFileSync(path.resolve(HERE, '..', 'scripts', 'canary-list.json'), 'utf8')) as { canaries?: Array<{ value?: string }> }
    return (list.canaries ?? []).map((c) => String(c.value || '')).filter(Boolean)
  } catch {
    return []
  }
})()

const HASHED_CHUNK_FILE = 'assets/[hash].js'
const HASHED_ASSET_FILE = 'assets/[hash][extname]'

export default defineConfig({
  // Relative: proxy embedding serves this page under whatever path the platform picks (/chat/ -> /<id>/).
  base: './',
  worker: {
    rollupOptions: {
      output: {
        chunkFileNames: HASHED_CHUNK_FILE,
        entryFileNames: HASHED_CHUNK_FILE,
        assetFileNames: HASHED_ASSET_FILE,
      },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      input: { embed: path.resolve(HERE, 'index.html') },
      output: {
        chunkFileNames: HASHED_CHUNK_FILE,
        entryFileNames: HASHED_CHUNK_FILE,
        assetFileNames: HASHED_ASSET_FILE,
        codeSplitting: {
          groups: [
            { name: 'vendor-react', test: /[\\/]node_modules[\\/](react|react-dom|scheduler)[\\/]/, priority: 30 },
            // AES for every HolyText reveal: hot path, so its own native chunk.
            { name: 'vendor-crypto', test: /[\\/]node_modules[\\/]@noble[\\/]/, priority: 25 },
            // Vite's preload helper on its own, so a lazy native chunk importing it cannot demote the
            // app chunk graph out of the VM (shield fixpoint).
            { name: 'preload-helper', test: /vite[\\/]preload-helper/, priority: 40 },
          ],
        },
      },
    },
  },
  plugins: [
    react(),
    buildObfuscatorPlugin(),
    // Compile mode is the default and the only mode that ships. SHIELD_MODE=manifest is a local
    // analysis-only debug build and is never set in a committed file.
    shieldPlugin({
      mode: process.env.SHIELD_MODE === 'manifest' ? 'manifest' : 'compile',
      exclude: ['polyfill', 'sw-', 'worker'],
      // Chunks that are purely node_modules (React, @noble) run native; app code stays bytecode.
      nativeVendorChunks: true,
      keepCompiled: (code) => VENDOR_CANARIES.some((canary) => code.includes(canary)),
    }),
  ],
})
