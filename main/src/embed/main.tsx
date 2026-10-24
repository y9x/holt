import { StrictMode, Suspense, lazy } from 'react'
import { createRoot } from 'react-dom/client'
import { loadDecryptionKey } from '../lib/holy-decrypt'
import { HolyText } from '../components/common/HolyText'
import { App } from './App'
import { readPlatform } from './platform'
import { startProxySession } from './proxy-session'
import './embed.css'

// A chat platform gets the full chatbox; every other platform gets the identity shell (App).
const ChatMount = lazy(() => import('../chat-mount').then((module) => ({ default: module.ChatMount })))

/**
 * Each site's chatbox opens on its own guild: on a first visit (nothing remembered yet) holt seeds the
 * chatbox's "last guild" with the site's guild. After that the user's own choice is remembered as usual,
 * and every bridged guild stays in the server rail.
 */
function seedHomeGuild(guild: string | null): void {
  if (!guild) return
  try {
    if (!localStorage.getItem('abulxt:chat-last-guild')) localStorage.setItem('abulxt:chat-last-guild', guild)
  } catch { /* storage blocked: the chatbox opens its first guild */ }
}

loadDecryptionKey()

const root = createRoot(document.getElementById('root')!)
const platform = readPlatform()
if (platform?.chat) seedHomeGuild(platform.homeGuild)
// A platform with its own accounts: sign the chatbox in with the platform's login before it mounts.
const ready = platform?.chat && platform.api === 'holt' ? startProxySession(platform.tokenStorageKey) : Promise.resolve()
void ready.then(() => root.render(
  <StrictMode>
    {platform?.chat ? (
      <Suspense fallback={null}>
        <ChatMount />
      </Suspense>
    ) : platform ? (
      <App platform={platform} />
    ) : (
      <HolyText as="p" className="holt-error" text="This site is not set up for chat." />
    )}
  </StrictMode>,
))
