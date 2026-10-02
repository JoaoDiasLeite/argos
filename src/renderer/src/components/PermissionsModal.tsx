import { useEffect, useState } from 'react'
import { ClaudePermissions } from '../types'
import Sheet from './Sheet'
import './PermissionsModal.css'

interface Props {
  onClose: () => void
}

type ListKey = keyof ClaudePermissions

// The dot colour is the rule's meaning, as everywhere else: ran (success), refused
// (error), asks (warn).
const LISTS: { key: ListKey; label: string; meaning: string; example: string; dot: string }[] = [
  { key: 'allow', label: 'Allow', meaning: 'runs without asking', example: 'e.g. Bash(git *)', dot: 'ok' },
  { key: 'deny', label: 'Deny', meaning: 'refused, with the rule named', example: 'e.g. Bash(rm *)', dot: 'err' },
  { key: 'ask', label: 'Ask', meaning: 'will ask you first', example: 'e.g. Edit(src/**)', dot: 'warn' }
]

export default function PermissionsModal({ onClose }: Props) {
  const [perms, setPerms] = useState<ClaudePermissions>({ allow: [], deny: [], ask: [] })
  const [inputs, setInputs] = useState<Record<ListKey, string>>({ allow: '', deny: '', ask: '' })
  const [saved, setSaved] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)

  useEffect(() => {
    window.electronAPI.getClaudePermissions().then(setPerms)
  }, [])

  const persist = async (next: ClaudePermissions) => {
    setSaveError(null)
    const result = await window.electronAPI.setClaudePermissions(next)
    if (!result.ok) {
      setSaveError(result.error ?? 'Unknown error saving permissions')
      return
    }
    setPerms(next)
    setSaved(true)
    setTimeout(() => setSaved(false), 1200)
  }

  const add = async (key: ListKey) => {
    const val = inputs[key].trim()
    if (!val) return
    if (perms[key].includes(val)) return
    await persist({ ...perms, [key]: [...perms[key], val] })
    setInputs((prev) => ({ ...prev, [key]: '' }))
  }

  const remove = async (key: ListKey, entry: string) => {
    await persist({ ...perms, [key]: perms[key].filter((e) => e !== entry) })
  }

  return (
    <Sheet
      title="Permissions"
      width={520}
      onClose={onClose}
      footer={
        <>
          <span className="help perms-saved">{saved ? 'Saved' : ''}</span>
          <button type="button" className="btn-ghost" onClick={onClose}>
            Done
          </button>
          <span className="help">Esc closes</span>
        </>
      }
    >
      <div className="perms-body">
        <p className="help">
          Rules Claude Code applies before asking you. Saved to <code>~/.claude/settings.json</code> as you
          edit.
        </p>

        {saveError && (
          <div className="block err perms-error" role="alert">
            {saveError}
          </div>
        )}

        {LISTS.map(({ key, label, meaning, example, dot }) => (
          <div key={key} className="perms-group">
            <div className="perms-head">
              <i className={`perms-dot ${dot}`} />
              <span className="perms-word">{label}</span>
              <span className="perms-meaning">{meaning}</span>
            </div>

            <ul className="perms-list">
              {perms[key].length === 0 && <li className="help perms-empty">No entries</li>}
              {perms[key].map((entry) => (
                <li key={entry} className="perms-entry">
                  <code className="perms-entry-text">{entry}</code>
                  <button type="button" className="perms-remove" onClick={() => remove(key, entry)} aria-label={`Remove ${entry}`}>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
                      <path d="M6 6l12 12M18 6L6 18" />
                    </svg>
                  </button>
                </li>
              ))}
            </ul>

            <div className="perms-add-row">
              <input
                className="text-input mono"
                value={inputs[key]}
                onChange={(e) => setInputs((prev) => ({ ...prev, [key]: e.target.value }))}
                onKeyDown={(e) => e.key === 'Enter' && add(key)}
                placeholder={example}
                spellCheck={false}
                aria-label={`Add ${label} entry`}
              />
              <button type="button" className="btn-ghost small" onClick={() => add(key)} disabled={!inputs[key].trim()}>
                Add
              </button>
            </div>
          </div>
        ))}
      </div>
    </Sheet>
  )
}
