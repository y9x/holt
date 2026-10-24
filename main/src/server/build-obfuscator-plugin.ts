import type { Plugin } from 'vite'
import { createEncryptionSession } from './crypto-utils.js'
import { buildEncryptedStringMap } from './obfuscation-strings.js'

export interface BuildObfuscatorOptions {
  extraStrings?: string[]
  isMainWebsite?: boolean
}

export function buildObfuscatorPlugin(options: BuildObfuscatorOptions = {}): Plugin {
  const session = createEncryptionSession()
  const stringMap = buildEncryptedStringMap(session, options.extraStrings || [])

  return {
    name: 'abulxt-build-obfuscator',
    enforce: 'post',
    transformIndexHtml: {
      order: 'post',
      handler(html) {
        const payload = JSON.stringify(stringMap)
        const keyDiv = `<div id="eckey" style="display:none">${session.combinedKeyBase64}</div>`
        const scriptPayload = `<script>window.__ABULXT_EC_KEY__=${JSON.stringify(session.combinedKeyBase64)};window.__ABULXT_STRINGS__=${payload};</script>`

        if (html.includes('</head>')) {
          return html.replace('</head>', `${keyDiv}\n${scriptPayload}\n</head>`)
        }
        return `${keyDiv}\n${scriptPayload}\n${html}`
      },
    },
  }
}
