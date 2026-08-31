import { useState, useRef } from 'react'
import { AskDecision, Message, ToolCall } from '../types'
import Markdown from './Markdown'
import DiffView, { highlightBlock } from './DiffView'
import './MessageBubble.css'

function CopyMessage({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)
  if (!text) return null
  const copy = () => {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    })
  }
  return (
    <button className="message-copy" onClick={copy} title="Copy message">
      {copied ? (
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <polyline points="20 6 9 17 4 12" />
        </svg>
      ) : (
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
          <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
        </svg>
      )}
      {copied ? 'Copied' : 'Copy'}
    </button>
  )
}


/**
 * A choice the owner made mid-task, drawn as one.
 *
 * The exchange is recorded as a tool call and its result, which is why a viewer
 * that knows only about tools prints a decision of his in grey monospace with
 * nobody's name on it. What he picked is in the open; what he turned down is one
 * disclosure away — "what were the alternatives" is often what you come back for,
 * but not at first glance.
 */
function DecisionBlock({ decisions }: { decisions: AskDecision[] }) {
  return (
    <div className="decision-block">
      {decisions.map((d, i) => (
        <div key={i} className="decision-section">
          <div className="decision-head">
            Decision{d.header ? <span className="decision-topic"> · {d.header}</span> : null}
          </div>
          <div className="decision-question">{d.question}</div>
          {d.chosen.map((c) => (
            <div key={c} className="decision-chosen">
              <span className="decision-tick" aria-hidden="true">✓</span>
              {c}
            </div>
          ))}
          {d.custom && (
            <div className="decision-chosen">
              <span className="decision-tick" aria-hidden="true">✓</span>
              {d.custom}
              <span className="decision-own">written in</span>
            </div>
          )}
          {d.rejected.length > 0 && (
            <details className="decision-rejected">
              <summary>
                {d.rejected.length} option{d.rejected.length === 1 ? '' : 's'} not taken
              </summary>
              {d.rejected.map((r) => (
                <div key={r} className="decision-rejected-item">{r}</div>
              ))}
            </details>
          )}
        </div>
      ))}
    </div>
  )
}

interface Props {
  message: Message
  streaming: boolean
  /** Defined only on the last assistant message when it ended in an error. */
  onRetry?: () => void
  onEditResend: (messageId: string, newText: string) => void
  /** Fork a new session from this message point. Present when branching is available. */
  onBranch?: (messageId: string) => void
}

function summarizeInput(input: unknown): string {
  if (input && typeof input === 'object') {
    const obj = input as Record<string, unknown>
    const primary =
      obj.file_path ?? obj.path ?? obj.command ?? obj.pattern ?? obj.query ?? obj.url
    if (primary) return String(primary)
    return Object.keys(obj).length ? JSON.stringify(obj).slice(0, 80) : ''
  }
  return input ? String(input).slice(0, 80) : ''
}

/** String coercion, mirroring ApprovalModal's `str()` — never throws on odd shapes. */
function str(v: unknown): string {
  return typeof v === 'string' ? v : v == null ? '' : String(v)
}

/** Safely reads `input` as a plain object; returns {} for anything else so callers never crash. */
function asObj(input: unknown): Record<string, unknown> {
  return input && typeof input === 'object' && !Array.isArray(input)
    ? (input as Record<string, unknown>)
    : {}
}

function basename(p: string): string {
  if (!p) return p
  const parts = p.split(/[\\/]/)
  return parts[parts.length - 1] || p
}

const RESULT_TRUNCATE = 2000

/** Truncation-aware body for plain-text results. Optionally renders as highlighted HTML. */
function ToolResultBody({
  result,
  highlightHtml
}: {
  result: string
  /** Pre-rendered highlighted HTML for the (possibly truncated) visible slice. */
  highlightHtml?: (visible: string) => string
}) {
  const [expanded, setExpanded] = useState(false)
  const render = (text: string) =>
    highlightHtml ? (
      // eslint-disable-next-line react/no-danger
      <pre className="hljs" dangerouslySetInnerHTML={{ __html: highlightHtml(text) }} />
    ) : (
      <pre>{text || '(no output)'}</pre>
    )
  if (result.length <= RESULT_TRUNCATE) {
    return render(result)
  }
  if (expanded) {
    return (
      <>
        {render(result)}
        <button className="tool-result-toggle" onClick={() => setExpanded(false)}>
          Show less
        </button>
      </>
    )
  }
  const remaining = result.length - RESULT_TRUNCATE
  return (
    <>
      {render(result.slice(0, RESULT_TRUNCATE))}
      <button className="tool-result-toggle" onClick={() => setExpanded(true)}>
        Show full output ({remaining.toLocaleString()} more chars)
      </button>
    </>
  )
}

