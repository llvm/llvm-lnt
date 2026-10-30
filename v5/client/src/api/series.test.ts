import { HttpResponse } from 'msw'
import { describe, expect, it } from 'vitest'
import type { Schemas } from './client'
import { fetchSeries } from './series'
import { errorResponse, mockSeries, ndjsonResponse } from '../test/mock-api'
import { server } from '../test/server'
import { REF } from '../test/fixtures'

const signal = () => new AbortController().signal

const pointAt = (commit: string, ordinal: number, value: number): Schemas['DataPoint'] => ({
  test: 'a',
  machine: 'm1',
  metric: 'execution_time',
  value,
  commit,
  ordinal,
  run_uuid: `run-${commit}`,
  submitted_at: '2026-08-25T14:22:41Z',
  measured_at: '2026-08-25T14:22:41Z',
  tag: null,
})

describe('fetchSeries', () => {
  it('asks for the series, and returns its every line once all have arrived', async () => {
    const points = [pointAt('c10', 10, 1), pointAt('c20', 20, 2)]
    let url: URL | undefined
    server.use(
      mockSeries(({ request }) => {
        url = new URL(request.url)
        return ndjsonResponse([[points[0]], [points[1]]])
      }),
    )

    const query = { metric: 'execution_time', machine: 'm1', test: ['a', 'b/c'], has_ordinal: true }
    expect(await fetchSeries(REF, query, signal())).toEqual(points)
    expect(url?.pathname).toBe('/api/projects/llvm/suites/libcxx/series')
    expect(url?.search).toBe('?metric=execution_time&machine=m1&test=a&test=b%2Fc&has_ordinal=true')
  })

  it('returns no line for an empty response', async () => {
    // Without a body at all, as the client sees a response whose `Content-Length` is 0.
    server.use(
      mockSeries(
        () =>
          new HttpResponse(null, {
            headers: { 'Content-Type': 'application/x-ndjson', 'Content-Length': '0' },
          }),
      ),
    )

    const query = { metric: 'execution_time', machine: 'm1' }
    expect(await fetchSeries(REF, query, signal())).toEqual([])
  })

  it('fails with the error the API answered with', async () => {
    server.use(mockSeries(() => errorResponse(404, 'not_found', "Machine 'm9' not found")))

    const query = { metric: 'execution_time', machine: 'm9' }
    await expect(fetchSeries(REF, query, signal())).rejects.toMatchObject({
      status: 404,
      code: 'not_found',
      message: "Machine 'm9' not found",
    })
  })
})
