import { ReactNode, useCallback, useEffect, useMemo, useState } from 'react'
import { BacklogReadResult, BacklogRecord, BacklogRef, BacklogTopic, BacklogWriteResult, PlannerTask } from '../types'
import MemoryPanel from '../components/MemoryPanel'
import { PlannerModeToggle, PlannerMode } from './SprintBoard'
import './views.css'
import './PlannerView.css'
import './BacklogBoard.css'

/** Where the board reopens — the project, not the record: the record is whatever that folder keeps. */
const PROJECT_KEY = 'backlog.projectPath'

interface BacklogBoardProps {
  mode: PlannerMode
  onMode: (m: PlannerMode) => void
  /**
   * Argos's own unscheduled tasks for the week on screen. The week stays owned by
   * PlannerView; this board only reads them so it can offer to move them into the repo.
   */
  legacyTasks: PlannerTask[]
  /** Drop one Argos task by id. Only ever called after the repo write has confirmed. */
  onDropLegacyTask: (id: string) => void
}

/** What the board is telling the user after a write — errors mostly, but not only. */
type Notice = { kind: 'error' | 'info'; text: string }

/** A run of topics under one heading, in file order. */
interface Group {
  section: string | null
  topics: BacklogTopic[]
}

const refOf = (t: BacklogTopic): BacklogRef => ({ line: t.line, title: t.title })

/**
 * Group by contiguous runs rather than by section name. Two headings that happen to
 * share a name are two places in the file, and folding them together would show the
 * user an order their record does not have.
 */
function groupTopics(topics: BacklogTopic[]): Group[] {
  const groups: Group[] = []
  for (const t of topics) {
    const last = groups[groups.length - 1]
    if (last && last.section === t.section) last.topics.push(t)
    else groups.push({ section: t.section, topics: [t] })
  }
  return groups
}

