import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { MigrationState, migrateLegacySessions } from './session-migrate'

let root: string
let sessionsDir: string
let backupDir: string
let exportsDir: string

const T0 = new Date(2026, 5, 3, 9, 15).getTime()

function legacy(id: string, model: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    name: `Chat ${id}`,
    createdAt: T0,
    updatedAt: T0,
    model,
    claudeSessionId: `cc-${id}`,
    costUsd: 0.5,
    messages: [
      { role: 'user', content: 'hi', timestamp: T0 },
      { role: 'assistant', content: 'hello', timestamp: T0 + 1000, toolCalls: [{ id: 't', tool: 'Bash', input: { command: 'ls' } }] }
    ],
    ...over
  }
}

function writeSession(file: string, content: string): void {
  fs.writeFileSync(path.join(sessionsDir, file), content)
}

function readSession(file: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(sessionsDir, file), 'utf-8'))
}

async function run(states: MigrationState[] = []) {
  return migrateLegacySessions({ sessionsDir, backupDir, exportsDir, writeState: (s) => void states.push(s) })
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'session-migrate-test-'))
  sessionsDir = path.join(root, 'sessions')
  backupDir = path.join(root, 'sessions-pre-2.0')
  exportsDir = path.join(root, 'exports', 'chats')
  fs.mkdirSync(sessionsDir)
})

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

