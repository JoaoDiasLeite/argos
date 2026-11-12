import { describe, expect, it } from 'vitest'
import { rendererCsp } from './renderer-csp'

function directives(csp: string): Record<string, string> {
  return Object.fromEntries(
    csp.split('; ').map((d) => {
      const [name, ...values] = d.split(' ')
      return [name, values.join(' ')]
    })
  )
}

describe('rendererCsp', () => {
  it('is strict in production', () => {
    const d = directives(rendererCsp({ dev: false }))
    expect(d['default-src']).toBe("'self'")
    expect(d['script-src']).toBe("'self'")
    expect(d['img-src']).toBe("'self' data:")
    expect(d['connect-src']).toBe("'self'")
    expect(d['object-src']).toBe("'none'")
    expect(d['base-uri']).toBe("'none'")
  })

  it('never allows eval', () => {
    for (const dev of [false, true]) {
      for (const blobScripts of [false, true]) {
        expect(rendererCsp({ dev, blobScripts })).not.toContain('unsafe-eval')
      }
    }
  })

  it('allows inline scripts only on the dev server', () => {
    expect(directives(rendererCsp({ dev: true }))['script-src']).toBe("'self' 'unsafe-inline'")
    expect(directives(rendererCsp({ dev: false, blobScripts: true }))['script-src']).toBe("'self' blob:")
  })

  it('allows no remote origins', () => {
    expect(rendererCsp({ dev: true, blobScripts: true })).not.toMatch(/https?:|\*/)
  })
})