export default function BacklogBoard({ mode, onMode, legacyTasks, onDropLegacyTask }: BacklogBoardProps) {
  const [projectPath, setProjectPath] = useState<string | undefined>(
    () => localStorage.getItem(PROJECT_KEY) || undefined
  )
  const [result, setResult] = useState<BacklogReadResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [notice, setNotice] = useState<Notice | null>(null)
  const [busy, setBusy] = useState(false)
  // Which line is open for renaming, which is awaiting a delete confirmation, and which
  // "add a topic" row is open. The add is keyed rather than identified by its section,
  // because the leading unheaded group and the file-wide add both carry a null section
  // and are still two different controls.
  const [editingLine, setEditingLine] = useState<number | null>(null)
  const [editDraft, setEditDraft] = useState('')
  const [confirmLine, setConfirmLine] = useState<number | null>(null)
  const [addOpen, setAddOpen] = useState<{ key: string; section: string | null } | null>(null)
  const [addDraft, setAddDraft] = useState('')
  const [memoryOpen, setMemoryOpen] = useState(false)

  const record: BacklogRecord | null = result && result.found ? result.record : null

  const reload = useCallback(async (path: string) => {
    setLoading(true)
    const res = await window.electronAPI.backlogRead(path)
    setResult(res)
    setLoading(false)
    return res
  }, [])

  useEffect(() => {
    if (!projectPath) {
      setResult(null)
      return
    }
    let cancelled = false
    setLoading(true)
    window.electronAPI.backlogRead(projectPath).then((res) => {
      if (cancelled) return
      setResult(res)
      setLoading(false)
    })
    return () => {
      cancelled = true
    }
  }, [projectPath])

  const pickFolder = async () => {
    const folder = await window.electronAPI.openFolder()
    if (!folder) return
    localStorage.setItem(PROJECT_KEY, folder)
    setNotice(null)
    setEditingLine(null)
    setConfirmLine(null)
    setAddOpen(null)
    setProjectPath(folder)
  }

  /**
   * The one place a write result turns into state. Success replaces the record wholesale
   * from `res.record` — the main process re-read the file after writing precisely so the
   * renderer never has to model what its own edit did. The two conflicts stay distinct:
   * `stale` is recoverable by reloading, `ambiguous` is not recoverable by the app at all
   * — the file has two identical lines and picking one for the user is the bug this
   * whole addressing scheme exists to prevent.
   */
  const applyWrite = async (res: BacklogWriteResult): Promise<boolean> => {
    if (res.ok) {
      setResult({ found: true, record: res.record })
      setNotice(null)
      // Both of these address a topic by its line, and adding, duplicating or deleting
      // shifts every line below it. Left open across a write, a delete confirmation
      // opened on one topic ends up sitting on whichever topic inherited that line —
      // which is the same class of mistake as addressing a write by text alone.
      setEditingLine(null)
      setConfirmLine(null)
      return true
    }
    if (res.error === 'stale') {
      setNotice({ kind: 'error', text: 'That topic is gone or reworded — the file changed under this view. Reloaded it.' })
      if (projectPath) await reload(projectPath)
      return false
    }
    if (res.error === 'ambiguous') {
      setNotice({
        kind: 'error',
        text: `${res.matches} lines read exactly the same, so Argos will not guess which one you meant. Make them distinct in the file, then reload.`
      })
      return false
    }
    if (res.error === 'no-record') {
      setNotice({ kind: 'error', text: 'The record is no longer there.' })
      if (projectPath) await reload(projectPath)
      return false
    }
    setNotice({ kind: 'error', text: res.message })
    return false
  }

  // Every operation goes through here so a write never overlaps another one.
  const run = async (fn: () => Promise<BacklogWriteResult>): Promise<boolean> => {
    if (busy) return false
    setBusy(true)
    try {
      return await applyWrite(await fn())
    } finally {
      setBusy(false)
    }
  }

  const setDone = (t: BacklogTopic, done: boolean) =>
    run(() => window.electronAPI.backlogSetDone(projectPath!, refOf(t), done))

  const duplicate = (t: BacklogTopic) =>
    run(() => window.electronAPI.backlogDuplicate(projectPath!, refOf(t)))

  const remove = (t: BacklogTopic) =>
    run(() => window.electronAPI.backlogDelete(projectPath!, refOf(t)))

  const commitEdit = async (t: BacklogTopic) => {
    const title = editDraft.trim()
    if (!title || title === t.title) {
      setEditingLine(null)
      return
    }
    await run(() => window.electronAPI.backlogEdit(projectPath!, refOf(t), title))
  }

  const commitAdd = async (section: string | null) => {
    const title = addDraft.trim()
    if (!title) return
    const ok = await run(() => window.electronAPI.backlogCreate(projectPath!, title, section))
    if (ok) setAddDraft('')
  }

  /**
   * Move one Argos task into the repo record. The order is the whole point: the task is
   * only dropped from the week once the repo write has come back ok, because a migration
   * that loses the task on a failed write is worse than no migration.
   */
  const migrate = async (task: PlannerTask) => {
    const ok = await run(() => window.electronAPI.backlogCreate(projectPath!, task.title, null))
    if (ok) onDropLegacyTask(task.id)
  }

  const migrateAll = async () => {
    for (const task of legacyTasks) {
      const ok = await run(() => window.electronAPI.backlogCreate(projectPath!, task.title, null))
      if (!ok) break
      onDropLegacyTask(task.id)
    }
  }

  const groups = useMemo(() => (record ? groupTopics(record.topics) : []), [record])

  const header = (
    <div className="view-header planner-header">
      <div className="planner-title-wrap">
        <PlannerModeToggle mode={mode} onMode={onMode} />
        <div>
          <h1>Backlog</h1>
          <p className="view-sub">
            {record
              ? `${record.relPath} · ${record.pending} pending · ${record.done} done`
              : "The project's own checkbox record"}
          </p>
        </div>
      </div>
      <div className="planner-header-actions">
        {projectPath && (
          <span className="backlog-project-path" title={projectPath}>
            {projectPath}
          </span>
        )}
        <button className="assist-btn" onClick={pickFolder}>
          {projectPath ? 'Change project' : 'Choose project'}
        </button>
      </div>
    </div>
  )

  const memory = (
    <div className="backlog-memory">
      <button className="backlog-memory-head" onClick={() => setMemoryOpen((v) => !v)}>
        <span>Project memory</span>
        <span className="backlog-memory-caret">{memoryOpen ? '▾' : '▸'}</span>
      </button>
      {memoryOpen && (
        <div className="backlog-memory-body">
          <MemoryPanel projectPath={projectPath} />
        </div>
      )}
    </div>
  )

  let body: ReactNode
  if (!projectPath) {
    body = (
      <div className="backlog-empty">
        <div className="backlog-empty-card">
          <h2>Pick a project</h2>
          <p>
            This mode edits the <code>- [ ]</code> checkboxes already written in the project&apos;s own record — the
            file that lives in the repo, survives Argos and travels with the code.
          </p>
          <button className="assist-btn primary wide" onClick={pickFolder}>
            Choose project folder
          </button>
        </div>
      </div>
    )
  } else if (loading && !result) {
    body = (
      <div className="view-loading">
        <div className="view-spinner" />
        <span className="view-loading-text">Reading the record…</span>
      </div>
    )
  } else if (result && !result.found) {
    body = (
      <div className="backlog-empty">
        <div className="backlog-empty-card">
          <h2>No record in this project</h2>
          <p>Argos looked for, in order:</p>
          <ul className="backlog-looked">
            {result.looked.map((rel) => (
              <li key={rel} className="backlog-looked-item">
                {rel}
              </li>
            ))}
          </ul>
          <p>Add one of these to the repo and it becomes the backlog.</p>
          <button className="assist-btn wide" onClick={() => reload(projectPath)}>
            Look again
          </button>
        </div>
      </div>
    )
  } else if (!record) {
    body = <div className="view-loading" />
  } else {
    body = (
      <div className="view-scroll backlog-scroll">
        {notice && (
          <div className={`backlog-notice ${notice.kind}`}>
            <span>{notice.text}</span>
            <button className="backlog-notice-x" onClick={() => setNotice(null)} title="Dismiss">
              ×
            </button>
          </div>
        )}

        <div className="backlog-layout">
          <div className="backlog-main">
            <div className="backlog-file">
              <div className="backlog-file-head">
                <span className="backlog-file-path" title={record.path}>
                  {record.relPath}
                </span>
                {/* Always the file-wide counts, never the length of what got rendered. */}
                <span className="backlog-tally">
                  <span className="backlog-tally-pill">{record.pending} pending</span>
                  <span className="backlog-tally-pill done">{record.done} done</span>
                </span>
              </div>
              <p className="backlog-file-meta">Every tick, edit and delete below rewrites that one line in this file.</p>
            </div>

            {legacyTasks.length > 0 && (
              <div className="backlog-legacy">
                <div className="backlog-legacy-head">
                  <span className="backlog-legacy-badge">Legacy</span>
                  <span>
                    {legacyTasks.length} unscheduled task{legacyTasks.length === 1 ? '' : 's'} still live only in Argos
                  </span>
                  <button className="assist-btn" disabled={busy} onClick={migrateAll}>
                    Move all
                  </button>
                </div>
                <p className="backlog-legacy-note">
                  This project keeps its own record, so the repo wins. Moving a task writes it into {record.relPath} and
                  only then drops it from the week.
                </p>
                <div className="backlog-legacy-list">
                  {legacyTasks.map((t) => (
                    <div key={t.id} className="backlog-legacy-row">
                      <span className="backlog-legacy-title">{t.title}</span>
                      <button className="assist-btn" disabled={busy} onClick={() => migrate(t)}>
                        Move to record
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {groups.length === 0 && (
              <p className="backlog-file-meta">No checkboxes in this file yet — add the first one below.</p>
            )}

            {groups.map((g, i) => (
              <div className="backlog-group" key={`${g.section ?? ''}-${i}`}>
                {g.section !== null && (
                  <div className="backlog-group-head">
                    <span className="backlog-group-title">{g.section}</span>
                    <span className="backlog-group-count">{g.topics.filter((t) => !t.done).length} open</span>
                  </div>
                )}
                <div className="backlog-topics">
                  {g.topics.map((t) => (
                    <div className={`backlog-topic ${t.done ? 'done' : ''}`} key={t.line}>
                      <input
                        type="checkbox"
                        className="backlog-topic-box"
                        checked={t.done}
                        disabled={busy}
                        onChange={(e) => setDone(t, e.target.checked)}
                      />
                      {editingLine === t.line ? (
                        <input
                          className="text-input backlog-topic-input"
                          value={editDraft}
                          autoFocus
                          onChange={(e) => setEditDraft(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') commitEdit(t)
                            else if (e.key === 'Escape') setEditingLine(null)
                          }}
                          onBlur={() => setEditingLine(null)}
                        />
                      ) : (
                        <button
                          className="backlog-topic-title"
                          title="Click to rename"
                          onClick={() => {
                            setEditDraft(t.title)
                            setEditingLine(t.line)
                          }}
                        >
                          {t.title}
                        </button>
                      )}
                      <span className="backlog-topic-actions">
                        <button
                          className="backlog-topic-btn"
                          disabled={busy}
                          title="Duplicate"
                          onClick={() => duplicate(t)}
                        >
                          Duplicate
                        </button>
                        <button
                          className="backlog-topic-btn danger"
                          disabled={busy}
                          title="Delete this line"
                          onClick={() => setConfirmLine(t.line)}
                        >
                          Delete
                        </button>
                      </span>
                      {confirmLine === t.line && (
                        // Naming the topic, because this removes a line from a file the
                        // user tracks in git — not from Argos's own storage.
                        <div className="backlog-confirm">
                          <span>
                            Delete “{t.title}” from {record.relPath}?
                          </span>
                          <div className="backlog-confirm-actions">
                            <button className="btn-ghost" onClick={() => setConfirmLine(null)}>
                              Cancel
                            </button>
                            <button className="btn-primary" disabled={busy} onClick={() => remove(t)}>
                              Delete line
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
                <AddRow
                  open={addOpen?.key === `g${i}`}
                  busy={busy}
                  draft={addDraft}
                  label={g.section === null ? '+ Add a topic here' : `+ Add to ${g.section}`}
                  onOpen={() => {
                    setAddDraft('')
                    setAddOpen({ key: `g${i}`, section: g.section })
                  }}
                  onDraft={setAddDraft}
                  onCommit={() => commitAdd(g.section)}
                  onCancel={() => setAddOpen(null)}
                />
              </div>
            ))}

            {/* The file-wide add, distinct from the per-section ones: it passes no section,
                so the topic lands at the end of the file rather than inside a run. */}
            <div className="backlog-add-file">
              <AddRow
                open={addOpen?.key === 'file'}
                busy={busy}
                draft={addDraft}
                label="+ Add a topic to the file"
                onOpen={() => {
                  setAddDraft('')
                  setAddOpen({ key: 'file', section: null })
                }}
                onDraft={setAddDraft}
                onCommit={() => commitAdd(null)}
                onCancel={() => setAddOpen(null)}
              />
            </div>
          </div>

          <aside className="backlog-aside">{memory}</aside>
        </div>
      </div>
    )
  }

  return (
    <div className="view">
      {header}
      {body}
    </div>
  )
}

/** The inline "add a topic" control, identical everywhere it appears. */
function AddRow(props: {
  open: boolean
  busy: boolean
  draft: string
  label: string
  onOpen: () => void
  onDraft: (v: string) => void
  onCommit: () => void
  onCancel: () => void
}) {
  if (!props.open) {
    return (
      <button className="backlog-add" onClick={props.onOpen}>
        {props.label}
      </button>
    )
  }
  return (
    <div className="backlog-add-row">
      <input
        className="text-input backlog-add-input"
        value={props.draft}
        autoFocus
        placeholder="New topic…"
        onChange={(e) => props.onDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') props.onCommit()
          else if (e.key === 'Escape') props.onCancel()
        }}
      />
      <button className="assist-btn" disabled={props.busy || !props.draft.trim()} onClick={props.onCommit}>
        Add
      </button>
      <button className="btn-ghost" onClick={props.onCancel}>
        Cancel
      </button>
    </div>
  )
}
