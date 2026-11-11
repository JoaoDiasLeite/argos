import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { loadJsonFileGuarded, writeJsonFileAtomic } from './json-file'
import { isPlainObject } from './json-load-pure'

let dir: string
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'argos-jsonfile-'))
})
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('loadJsonFileGuarded', () => {
  it('missing file: missing, nothing created', () => {
    expect(loadJsonFileGuarded(path.join(dir, 'config.json'), isPlainObject).kind).toBe('missing')
    expect(fs.readdirSync(dir)).toEqual([])
  })

  it('valid file: ok, no copy', () => {
    const p = path.join(dir, 'config.json')
    writeJsonFileAtomic(p, { a: 1 })
    expect(loadJsonFileGuarded(p, isPlainObject)).toEqual({ kind: 'ok', value: { a: 1 } })
    expect(fs.readdirSync(dir)).toEqual(['config.json'])
  })

  it('truncated and wrong-shape files are copied aside, original left in place', () => {
    for (const body of ['{"a": 1, "b', '[1,2]', '"str"']) {
      const p = path.join(dir, 'config.json')
      fs.writeFileSync(p, body)
      expect(loadJsonFileGuarded(p, isPlainObject).kind).toBe('corrupt')
      const copies = fs.readdirSync(dir).filter((f) => f.startsWith('config.json.corrupt-'))
      expect(copies.length).toBeGreaterThan(0)
      expect(copies.some((c) => fs.readFileSync(path.join(dir, c), 'utf-8') === body)).toBe(true)
      for (const c of copies) fs.unlinkSync(path.join(dir, c))
    }
  })

  it('keeps at most three corrupt copies', () => {
    const p = path.join(dir, 'config.json')
    for (let i = 1; i <= 5; i++) fs.writeFileSync(`${p}.corrupt-${i}`, 'old')
    fs.writeFileSync(p, '{')
    loadJsonFileGuarded(p, isPlainObject)
    expect(fs.readdirSync(dir).filter((f) => f.startsWith('config.json.corrupt-'))).toHaveLength(3)
  })

  it('a read error that is not ENOENT or a parse error is unreadable and makes no copy', () => {
    // A directory in place of the file: readFileSync throws EISDIR, a stand-in for a lock.
    const p = path.join(dir, 'config.json')
    fs.mkdirSync(p)
    expect(loadJsonFileGuarded(p, isPlainObject).kind).toBe('unreadable')
    expect(fs.readdirSync(dir)).toEqual(['config.json'])
  })
})