/** Same truncation behavior as ToolResultBody, but renders each line as a list item. */
function ToolResultLines({ result }: { result: string }) {
  const [expanded, setExpanded] = useState(false)
  const lines = result.split('\n')
  const LINE_LIMIT = 60
  const visible = expanded ? lines : lines.slice(0, LINE_LIMIT)
  if (!result.trim()) return <pre>(no output)</pre>
  return (
    <>
      <ul className="tool-result-lines">
        {visible.map((line, i) => (
          <li key={i}>{line || ' '}</li>
        ))}
      </ul>
      {lines.length > LINE_LIMIT && !expanded && (
        <button className="tool-result-toggle" onClick={() => setExpanded(true)}>
          Show all {lines.length.toLocaleString()} lines
        </button>
      )}
      {lines.length > LINE_LIMIT && expanded && (
        <button className="tool-result-toggle" onClick={() => setExpanded(false)}>
          Show less
        </button>
      )}
    </>
  )
}

/** Raw JSON input, tucked away for debugging — collapsed by default in rich renderers. */
function RawInputDetails({ input }: { input: unknown }) {
  return (
    <details className="tool-raw-input">
      <summary>Raw input</summary>
      <pre>{JSON.stringify(input, null, 2)}</pre>
    </details>
  )
}

const WRENCH_PATH =
  'M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z'

function Icon({ children }: { children: React.ReactNode }) {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      {children}
    </svg>
  )
}

/** Per-tool icon. Falls back to the generic wrench for anything unrecognized. */
function ToolIcon({ tool }: { tool: string }) {
  switch (tool) {
    case 'Edit':
    case 'MultiEdit':
      return (
        <Icon>
          <path d="M12 20h9" />
          <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z" />
        </Icon>
      )
    case 'Write':
      return (
        <Icon>
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
          <polyline points="14 2 14 8 20 8" />
        </Icon>
      )
    case 'Read':
      return (
        <Icon>
          <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
          <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
        </Icon>
      )
    case 'Bash':
      return (
        <Icon>
          <polyline points="4 17 10 11 4 5" />
          <line x1="12" y1="19" x2="20" y2="19" />
        </Icon>
      )
    case 'Grep':
    case 'Glob':
      return (
        <Icon>
          <circle cx="11" cy="11" r="7" />
          <line x1="21" y1="21" x2="16.65" y2="16.65" />
        </Icon>
      )
    case 'WebFetch':
    case 'WebSearch':
      return (
        <Icon>
          <circle cx="12" cy="12" r="9" />
          <path d="M3 12h18M12 3a15 15 0 0 1 0 18 15 15 0 0 1 0-18z" />
        </Icon>
      )
    default:
      return <Icon><path d={WRENCH_PATH} /></Icon>
  }
}

type ToolKind = 'file-edit' | 'read' | 'search' | 'bash' | 'web' | 'other'

function kindOf(tool: string): ToolKind {
  if (tool === 'Edit' || tool === 'MultiEdit' || tool === 'Write') return 'file-edit'
  if (tool === 'Read') return 'read'
  if (tool === 'Grep' || tool === 'Glob') return 'search'
  if (tool === 'Bash') return 'bash'
  if (tool === 'WebFetch' || tool === 'WebSearch') return 'web'
  return 'other'
}

/** One-line summary shown in the collapsed row, tailored per tool. */
function summaryFor(tool: string, input: unknown): { text: string; title?: string } {
  const obj = asObj(input)
  switch (tool) {
    case 'Edit':
    case 'Write':
    case 'MultiEdit':
    case 'Read': {
      const path = str(obj.file_path ?? obj.path)
      return path ? { text: basename(path), title: path } : { text: summarizeInput(input) }
    }
    case 'Bash': {
      const cmd = str(obj.command)
      return { text: cmd.length > 80 ? cmd.slice(0, 80) + '…' : cmd, title: cmd }
    }
    case 'Grep':
    case 'Glob': {
      const pattern = str(obj.pattern)
      return pattern ? { text: pattern, title: pattern } : { text: summarizeInput(input) }
    }
    case 'WebFetch':
    case 'WebSearch': {
      const target = str(obj.url ?? obj.query)
      return target ? { text: target, title: target } : { text: summarizeInput(input) }
    }
    default:
      return { text: summarizeInput(input) }
  }
}

