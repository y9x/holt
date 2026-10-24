// holt-owned stand-in for abulxt's lib/ads.ts. The vendored lib/auth-api.ts imports invalidateAdsConfig to
// refresh ad settings after a sign-in; the chat frame shows no ads, so there is nothing to refresh.

export function invalidateAdsConfig(): void {}
