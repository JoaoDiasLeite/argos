import React from 'react'
import { createRoot } from 'react-dom/client'
import Pill from './Pill'
import { I18nProvider } from '../i18n'
import '../styles/global.css'
import '../styles/shared.css'
import './Pill.css'

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <I18nProvider>
      <Pill />
    </I18nProvider>
  </React.StrictMode>
)
