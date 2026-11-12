// Content-Security-Policy for the app's own renderer pages. electron.vite.config.ts injects
// it as a <meta http-equiv> at the top of every html entry, in the build and on the dev
// server. Pure, so the directive list is pinned by a test.

export interface RendererCspOptions {
  /** The vite dev server, which injects an inline React Refresh preamble script. */
  dev: boolean
  /** The companion page loads its recorder AudioWorklet from a Blob URL (companion/recorder.ts). */
  blobScripts?: boolean
}

export function rendererCsp({ dev, blobScripts = false }: RendererCspOptions): string {
  const script = ["'self'"]
  if (blobScripts) script.push('blob:')
  if (dev) script.push("'unsafe-inline'")
  return [
    // Everything not listed below: only the app's own files (file:// built, the dev server's origin in dev).
    "default-src 'self'",
    `script-src ${script.join(' ')}`,
    // xterm and the companion page add <style> elements; vite's dev CSS is injected the same way.
    "style-src 'self' 'unsafe-inline'",
    // Bundled assets, and data: for vite-inlined small assets and pasted image previews.
    // No remote images: chat markdown comes from model output, and an <img> to an
    // attacker's host is a way to leak data.
    "img-src 'self' data:",
    // The renderer never fetches remotely (all network goes through IPC); 'self' also
    // covers the dev server's HMR websocket.
    "connect-src 'self'",
    "object-src 'none'",
    "frame-src 'none'",
    "base-uri 'none'",
    "form-action 'none'"
  ].join('; ')
}
