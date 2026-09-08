import { existsSync } from 'node:fs'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import fastifyStatic from '@fastify/static'

/**
 * True for paths owned by the REST API.
 *
 * These must never fall through to the SPA's index.html: an unmatched `/api/...` route is a genuine
 * 404 and has to answer with the JSON error envelope rather than a page of HTML.
 */
export function isApiPath(url: string): boolean {
  const pathname = url.split('?')[0]
  return pathname === '/api' || pathname.startsWith('/api/')
}

function notFound(request: FastifyRequest, reply: FastifyReply) {
  return reply.code(404).send({
    error: { code: 'not_found', message: `No route for ${request.method} ${request.url}` },
  })
}

/**
 * Serve the built client, and route unknown paths to it so that deep links and hard refreshes
 * resolve to the right route instead of 404ing.
 *
 * Anything that is not a GET, or that belongs to the API, keeps a real 404.
 */
export async function registerSpa(app: FastifyInstance, clientDist: string) {
  const hasClient = existsSync(clientDist)

  if (hasClient) {
    await app.register(fastifyStatic, { root: clientDist })
  }

  app.setNotFoundHandler((request, reply) => {
    if (!hasClient || request.method !== 'GET' || isApiPath(request.url)) {
      return notFound(request, reply)
    }
    return reply.sendFile('index.html')
  })
}
