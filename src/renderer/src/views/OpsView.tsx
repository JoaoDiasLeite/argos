import { useCallback, useEffect, useState } from 'react'
import type { OpsRunbookInfo } from '../types'
import { readRecentRunbooks, RECENT_RUNBOOKS_KEY } from '../components/ChatConfigBar'
import './OpsView.css'

/**
 * Servers → Ops: the runbooks Argos has seen, and the day's ledger.
 *
 * The list is the same recents the chat's runbook picker keeps (`ops.recentRunbooks`), so a
 * runbook picked in either place shows up in both. Each entry is re-read on mount rather
 * than cached: a runbook is a folder someone edits, and a stale host count or a policy that
 * stopped validating is exactly what this screen exists to show.
 */

const RECENT_MAX = 8

/** Same rule as the chat picker's (ChatConfigBar): most recent first, de-duplicated, capped. */
function pushRecentRunbook(dir: string): string[] {
  const next = [dir, ...readRecentRunbooks().filter((p) => p !== dir)].slice(0, RECENT_MAX)
  try {
    localStorage.setItem(RECENT_RUNBOOKS_KEY, JSON.stringify(next))
  } catch {
    /* storage unavailable: the list just isn't remembered */
  }
  return next
}

function forgetRecentRunbook(dir: string): string[] {
  const next = readRecentRunbooks().filter((p) => p !== dir)
  try {
    localStorage.setItem(RECENT_RUNBOOKS_KEY, JSON.stringify(next))
  } catch {
    /* storage unavailable */
  }
  return next
}

const utcToday = () => new Date().toISOString().slice(0, 10)

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

const baseName = (p: string) => p.split(/[\\/]/).filter(Boolean).pop() ?? p

type OpsLoadFailure = Extract<OpsRunbookInfo, { ok: false }>
type VerifyResult = { ok: true; lines: number } | { ok: false; brokenAt?: number; reason: string }

interface Props {
  onOpen: (runbookPath: string) => void
}

