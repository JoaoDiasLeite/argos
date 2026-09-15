import { describe, it, expect } from 'vitest'
import {
  changeNoun,
  changeLabel,
  kindLabel,
  refSigil,
  sigilIsMeaningful,
  forgeFromRemote,
  looksLikeForge,
  pickForgeServer
} from './forge-pure'

describe('forge vocabulary', () => {
  it('names the change request the way each forge does', () => {
    expect(changeNoun('gitlab')).toBe('merge request')
    expect(changeNoun('github')).toBe('pull request')
    expect(changeNoun('github', true)).toBe('pull requests')
    expect(changeLabel('gitlab')).toBe('Merge request')
    expect(changeLabel('github')).toBe('Pull request')
  })

  it('labels a row by forge and kind', () => {
    expect(kindLabel('github', 'merge-request')).toBe('Pull request')
    expect(kindLabel('gitlab', 'merge-request')).toBe('Merge request')
    expect(kindLabel('github', 'issue')).toBe('Issue')
  })

  it('only writes ! where GitLab would', () => {
    expect(refSigil('gitlab', 'merge-request')).toBe('!')
    expect(refSigil('gitlab', 'issue')).toBe('#')
    // GitHub numbers issues and PRs in one sequence and writes both with #.
    expect(refSigil('github', 'merge-request')).toBe('#')
    expect(refSigil('github', 'issue')).toBe('#')
  })

  it('knows the sigil identifies a kind on GitLab only', () => {
    expect(sigilIsMeaningful('gitlab')).toBe(true)
    expect(sigilIsMeaningful('github')).toBe(false)
  })
})

describe('forgeFromRemote', () => {
  it('reads the common remote forms', () => {
    expect(forgeFromRemote('https://gitlab.com/group/repo.git')).toBe('gitlab')
    expect(forgeFromRemote('git@github.com:owner/repo.git')).toBe('github')
    expect(forgeFromRemote('ssh://git@gitlab.com:22/group/repo.git')).toBe('gitlab')
  })

  it('recognises self-hosted installs', () => {
    // The case in front of us: a company GitLab on its own domain.
    expect(forgeFromRemote('https://gitlab.cityfy.pt/adm/wm-project')).toBe('gitlab')
    expect(forgeFromRemote('git@github.acme.internal:team/app.git')).toBe('github')
  })

  it('says nothing rather than guessing', () => {
    expect(forgeFromRemote('https://bitbucket.org/team/repo.git')).toBeNull()
    expect(forgeFromRemote('https://git.acme.com/team/repo.git')).toBeNull()
    expect(forgeFromRemote('')).toBeNull()
    expect(forgeFromRemote(null)).toBeNull()
  })
})

describe('looksLikeForge', () => {
  it('matches on name, url or env', () => {
    expect(looksLikeForge({ name: 'gitlab' }, 'gitlab')).toBe(true)
    expect(looksLikeForge({ name: 'wm-git' }, 'gitlab')).toBe(true)
    expect(looksLikeForge({ name: 'gh', url: 'https://api.github.com/mcp' }, 'github')).toBe(true)
    expect(
      looksLikeForge({ name: 'srv', config: { env: { GITHUB_TOKEN: 'x' } } }, 'github')
    ).toBe(true)
  })

  it('does not cross the two forges', () => {
    expect(looksLikeForge({ name: 'gitlab' }, 'github')).toBe(false)
    expect(looksLikeForge({ name: 'github' }, 'gitlab')).toBe(false)
  })
})

describe('pickForgeServer', () => {
  const gl = { name: 'wm-git' }
  const gh = { name: 'github-mcp' }

  it('prefers the forge the project actually uses', () => {
    expect(pickForgeServer([gl, gh], 'github')).toEqual({ server: gh, forge: 'github' })
    expect(pickForgeServer([gl, gh], 'gitlab')).toEqual({ server: gl, forge: 'gitlab' })
  })

  it('takes the only one configured when the remote says otherwise', () => {
    // Preferring GitHub is no use if only the GitLab MCP exists.
    expect(pickForgeServer([gl], 'github')).toEqual({ server: gl, forge: 'gitlab' })
  })

  it('falls back to GitLab when nothing points either way', () => {
    expect(pickForgeServer([gl, gh], null)).toEqual({ server: gl, forge: 'gitlab' })
  })

  it('finds nothing when no forge server is configured', () => {
    expect(pickForgeServer([{ name: 'filesystem' }], 'gitlab')).toBeNull()
    expect(pickForgeServer([], null)).toBeNull()
  })
})
