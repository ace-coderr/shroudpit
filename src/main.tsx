import './polyfills'
import '@fontsource/newsreader/400.css'
import '@fontsource/newsreader/400-italic.css'
import '@fontsource/newsreader/600.css'
import '@fontsource/jetbrains-mono/400.css'
import '@fontsource/jetbrains-mono/600.css'
import './index.css'

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { HashRouter } from 'react-router-dom'
import App from './App'
import { WalletProviders } from './lib/wallet'

// Hash routing: GitHub Pages is static and cannot rewrite deep links.
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <WalletProviders>
      <HashRouter>
        <App />
      </HashRouter>
    </WalletProviders>
  </StrictMode>,
)