/** Edit/MultiEdit/Write body — one or more diffs against the file's current content. */
function FileEditBody({ tool, input }: { tool: string; input: unknown }) {
  const obj = asObj(input)
  const filePath = str(obj.file_path ?? obj.path)
  if (tool === 'Write') {
    return <DiffView oldText="" newText={str(obj.content)} filePath={filePath} />
  }
  if (tool === 'MultiEdit' && Array.isArray(obj.edits)) {
    return (
      <div className="tool-multi-edit">
        {(obj.edits as { old_string?: string; new_string?: string }[]).map((e, i) => (
          <div key={i} className="tool-multi-edit-item">
            <div className="tool-call-section-label">Edit {i + 1}</div>
            <DiffView oldText={str(e?.old_string)} newText={str(e?.new_string)} filePath={filePath} />
          </div>
        ))}
      </div>
    )
  }
  if (tool === 'Edit' && ('old_string' in obj || 'new_string' in obj)) {
    return <DiffView oldText={str(obj.old_string)} newText={str(obj.new_string)} filePath={filePath} />
  }
  return null
}

/** Bash body — terminal-styled command line plus its output. */
function BashBody({ input, result, isError }: { input: unknown; result?: string; isError?: boolean }) {
  const obj = asObj(input)
  const command = str(obj.command)
  const description = str(obj.description)
  return (
    <div className="tool-bash">
      <div className="tool-bash-cmd">
        <span className="tool-bash-prompt">❯</span>
        <pre>{command}</pre>
      </div>
      {description && <div className="tool-bash-desc">{description}</div>}
      {result !== undefined && (
        <>
          <div className="tool-call-section-label">{isError ? 'Error' : 'Output'}</div>
          <div className="tool-bash-output">
            <ToolResultBody result={result} />
          </div>
        </>
      )}
    </div>
  )
}

function ToolCallView({ call }: { call: ToolCall }) {
  const kind = kindOf(call.tool)
  const { text: summaryText, title: summaryTitle } = summaryFor(call.tool, call.input)
  const obj = asObj(call.input)
  const filePath = str(obj.file_path ?? obj.path)

  const renderRichBody = (): React.ReactNode => {
    if (kind === 'file-edit') {
      // A JSX element is always truthy, so gate on the input shape itself; anything
      // unrecognized falls through to the generic JSON view.
      const matches =
        call.tool === 'Write'
          ? 'content' in obj
          : call.tool === 'MultiEdit'
            ? Array.isArray(obj.edits)
            : 'old_string' in obj || 'new_string' in obj
      if (!matches) return null
      return (
        <>
          <FileEditBody tool={call.tool} input={call.input} />
          {call.isError && call.result !== undefined && (
            <>
              <div className="tool-call-section-label">Error</div>
              <ToolResultBody result={call.result} />
            </>
          )}
          <RawInputDetails input={call.input} />
        </>
      )
    }
    if (call.tool === 'Bash') {
      return <BashBody input={call.input} result={call.result} isError={call.isError} />
    }
    if (call.tool === 'Read' && call.result !== undefined) {
      return (
        <>
          <ToolResultBody result={call.result} highlightHtml={(text) => highlightBlock(text, filePath)} />
          <RawInputDetails input={call.input} />
        </>
      )
    }
    if ((call.tool === 'Grep' || call.tool === 'Glob') && call.result !== undefined) {
      return (
        <>
          <div className="tool-call-section-label">{call.isError ? 'Error' : 'Result'}</div>
          <ToolResultLines result={call.result} />
          <RawInputDetails input={call.input} />
        </>
      )
    }
    return null
  }

  const richBody = renderRichBody()

  return (
    <details className={`tool-call kind-${kind} ${call.isError ? 'error' : ''}`}>
      <summary>
        <span className="tool-call-icon">
          <ToolIcon tool={call.tool} />
        </span>
        <span className="tool-call-name">{call.tool}</span>
        <span className="tool-call-arg" title={summaryTitle}>{summaryText}</span>
        {call.result === undefined && <span className="tool-call-spin" />}
      </summary>
      <div className="tool-call-detail">
        {richBody ?? (
          <>
            <div className="tool-call-section-label">Input</div>
            <pre>{JSON.stringify(call.input, null, 2)}</pre>
            {call.result !== undefined && (
              <>
                <div className="tool-call-section-label">{call.isError ? 'Error' : 'Result'}</div>
                <ToolResultBody result={call.result} />
              </>
            )}
          </>
        )}
      </div>
    </details>
  )
}

