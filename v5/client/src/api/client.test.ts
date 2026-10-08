import { HttpResponse, http } from 'msw'
import { afterEach, describe, expect, it } from 'vitest'
import { ApiError, api, authedApi, setTokenSource, unwrap } from './client'
import { errorResponse, mockApi } from '../test/mock-api'
import { server } from '../test/server'

const SUITE = { name: 'nts', metrics: [], commit_fields: [], machine_fields: [] }

describe('unwrap', () => {
  it('returns the body of a successful response', async () => {
    server.use(mockApi('get', '/api/suites', () => HttpResponse.json({ items: [SUITE] })))

    expect(await unwrap(api.GET('/api/suites'))).toEqual({ items: [SUITE] })
  })

  it('returns nothing for a 204', async () => {
    server.use(
      mockApi('delete', '/api/suites/{testsuite}/runs/{uuid}', () => new HttpResponse(null, { status: 204 })),
    )

    const deleted = authedApi.DELETE('/api/suites/{testsuite}/runs/{uuid}', {
      params: { path: { testsuite: 'nts', uuid: '573af861-8303-4a5b-a643-b8321e0142c4' } },
    })
    expect(await unwrap(deleted)).toBeUndefined()
  })

  it("turns the API's error envelope into an ApiError", async () => {
    server.use(
      mockApi('get', '/api/suites/{name}', () =>
        errorResponse(404, 'not_found', "Test suite 'nope' not found"),
      ),
    )

    const request = unwrap(api.GET('/api/suites/{name}', { params: { path: { name: 'nope' } } }))
    await expect(request).rejects.toMatchObject({
      name: 'ApiError',
      status: 404,
      code: 'not_found',
      message: "Test suite 'nope' not found",
    })
  })

  it('tells the three 409s apart by their code', async () => {
    server.use(
      mockApi('post', '/api/suites', () => errorResponse(409, 'retry', 'Try again')),
    )

    await expect(unwrap(authedApi.POST('/api/suites', { body: SUITE }))).rejects.toMatchObject({
      name: 'ApiError',
      status: 409,
      code: 'retry',
    })
  })

  it('reports a 413, which carries no envelope, with a message of its own', async () => {
    server.use(
      http.post('/api/suites', () => new HttpResponse('Content Too Large', { status: 413 })),
    )

    await expect(unwrap(authedApi.POST('/api/suites', { body: SUITE }))).rejects.toMatchObject({
      name: 'ApiError',
      status: 413,
      code: null,
      message: 'The request is too large for the server.',
    })
  })

  it('does not take a JSON body for an envelope unless it is one', async () => {
    server.use(
      http.get('/api/suites', () => HttpResponse.json({ error: 'Bad gateway' }, { status: 502 })),
    )

    await expect(unwrap(api.GET('/api/suites'))).rejects.toMatchObject({
      name: 'ApiError',
      status: 502,
      code: null,
      message: 'The server answered with an unexpected HTTP 502.',
    })
  })

  it('reports a request that got no response', async () => {
    server.use(http.get('/api/suites', () => HttpResponse.error()))

    await expect(unwrap(api.GET('/api/suites'))).rejects.toMatchObject({
      name: 'ApiError',
      status: 0,
      code: null,
      message: 'Could not reach the server.',
    })
  })

  it('treats a 401 and a 403 as a denied permission, and nothing else', async () => {
    expect(new ApiError(401, 'unauthorized', '').isPermissionDenied).toBe(true)
    expect(new ApiError(403, 'forbidden', '').isPermissionDenied).toBe(true)
    expect(new ApiError(404, 'not_found', '').isPermissionDenied).toBe(false)
  })
})

describe('query parameters', () => {
  it('repeats a parameter that takes several values', async () => {
    let query = ''
    server.use(
      mockApi('get', '/api/suites/{testsuite}/regressions', ({ request }) => {
        query = new URL(request.url).search
        return HttpResponse.json({ items: [], cursor: { next: null, previous: null } })
      }),
    )

    await unwrap(
      api.GET('/api/suites/{testsuite}/regressions', {
        params: {
          path: { testsuite: 'nts' },
          query: { state: ['detected', 'active'], sort: '-created_at' },
        },
      }),
    )
    expect(query).toBe('?state=detected&state=active&sort=-created_at')
  })

  it('leaves out a parameter that is null or undefined', async () => {
    let query: string | null = null
    server.use(
      mockApi('get', '/api/suites/{testsuite}/machines', ({ request }) => {
        query = new URL(request.url).search
        return HttpResponse.json({ items: [], total: 0 })
      }),
    )

    await unwrap(
      api.GET('/api/suites/{testsuite}/machines', {
        params: { path: { testsuite: 'nts' }, query: { search: null, tracked: undefined } },
      }),
    )
    expect(query).toBe('')
  })

  it('encodes a value that is not URL-safe', async () => {
    let search: string | null = null
    server.use(
      mockApi('get', '/api/suites/{testsuite}/tests', ({ request }) => {
        search = new URL(request.url).searchParams.get('search')
        return HttpResponse.json({ items: [], cursor: { next: null, previous: null } })
      }),
    )

    await unwrap(
      api.GET('/api/suites/{testsuite}/tests', {
        params: { path: { testsuite: 'nts' }, query: { search: 'a&b=c/d e' } },
      }),
    )
    expect(search).toBe('a&b=c/d e')
  })
})

describe('aborting', () => {
  it('rejects with the abort rather than an ApiError', async () => {
    server.use(mockApi('get', '/api/suites', () => new Promise<never>(() => {})))
    const controller = new AbortController()

    const request = unwrap(api.GET('/api/suites', { signal: controller.signal }))
    controller.abort()

    await expect(request).rejects.toHaveProperty('name', 'AbortError')
  })
})

describe('credentials', () => {
  afterEach(() => setTokenSource(() => null))

  function recordAuthorization(): { header: string | null | undefined } {
    const seen: { header: string | null | undefined } = { header: undefined }
    server.use(
      mockApi('get', '/api/auth', ({ request }) => {
        seen.header = request.headers.get('Authorization')
        return HttpResponse.json({ key: null })
      }),
    )
    return seen
  }

  it('are sent by the authenticated client', async () => {
    setTokenSource(() => 'f'.repeat(64))
    const seen = recordAuthorization()

    await unwrap(authedApi.GET('/api/auth'))
    expect(seen.header).toBe(`Bearer ${'f'.repeat(64)}`)
  })

  it('are never sent by the anonymous client', async () => {
    setTokenSource(() => 'f'.repeat(64))
    const seen = recordAuthorization()

    await unwrap(api.GET('/api/auth'))
    expect(seen.header).toBeNull()
  })

  it('are not sent while there is no token', async () => {
    const seen = recordAuthorization()

    await unwrap(authedApi.GET('/api/auth'))
    expect(seen.header).toBeNull()
  })
})
