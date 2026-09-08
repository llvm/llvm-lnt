import type { FastifyInstance } from 'fastify'
import { sql } from 'drizzle-orm'
import { db } from '../db.js'

export async function healthRoutes(app: FastifyInstance) {
  app.get('/healthz', async (_request, reply) => {
    try {
      await db.execute(sql`select 1`)
      return { ok: true }
    } catch (error) {
      app.log.error(error)
      return reply.status(500).send({ ok: false })
    }
  })
}
