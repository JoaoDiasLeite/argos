import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useT } from '../i18n'
import './CommandExplain.css'

type State = { kind: 'idle' } | { kind: 'loading' } | { kind: 'done'; text: string } | { kind: 'error'; error: string }

/**
 * The command block of an ops approval with a "?" beside it. The "?" asks main for an
 * explanation of these exact words from a separate model call that sees nothing else
 * (ops-explain-pure.ts), and shows it under the block, labelled as generated. Nothing
 * here can approve or change the call: the block above stays what the operator decides on.
 */
export default function CommandExplain({ argv, children }: { argv: string[]; children: ReactNode }) {
  const t = useT()
  const [open, setOpen] = useState(false)
  const [state, setState] = useState<State>({ kind: 'idle' })
  const key = JSON.stringify(argv)
  // The call the card shows now; an answer for an earlier one is dropped.
  const current = useRef(key)

  // Another call in the same card: start again closed.
  useEffect(() => {
    current.current = key
    setOpen(false)
    setState({ kind: 'idle' })
  }, [key])

  const ask = () => {
    const asked = key
    setState({ kind: 'loading' })
    window.electronAPI
      .opsExplainCommand(JSON.parse(asked) as string[])
      .then((r) => {
        if (current.current !== asked) return
        setState(r.ok ? { kind: 'done', text: r.text } : { kind: 'error', error: r.error })
      })
      .catch((e: unknown) => {
        if (current.current === asked) setState({ kind: 'error', error: e instanceof Error ? e.message : String(e) })
      })
  }

  const toggle = () => {
    const next = !open
    setOpen(next)
    if (next && (state.kind === 'idle' || state.kind === 'error')) ask()
  }

  return (
    <div className="cmd-explain">
      <div className="cmd-explain-row">
        <div className="cmd-explain-block">{children}</div>
        <button
          type="button"
          className={`cmd-explain-btn${open ? ' on' : ''}`}
          aria-expanded={open}
          aria-label={t('ops.explain.button')}
          title={t('ops.explain.button')}
          onClick={toggle}
        >
          ?
        </button>
      </div>
      {open && (
        <div className="cmd-explain-panel" role="status" aria-live="polite">
          {state.kind === 'loading' && <div className="cmd-explain-wait">{t('ops.explain.loading')}</div>}
          {state.kind === 'done' && (
            <>
              <div className="cmd-explain-text">{state.text}</div>
              <div className="cmd-explain-note">{t('ops.explain.note')}</div>
            </>
          )}
          {state.kind === 'error' && (
            <div className="cmd-explain-error">
              <span>{state.error}</span>{' '}
              <button type="button" className="btn-text" onClick={ask}>
                {t('ops.explain.retry')}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
