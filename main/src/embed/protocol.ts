// The postMessage protocol between a platform page (host) and the holt iframe (frame).
//
// Both sides check `event.origin`: the host accepts only holt's origin, the frame accepts only the
// platform's allowedOrigins. Every message is `{ holt: 1, type, ...fields }`; anything else is ignored.
//
// frame -> host
//   ready           The frame is loaded and wants an identity token (or null for a guest).
//   token-expired   The frame's session ended; the host should mint a fresh identity token.
//   navigate        The user chose an account action holt does not own. `target` names a platform
//                   link (account, settings, verifyEmail, signIn); `url` is that link as holt has it
//                   configured. The host navigates the top page.
//   resize          Content height changed (for hosts that size the frame to content).
//
// host -> frame
//   token           An identity token minted by the platform's backend, or null to continue as a guest.

export const HOLT_PROTOCOL = 1

export type LinkTarget = 'account' | 'settings' | 'verifyEmail' | 'signIn'

export type FrameToHost =
  | { holt: 1; type: 'ready' }
  | { holt: 1; type: 'token-expired' }
  | { holt: 1; type: 'navigate'; target: LinkTarget; url: string }
  | { holt: 1; type: 'resize'; height: number }

export type HostToFrame =
  | { holt: 1; type: 'token'; token: string | null }

export function isHoltMessage(data: unknown): data is { holt: 1; type: string } {
  return typeof data === 'object' && data !== null && (data as { holt?: unknown }).holt === HOLT_PROTOCOL && typeof (data as { type?: unknown }).type === 'string'
}
