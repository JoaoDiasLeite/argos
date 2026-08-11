import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
// `lib/common` carries the ~35 languages we can realistically map an extension to and is a
// fraction of the full bundle. Anything unmapped falls back to plaintext (see detectLanguage).
import hljs from 'highlight.js/lib/common'
import './FileEditor.css'

interface ReadResult {
  ok: boolean
  content?: string
  tooLarge?: boolean
  binary?: boolean
  error?: string
}

interface WriteResult {
  ok: boolean
  error?: string
}

interface Props {
  filePath: string
  onClose: () => void
  /** Read the file's content. Parametrized so this editor can open a file over SFTP
   *  (Remote Session) or local fs (WSL "Connect" LocalBrowser) — same modal either way. */
  read: (filePath: string) => Promise<ReadResult>
  write: (filePath: string, content: string) => Promise<WriteResult>
  /** Fallback for files too large/binary to edit in-app. Omitted where download isn't
   *  wired up yet (WSL v1 — see plan notes). */
  onDownload?: () => void
}

/** Two spaces — matches the `tab-size: 2` convention the editor renders with. */
const INDENT = '  '
/** Past this many characters we stop highlighting entirely and fall back to a plain
 *  textarea. `package-lock.json` is the motivating case. */
const HIGHLIGHT_LIMIT = 200_000
/** Below this, highlighting runs synchronously on every keystroke (imperceptible).
 *  Above it we debounce so typing stays smooth. */
const SYNC_LIMIT = 50_000
const HIGHLIGHT_DEBOUNCE_MS = 120
const WRAP_KEY = 'fileEditor.wordWrap'
/** Fallback until we can measure the real line box (12.5px * 1.55). */
const FALLBACK_LINE_H = 19.375

/** Extension → highlight.js language. Explicit on purpose: hljs auto-detection is slow and
 *  guesses wrong often enough to be worse than no colour at all. Unknown names are dropped
 *  by the getLanguage() guard below, so listing an extension is always safe. */
const EXT_LANG: Record<string, string> = {
  ts: 'typescript', tsx: 'typescript', mts: 'typescript', cts: 'typescript',
  js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
  json: 'json', jsonc: 'json', json5: 'json',
  css: 'css', scss: 'scss', sass: 'scss', less: 'less',
  html: 'xml', htm: 'xml', xhtml: 'xml', vue: 'xml', svelte: 'xml', xml: 'xml', svg: 'xml', plist: 'xml',
  md: 'markdown', markdown: 'markdown', mdx: 'markdown',
  sh: 'bash', bash: 'bash', zsh: 'bash', ksh: 'bash', bashrc: 'bash', profile: 'bash',
  ps1: 'powershell', psm1: 'powershell',
  py: 'python', pyw: 'python', rb: 'ruby', php: 'php', pl: 'perl', lua: 'lua', r: 'r',
  yml: 'yaml', yaml: 'yaml',
  toml: 'ini', ini: 'ini', cfg: 'ini', conf: 'ini', env: 'ini', properties: 'ini',
  sql: 'sql', rs: 'rust', go: 'go', java: 'java', kt: 'kotlin', kts: 'kotlin', swift: 'swift',
  c: 'c', h: 'c', cpp: 'cpp', cc: 'cpp', cxx: 'cpp', hpp: 'cpp', hh: 'cpp', hxx: 'cpp',
  cs: 'csharp', m: 'objectivec', mm: 'objectivec',
  diff: 'diff', patch: 'diff', graphql: 'graphql', gql: 'graphql',
  txt: 'plaintext', log: 'plaintext'
}

/** Whole-filename matches for the extension-less files people actually open. */
const NAME_LANG: Record<string, string> = {
  dockerfile: 'dockerfile',
  makefile: 'makefile',
  gemfile: 'ruby',
  rakefile: 'ruby'
}

