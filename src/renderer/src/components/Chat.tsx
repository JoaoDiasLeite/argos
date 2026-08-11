import { Fragment, useEffect, useRef, useState, lazy, Suspense } from 'react'
import { Session, ModelInfo, Attachment, SlashCommand, ProviderId } from '../types'
import MessageBubble from './MessageBubble'
import ModelPicker from './ModelPicker'
import ChatConfigBar from './ChatConfigBar'
import { sessionToMarkdown } from '../lib/markdown-export'
import './Chat.css'

// ChatTerminal pulls in @xterm/xterm + its addons (~300 kB) but is only ever
// rendered once the user opens the embedded terminal (`termOpen`, default
// false) — so it's loaded lazily instead of bundled into the initial chunk.
const ChatTerminal = lazy(() => import('./ChatTerminal'))

// ── Text-file attachment limits & heuristics ─────────────────────────────────
const MAX_FILE_ATTACHMENTS = 5
const MAX_FILE_BYTES = 200 * 1024
// Extensions that are almost certainly binary — images among these go through the
// existing image path instead, so anything here reaching the text path is rejected.
const BINARY_EXTENSIONS = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'pdf', 'zip', 'exe', 'dll', 'bin'
])

// Human-readable byte size, e.g. 14560 → "14.2 KB".
function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const kb = bytes / 1024
  if (kb < 1024) return `${kb.toFixed(1)} KB`
  return `${(kb / 1024).toFixed(1)} MB`
}

// Ellipsize the middle of a long filename so the extension stays visible.
function middleEllipsis(name: string, max = 28): string {
  if (name.length <= max) return name
  const keep = max - 1
  const head = Math.ceil(keep / 2)
  const tail = Math.floor(keep / 2)
  return `${name.slice(0, head)}…${name.slice(name.length - tail)}`
}

/**
 * Approximate the context footprint currently re-sent on every turn: walk back to
 * the last assistant message that carries usage and sum its input + cache tokens
 * (that turn's input + cacheRead + cacheCreation ≈ the whole conversation re-sent).
 * Returns null for old sessions where no message has usage.
 */
function contextTokens(session?: Session): number | null {
  if (!session) return null
  for (let i = session.messages.length - 1; i >= 0; i--) {
    const u = session.messages[i].usage
    if (u) return u.inputTokens + u.cacheReadTokens + u.cacheCreationTokens
  }
  return null
}

interface Props {
  session?: Session
  streaming: boolean
  onSendMessage: (
    text: string,
    images?: { mediaType: string; data: string }[],
    files?: { name: string; content: string }[]
  ) => void
  onStop: () => void
  onOpenSettings: () => void
  ready: boolean
  models: ModelInfo[]
  currentModel: string
  onModelChange: (modelId: string) => void
  /** The active chat's provider — forwarded to ChatTerminal to launch the right CLI. */
  terminalProvider: ProviderId
  /** The account (for terminalProvider) this chat is bound to — forwarded to ChatTerminal. */
  terminalAccountId?: string
  /** Which panel a chat opens in the first time it's seen (the "Open new chats in" pref). */
  defaultChatView: 'chat' | 'terminal'
  /** Bumped by App whenever it deliberately lands you on a new chat (switching account,
   *  returning to the chat view) — forces the composer into view. See the effect below. */
  newChatNonce: number
  onOpenClaudeMd: () => void
  autoApprove: boolean
  onToggleAutoApprove: () => void
  lightMode: boolean
  onToggleLightMode: () => void
  onStartFresh: () => void
  onCompact: () => void
  compacting: boolean
  onOpenCheckpoints: () => void
  onOpenGit: () => void
  onRetry: () => void
  onEditResend: (messageId: string, newText: string) => void
  onBranch: (messageId: string) => void
  onExportSession: (format: 'md' | 'html') => void
  /** Patch the active draft session (folder / environment / extra dirs) from the new-chat bar. */
  onPatchSession: (patch: Partial<Session>) => void
}

