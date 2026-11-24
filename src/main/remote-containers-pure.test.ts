import { describe, it, expect } from 'vitest'
import {
  containerShellArgs,
  containerShellCommand,
  listContainersCommand,
  parseContainerListing,
  parsePorts
} from './remote-containers-pure'

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

describe('the compose-aware format', () => {
  it('reads ports, project and service, and keeps rows without labels ungrouped', () => {
    const out = [
      `${MARK} docker`,
      '6dca71d7a13c|lab-server-1|lab:latest|22/tcp, 127.0.0.1:3001->3000/tcp|lab|server|Up 2 hours',
      'c56cd6de1969|lab-db-1|postgres:12|0.0.0.0:5401->5432/tcp, :::5401->5432/tcp|lab|db|Up 2 hours (healthy)',
      'abcdef012345|loose|redis:7||<no value>|<no value>|Exited (0) 1 day ago',
      '111111111111|podman-one|nginx|0.0.0.0:8053->53/udp|||Up 5 minutes'
    ].join('\n')
    const r = parseContainerListing(out)
    if (r.kind !== 'list') throw new Error('expected a list')
    const byName = Object.fromEntries(r.containers.map((c) => [c.name, c]))
    expect(byName['lab-server-1']).toMatchObject({ project: 'lab', service: 'server', ports: ['3001→3000'], running: true })
    expect(byName['lab-db-1']).toMatchObject({ project: 'lab', service: 'db', ports: ['5401→5432'], status: 'Up 2 hours (healthy)' })
    expect(byName.loose.project).toBeUndefined()
    expect(byName.loose.service).toBeUndefined()
    expect(byName.loose.ports).toEqual([])
    expect(byName['podman-one']).toMatchObject({ ports: ['8053→53/udp'], running: true })
  })

  it('asks for the long format first and falls back to the four fields', () => {
    const cmd = listContainersCommand()
    expect(cmd).toContain('com.docker.compose.project')
    expect(cmd.indexOf('--format "$F"')).toBeLessThan(cmd.indexOf('--format "$F0"'))
  })
})

describe('parsePorts', () => {
  it('keeps published ports once and drops exposed ones', () => {
    expect(parsePorts('0.0.0.0:80->80/tcp, :::80->80/tcp, 443/tcp')).toEqual(['80→80'])
    expect(parsePorts('127.0.0.1:9000-9001->9000-9001/tcp')).toEqual(['9000-9001→9000-9001'])
    expect(parsePorts('')).toEqual([])
  })
})

describe('containerShellArgs', () => {
  it('is an argument vector with only the validated id', () => {
    expect(containerShellArgs('docker', 'abcdef012345')).toEqual([
      'exec',
      '-it',
      'abcdef012345',
      'sh',
      '-c',
      'command -v bash >/dev/null 2>&1 && exec bash || exec sh'
    ])
    expect(containerShellArgs('docker', 'web; rm -rf /')).toBeNull()
  })
})
