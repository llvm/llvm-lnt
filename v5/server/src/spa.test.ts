import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import Fastify from 'fastify'
import { isApiPath, isStaticAssetPath, registerSpa } from './spa.js'

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

describe('isStaticAssetPath', () => {
  it.each([
    '/favicon.ico',
    '/assets/index-DcWSbQGc.js',
    '/assets/index-BfuC4xkh.css',
    '/assets/index-DcWSbQGc.js.map',
    '/fonts/inter.woff2',
    '/llms.txt',
    '/site.webmanifest',
  ])('treats %s as a static asset request', (url) => {
    expect(isStaticAssetPath(url)).toBe(true)
  })

  // Plenty of real routes end in something dot-like, so a bare "contains a dot" check would break
  // them. Machine names in particular routinely carry version numbers.
  it.each([
    '/',
    '/suites/nts',
    '/suites/nts/machines/macos-26.5-arm64',
    '/suites/nts/machines/linux-x86_64',
    '/suites/nts/commits/014621ede7c1',
    '/graph?suite=nts',
  ])('treats %s as a client route', (url) => {
    expect(isStaticAssetPath(url)).toBe(false)
  })
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

  it('404s a missing asset instead of serving the SPA', async () => {
    const app = await build()

    // The shape a client ends up requesting when it is holding a hashed URL from a previous deploy.
    const response = await app.inject({ method: 'GET', url: '/assets/index-STALEHASH.js' })

    expect(response.statusCode).toBe(404)
    expect(response.json().error.code).toBe('not_found')
  })

  it('404s a missing favicon instead of serving the SPA', async () => {
    const app = await build()

    const response = await app.inject({ method: 'GET', url: '/favicon.ico' })

    expect(response.statusCode).toBe(404)
  })

  it('still serves the SPA for a route whose last segment contains dots', async () => {
    const app = await build()

    const response = await app.inject({
      method: 'GET',
      url: '/suites/nts/machines/macos-26.5-arm64',
    })

    expect(response.statusCode).toBe(200)
    expect(response.body).toContain('<title>LNT</title>')
  })

  it('serves an asset that does exist', async () => {
    writeFileSync(path.join(clientDist, 'real.css'), 'body{}')
    const app = await build()

    const response = await app.inject({ method: 'GET', url: '/real.css' })

    expect(response.statusCode).toBe(200)
    expect(response.body).toBe('body{}')
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