describe('migrateLegacySessions', () => {
  it('exports, backs up and rewrites legacy sessions; leaves the rest alone', async () => {
    // With a BOM on the first one, as PowerShell 5.1 writes.
    const aRaw = '\uFEFF' + JSON.stringify(legacy('a', 'claude-opus-5', { extra: 'kept' }), null, 2)
    const bRaw = JSON.stringify(legacy('b', 'gpt-5.6-sol'))
    const doneRaw = JSON.stringify({ id: 'done', name: 'x', provider: 'claude', hasTerminalActivity: true, createdAt: T0, updatedAt: T0 })
    const badRaw = '{ "id": "bad", "messages": ['
    writeSession('a.json', aRaw)
    writeSession('b.json', bRaw)
    writeSession('done.json', doneRaw)
    writeSession('bad.json', badRaw)
    fs.writeFileSync(path.join(sessionsDir, 'notes.txt'), 'ignored')

    const states: MigrationState[] = []
    const res = await run(states)

    expect(res.exported).toBe(2)
    expect(res.skipped).toBe(1)
    expect(res.failed).toHaveLength(1)
    expect(res.failed[0].id).toBe('bad')
    expect(res.failed[0].error).toBeTruthy()

    expect(states).toHaveLength(1)
    expect(states[0]).toMatchObject({ version: '2.0.0', exported: 2, failed: res.failed })
    expect(typeof states[0].ranAt).toBe('number')

    // Backups are byte-for-byte copies.
    expect(fs.readFileSync(path.join(backupDir, 'a.json'), 'utf-8')).toBe(aRaw)
    expect(fs.readFileSync(path.join(backupDir, 'b.json'), 'utf-8')).toBe(bRaw)
    expect(fs.existsSync(path.join(backupDir, 'done.json'))).toBe(false)
    expect(fs.existsSync(path.join(backupDir, 'bad.json'))).toBe(false)

    const exports = fs.readdirSync(exportsDir).sort()
    expect(exports).toEqual(['2026-06-03-chat-a-a.md', '2026-06-03-chat-b-b.md'])
    const md = fs.readFileSync(path.join(exportsDir, exports[0]), 'utf-8')
    expect(md).toContain('# Chat a')
    expect(md).toContain('- \u{1F527} Bash ls')

    const a = readSession('a.json')
    expect(a).not.toHaveProperty('messages')
    expect(a).not.toHaveProperty('model')
    expect(a).not.toHaveProperty('costUsd')
    expect(a.provider).toBe('claude')
    expect(a.archivedTranscript).toBe(path.join(exportsDir, '2026-06-03-chat-a-a.md'))
    expect(a.hasTerminalActivity).toBe(false)
    expect(a.claudeSessionId).toBe('cc-a')
    expect(a.extra).toBe('kept')

    const b = readSession('b.json')
    expect(b).not.toHaveProperty('messages')
    expect(b.provider).toBe('codex')
    expect(b).not.toHaveProperty('claudeSessionId')

    expect(fs.readFileSync(path.join(sessionsDir, 'done.json'), 'utf-8')).toBe(doneRaw)
    expect(fs.readFileSync(path.join(sessionsDir, 'bad.json'), 'utf-8')).toBe(badRaw)
    expect(fs.readdirSync(sessionsDir).filter((f) => f.endsWith('.tmp'))).toEqual([])
  })

  it('exports nothing new on a second run', async () => {
    writeSession('a.json', JSON.stringify(legacy('a', 'claude-opus-5')))
    writeSession('b.json', JSON.stringify(legacy('b', 'gemini-3-flash-preview')))
    const first = await run()
    expect(first.exported).toBe(2)
    const after = fs.readFileSync(path.join(sessionsDir, 'a.json'), 'utf-8')

    const second = await run()
    expect(second).toEqual({ exported: 0, upgraded: 0, skipped: 2, failed: [] })
    expect(fs.readdirSync(exportsDir)).toHaveLength(2)
    expect(fs.readdirSync(backupDir)).toHaveLength(2)
    expect(fs.readFileSync(path.join(sessionsDir, 'a.json'), 'utf-8')).toBe(after)
  })

  it('never overwrites an existing different backup and leaves that session untouched', async () => {
    const raw = JSON.stringify(legacy('a', 'claude-opus-5'))
    writeSession('a.json', raw)
    fs.mkdirSync(backupDir)
    fs.writeFileSync(path.join(backupDir, 'a.json'), 'older backup')

    const res = await run()
    expect(res.exported).toBe(0)
    expect(res.failed.map((f) => f.id)).toEqual(['a'])
    expect(fs.readFileSync(path.join(backupDir, 'a.json'), 'utf-8')).toBe('older backup')
    expect(fs.readFileSync(path.join(sessionsDir, 'a.json'), 'utf-8')).toBe(raw)
  })

  it('retries after a partial run whose backup and export were already written', async () => {
    const raw = JSON.stringify(legacy('a', 'claude-opus-5'))
    writeSession('a.json', raw)
    fs.mkdirSync(backupDir)
    fs.writeFileSync(path.join(backupDir, 'a.json'), raw)

    const res = await run()
    expect(res).toEqual({ exported: 1, upgraded: 0, skipped: 0, failed: [] })
    expect(readSession('a.json')).not.toHaveProperty('messages')
  })

  it('treats a missing sessions dir as empty', async () => {
    fs.rmSync(sessionsDir, { recursive: true })
    expect(await run()).toEqual({ exported: 0, upgraded: 0, skipped: 0, failed: [] })
  })

  it('rewrites a messageless pre-2.0 session to the 2.0 shape without exporting it', async () => {
    writeSession('t.json', JSON.stringify({ id: 't', name: 'T', model: 'gemini-3-flash-preview', permissionMode: 'default', hasTerminalActivity: true, createdAt: T0, updatedAt: T0 }))
    const res = await run()
    expect(res).toEqual({ exported: 0, upgraded: 1, skipped: 0, failed: [] })
    const t = readSession('t.json')
    expect(t.provider).toBe('gemini')
    expect(t).not.toHaveProperty('model')
    expect(t).not.toHaveProperty('permissionMode')
    expect(t.hasTerminalActivity).toBe(true)
    expect(fs.existsSync(backupDir)).toBe(false)
    expect(fs.existsSync(exportsDir)).toBe(false)
    expect((await run()).upgraded).toBe(0)
  })
})
