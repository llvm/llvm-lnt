import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import Fastify from 'fastify'
import { isApiPath, registerSpa } from './spa.js'

describe('isApiPath', () => {
  it.each(['/api', '/api/', '/api/suites/nts/runs', '/api/suites?limit=25'])(
    'treats %s as an API path',
    (url) => {
      expect(isApiPath(url)).toBe(true)
    },
  )

  it.each(['/', '/suites/nts', '/apiary', '/graph?suite=nts'])(
    'treats %s as a client path',
    (url) => {
      expect(isApiPath(url)).toBe(false)
    },
  )
})

describe('registerSpa with a built client', () => {
  let clientDist: string

  beforeAll(() => {
    clientDist = mkdtempSync(path.join(tmpdir(), 'lnt-spa-'))
    writeFileSync(path.join(clientDist, 'index.html'), '<!doctype html><title>LNT</title>')
  })

  async function build() {
    const app = Fastify({ logger: false })
    await registerSpa(app, clientDist)
    return app
  }

  it('serves index.html for an unknown deep link', async () => {
    const app = await build()

    const response = await app.inject({ method: 'GET', url: '/suites/nts/runs/abc' })

    expect(response.statusCode).toBe(200)
    expect(response.body).toContain('<title>LNT</title>')
  })

  it('returns the JSON error envelope for an unmatched API route', async () => {
    const app = await build()

    const response = await app.inject({ method: 'GET', url: '/api/suites/nts/nope' })

    expect(response.statusCode).toBe(404)
    expect(response.json().error.code).toBe('not_found')
  })

  it('does not serve the SPA for non-GET requests', async () => {
    const app = await build()

    const response = await app.inject({ method: 'POST', url: '/suites/nts' })

    expect(response.statusCode).toBe(404)
    expect(response.json().error.code).toBe('not_found')
  })
})

describe('registerSpa without a built client', () => {
  it('404s rather than trying to serve a missing index.html', async () => {
    const app = Fastify({ logger: false })
    await registerSpa(app, path.join(tmpdir(), 'lnt-spa-does-not-exist'))

    const response = await app.inject({ method: 'GET', url: '/' })

    expect(response.statusCode).toBe(404)
    expect(response.json().error.code).toBe('not_found')
  })
})
