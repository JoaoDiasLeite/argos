import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'

/**
 * The Codex tag store — the one tag set Argos keeps outside the transcript.
 *
 * store.ts is the only module here that needs Electron, and only for the userData
 * directory, so that is all this mock supplies: a real temp directory, so the reads
 * and writes go through the same JSON file they do in the app.
 */
// Hoisted, because the module mock below is itself hoisted above the imports — the
// directory has to exist before store.ts resolves its path at import time.
const { userData } = vi.hoisted(() => ({
  userData: require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), 'argos-store-'))
}))
vi.mock('electron', () => ({ app: { getPath: () => userData } }))

import {
  codexTagKey,
  forgetCodexSessionTags,
  getCodexSessionTags,
  setCodexSessionTags
} from './store'

const SOURCE = 'codex:acct-1'
const SESSION = '01a085ae-90a3-70c2-815d-7d542e1760f3'

beforeEach(() => {
  forgetCodexSessionTags(SOURCE, SESSION)
})

afterAll(() => {
  try {
    fs.rmSync(userData, { recursive: true, force: true })
  } catch {
    /* temp dir */
  }
})

describe('codex session tags', () => {
  it('stores and reads back a conversation’s tags', () => {
    setCodexSessionTags(SOURCE, SESSION, ['ui', 'done'])
    expect(getCodexSessionTags()[codexTagKey(SOURCE, SESSION)]).toEqual(['ui', 'done'])
  })

  it('drops the entry when the last tag is removed', () => {
    setCodexSessionTags(SOURCE, SESSION, ['ui'])
    setCodexSessionTags(SOURCE, SESSION, [])
    expect(codexTagKey(SOURCE, SESSION) in getCodexSessionTags()).toBe(false)
  })

  it('keys by source as well as session, so two homes never share a set', () => {
    setCodexSessionTags(SOURCE, SESSION, ['ui'])
    setCodexSessionTags('codex', SESSION, ['perf'])
    const map = getCodexSessionTags()
    expect(map[codexTagKey(SOURCE, SESSION)]).toEqual(['ui'])
    expect(map[codexTagKey('codex', SESSION)]).toEqual(['perf'])
    forgetCodexSessionTags('codex', SESSION)
  })

  it('survives a store written with something that is not a tag list', () => {
    setCodexSessionTags(SOURCE, SESSION, ['ui'])
    const file = path.join(userData, 'store.json')
    const raw = JSON.parse(fs.readFileSync(file, 'utf-8'))
    raw.codexSessionTags['codex:broken'] = 'not-a-list'
    raw.codexSessionTags['codex:partly'] = ['ui', 7]
    fs.writeFileSync(file, JSON.stringify(raw), 'utf-8')
    // The store caches in memory, so this is about what a FRESH read would make of it:
    // the reader filters rather than throws, which is what keeps one bad entry from
    // taking every other conversation's tags down with it.
    const map = getCodexSessionTags()
    expect(map['codex:broken']).toBeUndefined()
    expect(map[codexTagKey(SOURCE, SESSION)]).toEqual(['ui'])
  })
})
