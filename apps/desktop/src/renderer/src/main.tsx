import React from 'react'
import ReactDOM from 'react-dom/client'
import { RendererCapabilitiesProvider, type RendererCapabilities } from '@openagent/plugin-kit/renderer'
import './fonts.css'
import './globals'
import App from './App'
import './styles.css'

const rendererCapabilities: RendererCapabilities = {
  openExternal: (url) => window.openAgent.openExternal(url),
  reportRendererFirstCommit: (input) => window.openAgent.reportRendererFirstCommit?.(input)
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <RendererCapabilitiesProvider capabilities={rendererCapabilities}>
      <App />
    </RendererCapabilitiesProvider>
  </React.StrictMode>
)
