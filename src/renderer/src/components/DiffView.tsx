// Core build + a curated language set, instead of the full `highlight.js` (which pulls
// ~190 grammars and roughly doubled the renderer bundle). Languages we don't register
// just fall through highlightLine's try/catch to plain escaped text — safe degradation.
import hljs from 'highlight.js/lib/core'
import typescript from 'highlight.js/lib/languages/typescript'
import javascript from 'highlight.js/lib/languages/javascript'
import python from 'highlight.js/lib/languages/python'
import bash from 'highlight.js/lib/languages/bash'
import json from 'highlight.js/lib/languages/json'
import css from 'highlight.js/lib/languages/css'
import scss from 'highlight.js/lib/languages/scss'
import less from 'highlight.js/lib/languages/less'
import xml from 'highlight.js/lib/languages/xml'
import yaml from 'highlight.js/lib/languages/yaml'
import markdown from 'highlight.js/lib/languages/markdown'
import go from 'highlight.js/lib/languages/go'
import rust from 'highlight.js/lib/languages/rust'
import java from 'highlight.js/lib/languages/java'
import c from 'highlight.js/lib/languages/c'
import cpp from 'highlight.js/lib/languages/cpp'
import csharp from 'highlight.js/lib/languages/csharp'
import ruby from 'highlight.js/lib/languages/ruby'
import php from 'highlight.js/lib/languages/php'
import sql from 'highlight.js/lib/languages/sql'
import powershell from 'highlight.js/lib/languages/powershell'
import ini from 'highlight.js/lib/languages/ini'
import dockerfile from 'highlight.js/lib/languages/dockerfile'
import kotlin from 'highlight.js/lib/languages/kotlin'
import swift from 'highlight.js/lib/languages/swift'
import lua from 'highlight.js/lib/languages/lua'
import r from 'highlight.js/lib/languages/r'
import makefile from 'highlight.js/lib/languages/makefile'
import { useT } from '../i18n'
import './DiffView.css'

for (const [name, lang] of [
  ['typescript', typescript], ['javascript', javascript], ['python', python],
  ['bash', bash], ['json', json], ['css', css], ['scss', scss], ['less', less],
  ['xml', xml], ['yaml', yaml], ['markdown', markdown], ['go', go], ['rust', rust],
  ['java', java], ['c', c], ['cpp', cpp], ['csharp', csharp], ['ruby', ruby],
  ['php', php], ['sql', sql], ['powershell', powershell], ['ini', ini],
  ['dockerfile', dockerfile], ['kotlin', kotlin], ['swift', swift], ['lua', lua],
  ['r', r], ['makefile', makefile]
] as const) {
  hljs.registerLanguage(name, lang)
}

interface Props {
  oldText: string
  newText: string
  /** Optional file path used to infer syntax highlighting language. */
  filePath?: string
}

interface Row {
  type: 'context' | 'add' | 'del'
  text: string
}

/**
 * Minimal line-level diff using the classic LCS table. Good enough for showing what an
 * Edit/Write will change — not a full Myers diff, but clear and dependency-free.
 */
function diffLines(a: string[], b: string[]): Row[] {
  const n = a.length
  const m = b.length
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1])
    }
  }
  const rows: Row[] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      rows.push({ type: 'context', text: a[i] })
      i++
      j++
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      rows.push({ type: 'del', text: a[i] })
      i++
    } else {
      rows.push({ type: 'add', text: b[j] })
      j++
    }
  }
  while (i < n) rows.push({ type: 'del', text: a[i++] })
  while (j < m) rows.push({ type: 'add', text: b[j++] })
  return rows
}

