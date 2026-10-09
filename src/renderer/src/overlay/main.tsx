import React from 'react'
import { createRoot } from 'react-dom/client'
import Overlay from './Overlay'
import { I18nProvider } from '../i18n'
import '../styles/global.css'
import '../styles/shared.css'
import './Overlay.css'

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <I18nProvider>
      <Overlay />
    </I18nProvider>
  </React.StrictMode>
)
