// Client config: the two functions the vendored holy-decrypt.ts imports from './config'. holt-owned
// (not in scripts/vendor-manifest.json): abulxt's copy also carries relay, cloak and API-base settings
// holt has none of.
//
// holt is never served inside a cloak, so there is no cloak shadow root; the obfuscation key comes
// from the #eckey element or window.__ABULXT_EC_KEY__ that build-obfuscator-plugin injects.

export interface ClientConfig {
  ecKey?: string
}

export function clientConfig(): ClientConfig {
  return {}
}

export function getCloakShadowRoot(): ShadowRoot | undefined {
  return undefined
}