function detectLanguage(filePath: string): string {
  const base = filePath.replace(/\\/g, '/').split('/').pop()?.toLowerCase() ?? ''
  const byName = NAME_LANG[base]
  if (byName && hljs.getLanguage(byName)) return byName
  const dot = base.lastIndexOf('.')
  // A leading-dot file (.gitignore) has no extension — the whole name is the "extension".
  const ext = dot > 0 ? base.slice(dot + 1) : ''
  const lang = EXT_LANG[ext]
  return lang && hljs.getLanguage(lang) ? lang : 'plaintext'
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

/** Modal editor for a remote/local file: line numbers, syntax highlighting, find & replace.
 *  Highlighting is a `<pre>` painted *under* a transparent textarea, so native editing,
 *  selection, IME and undo all keep working. */
export default function FileEditor({ filePath, onClose, read, write, onDownload }: Props) {
  const [content, setContent] = useState('')
  const [original, setOriginal] = useState('')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [tooLarge, setTooLarge] = useState(false)
  const [binary, setBinary] = useState(false)

  // Word wrap defaults ON and remembers the user's choice — a single global preference
  // rather than a per-file-type guess, which is easier to reason about than "it depends".
  const [wrap, setWrap] = useState<boolean>(() => {
    try {
      return localStorage.getItem(WRAP_KEY) !== 'off'
    } catch {
      return true
    }
  })
  const [caret, setCaret] = useState({ line: 1, col: 1, selLen: 0 })
  const [confirmDiscard, setConfirmDiscard] = useState(false)

  const [findOpen, setFindOpen] = useState(false)
  const [replaceShown, setReplaceShown] = useState(false)
  const [query, setQuery] = useState('')
  const [replacement, setReplacement] = useState('')
  const [caseSensitive, setCaseSensitive] = useState(false)
  const [matchIndex, setMatchIndex] = useState(0)

  const taRef = useRef<HTMLTextAreaElement>(null)
  const hlRef = useRef<HTMLPreElement>(null)
  const findInputRef = useRef<HTMLInputElement>(null)
  /** Selection to restore after a programmatic buffer rewrite (indent, replace) — React
   *  resets a controlled textarea's caret to the end otherwise. */
  const pendingSelRef = useRef<[number, number] | null>(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    setTooLarge(false)
    setBinary(false)
    read(filePath).then((res) => {
      if (cancelled) return
      setLoading(false)
      if (!res.ok) {
        setError(res.error || 'Failed to read file')
        return
      }
      if (res.tooLarge) {
        setTooLarge(true)
        return
      }
      if (res.binary) {
        setBinary(true)
        return
      }
      setContent(res.content ?? '')
      setOriginal(res.content ?? '')
    })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filePath])

  const dirty = content !== original
  const editable = !loading && !error && !tooLarge && !binary

  const save = useCallback(async () => {
    if (!dirty || saving) return
    setSaving(true)
    setError(null)
    const res = await write(filePath, content)
    setSaving(false)
    if (res.ok) setOriginal(content)
    else setError(res.error || 'Failed to save file')
  }, [dirty, saving, write, filePath, content])

  /** Closing with unsaved edits raises an inline confirmation instead of throwing them away. */
  const requestClose = useCallback(() => {
    if (dirty) setConfirmDiscard(true)
    else onClose()
  }, [dirty, onClose])

  // ── Highlighting ────────────────────────────────────────────────────────────
  const language = useMemo(() => detectLanguage(filePath), [filePath])
  const highlightEnabled = editable && content.length <= HIGHLIGHT_LIMIT

  /** Tokenised HTML tagged with the source it was produced from, so a stale result is
   *  never painted under a newer buffer. */
  const [tokens, setTokens] = useState<{ src: string; html: string } | null>(null)

  useEffect(() => {
    if (!highlightEnabled) {
      setTokens(null)
      return
    }
    const run = () => {
      let html: string
      try {
        html =
          language === 'plaintext'
            ? escapeHtml(content)
            : hljs.highlight(content, { language, ignoreIllegals: true }).value
      } catch {
        html = escapeHtml(content)
      }
      setTokens({ src: content, html })
    }
    if (content.length <= SYNC_LIMIT) {
      run()
      return
    }
    const t = window.setTimeout(run, HIGHLIGHT_DEBOUNCE_MS)
    return () => window.clearTimeout(t)
  }, [content, language, highlightEnabled])

  /** While the debounce is in flight we paint the escaped buffer verbatim — the colours lag
   *  by a tick on big files, but the two layers never show different *characters*.
   *  The trailing "\n" keeps the <pre> as tall as the textarea, which always reserves a
   *  final empty line for a file ending in a newline. */
  const highlightHtml = useMemo(() => {
    if (!highlightEnabled) return ''
    const html = tokens && tokens.src === content ? tokens.html : escapeHtml(content)
    return `${html}\n`
  }, [highlightEnabled, tokens, content])

  // ── Gutter ──────────────────────────────────────────────────────────────────
  const lineCount = useMemo(() => {
    let n = 1
    for (let i = 0; i < content.length; i++) if (content.charCodeAt(i) === 10) n++
    return n
  }, [content])

  /** Wrapping makes one logical line span several visual rows, so a 1..n gutter would drift
   *  away from the text. Rather than measure wrapped row heights we hide the gutter while
   *  wrap is on — an honest absence beats a quietly wrong column. */
  const gutterShown = editable && !wrap

  const [lineH, setLineH] = useState(FALLBACK_LINE_H)
  const [view, setView] = useState({ top: 0, height: 400 })

  useLayoutEffect(() => {
    const ta = taRef.current
    if (!ta) return
    const cs = getComputedStyle(ta)
    const h = parseFloat(cs.lineHeight)
    if (!Number.isNaN(h) && h > 0) setLineH(h)
    setView({ top: ta.scrollTop, height: ta.clientHeight })
  }, [editable, wrap])

  // Keep the visible-line window right when the modal is resized (window resize, wrap toggle).
  useEffect(() => {
    const ta = taRef.current
    if (!ta || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => setView({ top: ta.scrollTop, height: ta.clientHeight }))
    ro.observe(ta)
    return () => ro.disconnect()
  }, [editable])

  const rafRef = useRef(0)
  useEffect(() => () => { if (rafRef.current) cancelAnimationFrame(rafRef.current) }, [])

  /** Both axes, on every textarea scroll — the highlight layer is driven imperatively so it
   *  never lags a frame behind the caret. */
  const handleScroll = () => {
    const ta = taRef.current
    if (!ta) return
    if (hlRef.current) {
      hlRef.current.scrollTop = ta.scrollTop
      hlRef.current.scrollLeft = ta.scrollLeft
    }
    // The gutter only needs a re-render when it is actually visible; throttle to a frame.
    if (!gutterShown || rafRef.current) return
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = 0
      const el = taRef.current
      if (el) setView({ top: el.scrollTop, height: el.clientHeight })
    })
  }

  /** Only the visible slice of line numbers is rendered — a 100k-line file would otherwise
   *  put 100k nodes in the DOM. */
  const gutterLines = useMemo(() => {
    if (!gutterShown) return { first: 0, numbers: [] as number[] }
    const first = Math.max(0, Math.floor(view.top / lineH) - 2)
    const visible = Math.ceil(view.height / lineH) + 4
    const last = Math.min(lineCount, first + visible)
    const numbers: number[] = []
    for (let i = first; i < last; i++) numbers.push(i + 1)
    return { first, numbers }
  }, [gutterShown, view.top, view.height, lineH, lineCount])

  // ── Caret / selection readout ───────────────────────────────────────────────
  const syncCaret = useCallback(() => {
    const ta = taRef.current
    if (!ta) return
    const s = ta.selectionStart
    const before = ta.value.slice(0, s)
    const nl = before.lastIndexOf('\n')
    let line = 1
    for (let i = 0; i < before.length; i++) if (before.charCodeAt(i) === 10) line++
    setCaret({ line, col: s - nl, selLen: ta.selectionEnd - s })
  }, [])

  /** Restore the caret after a programmatic rewrite, before the browser paints. */
  useLayoutEffect(() => {
    const sel = pendingSelRef.current
    const ta = taRef.current
    if (!sel || !ta) return
    pendingSelRef.current = null
    ta.setSelectionRange(sel[0], sel[1])
    syncCaret()
  }, [content, syncCaret])

  // ── Tab / Shift+Tab indentation ─────────────────────────────────────────────
  const applyIndent = (outdent: boolean) => {
    const ta = taRef.current
    if (!ta) return
    const s = ta.selectionStart
    const e = ta.selectionEnd
    const multiline = content.slice(s, e).includes('\n')

    // Plain caret, indenting: just insert at the caret.
    if (!outdent && s === e) {
      setContent(content.slice(0, s) + INDENT + content.slice(e))
      pendingSelRef.current = [s + INDENT.length, s + INDENT.length]
      return
    }

    // Otherwise operate on every line the selection touches. A selection ending exactly at a
    // line start doesn't "touch" that line, matching how editors normally behave.
    const blockStart = content.lastIndexOf('\n', s - 1) + 1
    let end = e
    if (multiline && e > s && content[e - 1] === '\n') end = e - 1
    let blockEnd = content.indexOf('\n', end)
    if (blockEnd === -1) blockEnd = content.length

    const lines = content.slice(blockStart, blockEnd).split('\n')
    let firstDelta = 0
    let totalDelta = 0
    const next = lines.map((ln, i) => {
      if (outdent) {
        const m = /^(\t| {1,2})/.exec(ln)
        if (!m) return ln
        if (i === 0) firstDelta = -m[0].length
        totalDelta -= m[0].length
        return ln.slice(m[0].length)
      }
      if (ln.length === 0) return ln // don't leave trailing whitespace on blank lines
      if (i === 0) firstDelta = INDENT.length
      totalDelta += INDENT.length
      return INDENT + ln
    })

    if (totalDelta === 0) return
    setContent(content.slice(0, blockStart) + next.join('\n') + content.slice(blockEnd))
    pendingSelRef.current = [Math.max(blockStart, s + firstDelta), Math.max(blockStart, e + totalDelta)]
  }

  // ── Find & replace ──────────────────────────────────────────────────────────
  /** Literal substring search — the query is never treated as a regex. */
  const matches = useMemo(() => {
    if (!findOpen || !query) return [] as number[]
    const hay = caseSensitive ? content : content.toLowerCase()
    const needle = caseSensitive ? query : query.toLowerCase()
    const out: number[] = []
    let i = hay.indexOf(needle)
    while (i !== -1) {
      out.push(i)
      i = hay.indexOf(needle, i + needle.length)
    }
    return out
  }, [findOpen, query, caseSensitive, content])

  useEffect(() => {
    setMatchIndex((i) => (matches.length === 0 ? 0 : Math.min(i, matches.length - 1)))
  }, [matches])

  /** Select the match natively (rather than painting an overlay that would have to be kept
   *  in sync with the highlight layer) and bring it on screen. */
  const gotoMatch = useCallback(
    (idx: number) => {
      const ta = taRef.current
      if (!ta || matches.length === 0) return
      const wrapped = ((idx % matches.length) + matches.length) % matches.length
      setMatchIndex(wrapped)
      const start = matches[wrapped]
      const end = start + query.length
      ta.focus()
      ta.setSelectionRange(start, end)
      if (!wrap) {
        // Centre the hit vertically when it is outside the viewport. Only meaningful without
        // wrapping, where one logical line is exactly one row tall.
        let line = 0
        for (let i = 0; i < start; i++) if (content.charCodeAt(i) === 10) line++
        const y = line * lineH
        if (y < ta.scrollTop || y > ta.scrollTop + ta.clientHeight - lineH) {
          ta.scrollTop = Math.max(0, y - ta.clientHeight / 2)
        }
      }
      handleScroll()
      syncCaret()
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [matches, query, wrap, content, lineH, syncCaret]
  )

  /** False until the user has stepped once for the current query, so the first Enter (or ↓)
   *  lands on match 1 rather than skipping straight to match 2. */
  const steppedRef = useRef(false)
  useEffect(() => {
    steppedRef.current = false
  }, [query, caseSensitive, findOpen])

  const step = (delta: number) => {
    if (matches.length === 0) return
    if (!steppedRef.current) {
      steppedRef.current = true
      gotoMatch(matchIndex)
      return
    }
    gotoMatch(matchIndex + delta)
  }

  // NOTE: replacing rewrites the whole buffer through React state, which drops the
  // textarea's native undo stack. Accepted tradeoff — the alternative (execCommand) is
  // deprecated and unreliable in Electron.
  const replaceCurrent = () => {
    if (matches.length === 0) return
    const start = matches[matchIndex]
    const end = start + query.length
    setContent(content.slice(0, start) + replacement + content.slice(end))
    pendingSelRef.current = [start + replacement.length, start + replacement.length]
  }

  const replaceAll = () => {
    if (matches.length === 0) return
    let out = ''
    let cursor = 0
    for (const start of matches) {
      out += content.slice(cursor, start) + replacement
      cursor = start + query.length
    }
    out += content.slice(cursor)
    setContent(out)
    setMatchIndex(0)
  }

  const openFind = (withReplace: boolean) => {
    // Seed the query from the selection, the way every other editor does.
    const ta = taRef.current
    const sel = ta ? ta.value.slice(ta.selectionStart, ta.selectionEnd) : ''
    if (sel && !sel.includes('\n')) setQuery(sel)
    setFindOpen(true)
    if (withReplace) setReplaceShown(true)
    // Focus lands in the input once it has mounted.
    requestAnimationFrame(() => {
      findInputRef.current?.focus()
      findInputRef.current?.select()
    })
  }

  const closeFind = () => {
    setFindOpen(false)
    setReplaceShown(false)
    taRef.current?.focus()
  }

  useEffect(() => {
    try {
      localStorage.setItem(WRAP_KEY, wrap ? 'on' : 'off')
    } catch {
      /* storage disabled — the toggle still works for this session */
    }
  }, [wrap])

  // ── Keyboard ────────────────────────────────────────────────────────────────
  /** Handled on the modal wrapper so the shortcuts work whatever inside has focus. Every key
   *  we act on stops propagating: this modal can be opened from the Remote Session view, and
   *  App itself listens on `window`. */
  const onKeyDown = (e: React.KeyboardEvent) => {
    const mod = e.metaKey || e.ctrlKey
    const key = e.key.toLowerCase()

    if (mod && key === 's') {
      e.preventDefault() // never let Electron/Chromium open its own save dialog
      e.stopPropagation()
      if (editable) void save()
      return
    }
    if (mod && (key === 'f' || key === 'h') && editable) {
      e.preventDefault()
      e.stopPropagation()
      openFind(key === 'h')
      return
    }
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      if (confirmDiscard) setConfirmDiscard(false)
      // Escape belongs to the find bar while focus is inside it, and to the modal otherwise.
      else if (findOpen && (e.target as HTMLElement).closest('.file-editor-find')) closeFind()
      else requestClose()
      return
    }
    if (e.key === 'Tab' && e.target === taRef.current) {
      e.preventDefault()
      e.stopPropagation()
      applyIndent(e.shiftKey)
    }
  }

  const size = useMemo(() => {
    // Byte length, not character count — that is what the file will actually weigh.
    try {
      return new TextEncoder().encode(content).length
    } catch {
      return content.length
    }
  }, [content])

  const matchLabel = query ? (matches.length ? `${matchIndex + 1} of ${matches.length}` : 'No results') : ''

  return (
    <div className="modal-backdrop" onClick={requestClose}>
      <div
        className="modal wide file-editor-modal"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={onKeyDown}
      >
        <div className="modal-header">
          <h3 className="mono file-editor-title" title={filePath}>
            {filePath}
            {dirty && <span className="file-editor-dirty">•</span>}
          </h3>
          <button className="icon-btn" onClick={requestClose} aria-label="Close" title="Close (Esc)">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>
        <div className="modal-body file-editor-body">
          {loading && <div className="view-empty small">Loading…</div>}
          {!loading && error && <div className="ssh-test err">{error}</div>}
          {!loading && !error && tooLarge && (
            <div className="file-editor-notice">
              <p>This file is too large to edit in-app.</p>
              {onDownload && (
                <button className="btn-ghost small" onClick={onDownload}>
                  Download instead
                </button>
              )}
            </div>
          )}
          {!loading && !error && binary && (
            <div className="file-editor-notice">
              <p>This looks like a binary file — it can&apos;t be shown as text.</p>
              {onDownload && (
                <button className="btn-ghost small" onClick={onDownload}>
                  Download instead
                </button>
              )}
            </div>
          )}
          {editable && (
            <>
              {/* In normal flow, above the code — a floating bar would cover the first line. */}
              {findOpen && (
                <div className="file-editor-find" role="search" aria-label="Find and replace">
                  <div className="file-editor-find-row">
                    <input
                      ref={findInputRef}
                      className="text-input file-editor-find-input"
                      placeholder="Find"
                      aria-label="Find"
                      value={query}
                      spellCheck={false}
                      onChange={(e) => {
                        setQuery(e.target.value)
                        setMatchIndex(0)
                      }}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.preventDefault()
                          step(e.shiftKey ? -1 : 1)
                        }
                      }}
                    />
                    <span className="file-editor-find-count">{matchLabel}</span>
                    <button
                      className={`file-editor-chip${caseSensitive ? ' on' : ''}`}
                      onClick={() => setCaseSensitive((v) => !v)}
                      aria-pressed={caseSensitive}
                      aria-label="Match case"
                      title="Match case"
                    >
                      Aa
                    </button>
                    <button
                      className="file-editor-chip"
                      onClick={() => step(-1)}
                      disabled={matches.length === 0}
                      aria-label="Previous match"
                      title="Previous match (Shift+Enter)"
                    >
                      ↑
                    </button>
                    <button
                      className="file-editor-chip"
                      onClick={() => step(1)}
                      disabled={matches.length === 0}
                      aria-label="Next match"
                      title="Next match (Enter)"
                    >
                      ↓
                    </button>
                    <button
                      className={`file-editor-chip${replaceShown ? ' on' : ''}`}
                      onClick={() => setReplaceShown((v) => !v)}
                      aria-pressed={replaceShown}
                      aria-label="Toggle replace"
                      title="Toggle replace (Ctrl+H)"
                    >
                      ⇄
                    </button>
                    <button
                      className="file-editor-chip"
                      onClick={closeFind}
                      aria-label="Close find"
                      title="Close find (Esc)"
                    >
                      ✕
                    </button>
                  </div>
                  {replaceShown && (
                    <div className="file-editor-find-row">
                      <input
                        className="text-input file-editor-find-input"
                        placeholder="Replace with"
                        aria-label="Replace with"
                        value={replacement}
                        spellCheck={false}
                        onChange={(e) => setReplacement(e.target.value)}
                      />
                      <button
                        className="btn-ghost small"
                        onClick={replaceCurrent}
                        disabled={matches.length === 0}
                        aria-label="Replace current match"
                        title="Replace current match"
                      >
                        Replace
                      </button>
                      <button
                        className="btn-ghost small"
                        onClick={replaceAll}
                        disabled={matches.length === 0}
                        aria-label="Replace all matches"
                        title="Replace all matches"
                      >
                        All
                      </button>
                    </div>
                  )}
                </div>
              )}

              <div className="file-editor-code">
                {gutterShown && (
                  <div className="file-editor-gutter" aria-hidden="true">
                    {/* The gutter itself never scrolls: the visible slice is translated to
                        `firstLine * lineHeight - scrollTop`, which is exactly where the
                        matching row sits inside the textarea's scrolled content. */}
                    <div
                      className="file-editor-gutter-inner"
                      style={{ transform: `translateY(${gutterLines.first * lineH - view.top}px)` }}
                    >
                      {gutterLines.numbers.map((n) => (
                        <div
                          key={n}
                          className={n === caret.line ? 'gl current' : 'gl'}
                          style={{ height: lineH }}
                        >
                          {n}
                        </div>
                      ))}
                    </div>
                  </div>
                )}
                <div className="file-editor-layers">
                  {highlightEnabled && (
                    <pre
                      ref={hlRef}
                      className={`file-editor-hl ${wrap ? 'wrap' : 'nowrap'}`}
                      aria-hidden="true"
                    >
                      <code dangerouslySetInnerHTML={{ __html: highlightHtml }} />
                    </pre>
                  )}
                  <textarea
                    ref={taRef}
                    className={`mono file-editor-textarea ${wrap ? 'wrap' : 'nowrap'}${highlightEnabled ? ' hl-on' : ''}`}
                    value={content}
                    onChange={(e) => setContent(e.target.value)}
                    onScroll={handleScroll}
                    onSelect={syncCaret}
                    onClick={syncCaret}
                    onKeyUp={syncCaret}
                    wrap={wrap ? 'soft' : 'off'}
                    spellCheck={false}
                    aria-label={`Contents of ${filePath}`}
                    autoFocus
                  />
                </div>
              </div>

              <div className="file-editor-status">
                <span>
                  Ln {caret.line}, Col {caret.col}
                </span>
                {caret.selLen > 0 && <span>{caret.selLen} selected</span>}
                <span className="file-editor-status-spacer" />
                {!highlightEnabled && <span title="Syntax highlighting is off above 200k characters">no highlighting (large file)</span>}
                <button
                  className={`file-editor-chip${wrap ? ' on' : ''}`}
                  onClick={() => setWrap((v) => !v)}
                  aria-pressed={wrap}
                  aria-label="Toggle word wrap"
                  title={wrap ? 'Word wrap on (line numbers hidden)' : 'Word wrap off'}
                >
                  Wrap
                </button>
                <span>{language}</span>
                <span>{formatBytes(size)}</span>
                <span className={dirty ? 'file-editor-modified' : undefined}>
                  {dirty ? 'Modified' : 'Saved'}
                </span>
              </div>
            </>
          )}
        </div>
        {confirmDiscard && (
          <div className="file-editor-confirm" role="alertdialog" aria-label="Unsaved changes">
            <span>Discard unsaved changes?</span>
            <button className="btn-ghost small" onClick={() => setConfirmDiscard(false)} autoFocus>
              Cancel
            </button>
            <button className="btn-ghost small danger" onClick={onClose}>
              Discard
            </button>
          </div>
        )}
        <div className="modal-footer">
          <button className="btn-secondary" onClick={requestClose}>Close</button>
          {editable && (
            <button className="btn-primary" onClick={save} disabled={!dirty || saving} title="Save (Ctrl+S)">
              {saving ? 'Saving…' : 'Save'}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
