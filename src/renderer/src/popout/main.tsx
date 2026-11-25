import React from 'react'
import { createRoot } from 'react-dom/client'
import Popout from './Popout'
import { I18nProvider } from '../i18n'
import { IS_DARWIN } from '../lib/platform'
import { installEditingKeys } from '../lib/clipboard-paste'
import '../styles/global.css'
import '../styles/shared.css'
import './Popout.css'

// macOS's application menu is shared by every window, and it carries no Edit roles, so
// this window's fields need the app's own editing keys too. Elsewhere Chromium's defaults
// already cover them here.
if (IS_DARWIN) installEditingKeys()

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <I18nProvider>
      <Popout />
    </I18nProvider>
  </React.StrictMode>
)
