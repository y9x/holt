import { StrictMode, Suspense, lazy } from 'react'
import { createRoot } from 'react-dom/client'
import { loadDecryptionKey } from '../lib/holy-decrypt'
import { HolyText } from '../components/common/HolyText'
import { App } from './App'
import { readPlatform } from './platform'
import './embed.css'

// A chat platform gets the full chatbox; every other platform gets the identity shell (App).
const ChatMount = lazy(() => import('../chat-mount').then((module) => ({ default: module.ChatMount })))

loadDecryptionKey()

const root = createRoot(document.getElementById('root')!)
const platform = readPlatform()
root.render(
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
)
