import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import {
  codexArchiveSession,
  codexArchivedDir,
  codexDeleteSession,
  codexMoveSession,
  codexRenameSession,
  codexSessions,
  codexUnarchiveSession,
  invalidateCodexScan,
  scanCodexArchived,
  scanCodexRollouts,
  CodexSource
} from './codex-data'

/**
 * The lifecycle operations against a real CODEX_HOME laid out the way Codex lays one
 * out, because every one of them is about where a file is and what its first line
 * says — the two things a mocked filesystem would have to invent.
 */

let home: string
let src: CodexSource
const made: string[] = []

const SESSION_A = '01a085ae-90a3-70c2-815d-7d542e1760f3'
const SESSION_B = '01a0a543-73f3-73c2-b1fb-86a2514b9d9a'

function rolloutName(stamp: string, sessionId: string): string {
  return `rollout-${stamp}-${sessionId}.jsonl`
}

/** A rollout with a real header and one message, in the date bucket its name names. */
function writeRollout(stamp: string, sessionId: string, cwd: string): string {
  const [date] = stamp.split('T')
  const [y, mo, d] = date.split('-')
  const file = path.join(home, 'sessions', y, mo, d, rolloutName(stamp, sessionId))
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(
    file,
    JSON.stringify({
      type: 'session_meta',
      timestamp: '2026-09-15T13:30:56.000Z',
      payload: { id: sessionId, cwd, originator: 'test' }
    }) +
      '\n' +
      JSON.stringify({
        type: 'response_item',
        timestamp: '2026-09-15T13:31:00.000Z',
        payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hello' }] }
      }) +
      '\n',
    'utf-8'
  )
  return file
}

function makeSource(): CodexSource {
  return {
    id: 'codex',
    label: 'Codex',
    home,
    sessionsDir: path.join(home, 'sessions'),
    indexPath: path.join(home, 'session_index.jsonl')
  }
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'argos-codex-'))
  made.push(home)
  src = makeSource()
  invalidateCodexScan()
})

afterAll(() => {
  for (const d of made) {
    try {
      fs.rmSync(d, { recursive: true, force: true })
    } catch {
      /* temp dirs */
    }
  }
})

describe('codexDeleteSession', () => {
  it('removes the rollout from disk', async () => {
    const file = writeRollout('2026-09-15T14-30-56', SESSION_A, 'C:\\dev\\proj')
    expect(await codexDeleteSession(src, SESSION_A)).toEqual({ ok: true })
    expect(fs.existsSync(file)).toBe(false)
  })

  it('reports a session it cannot find rather than claiming success', async () => {
    expect(await codexDeleteSession(src, SESSION_A)).toEqual({ ok: false, error: 'not-found' })
  })

  it('deletes an archived conversation too', async () => {
    writeRollout('2026-09-15T14-30-56', SESSION_A, 'C:\\dev\\proj')
    await codexArchiveSession(src, SESSION_A)
    expect(await codexDeleteSession(src, SESSION_A, true)).toEqual({ ok: true })
    expect(await scanCodexArchived(src, true)).toEqual([])
  })
})

describe('codexArchiveSession / codexUnarchiveSession', () => {
  it('moves the rollout into archived_sessions and back to its own date bucket', async () => {
    const stamp = '2026-09-15T14-30-56'
    const original = writeRollout(stamp, SESSION_A, 'C:\\dev\\proj')

    expect(await codexArchiveSession(src, SESSION_A)).toEqual({ ok: true })
    const archivedFile = path.join(codexArchivedDir(src), rolloutName(stamp, SESSION_A))
    expect(fs.existsSync(archivedFile)).toBe(true)
    expect(fs.existsSync(original)).toBe(false)

    expect(await codexUnarchiveSession(src, SESSION_A)).toEqual({ ok: true })
    expect(fs.existsSync(original)).toBe(true)
    expect(fs.existsSync(archivedFile)).toBe(false)
  })

  it('lists an archived conversation only in the archived listing', async () => {
    writeRollout('2026-09-15T14-30-56', SESSION_A, 'C:\\dev\\proj')
    writeRollout('2026-09-15T14-45-57', SESSION_B, 'C:\\dev\\proj')
    await codexArchiveSession(src, SESSION_A)
    invalidateCodexScan()

    const encodedDir = 'C--dev-proj'
    const active = await codexSessions(src, encodedDir)
    const archived = await codexSessions(src, encodedDir, true)
    expect(active.map((s) => s.sessionId)).toEqual([SESSION_B])
    expect(archived.map((s) => s.sessionId)).toEqual([SESSION_A])
    expect(archived[0].archived).toBe(true)
  })
})

describe('codexRenameSession', () => {
  it('appends the new name to the session index', async () => {
    writeRollout('2026-09-15T14-30-56', SESSION_A, 'C:\\dev\\proj')
    expect(await codexRenameSession(src, SESSION_A, '  Refile  the   docs ')).toEqual({ ok: true })
    const line = JSON.parse(fs.readFileSync(src.indexPath, 'utf-8').trim())
    expect(line.id).toBe(SESSION_A)
    expect(line.thread_name).toBe('Refile the docs')
    // The name is what the listing shows, which is the whole point of writing it where
    // Codex keeps its own.
    invalidateCodexScan()
    const [session] = await codexSessions(src, 'C--dev-proj')
    expect(session.title).toBe('Refile the docs')
  })

  it('refuses an empty title without touching the index', async () => {
    writeRollout('2026-09-15T14-30-56', SESSION_A, 'C:\\dev\\proj')
    const res = await codexRenameSession(src, SESSION_A, '   ')
    expect(res.ok).toBe(false)
    expect(fs.existsSync(src.indexPath)).toBe(false)
  })
})

describe('codexMoveSession', () => {
  it('rewrites the cwd in the header and leaves the rest of the transcript alone', async () => {
    const file = writeRollout('2026-09-15T14-30-56', SESSION_A, 'C:\\dev\\proj')
    const before = fs.readFileSync(file, 'utf-8').split('\n')

    expect(await codexMoveSession(src, SESSION_A, 'C:\\dev\\other')).toEqual({ ok: true })

    const after = fs.readFileSync(file, 'utf-8').split('\n')
    expect(JSON.parse(after[0]).payload.cwd).toBe('C:\\dev\\other')
    expect(JSON.parse(after[0]).payload.id).toBe(SESSION_A)
    expect(after.slice(1)).toEqual(before.slice(1))
    // No temp file left behind, whichever way the rewrite went.
    expect(fs.readdirSync(path.dirname(file))).toEqual([path.basename(file)])
  })

  it('files the conversation under the project it was moved to', async () => {
    writeRollout('2026-09-15T14-30-56', SESSION_A, 'C:\\dev\\proj')
    await codexMoveSession(src, SESSION_A, 'C:\\dev\\other')
    invalidateCodexScan()
    expect((await codexSessions(src, 'C--dev-proj')).length).toBe(0)
    expect((await codexSessions(src, 'C--dev-other')).map((s) => s.sessionId)).toEqual([SESSION_A])
  })

  it('refuses a transcript whose first line is not a header', async () => {
    const file = writeRollout('2026-09-15T14-30-56', SESSION_A, 'C:\\dev\\proj')
    await scanCodexRollouts(src, true)
    fs.writeFileSync(file, '{"type":"response_item"}\n', 'utf-8')
    const res = await codexMoveSession(src, SESSION_A, 'C:\\dev\\other')
    expect(res).toMatchObject({ ok: false, error: 'failed' })
  })
})
