import { describe, it, expect } from 'vitest'
import { containerShellCommand, listContainersCommand, parseContainerListing } from './remote-containers-pure'

const MARK = '@@argos-containers'

describe('parseContainerListing', () => {
  it('reads docker rows, running first', () => {
    const out = [
      `${MARK} docker`,
      '0123456789ab|old_job|alpine:3.19|Exited (0) 2 days ago',
      'abcdef012345|web|nginx:1.27|Up 3 hours',
      '111111111111|db|postgres:16|Up 5 days (healthy)',
      ''
    ].join('\n')
    const r = parseContainerListing(out)
    expect(r.kind).toBe('list')
    if (r.kind !== 'list') return
    expect(r.runtime).toBe('docker')
    expect(r.sudo).toBe(false)
    expect(r.containers.map((c) => c.name)).toEqual(['db', 'web', 'old_job'])
    expect(r.containers[0]).toEqual({
      id: '111111111111',
      name: 'db',
      image: 'postgres:16',
      status: 'Up 5 days (healthy)',
      running: true
    })
    expect(r.containers[2].running).toBe(false)
  })

  it('notes that sudo was needed, and skips a login banner and CRLF', () => {
    const out = `Welcome!\r\n${MARK} sudo podman\r\nabcdef012345|app|localhost/app:latest|Up 2 minutes\r\n`
    const r = parseContainerListing(out)
    expect(r).toMatchObject({ kind: 'list', runtime: 'podman', sudo: true })
    if (r.kind === 'list') expect(r.containers).toHaveLength(1)
  })

  it('returns an empty list when nothing runs', () => {
    expect(parseContainerListing(`${MARK} docker\n\n`)).toEqual({ kind: 'list', runtime: 'docker', sudo: false, containers: [] })
  })

  it('drops rows whose id is not hex', () => {
    const out = `${MARK} docker\n$(reboot)|x|y|Up 1 second\nabcdef012345|ok|img|Up 1 second\n`
    const r = parseContainerListing(out)
    if (r.kind !== 'list') throw new Error('expected a list')
    expect(r.containers.map((c) => c.id)).toEqual(['abcdef012345'])
  })

  it('reports no runtime, a refused one, and garbage', () => {
    expect(parseContainerListing(`${MARK} none\n`)).toEqual({ kind: 'none' })
    expect(
      parseContainerListing(`${MARK} failed docker\npermission denied while trying to connect to the Docker daemon socket\n`)
    ).toEqual({ kind: 'failed', runtime: 'docker', detail: 'permission denied while trying to connect to the Docker daemon socket' })
    expect(parseContainerListing('bash: sh: command not found\n')).toEqual({ kind: 'garbled' })
    expect(parseContainerListing(`${MARK} kubectl\n`)).toEqual({ kind: 'garbled' })
  })
})

describe('containerShellCommand', () => {
  it('builds an exec with only the id', () => {
    expect(containerShellCommand('docker', false, 'abcdef012345')).toBe(
      "docker exec -it abcdef012345 sh -c 'command -v bash >/dev/null 2>&1 && exec bash || exec sh'"
    )
    expect(containerShellCommand('podman', true, 'abcdef012345')).toMatch(/^sudo podman exec -it abcdef012345 /)
  })

  it('refuses anything that is not an id', () => {
    expect(containerShellCommand('docker', false, 'web; rm -rf /')).toBeNull()
    expect(containerShellCommand('docker', false, 'ABCDEF012345')).toBeNull()
    expect(containerShellCommand('docker', false, 'abc')).toBeNull()
  })
})

describe('listContainersCommand', () => {
  it('is one sh -c with the marker and both runtimes', () => {
    const cmd = listContainersCommand()
    expect(cmd.startsWith("sh -c '")).toBe(true)
    expect(cmd).toContain(MARK)
    expect(cmd).toContain('docker podman')
    expect(cmd).toContain('sudo -n')
  })
})
