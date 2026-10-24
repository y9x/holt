import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { loadDecryptionKey } from '../lib/holy-decrypt'
import { HolyText } from '../components/common/HolyText'
import { App } from './App'
import { readPlatform } from './platform'
import './embed.css'

loadDecryptionKey()

const root = createRoot(document.getElementById('root')!)
const platform = readPlatform()
root.render(
  <StrictMode>
    {platform ? <App platform={platform} /> : <HolyText as="p" className="holt-error" text="This site is not set up for chat." />}
  </StrictMode>,
)