/** Singular/plural label per tool kind, in the order they appear in the summary line. */
const KIND_LABELS: { kind: ToolKind; one: string; many: string }[] = [
  { kind: 'bash', one: 'command', many: 'commands' },
  { kind: 'file-edit', one: 'file edit', many: 'file edits' },
  { kind: 'read', one: 'read', many: 'reads' },
  { kind: 'search', one: 'search', many: 'searches' },
  { kind: 'web', one: 'web', many: 'web' },
  { kind: 'other', one: 'tool', many: 'tools' }
]

/** Builds e.g. "13 steps · 9 commands · 2 file edits · 1 search" from a run of calls. */
function summarizeGroup(calls: ToolCall[]): string {
  const counts = new Map<ToolKind, number>()
  for (const call of calls) {
    const k = kindOf(call.tool)
    counts.set(k, (counts.get(k) ?? 0) + 1)
  }
  const total = calls.length
  const parts = [`${total} step${total === 1 ? '' : 's'}`]
  for (const { kind, one, many } of KIND_LABELS) {
    const n = counts.get(kind) ?? 0
    if (n > 0) parts.push(`${n} ${n === 1 ? one : many}`)
  }
  return parts.join(' · ')
}

function Chevron() {
  return (
    <svg
      className="tool-group-chevron"
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <polyline points="9 18 15 12 9 6" />
    </svg>
  )
}

/**
 * Collapses a message's run of tool calls into a single card with a summary header.
 * Auto-opens while the turn is streaming or any call is still running, then
 * auto-collapses once complete — unless the user has toggled it manually.
 */
function ToolCallGroup({ calls, streaming }: { calls: ToolCall[]; streaming: boolean }) {
  const [override, setOverride] = useState<boolean | null>(null)
  const running = calls.find((c) => c.result === undefined)
  const streamingOrRunning = streaming || running !== undefined
  const open = override !== null ? override : streamingOrRunning

  const runningArg = running ? summaryFor(running.tool, running.input).text : ''

  return (
    <div className={`tool-group ${open ? 'open' : ''}`}>
      <button
        type="button"
        className="tool-group-header"
        aria-expanded={open}
        onClick={() => setOverride(!open)}
      >
        <Chevron />
        <span className="tool-group-summary">{summarizeGroup(calls)}</span>
        {running && (
          <>
            {runningArg && <span className="tool-group-running">· running: {runningArg}</span>}
            <span className="tool-call-spin" />
          </>
        )}
      </button>
      {open && (
        <div className="tool-group-body">
          {calls.map((call) => (
            <ToolCallView key={call.id} call={call} />
          ))}
        </div>
      )}
    </div>
  )
}

function fmtTok(n: number): string {
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M'
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K'
  return String(Math.round(n))
}

