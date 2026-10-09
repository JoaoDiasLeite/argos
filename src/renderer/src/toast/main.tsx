import React from 'react'
import { createRoot } from 'react-dom/client'
import Toast from './Toast'
import { I18nProvider } from '../i18n'
import '../styles/global.css'
import '../styles/shared.css'
import './Toast.css'

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <I18nProvider>
      <Toast />
    </I18nProvider>
  </React.StrictMode>
)
