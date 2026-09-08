import { describe, expect, it, vi } from 'vitest'
import Fastify from 'fastify'

vi.mock('../db.js', () => ({
  db: { execute: vi.fn() },
}))

import { db } from '../db.js'
import { healthRoutes } from './health.js'

describe('GET /healthz', () => {
  it('returns ok when the database responds', async () => {
    vi.mocked(db.execute).mockResolvedValueOnce(undefined as never)
    const app = Fastify()
    await app.register(healthRoutes)

    const response = await app.inject({ method: 'GET', url: '/healthz' })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({ ok: true })
  })

  it('returns 500 when the database fails', async () => {
    vi.mocked(db.execute).mockRejectedValueOnce(new Error('boom'))
    const app = Fastify({ logger: false })
    await app.register(healthRoutes)

    const response = await app.inject({ method: 'GET', url: '/healthz' })

    expect(response.statusCode).toBe(500)
    expect(response.json()).toEqual({ ok: false })
  })
})