export default function OpsView({ onOpen }: Props) {
  const [recents, setRecents] = useState<string[]>(readRecentRunbooks)
  const [infos, setInfos] = useState<Record<string, OpsRunbookInfo | 'loading'>>({})
  const [pickError, setPickError] = useState<OpsLoadFailure | null>(null)
  const [ledger, setLedger] = useState<{ dir: string; files: number; bytes: number } | null>(null)
  const [verifying, setVerifying] = useState(false)
  const [verifyResult, setVerifyResult] = useState<VerifyResult | null>(null)

  const load = useCallback((dirs: string[]) => {
    setInfos((prev) => ({ ...prev, ...Object.fromEntries(dirs.map((d) => [d, 'loading' as const])) }))
    for (const dir of dirs) {
      window.electronAPI
        .opsLoadRunbook(dir)
        .then((info) => setInfos((prev) => ({ ...prev, [dir]: info })))
        .catch((e) =>
          setInfos((prev) => ({ ...prev, [dir]: { ok: false, error: e instanceof Error ? e.message : String(e) } }))
        )
    }
  }, [])

  useEffect(() => {
    load(readRecentRunbooks())
    let cancelled = false
    window.electronAPI
      .opsLedgerInfo()
      .then((info) => !cancelled && setLedger(info))
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [load])

  const chooseFolder = async () => {
    setPickError(null)
    const dir = await window.electronAPI.openFolder()
    if (!dir) return
    const info = await window.electronAPI.opsLoadRunbook(dir)
    if (!info.ok) {
      setPickError(info)
      return
    }
    setRecents(pushRecentRunbook(dir))
    setInfos((prev) => ({ ...prev, [dir]: info }))
    onOpen(dir)
  }

  const forget = (dir: string) => setRecents(forgetRecentRunbook(dir))

  const verifyToday = async () => {
    setVerifying(true)
    setVerifyResult(null)
    try {
      setVerifyResult(await window.electronAPI.opsVerify(utcToday()))
    } catch (e) {
      setVerifyResult({ ok: false, reason: e instanceof Error ? e.message : String(e) })
    } finally {
      setVerifying(false)
    }
  }

  return (
    <div className="view ops-view">
      <div className="view-header">
        <div className="ops-view-col ops-view-head">
          <div>
            <h1>Ops</h1>
            <p className="view-sub">
              Runbook-gated work on your servers: every command is checked against the runbook&apos;s policy,
              asked when it must be, and written to the ledger.
            </p>
          </div>
          <div className="header-actions">
            <button className="btn-primary small" onClick={chooseFolder}>
              Choose runbook folder…
            </button>
          </div>
        </div>
      </div>

      <div className="view-scroll">
        <div className="ops-view-col">
          {pickError && (
            <div className="ops-view-error" role="alert">
              <strong>That folder is not a usable runbook.</strong> {pickError.error}
              {pickError.errors && pickError.errors.length > 0 && (
                <ul>
                  {pickError.errors.map((e, i) => (
                    <li key={i}>{e}</li>
                  ))}
                </ul>
              )}
            </div>
          )}

          {recents.length === 0 ? (
            <div className="ops-view-empty">
              <p>
                A runbook is a folder with a <code>RUNBOOK.md</code> describing the work, a <code>policy.json</code>{' '}
                naming the hosts and the commands allowed on them, and an optional <code>scripts/</code> folder.
                Choose one to open its workspace; it stays listed here afterwards.
              </p>
            </div>
          ) : (
            <ul className="ops-view-list">
              {recents.map((dir) => {
                const info = infos[dir]
                const loading = !info || info === 'loading'
                const ok = !loading && info.ok
                return (
                  <li key={dir} className="ops-view-row-wrap">
                    <button
                      className={`ops-view-row${!loading && !ok ? ' bad' : ''}`}
                      onClick={() => onOpen(dir)}
                      title={dir}
                    >
                      <span className="ops-view-name">{ok ? info.name : baseName(dir)}</span>
                      {ok && info.platform && <span className="ops-view-tag">{info.platform}</span>}
                      {ok && info.strict && <span className="ops-view-tag strict">strict</span>}
                      <span className="ops-view-detail">
                        {loading && <span className="ops-view-meta">Loading…</span>}
                        {ok && (
                          <>
                            <span className="ops-view-meta">
                              {info.hosts.length} host{info.hosts.length === 1 ? '' : 's'}
                            </span>
                            {info.warnings.length > 0 && (
                              <span className="ops-view-meta warn" title={info.warnings.join('\n')}>
                                {info.warnings.length} warning{info.warnings.length === 1 ? '' : 's'}
                              </span>
                            )}
                          </>
                        )}
                        {!loading && !info.ok && (
                          <span
                            className="ops-view-meta error"
                            title={[info.error, ...(info.errors ?? [])].join('\n')}
                          >
                            {info.errors && info.errors.length > 0
                              ? `${info.errors.length} error${info.errors.length === 1 ? '' : 's'}`
                              : info.error}
                          </span>
                        )}
                        <span className="ops-view-meta mono">{dir}</span>
                      </span>
                    </button>
                    {!loading && !ok && (
                      <button className="btn-ghost small ops-view-forget" onClick={() => forget(dir)}>
                        Forget
                      </button>
                    )}
                  </li>
                )
              })}
            </ul>
          )}

          <div className="ops-view-ledger">
            <span className="ops-view-ledger-text">
              {ledger
                ? `Ledger · ${ledger.files} file${ledger.files === 1 ? '' : 's'} · ${formatBytes(ledger.bytes)}`
                : 'Ledger'}
              {ledger && (
                <span className="ops-view-meta mono" title={ledger.dir}>
                  {ledger.dir}
                </span>
              )}
            </span>
            {verifyResult && (
              <span className={`ops-view-verify${verifyResult.ok ? ' ok' : ' bad'}`} role="status">
                {verifyResult.ok
                  ? verifyResult.lines === 0
                    ? 'No entries today yet'
                    : `Today intact · ${verifyResult.lines} lines`
                  : verifyResult.brokenAt !== undefined
                    ? `Broken at line ${verifyResult.brokenAt}: ${verifyResult.reason}`
                    : `Broken: ${verifyResult.reason}`}
              </span>
            )}
            <button className="btn-ghost small" onClick={verifyToday} disabled={verifying}>
              {verifying ? 'Verifying…' : 'Verify today'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
