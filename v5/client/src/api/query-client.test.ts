import { describe, expect, it } from 'vitest'
import { ApiError } from './client'
import { shouldRetry } from './query-client'

describe('shouldRetry', () => {
  it.each([
    ['no response', new ApiError(0, null, '')],
    ['a server error', new ApiError(500, 'internal_error', '')],
    ['a proxy error', new ApiError(502, null, '')],
    ['a concurrent schema change', new ApiError(409, 'retry', '')],
  ])('retries %s', (_, error) => {
    expect(shouldRetry(0, error)).toBe(true)
    expect(shouldRetry(1, error)).toBe(true)
    expect(shouldRetry(2, error)).toBe(false)
  })

  it.each([
    ['an invalid request', new ApiError(400, 'invalid_request', '')],
    ['a denied permission', new ApiError(403, 'forbidden', '')],
    ['a missing entity', new ApiError(404, 'not_found', '')],
    ['a conflict', new ApiError(409, 'conflict', '')],
    ['an error from the client itself', new TypeError('x is undefined')],
  ])('does not retry %s', (_, error) => {
    expect(shouldRetry(0, error)).toBe(false)
  })
})
