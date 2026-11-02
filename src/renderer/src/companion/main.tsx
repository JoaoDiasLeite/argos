import React, { useEffect } from 'react'
import { createRoot } from 'react-dom/client'
// The app's styles first: global.css paints body with --bg-0, and pet.css / bubble.css
// (imported by the components below) must come after it to make the page transparent
// again. In the other order the pet sat on a near-white square in the light theme.
import '../styles/global.css'
import '../styles/shared.css'
import { I18nProvider } from '../i18n'
import { applyTheme } from '../lib/theme'
import Pet from './Pet'
import Bubble from './Bubble'

// The companion's two windows (docs/COMPANION_PLAN.md §9.1–9.2): one page, told apart by
// the hash main loads it with — '#pet' for Argos, '#bubble' for the bubble beside him.
// No markdown or highlighting here: the entry stays small so the bubble paints at once.

/** The user's palette and theme, followed live like the overlay does. */
function Themed({ children }: { children: React.ReactNode }) {
  useEffect(() => {
    window.electronAPI
      .getConfig()
      .then((config) => applyTheme(document.documentElement, config.ui))
      .catch(() => {})
    return window.electronAPI.onUiPrefs((ui) => applyTheme(document.documentElement, ui))
  }, [])
  return <>{children}</>
}

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <I18nProvider>
      <Themed>{location.hash === '#bubble' ? <Bubble /> : <Pet />}</Themed>
    </I18nProvider>
  </React.StrictMode>
)