export default function Chat({
  session,
  streaming,
  onSendMessage,
  onStop,
  onOpenSettings,
  ready,
  models,
  currentModel,
  onModelChange,
  terminalProvider,
  terminalAccountId,
  defaultChatView,
  newChatNonce,
  onOpenClaudeMd,
  autoApprove,
  onToggleAutoApprove,
  lightMode,
  onToggleLightMode,
  onStartFresh,
  onCompact,
  compacting,
  onOpenCheckpoints,
  onOpenGit,
  onRetry,
  onEditResend,
  onBranch,
  onExportSession,
  onPatchSession
}: Props) {
  const [exportMenuOpen, setExportMenuOpen] = useState(false)
  const [markdownCopied, setMarkdownCopied] = useState(false)
  const [markdownSaved, setMarkdownSaved] = useState(false)
  // Long-session banners the user has waved away, keyed by session id. In-memory only:
  // the warning is worth re-stating in a fresh app run, but not on every render.
  const [dismissedBanners, setDismissedBanners] = useState<Record<string, boolean>>({})
  // Which provider's model the active chat is running — the model picker filters to it.
  const activeProvider = models.find((m) => currentModel.startsWith(m.id))?.provider ?? 'claude'
  const CONTEXT_FILE: Record<typeof activeProvider, string> = {
    claude: 'CLAUDE.md',
    codex: 'AGENTS.md',
    gemini: 'GEMINI.md'
  }
  // Per-chat terminal toggle, keyed by session id so each chat remembers its own state.
  const [termOpenById, setTermOpenById] = useState<Record<string, boolean>>({})
  // Fall back to the "open new chats in" pref for sessions not yet in the map, so a
  // brand-new terminal session renders the terminal on its first paint instead of
  // flashing the chat welcome/picker screen while the seeding effect below catches up.
  const termOpen = !!session && (session.id in termOpenById
    ? termOpenById[session.id]
    : defaultChatView === 'terminal')
  const toggleTerminal = () => {
    if (!session) return
    setTermOpenById((prev) => ({ ...prev, [session.id]: !prev[session.id] }))
  }
  // Seed a session's terminal state from the "default view" pref the first time it's seen.
  useEffect(() => {
    if (!session) return
    if (session.id in termOpenById) return
    setTermOpenById((prev) => ({ ...prev, [session.id]: defaultChatView === 'terminal' }))
  }, [session, defaultChatView, termOpenById])
  // When App deliberately moves you to a new chat, show the composer even if the "open new
  // chats in" pref says Terminal. Otherwise the jump is invisible: you were looking at a
  // terminal and you'd still be looking at one, so switching account appears to do nothing.
  // Runs on nonce changes only — a plain chat switch keeps whatever pane that chat was on.
  useEffect(() => {
    if (!session || newChatNonce === 0) return
    setTermOpenById((prev) => ({ ...prev, [session.id]: false }))
    // …and put the caret in the composer. The accent sweep that goes with it is driven by
    // remounting the band (see the composer markup), not from here.
    textareaRef.current?.focus()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [newChatNonce])
  const [input, setInput] = useState('')
  const [attachments, setAttachments] = useState<Attachment[]>([])
  // Transient inline feedback (e.g. rejected attachment); clears itself after ~4s.
  const [attachNotice, setAttachNotice] = useState<string | null>(null)
  // True while files are being dragged over the chat, to show the drop overlay.
  const [dragging, setDragging] = useState(false)
  // dragenter/dragleave fire per descendant; count them so the overlay only clears
  // once the pointer has truly left the chat root.
  const dragDepth = useRef(0)
  const bottomRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const pickerListRef = useRef<HTMLDivElement>(null)

  // ── Slash-command picker ──────────────────────────────────────────────────
  const [slashCommands, setSlashCommands] = useState<SlashCommand[]>([])
  const [pickerOpen, setPickerOpen] = useState(false)
  const [pickerActive, setPickerActive] = useState(0)

  // Fetch command list whenever the project path changes.
  useEffect(() => {
    let cancelled = false
    window.electronAPI.commandsList(session?.projectPath).then((cmds) => {
      if (!cancelled) setSlashCommands(cmds)
    }).catch(() => { /* ignore */ })
    return () => { cancelled = true }
  }, [session?.projectPath])

  // Compute the query string after the leading slash (first word only).
  const slashQuery = (() => {
    if (!input.startsWith('/')) return null
    // Only show picker before the user has added a space + args
    const space = input.indexOf(' ')
    if (space !== -1) return null
    return input.slice(1).toLowerCase()
  })()

  // Filtered list based on what they've typed after '/'.
  const pickerItems = slashQuery !== null
    ? slashCommands.filter((c) =>
        slashQuery === '' || c.name.toLowerCase().includes(slashQuery) ||
        (c.description ?? '').toLowerCase().includes(slashQuery)
      )
    : []

  // Open/close the picker; reset selection to 0 on every open.
  useEffect(() => {
    const shouldOpen = slashQuery !== null && pickerItems.length > 0
    setPickerOpen(shouldOpen)
    if (shouldOpen) setPickerActive(0)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slashQuery])

  // Keep the active index in bounds when the filtered list shrinks.
  useEffect(() => {
    if (pickerItems.length > 0) {
      setPickerActive((prev) => (prev >= pickerItems.length ? pickerItems.length - 1 : prev))
    }
    if (pickerItems.length === 0) setPickerOpen(false)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pickerItems.length])

  // Scroll active item into view.
  useEffect(() => {
    const el = pickerListRef.current?.querySelector('.slash-picker-item.active') as HTMLElement | null
    el?.scrollIntoView({ block: 'nearest' })
  }, [pickerActive])

  const acceptPickerItem = (item: SlashCommand) => {
    const insertion = item.kind === 'skill'
      ? `Use the "${item.name}" skill to `
      : `/${item.name} `
    setInput(insertion)
    setPickerOpen(false)
    setTimeout(() => textareaRef.current?.focus(), 0)
  }

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [session?.messages])

  const handleCopyMarkdown = () => {
    if (!session) return
    navigator.clipboard.writeText(sessionToMarkdown(session)).then(() => {
      // Keep the dropdown open long enough for the "Copied ✓" label to be seen,
      // then close it (closing immediately would hide the only feedback).
      setMarkdownCopied(true)
      setTimeout(() => {
        setMarkdownCopied(false)
        setExportMenuOpen(false)
      }, 1200)
    })
  }

  const handleSaveMarkdown = async () => {
    if (!session) return
    const md = sessionToMarkdown(session)
    const result = await window.electronAPI.exportMarkdown(session.name || 'chat', md)
    if (result.saved) {
      setMarkdownSaved(true)
      setTimeout(() => setMarkdownSaved(false), 1500)
    }
  }

  const handleSend = () => {
    if (streaming) {
      onStop()
      return
    }
    const text = input.trim()
    if (!text && attachments.length === 0) return
    const images = attachments
      .filter((a): a is Extract<Attachment, { kind: 'image' }> => a.kind === 'image')
      .map((a) => ({ mediaType: a.mediaType, data: a.data }))
    const files = attachments
      .filter((a): a is Extract<Attachment, { kind: 'file' }> => a.kind === 'file')
      .map((a) => ({ name: a.name, content: a.content }))
    setInput('')
    setAttachments([])
    resetTextareaHeight()
    // Sensible fallback prompt when the user attaches without typing.
    const fallback = images.length ? 'Describe these image(s).' : 'See the attached file(s).'
    onSendMessage(
      text || fallback,
      images.length ? images : undefined,
      files.length ? files : undefined
    )
  }

  // Show a brief red notice above the input; auto-clears after ~4s.
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const showNotice = (msg: string) => {
    setAttachNotice(msg)
    if (noticeTimer.current) clearTimeout(noticeTimer.current)
    noticeTimer.current = setTimeout(() => setAttachNotice(null), 4000)
  }

  // Route each incoming file: images go through the existing base64 image path; anything
  // else is read as text and attached as a file chip. Enforce limits (max 5 files, 200 KB
  // each) and reject likely-binary content at add time.
  const addFiles = (files: FileList | File[]) => {
    // Reserve remaining file slots up front (reads are async, so count optimistically).
    let fileSlots = MAX_FILE_ATTACHMENTS - attachments.filter((a) => a.kind === 'file').length
    for (const file of Array.from(files)) {
      if (file.type.startsWith('image/')) {
        const reader = new FileReader()
        reader.onload = () => {
          const result = reader.result as string
          const data = result.split(',')[1] ?? ''
          setAttachments((prev) => [...prev, { kind: 'image', mediaType: file.type, data, preview: result }])
        }
        reader.readAsDataURL(file)
        continue
      }
      const ext = file.name.includes('.') ? file.name.split('.').pop()!.toLowerCase() : ''
      if (BINARY_EXTENSIONS.has(ext)) {
        showNotice(`Can't attach "${file.name}" — looks like a binary file.`)
        continue
      }
      if (file.size > MAX_FILE_BYTES) {
        showNotice(`"${file.name}" is too large (max ${formatSize(MAX_FILE_BYTES)}).`)
        continue
      }
      if (fileSlots <= 0) {
        showNotice(`Only ${MAX_FILE_ATTACHMENTS} files can be attached per message.`)
        break
      }
      fileSlots--
      const reader = new FileReader()
      reader.onload = () => {
        const content = reader.result as string
        // NUL byte ⇒ almost certainly binary content that slipped past the denylist.
        if (content.includes(String.fromCharCode(0))) {
          showNotice(`Can't attach "${file.name}" — looks like a binary file.`)
          return
        }
        setAttachments((prev) => [...prev, { kind: 'file', name: file.name, size: file.size, content }])
      }
      reader.readAsText(file)
    }
  }

  const handlePaste = (e: React.ClipboardEvent) => {
    const imageItems = Array.from(e.clipboardData.items).filter((i) => i.type.startsWith('image/'))
    if (imageItems.length === 0) return
    e.preventDefault()
    addFiles(imageItems.map((i) => i.getAsFile()).filter((f): f is File => !!f))
  }

  // ── Drag & drop files onto the chat ────────────────────────────────────────
  const dndActive = ready && !streaming
  const dragHasFiles = (e: React.DragEvent) => Array.from(e.dataTransfer.types).includes('Files')
  const handleDragEnter = (e: React.DragEvent) => {
    if (!dndActive || !dragHasFiles(e)) return
    e.preventDefault()
    dragDepth.current += 1
    setDragging(true)
  }
  const handleDragOver = (e: React.DragEvent) => {
    if (!dndActive || !dragHasFiles(e)) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
  }
  const handleDragLeave = (e: React.DragEvent) => {
    if (!dragHasFiles(e)) return
    dragDepth.current = Math.max(0, dragDepth.current - 1)
    if (dragDepth.current === 0) setDragging(false)
  }
  const handleDrop = (e: React.DragEvent) => {
    dragDepth.current = 0
    setDragging(false)
    if (!dragHasFiles(e)) return
    // Prevent the browser from navigating away to the dropped file.
    e.preventDefault()
    if (!dndActive) return
    if (e.dataTransfer.files.length) addFiles(e.dataTransfer.files)
  }

  const removeAttachment = (idx: number) => {
    setAttachments((prev) => prev.filter((_, i) => i !== idx))
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (pickerOpen) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setPickerActive((a) => Math.min(a + 1, pickerItems.length - 1))
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setPickerActive((a) => Math.max(a - 1, 0))
        return
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault()
        // Don't accept during IME composition (keyCode 229 is the IME sentinel)
        if (e.nativeEvent.isComposing || e.keyCode === 229) return
        const item = pickerItems[pickerActive]
        if (item) acceptPickerItem(item)
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        setPickerOpen(false)
        return
      }
    }
    // Don't send during IME composition
    if (e.key === 'Enter' && !e.shiftKey && !streaming && !e.nativeEvent.isComposing && e.keyCode !== 229) {
      e.preventDefault()
      handleSend()
    }
  }

  // Close the picker when the textarea loses focus (e.g. user clicks elsewhere).
  // Use a short delay so a click on a picker item fires its onClick before the list unmounts.
  const handleBlur = () => {
    setTimeout(() => setPickerOpen(false), 150)
  }

  const handleInput = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setInput(e.target.value)
    const ta = e.target
    ta.style.height = 'auto'
    ta.style.height = Math.min(ta.scrollHeight, 200) + 'px'
  }

  const resetTextareaHeight = () => {
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto'
    }
  }

  const isEmpty = !session || session.messages.length === 0

  const formatTokens = (n: number): string => {
    if (n >= 1000) return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k'
    return String(n)
  }

  // Headline counts only input+output — cache traffic dwarfs them and reads as
  // "tokens spent" when it's mostly cheap re-reads; the tooltip keeps the breakdown.
  const ioTokens = (session?.inputTokens ?? 0) + (session?.outputTokens ?? 0)
  const cacheTokens = (session?.cacheReadTokens ?? 0) + (session?.cacheCreationTokens ?? 0)

  // Real context footprint (last-turn input + cache). null on old sessions w/o usage.
  const ctxTokens = contextTokens(session)
  const ctxColor =
    ctxTokens != null && ctxTokens >= 150_000
      ? 'var(--error)'
      : ctxTokens != null && ctxTokens >= 100_000
        ? '#e2b341'
        : undefined
  // The single cost/context readout under the composer — the header chip and the separate
  // context indicator both folded into this one. Shown whenever there's any usage at all.
  const showUsageReadout = !!session && ((session.costUsd ?? 0) > 0 || ioTokens + cacheTokens > 0)
  const usageTooltip = session
    ? [
        `Input: ${formatTokens(session.inputTokens ?? 0)} tok`,
        `Output: ${formatTokens(session.outputTokens ?? 0)} tok`,
        `Cache read: ${formatTokens(session.cacheReadTokens ?? 0)} tok`,
        `Cache write: ${formatTokens(session.cacheCreationTokens ?? 0)} tok`,
        '',
        'Context is the approximate payload re-sent on each turn (last turn\'s input + cache tokens). Compact the chat to shrink it.'
      ].join('\n')
    : undefined

  // Warn on real context when we have it; fall back to message count for old sessions.
  const showLongSessionBanner =
    (ctxTokens != null ? ctxTokens >= 120_000 : !!session && session.messages.length >= 40) &&
    !!session &&
    !dismissedBanners[session.id]

  // Title block: session name plus one quiet meta line replacing the header adornments.
  const hasTitleMeta = !!(session?.agentName || session?.remoteHostName || session?.claudeSessionId)
  const titleBlock = session && (
    <div className="chat-title-block">
      <div className="chat-title-name">{session.name || 'New chat'}</div>
      {hasTitleMeta && (
        <div className="chat-title-meta">
          {session.agentName && <span title="Agent this chat runs as">{session.agentName}</span>}
          {session.remoteHostName && (
            <span title="Running on remote host over SSH">⇄ {session.remoteHostName}</span>
          )}
          {session.claudeSessionId && <span title="Resumed Claude Code session">resumed</span>}
        </div>
      )}
    </div>
  )

  return (
    <div
      className="chat"
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {dragging && (
        <div className="chat-drop-overlay">
          <div className="chat-drop-inner">
            <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <polyline points="7 10 12 15 17 10" />
              <line x1="12" y1="15" x2="12" y2="3" />
            </svg>
            <span>Drop files to attach</span>
          </div>
        </div>
      )}
      {/* Floating action cluster over the transcript. Hidden while the embedded terminal
          is open: it would float over xterm's own surface, and ChatTerminal already
          renders its own close control to get you back to the chat. */}
      {!termOpen && (
        <div className={`chat-float-actions ${exportMenuOpen ? 'open' : ''}`}>
          <button
            className={`header-icon-btn ${termOpen ? 'term-active' : ''}`}
            onClick={toggleTerminal}
            title="Terminal for this chat"
            aria-label="Terminal for this chat"
            aria-pressed={termOpen}
            disabled={!session}
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <rect x="2" y="4" width="20" height="16" rx="2" />
              <polyline points="6 9 10 12 6 15" />
              <line x1="12" y1="15" x2="16" y2="15" />
            </svg>
          </button>
          <div className="header-menu-wrap" style={{ position: 'relative' }}>
            <button
              className="header-icon-btn"
              onClick={() => setExportMenuOpen((v) => !v)}
              title="More"
              aria-label="More"
              aria-haspopup="menu"
              aria-expanded={exportMenuOpen}
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <circle cx="5" cy="12" r="1" /><circle cx="12" cy="12" r="1" /><circle cx="19" cy="12" r="1" />
              </svg>
            </button>
            {exportMenuOpen && (
              <div className="header-menu-dropdown" onMouseLeave={() => setExportMenuOpen(false)}>
                <button disabled={isEmpty} onClick={() => { setExportMenuOpen(false); handleSaveMarkdown() }}>
                  {markdownSaved ? 'Saved ✓' : 'Export as .md'}
                </button>
                <button disabled={isEmpty} onClick={handleCopyMarkdown}>
                  {markdownCopied ? 'Copied ✓' : 'Copy as Markdown'}
                </button>
                <button disabled={isEmpty} onClick={() => { setExportMenuOpen(false); onExportSession('html') }}>Export as HTML</button>
                <div className="header-menu-divider" />
                <button onClick={() => { setExportMenuOpen(false); onOpenGit() }}>Git…</button>
                <button onClick={() => { setExportMenuOpen(false); onOpenCheckpoints() }}>Checkpoints…</button>
                <button onClick={() => { setExportMenuOpen(false); onOpenClaudeMd() }}>Edit {CONTEXT_FILE[activeProvider]}</button>
              </div>
            )}
          </div>
        </div>
      )}

      <div className="chat-messages" style={termOpen ? { display: 'none' } : undefined}>
        {isEmpty ? (
          <div className="chat-empty">
            {titleBlock}
            <div className="welcome">
              <div className="welcome-icon">
                <svg width="40" height="40" viewBox="0 0 24 24" fill="none">
                  <circle cx="12" cy="12" r="10" stroke="var(--accent)" strokeWidth="1" />
                  <path d="M8 12h8M12 8v8" stroke="var(--accent)" strokeWidth="1.5" strokeLinecap="round" />
                </svg>
              </div>
              <h2>What&rsquo;s up next?</h2>
              <p>Set the folder, environment, and any extra directories below, then describe a task to get started.</p>
            </div>
          </div>
        ) : (
          <>
            {titleBlock}
            {session!.messages.map((msg, idx) => {
              const isLast = idx === session!.messages.length - 1
              const showBranchDivider = session!.branchedFrom?.atMessageId === msg.id
              return (
                <Fragment key={msg.id}>
                  <MessageBubble
                    message={msg}
                    streaming={streaming && isLast && msg.role === 'assistant'}
                    onRetry={isLast && msg.role === 'assistant' && msg.error ? onRetry : undefined}
                    onEditResend={onEditResend}
                    onBranch={onBranch}
                  />
                  {showBranchDivider && (
                    <div className="branch-divider" role="separator">
                      <span className="branch-divider-mark" aria-hidden="true">&#9090;</span>
                      branched from &ldquo;{session!.branchedFrom!.name}&rdquo; here
                    </div>
                  )}
                </Fragment>
              )
            })}
          </>
        )}
        <div ref={bottomRef} />
      </div>

      {session && termOpen && (
        <Suspense fallback={null}>
          <ChatTerminal
            key={session.id}
            terminalId={`chatterm_${session.id}`}
            cwd={session.projectPath}
            accountId={terminalAccountId}
            provider={terminalProvider}
            wslDistro={session.wslDistro}
            remoteHostId={session.remoteHostId}
            resumeSessionId={session.claudeSessionId}
            onClose={toggleTerminal}
            onActive={() => {
              if (!session.hasTerminalActivity) onPatchSession({ hasTerminalActivity: true })
            }}
          />
        </Suspense>
      )}

      <div className="chat-input-area" style={termOpen ? { display: 'none' } : undefined}>
      <div className="chat-input-column">
        {session && showLongSessionBanner && (
          <div className="long-session-banner">
            <span className="long-session-text">
              {ctxTokens != null ? (
                <>
                  This chat's context is ~{formatTokens(ctxTokens)} tokens — the whole history is
                  re-sent every turn, which burns quota. Compact it or start fresh.
                </>
              ) : (
                <>
                  This chat has {session.messages.length} messages — the whole history is re-sent
                  every turn, which burns tokens. Compact it or start fresh.
                </>
              )}
            </span>
            <div className="long-session-actions">
              <button onClick={onCompact} disabled={compacting}>
                {compacting ? 'Compacting…' : 'Compact'}
              </button>
              <button onClick={onStartFresh} disabled={compacting}>
                Start fresh
              </button>
              <button
                className="long-session-dismiss"
                onClick={() => setDismissedBanners((prev) => ({ ...prev, [session.id]: true }))}
                title="Dismiss"
                aria-label="Dismiss this warning"
              >
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" aria-hidden="true">
                  <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            </div>
          </div>
        )}
        {attachNotice && <div className="attach-notice">{attachNotice}</div>}
        {attachments.length > 0 && (
          <div className="attachments">
            {attachments.map((a, i) =>
              a.kind === 'image' ? (
                <div className="attachment" key={i}>
                  <img src={a.preview} alt="attachment" />
                  <button className="attachment-remove" onClick={() => removeAttachment(i)} title="Remove" aria-label="Remove attachment">
                    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" aria-hidden="true">
                      <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
                    </svg>
                  </button>
                </div>
              ) : (
                <div className="file-chip" key={i} title={`${a.name} · ${formatSize(a.size)}`}>
                  <svg className="file-chip-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                    <polyline points="14 2 14 8 20 8" />
                  </svg>
                  <span className="file-chip-name">{middleEllipsis(a.name)}</span>
                  <span className="file-chip-size">{formatSize(a.size)}</span>
                  <button className="file-chip-remove" onClick={() => removeAttachment(i)} title="Remove" aria-label="Remove attachment">
                    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" aria-hidden="true">
                      <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
                    </svg>
                  </button>
                </div>
              )
            )}
          </div>
        )}
        {/* The composer as one unit — input plus the options row — so the new-chat sweep
            crosses the whole thing instead of just the strip of chips. */}
        <div className="composer-shell">
        {/* Keyed on the nonce so every New chat press mounts a fresh band and therefore
            restarts the sweep. Toggling a class instead silently no-ops whenever the class
            is still applied from a previous press, which left the highlight dead after the
            first couple of presses. */}
        <span className="composer-sheen" aria-hidden="true">
          {newChatNonce > 0 && <span key={newChatNonce} className="composer-sheen-band" />}
        </span>
        <div className="input-wrapper">
          {pickerOpen && (
            <div className="slash-picker" role="listbox" aria-label="Slash commands">
              <div className="slash-picker-list" ref={pickerListRef}>
                {pickerItems.length === 0 ? (
                  <div className="slash-picker-empty">No matches</div>
                ) : (
                  pickerItems.map((item, i) => (
                    <div
                      key={`${item.kind}:${item.scope}:${item.name}`}
                      className={`slash-picker-item${i === pickerActive ? ' active' : ''}`}
                      role="option"
                      aria-selected={i === pickerActive}
                      onMouseEnter={() => setPickerActive(i)}
                      onClick={() => acceptPickerItem(item)}
                    >
                      <span className="slash-picker-name">/{item.name}</span>
                      {item.description && (
                        <span className="slash-picker-desc">{item.description}</span>
                      )}
                      <span className="slash-picker-badges">
                        <span className={`slash-badge slash-badge-kind-${item.kind}`}>
                          {item.kind}
                        </span>
                        {item.scope === 'project' && (
                          <span className="slash-badge slash-badge-scope-project">project</span>
                        )}
                      </span>
                    </div>
                  ))
                )}
              </div>
              <div className="slash-picker-foot">
                <span>↑↓ navigate</span>
                <span>↵ Tab accept</span>
                <span>esc dismiss</span>
              </div>
            </div>
          )}
          <input
            ref={fileInputRef}
            type="file"
            multiple
            style={{ display: 'none' }}
            onChange={(e) => {
              if (e.target.files) addFiles(e.target.files)
              // Reset so picking the same file again re-fires onChange.
              e.target.value = ''
            }}
          />
          <button
            className="attach-btn"
            onClick={() => fileInputRef.current?.click()}
            disabled={!ready || streaming}
            title="Attach image or file"
            aria-label="Attach image or file"
          >
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
            </svg>
          </button>
          {/* Placeholder stays provider-neutral: a chat runs on Codex or Gemini just as
              readily as on Claude, and the chip row below already names the model. */}
          <textarea
            ref={textareaRef}
            className="chat-input"
            placeholder={ready ? 'Describe a task or ask a question…  (paste images or drop/attach files)' : 'Connect your account in Settings to start'}
            value={input}
            onChange={handleInput}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            onBlur={handleBlur}
            rows={1}
            disabled={!ready}
          />
          <button
            className={`send-btn ${streaming ? 'stop' : input.trim() || attachments.length ? 'active' : ''}`}
            onClick={handleSend}
            disabled={(!input.trim() && attachments.length === 0 && !streaming) || !ready}
            title={streaming ? 'Stop' : 'Send (Enter)'}
            aria-label={streaming ? 'Stop' : 'Send'}
          >
            {streaming ? (
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
                <rect x="6" y="6" width="12" height="12" rx="2" />
              </svg>
            ) : (
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <line x1="22" y1="2" x2="11" y2="13" />
                <polygon points="22 2 15 22 11 13 2 9 22 2" />
              </svg>
            )}
          </button>
        </div>

        {/* Persistent chip row under the composer: where the chat runs (ChatConfigBar) plus
            the model / mode controls that used to live in the header. Connect account leads
            because it's the only path to a working app — it must never be hover-only. */}
        <div className="composer-chips">
          {!ready && (
            <button className="header-btn warning chip-connect" onClick={onOpenSettings}>
              Connect account
            </button>
          )}
          {session && <ChatConfigBar session={session} onPatch={onPatchSession} disabled={!ready} />}
          <div className="composer-chips-right">
            {models.some((m) => m.provider === activeProvider) && (
              <ModelPicker
                models={models.filter((m) => m.provider === activeProvider)}
                value={currentModel}
                onChange={onModelChange}
                compact
              />
            )}
            <div className="chip-toggle-group">
              <button
                className={`approve-toggle ${autoApprove ? 'auto' : 'ask'}`}
                onClick={onToggleAutoApprove}
                title={autoApprove ? 'Auto-approving all tools — click to require approval' : 'Asking before file edits & commands — click to auto-approve'}
                aria-label={autoApprove ? 'Auto-approving all tools — click to require approval' : 'Asking before file edits & commands — click to auto-approve'}
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  {autoApprove ? (
                    <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" />
                  ) : (
                    <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
                  )}
                </svg>
                {autoApprove ? 'Auto' : 'Approve'}
              </button>
              <button
                className={`approve-toggle ${lightMode ? 'auto' : 'ask'}`}
                onClick={onToggleLightMode}
                title={
                  lightMode
                    ? 'Light mode ON — no tools sent (cheapest for plain chat). Click to enable tools.'
                    : 'Tools enabled. Click for Light mode: no tools, fewer tokens per turn (best for plain Q&A).'
                }
                aria-label="Toggle light (no-tools) chat mode"
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" />
                </svg>
                {lightMode ? 'Light' : 'Full'}
              </button>
            </div>
          </div>
        </div>
        </div>

        {/* The one place cost/context is stated. Keyboard hint only on a fresh chat. */}
        {(isEmpty || showUsageReadout) && (
          <div className="input-hint">
            {isEmpty && <span>Enter to send · Shift+Enter for newline</span>}
            {showUsageReadout && (
              <span
                className="usage-readout"
                style={ctxColor ? { color: ctxColor } : undefined}
                title={usageTooltip}
              >
                {ctxTokens != null && `${formatTokens(ctxTokens)} ctx · `}
                ${(session!.costUsd ?? 0) < 0.01
                  ? (session!.costUsd ?? 0).toFixed(4)
                  : (session!.costUsd ?? 0).toFixed(2)}
              </span>
            )}
          </div>
        )}
      </div>
      </div>
    </div>
  )
}