/** Infer hljs language from a file path extension. Returns undefined if not recognized. */
export function langFromPath(filePath?: string): string | undefined {
  if (!filePath) return undefined
  const ext = filePath.split('.').pop()?.toLowerCase()
  if (!ext) return undefined
  // Map common extensions to hljs language names
  const map: Record<string, string> = {
    ts: 'typescript',
    tsx: 'typescript',
    js: 'javascript',
    jsx: 'javascript',
    mjs: 'javascript',
    cjs: 'javascript',
    py: 'python',
    rb: 'ruby',
    rs: 'rust',
    go: 'go',
    java: 'java',
    kt: 'kotlin',
    cs: 'csharp',
    cpp: 'cpp',
    cc: 'cpp',
    c: 'c',
    h: 'c',
    hpp: 'cpp',
    sh: 'bash',
    bash: 'bash',
    zsh: 'bash',
    fish: 'bash',
    ps1: 'powershell',
    css: 'css',
    scss: 'scss',
    less: 'less',
    html: 'xml',
    htm: 'xml',
    xml: 'xml',
    svg: 'xml',
    json: 'json',
    yaml: 'yaml',
    yml: 'yaml',
    toml: 'ini',
    ini: 'ini',
    md: 'markdown',
    sql: 'sql',
    graphql: 'graphql',
    gql: 'graphql',
    swift: 'swift',
    php: 'php',
    r: 'r',
    dart: 'dart',
    lua: 'lua',
    vim: 'vim',
    dockerfile: 'dockerfile',
    makefile: 'makefile',
  }
  return map[ext]
}

/**
 * Highlight a single line's text using hljs. Returns an HTML string.
 * Falls back to the plain text (escaped) if language is unknown or hljs throws.
 */
function highlightLine(text: string, lang: string | undefined): string {
  if (!lang || text.trim() === '') return escapeHtml(text)
  try {
    return hljs.highlight(text, { language: lang, ignoreIllegals: true }).value
  } catch {
    return escapeHtml(text)
  }
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/**
 * Highlight a whole block of text (e.g. a file's contents) using hljs, keyed off a file
 * path's extension. Returns an HTML string safe for dangerouslySetInnerHTML, or the plain
 * escaped text if the language is unknown, too large to highlight, or hljs throws.
 */
export function highlightBlock(text: string, filePath?: string): string {
  if (text.length > HIGHLIGHT_CHAR_LIMIT) return escapeHtml(text)
  const lang = langFromPath(filePath)
  if (!lang) return escapeHtml(text)
  try {
    return hljs.highlight(text, { language: lang, ignoreIllegals: true }).value
  } catch {
    return escapeHtml(text)
  }
}

const SIGN: Record<Row['type'], string> = { context: ' ', add: '+', del: '-' }

/** Above this row count, skip syntax highlighting to avoid hanging the renderer. */
const HIGHLIGHT_ROW_LIMIT = 2000

/** Above this character count for either input, skip highlighting entirely. */
const HIGHLIGHT_CHAR_LIMIT = 200_000

export default function DiffView({ oldText, newText, filePath }: Props) {
  const t = useT()
  const rows = diffLines(oldText.split('\n'), newText.split('\n'))
  const tooLarge =
    rows.length > HIGHLIGHT_ROW_LIMIT ||
    oldText.length > HIGHLIGHT_CHAR_LIMIT ||
    newText.length > HIGHLIGHT_CHAR_LIMIT
  const lang = tooLarge ? undefined : langFromPath(filePath)
  return (
    <div className="diff-view">
      {tooLarge && (
        <div className="diff-truncation-notice">
          {t('editor.diff.large')}
        </div>
      )}
      {rows.map((r, i) => (
        <div key={i} className={`diff-row ${r.type}`}>
          <span className="diff-sign">{SIGN[r.type]}</span>
          {lang ? (
            <span
              className="diff-text hljs"
              // eslint-disable-next-line react/no-danger
              dangerouslySetInnerHTML={{ __html: highlightLine(r.text || ' ', lang) }}
            />
          ) : (
            <span className="diff-text">{r.text || ' '}</span>
          )}
        </div>
      ))}
    </div>
  )
}
