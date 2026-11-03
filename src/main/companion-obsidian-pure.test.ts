import { describe, it, expect } from 'vitest'
import * as path from 'path'
import { candidateName, cleanSubfolder, exportDir, noteFileName, noteMarkdown, slugify } from './companion-obsidian-pure'
import type { CompanionNote } from './companion-types'

// Tuesday 3 November 2026, 14:05 local.
const created = new Date(2026, 10, 3, 14, 5).getTime()
const note = (over: Partial<CompanionNote> = {}): CompanionNote => ({
  id: 'n1',
  text: 'o servidor de Vila Real usa a porta 8443',
  createdAt: created,
  source: 'voice',
  ...over
})

describe('slugify', () => {
  it('drops accents and punctuation, lower case', () => {
    expect(slugify('Câmara de Évora: ligar à Conceição!')).toBe('camara-de-evora-ligar-a-conceicao')
  })

  it('cuts long text at a word, without a trailing dash', () => {
    const slug = slugify('a reunião com a equipa de infraestrutura sobre a migração dos servidores de produção')
    expect(slug.length).toBeLessThanOrEqual(48)
    expect(slug).toBe('a-reuniao-com-a-equipa-de-infraestrutura-sobre-a')
  })

  it('falls back to "nota" when nothing is left', () => {
    expect(slugify('!!! ???')).toBe('nota')
  })
})

describe('noteFileName', () => {
  it('is the local day and the slug', () => {
    expect(noteFileName(note())).toBe('2026-11-03-o-servidor-de-vila-real-usa-a-porta-8443.md')
  })
})

describe('candidateName', () => {
  it('suffixes before .md from the second try', () => {
    expect(candidateName('2026-11-03-x.md', 1)).toBe('2026-11-03-x.md')
    expect(candidateName('2026-11-03-x.md', 2)).toBe('2026-11-03-x-2.md')
    expect(candidateName('2026-11-03-x.md', 3)).toBe('2026-11-03-x-3.md')
  })
})

describe('noteMarkdown', () => {
  it('writes frontmatter with created, source and the argos tag, then the text', () => {
    expect(noteMarkdown(note())).toBe(
      ['---', 'created: 2026-11-03T14:05', 'source: voice', 'tags:', '  - "argos"', '---', '', 'o servidor de Vila Real usa a porta 8443', ''].join('\n')
    )
  })

  it('quotes tags, strips a leading # and never repeats argos', () => {
    const md = noteMarkdown(note({ tags: ['#infra', 'argos', 'a: b', ' '] }))
    expect(md).toContain('  - "argos"\n  - "infra"\n  - "a: b"\n---')
  })
})

describe('cleanSubfolder', () => {
  it('normalises slashes and trims', () => {
    expect(cleanSubfolder(' /Argos\\Notas/ ')).toBe('Argos/Notas')
    expect(cleanSubfolder('')).toBe('')
  })

  it('refuses anything that leaves the vault or Windows would refuse', () => {
    expect(cleanSubfolder('../fora')).toBeNull()
    expect(cleanSubfolder('Argos/../..')).toBeNull()
    expect(cleanSubfolder('C:\\Windows')).toBeNull()
    expect(cleanSubfolder('\\\\server\\share')).toBeNull()
    expect(cleanSubfolder('a:b')).toBeNull()
    expect(cleanSubfolder('pasta.')).toBeNull()
  })
})

describe('exportDir', () => {
  const vault = path.resolve('vault')

  it('is off without a vault or with a relative one', () => {
    expect(exportDir('', 'Argos')).toBeNull()
    expect(exportDir('vault', 'Argos')).toBeNull()
  })

  it('joins the vault and the subfolder, or is the vault itself', () => {
    expect(exportDir(vault, 'Argos/Notas')).toBe(path.join(vault, 'Argos', 'Notas'))
    expect(exportDir(vault, '')).toBe(path.normalize(vault))
  })

  it('is off for a subfolder that would leave the vault', () => {
    expect(exportDir(vault, '../x')).toBeNull()
  })
})
