import React from 'react'
import { createRoot } from 'react-dom/client'
import Popout from './Popout'
import { I18nProvider } from '../i18n'
import '../styles/global.css'
import '../styles/shared.css'
import './Popout.css'

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <I18nProvider>
      <Popout />
    </I18nProvider>
  </React.StrictMode>
)
