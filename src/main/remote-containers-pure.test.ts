import { describe, it, expect } from 'vitest'
import {
  actionErrorText,
  composeActionArgv,
  composeActionCommand,
  composeProbeCommand,
  containerActionArgs,
  containerActionCommand,
  containerStatsCommand,
  isComposeProject,
  parseContainerStats,
  statsFor,
  containerLogsArgs,
  containerLogsCommand,
  readContainerLogsOptions,
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

describe('readContainerLogsOptions', () => {
  it('accepts the fixed tails, as strings or numbers, and returns the list value', () => {
    expect(readContainerLogsOptions({ follow: true, tail: '500', timestamps: false })).toEqual({ follow: true, tail: '500', timestamps: false })
    expect(readContainerLogsOptions({ follow: false, tail: 2000, timestamps: true })).toEqual({ follow: false, tail: '2000', timestamps: true })
    expect(readContainerLogsOptions({ follow: true, tail: 'all', timestamps: false })?.tail).toBe('all')
  })

  it('refuses anything off the list or of the wrong type', () => {
    const base = { follow: true, timestamps: false }
    for (const tail of ['100', '500 ', '0500', '500; rm -rf /', '$(id)', 'ALL', 1e3, 500.5, -500, ['all'], ['500'], null, undefined, {}]) {
      expect(readContainerLogsOptions({ ...base, tail })).toBeNull()
    }
    expect(readContainerLogsOptions({ follow: 'true', tail: '500', timestamps: false })).toBeNull()
    expect(readContainerLogsOptions({ follow: true, tail: '500', timestamps: 1 })).toBeNull()
    expect(readContainerLogsOptions({ follow: true, tail: '500' })).toBeNull()
    expect(readContainerLogsOptions(null)).toBeNull()
    expect(readContainerLogsOptions('follow')).toBeNull()
    expect(readContainerLogsOptions([true, '500', false])).toBeNull()
  })
})

describe('containerLogsArgs', () => {
  const id = 'abcdef012345'
  it('builds the vector from the options', () => {
    expect(containerLogsArgs('docker', id, { follow: true, tail: '500', timestamps: false })).toEqual(['logs', '--tail', '500', '-f', id])
    expect(containerLogsArgs('podman', id, { follow: false, tail: 'all', timestamps: true })).toEqual(['logs', '--tail', 'all', '--timestamps', id])
    expect(containerLogsArgs('docker', id, { follow: true, tail: 200, timestamps: true })).toEqual(['logs', '--tail', '200', '--timestamps', '-f', id])
  })

  it('refuses a bad id, tail or runtime', () => {
    const ok = { follow: true, tail: '500', timestamps: false }
    expect(containerLogsArgs('docker', 'web; rm -rf /', ok)).toBeNull()
    expect(containerLogsArgs('docker', '$(reboot)', ok)).toBeNull()
    expect(containerLogsArgs('docker', 'ABCDEF012345', ok)).toBeNull()
    expect(containerLogsArgs('docker', `${id}\n`, ok)).toBeNull()
    expect(containerLogsArgs('docker', id, { ...ok, tail: '500 --since=1h' })).toBeNull()
    expect(containerLogsArgs('docker', id, { ...ok, tail: "500'; id; '" })).toBeNull()
    expect(containerLogsArgs('docker', id, undefined)).toBeNull()
    expect(containerLogsArgs('nerdctl' as 'docker', id, ok)).toBeNull()
  })
})

describe('containerLogsCommand', () => {
  const id = 'abcdef012345'
  it('is the vector as one command line, with the id quoted', () => {
    expect(containerLogsCommand('docker', false, id, { follow: true, tail: '500', timestamps: false })).toBe(`docker logs --tail 500 -f '${id}'`)
    expect(containerLogsCommand('docker', false, id, { follow: false, tail: 'all', timestamps: true })).toBe(`docker logs --tail all --timestamps '${id}'`)
  })

  it('uses sudo when the listing did, and only for a real true', () => {
    expect(containerLogsCommand('podman', true, id, { follow: true, tail: '2000', timestamps: false })).toBe(`sudo podman logs --tail 2000 -f '${id}'`)
    expect(containerLogsCommand('docker', 'yes' as unknown as boolean, id, { follow: true, tail: '200', timestamps: false })).toBe(`docker logs --tail 200 -f '${id}'`)
  })

  it('refuses injection in the id and in the tail', () => {
    expect(containerLogsCommand('docker', true, "abcdef012345'; id; '", { follow: true, tail: '500', timestamps: false })).toBeNull()
    expect(containerLogsCommand('docker', true, id, { follow: true, tail: '500 && id', timestamps: false })).toBeNull()
    expect(containerLogsCommand('docker', true, id, { follow: true, tail: '`id`', timestamps: false })).toBeNull()
  })
})

describe('containerActionArgs / containerActionCommand', () => {
  const id = 'abcdef012345'
  it('builds start, stop and restart from the id', () => {
    expect(containerActionArgs('docker', id, 'start')).toEqual(['start', id])
    expect(containerActionArgs('podman', id, 'restart')).toEqual(['restart', id])
    expect(containerActionCommand('docker', false, id, 'stop')).toBe(`docker stop '${id}'`)
  })

  it('uses sudo -n when the listing did, and only for a real true', () => {
    expect(containerActionCommand('docker', true, id, 'restart')).toBe(`sudo -n docker restart '${id}'`)
    expect(containerActionCommand('docker', 1 as unknown as boolean, id, 'restart')).toBe(`docker restart '${id}'`)
  })

  it('refuses an action outside the fixed list', () => {
    for (const a of ['rm', 'kill', 'start; id', 'Stop', '', null, ['stop'], 3]) {
      expect(containerActionArgs('docker', id, a)).toBeNull()
      expect(containerActionCommand('docker', false, id, a)).toBeNull()
    }
  })

  it('refuses injection in the id', () => {
    for (const bad of ['web', `${id}; reboot`, '$(id)', `${id}\n`, `'${id}'`, 'ABCDEF012345', `${id} --time 0`, 42]) {
      expect(containerActionArgs('docker', bad, 'stop')).toBeNull()
      expect(containerActionCommand('docker', true, bad, 'stop')).toBeNull()
    }
    expect(containerActionArgs('nerdctl' as 'docker', id, 'stop')).toBeNull()
  })
})

describe('compose project actions', () => {
  it('accepts compose project names only', () => {
    expect(isComposeProject('argos-vc-demo')).toBe(true)
    expect(isComposeProject('portal_videos2')).toBe(true)
    expect(isComposeProject('a'.repeat(64))).toBe(true)
    for (const bad of ['a'.repeat(65), '-x', '_x', 'Upper', 'a b', 'a;id', '$(id)', "a'b", 'a/b', '', 'a\nb', null, 7]) {
      expect(isComposeProject(bad)).toBe(false)
    }
  })

  it('builds the plugin and the standalone forms', () => {
    expect(composeActionArgv('docker', 'plugin', 'demo', 'restart')).toEqual({ cmd: 'docker', args: ['compose', '-p', 'demo', 'restart'] })
    expect(composeActionArgv('docker', 'standalone', 'demo', 'stop')).toEqual({ cmd: 'docker-compose', args: ['-p', 'demo', 'stop'] })
    expect(composeActionArgv('podman', 'plugin', 'demo', 'start')).toEqual({ cmd: 'podman', args: ['compose', '-p', 'demo', 'start'] })
    // Podman has no standalone fallback: it is reported as not supported instead.
    expect(composeActionArgv('podman', 'standalone', 'demo', 'start')).toBeNull()
  })

  it('quotes the project and uses sudo -n in the command line', () => {
    expect(composeActionCommand('docker', false, 'plugin', 'demo', 'stop')).toBe(`docker compose -p 'demo' stop`)
    expect(composeActionCommand('docker', true, 'standalone', 'demo', 'start')).toBe(`sudo -n docker-compose -p 'demo' start`)
    expect(composeProbeCommand('docker', true, 'plugin')).toBe('sudo -n docker compose version')
    expect(composeProbeCommand('docker', false, 'standalone')).toBe('docker-compose version')
    expect(composeProbeCommand('podman', false, 'standalone')).toBeNull()
  })

  it('refuses injection in the project and a bad action', () => {
    for (const bad of ["demo'; reboot; '", 'demo && id', 'demo\nid', '`id`', '--file=/etc/passwd', 'demo stop']) {
      expect(composeActionArgv('docker', 'plugin', bad, 'stop')).toBeNull()
      expect(composeActionCommand('docker', true, 'plugin', bad, 'stop')).toBeNull()
    }
    expect(composeActionArgv('docker', 'plugin', 'demo', 'down')).toBeNull()
    expect(composeActionArgv('docker', 'plugin', 'demo', 'rm')).toBeNull()
    expect(composeActionArgv('docker', 'other' as 'plugin', 'demo', 'stop')).toBeNull()
  })
})

describe('actionErrorText', () => {
  it('keeps the last lines, without escapes or blanks', () => {
    const err = '\x1b[1A\x1b[2K Container demo-a-1  Stopping\r\n\n Container demo-a-1  Stopped\nline3\nline4\nError response from daemon: boom\n'
    expect(actionErrorText(err)).toBe('Container demo-a-1  Stopped\nline3\nline4\nError response from daemon: boom')
  })

  it('cuts a long message from the front', () => {
    const text = actionErrorText('x'.repeat(1000), 4, 50)
    expect(text.length).toBe(50)
    expect(text.startsWith('…')).toBe(true)
  })

  it('is empty for nothing readable', () => {
    expect(actionErrorText('\x1b[0m\n  \n')).toBe('')
  })
})

describe('container stats', () => {
  it('builds the stats command with the format quoted', () => {
    expect(containerStatsCommand('docker', false)).toBe(`docker stats --no-stream --format '{{.ID}}|{{.CPUPerc}}|{{.MemUsage}}|{{.MemPerc}}'`)
    expect(containerStatsCommand('podman', true)).toMatch(/^sudo -n podman stats --no-stream --format '/)
  })

  it('parses docker and podman rows', () => {
    const out = [
      'abcdef012345|3.21%|245.3MiB / 7.6GiB|3.15%',
      '0123456789abcdef0123|0.00%|1.2MB / 8.2GB|0.01%\r',
      'ffffffffffff|--|-- / --|--',
      'not a row',
      'zzzzzzzzzzzz|1%|1MiB / 2MiB|50%',
      ''
    ].join('\n')
    expect(parseContainerStats(out)).toEqual([
      { id: 'abcdef012345', cpu: 3.21, mem: '245.3MiB / 7.6GiB', memPerc: 3.15 },
      { id: '0123456789abcdef0123', cpu: 0, mem: '1.2MB / 8.2GB', memPerc: 0.01 },
      { id: 'ffffffffffff', cpu: null, mem: '', memPerc: null }
    ])
  })

  it('drops a memory column that is not plain sizes', () => {
    expect(parseContainerStats('abcdef012345|1%|<img src=x>|1%')[0].mem).toBe('')
  })

  it('matches rows by id prefix, either way', () => {
    const rows = parseContainerStats('abcdef012345|1%|1MiB / 2MiB|50%\n0123456789abcdef|2%|1MiB / 2MiB|50%')
    expect(statsFor(rows, 'abcdef012345')?.cpu).toBe(1)
    expect(statsFor(rows, 'abcdef0123456789abcdef')?.cpu).toBe(1)
    expect(statsFor(rows, '0123456789ab')?.cpu).toBe(2)
    expect(statsFor(rows, '999999999999')).toBeUndefined()
    expect(statsFor(rows, 'abc')).toBeUndefined()
  })
})
