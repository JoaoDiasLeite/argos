import { describe, it, expect } from 'vitest'
import { groupContainers, readStatus, statsLine, statsTone } from './container-groups'
import type { RemoteContainerRow } from '../types'

const row = (id: string, name: string, running: boolean, project?: string, service?: string): RemoteContainerRow => ({
  id: id.padEnd(12, '0'),
  name,
  image: `${name}:latest`,
  status: running ? 'Up 1 hour' : 'Exited (0) 1 day ago',
  running,
  project,
  service
})

const rows = [
  row('a', 'lab-db-1', true, 'lab', 'db'),
  row('b', 'lab-app-1', false, 'lab', 'app'),
  row('c', 'old-web-1', false, 'old', 'web'),
  row('d', 'adhoc', true),
  row('e', 'api-worker-1', true, 'api', 'worker'),
  row('f', 'scratch', false)
]

describe('groupContainers', () => {
  it('groups by project, running projects first, the rest loose', () => {
    const g = groupContainers(rows)
    expect(g.groups.map((x) => x.project)).toEqual(['api', 'lab', 'old'])
    expect(g.groups[1].containers.map((c) => c.service)).toEqual(['db', 'app'])
    expect(g.groups[1].running).toBe(1)
    expect(g.loose.map((c) => c.name)).toEqual(['adhoc', 'scratch'])
  })

  it('hides stopped containers and the projects left empty', () => {
    const g = groupContainers(rows, { runningOnly: true })
    expect(g.groups.map((x) => x.project)).toEqual(['api', 'lab'])
    // The count is the project's, not what is shown of it.
    expect(g.groups[1]).toMatchObject({ running: 1, total: 2 })
    expect(g.groups[1].containers).toHaveLength(1)
    expect(g.loose.map((c) => c.name)).toEqual(['adhoc'])
  })

  it('filters on name, service, project and image', () => {
    expect(groupContainers(rows, { query: 'LAB' }).groups.map((x) => x.project)).toEqual(['lab'])
    expect(groupContainers(rows, { query: 'worker' }).groups[0].containers).toHaveLength(1)
    expect(groupContainers(rows, { query: 'scratch:' }).loose.map((c) => c.name)).toEqual(['scratch'])
  })
})

describe('readStatus', () => {
  it('splits a health tag off', () => {
    expect(readStatus('Up 2 days (healthy)')).toEqual({ text: 'Up 2 days', tag: 'healthy', tone: 'ok' })
    expect(readStatus('Up 3 minutes (health: starting)')).toEqual({ text: 'Up 3 minutes', tag: 'starting', tone: 'warn' })
    expect(readStatus('Up 1 hour (unhealthy)').tone).toBe('bad')
  })

  it('marks a non-zero exit only', () => {
    expect(readStatus('Exited (1) 3 days ago')).toEqual({ text: 'Exited (1) 3 days ago', tone: 'bad' })
    expect(readStatus('Exited (0) 3 days ago')).toEqual({ text: 'Exited (0) 3 days ago' })
    expect(readStatus('Up 5 days')).toEqual({ text: 'Up 5 days' })
  })
})

describe('statsTone / statsLine', () => {
  it('warns above 80 and flags above 95, on CPU or memory', () => {
    expect(statsTone(3.2, 10)).toBe('')
    expect(statsTone(80, 80)).toBe('')
    expect(statsTone(80.1, 1)).toBe('warn')
    expect(statsTone(1, 90)).toBe('warn')
    expect(statsTone(95.5, 1)).toBe('bad')
    expect(statsTone(180, null)).toBe('bad')
    expect(statsTone(null, null)).toBe('')
  })

  it('writes the line from what is known', () => {
    expect(statsLine(3.21, '245MiB / 7.6GiB')).toBe('CPU 3.2% · 245MiB / 7.6GiB')
    expect(statsLine(null, '245MiB / 7.6GiB')).toBe('245MiB / 7.6GiB')
    expect(statsLine(0, '')).toBe('CPU 0.0%')
    expect(statsLine(null, '')).toBeNull()
  })
})