export default function MessageBubble({ message, streaming, onRetry, onEditResend, onBranch }: Props) {
  const isUser = message.role === 'user'
  // A decision turn has no prose to edit, resend or branch from — it is a record of
  // a choice, and the affordances of a message he typed would all be lies on it.
  const decisions = message.decisions?.length ? message.decisions : null
  const [editing, setEditing] = useState(false)
  const [editText, setEditText] = useState(message.content)
  const editRef = useRef<HTMLTextAreaElement>(null)

  const startEdit = () => {
    setEditText(message.content)
    setEditing(true)
    // Focus textarea after render
    setTimeout(() => editRef.current?.focus(), 0)
  }

  const cancelEdit = () => {
    setEditing(false)
    setEditText(message.content)
  }

  const saveEdit = () => {
    if (!editText.trim() || streaming) return
    setEditing(false)
    onEditResend(message.id, editText)
  }

  const handleEditKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Escape') { cancelEdit(); return }
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { saveEdit() }
  }

  return (
    <div className={`message-row ${isUser ? 'user' : 'assistant'}`}>
      <div className="message-avatar">
        {isUser ? (
          <div className="avatar user-avatar">U</div>
        ) : (
          <div className="avatar claude-avatar">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
              <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="1.5" />
              <path d="M8 12h8M12 8v8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          </div>
        )}
      </div>
      <div className="message-body">
        <div className="message-head">
          <span className="message-role">{isUser ? 'You' : 'Claude'}</span>
          <CopyMessage text={message.content} />
          {onBranch && !streaming && !editing && !decisions && (
            <button
              className="message-branch"
              onClick={() => onBranch(message.id)}
              title="Branch a new chat from this point"
              aria-label="Branch a new chat from this point"
            >
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <line x1="6" y1="3" x2="6" y2="15" />
                <circle cx="18" cy="6" r="3" />
                <circle cx="6" cy="18" r="3" />
                <path d="M18 9a9 9 0 0 1-9 9" />
              </svg>
              Branch
            </button>
          )}
          {isUser && !editing && !decisions && (
            <button
              className="message-edit"
              onClick={startEdit}
              title="Edit and resend"
              aria-label="Edit and resend"
            >
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
                <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
              </svg>
              Edit
            </button>
          )}
        </div>
        {!isUser && message.toolCalls && message.toolCalls.length > 0 && (
          <div className="tool-calls">
            {/* Two or more calls collapse into the one-line summary; a lone call stays
                expanded so the common single-tool turn reads without an extra click. */}
            {message.toolCalls.length >= 2 ? (
              <ToolCallGroup calls={message.toolCalls} streaming={streaming} />
            ) : (
              message.toolCalls.map((call) => <ToolCallView key={call.id} call={call} />)
            )}
          </div>
        )}
        {isUser && editing ? (
          <div className="message-edit-area">
            <textarea
              ref={editRef}
              className="message-edit-textarea"
              value={editText}
              onChange={(e) => setEditText(e.target.value)}
              onKeyDown={handleEditKeyDown}
              rows={Math.max(2, editText.split('\n').length)}
              aria-label="Edit message"
            />
            <div className="message-edit-actions">
              <button
                className="message-edit-save"
                onClick={saveEdit}
                disabled={streaming || !editText.trim()}
                aria-label="Save and rerun"
              >
                Save &amp; rerun
              </button>
              <button
                className="message-edit-cancel"
                onClick={cancelEdit}
                aria-label="Cancel edit"
              >
                Cancel
              </button>
            </div>
          </div>
        ) : decisions ? (
          <DecisionBlock decisions={decisions} />
        ) : message.content ? (
          <div className="message-content">
            {isUser ? (
              <div className="user-text">{message.content}</div>
            ) : (
              <Markdown content={message.content} />
            )}
            {/* What was attached, shown where it was sent. Thumbnails, so a
                transcript with images in it stays a readable size. */}
            {message.imageThumbnails && message.imageThumbnails.length > 0 && (
              <div className="msg-images">
                {message.imageThumbnails.map((src, i) => (
                  <img key={i} className="msg-image" src={src} alt="attached image" />
                ))}
              </div>
            )}
          </div>
        ) : (
          streaming && (!message.toolCalls || message.toolCalls.length === 0) && (
            <div className="typing-indicator"><span /><span /><span /></div>
          )
        )}
        {streaming && message.content && <span className="cursor-blink" />}
        {!isUser && message.usage && !streaming && (
          <div className="msg-usage" title="Tokens for this turn — local estimate at public API rates">
            <span>{fmtTok(message.usage.inputTokens)} in</span>
            {message.usage.cacheReadTokens > 0 && (
              <span className="msg-usage-cache">· ♻ {fmtTok(message.usage.cacheReadTokens)} cached</span>
            )}
            <span>· {fmtTok(message.usage.outputTokens)} out</span>
            <span className="msg-usage-cost">
              · ~${message.usage.costUsd < 0.01 ? message.usage.costUsd.toFixed(4) : message.usage.costUsd.toFixed(2)}
            </span>
          </div>
        )}
        {onRetry && (
          <button
            className="message-retry"
            onClick={onRetry}
            disabled={streaming}
            aria-label="Retry this turn"
          >
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <polyline points="1 4 1 10 7 10" />
              <path d="M3.51 15a9 9 0 1 0 .49-3.71" />
            </svg>
            Retry
          </button>
        )}
      </div>
    </div>
  )
}
