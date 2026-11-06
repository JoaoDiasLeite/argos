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
import Ball from './Ball'

// The companion's windows (docs/COMPANION_PLAN.md §9.1–9.2, §13.3 P2): one page, told
// apart by the hash main loads it with — '#pet' for Argos, '#bubble' for the bubble
// beside him, '#ball' for the ball he fetches. No markdown or highlighting here: the
// entry stays small so the bubble paints at once.

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

/**
 * Undo the page zoom these windows inherit. Chromium zooms every window of one origin
 * together, so the main window's UI size (app:set-zoom, 0.9 at 'sm') zoomed the pet too:
 * the dog was drawn 90 % size from the window's top-left and stood short of its bottom
 * edge, above the taskbar, and the bubble measured itself in the wrong unit. A root zoom
 * of the inverse puts one CSS px back at one DIP, which is what main's geometry speaks.
 * A zoom change resizes the viewport, so 'resize' is the cue to look again.
 */
function cancelPageZoom(): void {
  const apply = (): void => {
    window.electronAPI.companion
      .zoom()
      .then((z) => {
        if (Number.isFinite(z) && z > 0) document.documentElement.style.zoom = String(1 / z)
      })
      .catch(() => {})
  }
  apply()
  window.addEventListener('resize', apply)
}

cancelPageZoom()

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <I18nProvider>
      <Themed>{location.hash === '#bubble' ? <Bubble /> : location.hash === '#ball' ? <Ball /> : <Pet />}</Themed>
    </I18nProvider>
  </React.StrictMode>
)
