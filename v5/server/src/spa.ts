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

// Extensions that mark a request as asking for a file rather than for a page.
const STATIC_ASSET_EXTENSIONS = new Set([
  'avif', 'cjs', 'css', 'eot', 'gif', 'ico', 'jpeg', 'jpg', 'js', 'json', 'map', 'mjs', 'otf',
  'png', 'svg', 'ttf', 'txt', 'wasm', 'webmanifest', 'webp', 'woff', 'woff2', 'xml',
])

/**
 * True for paths that look like a request for a static file.
 *
 * Matching is against a known set of extensions rather than "the last segment contains a dot",
 * because real routes do: `/suites/nts/machines/macos-26.5-arm64` must still reach the SPA.
 */
export function isStaticAssetPath(url: string): boolean {
  const pathname = url.split('?')[0]
  const lastSegment = pathname.slice(pathname.lastIndexOf('/') + 1)
  const dot = lastSegment.lastIndexOf('.')
  if (dot === -1) return false
  return STATIC_ASSET_EXTENSIONS.has(lastSegment.slice(dot + 1).toLowerCase())
}

/**
 * Serve the built client, and route unknown paths to it so that deep links and hard refreshes
 * resolve to the right route instead of 404ing.
 *
 * Anything that is not a GET, that belongs to the API, or that names a file we do not have, keeps a
 * real 404.
 */
export async function registerSpa(app: FastifyInstance, clientDist: string) {
  const hasClient = existsSync(clientDist)

  if (hasClient) {
    await app.register(fastifyStatic, { root: clientDist })
  }

  app.setNotFoundHandler((request, reply) => {
    if (
      !hasClient ||
      request.method !== 'GET' ||
      isApiPath(request.url) ||
      isStaticAssetPath(request.url)
    ) {
      return notFound(request, reply)
    }
    return reply.sendFile('index.html')
  })
}
