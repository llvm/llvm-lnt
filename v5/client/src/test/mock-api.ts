/**
 * Mock API handlers for tests, typed by the generated schema so that a mock cannot drift from the
 * API it stands in for: the path must be one the API serves under that method, and the response
 * body one that operation documents.
 */

import { http, HttpResponse, type DefaultBodyType, type HttpResponseResolver } from 'msw'
import type { Schemas } from '../api/client'
import type { paths } from '../api/schema'

type Method = 'get' | 'post' | 'patch' | 'delete'

export type PathWith<M extends Method> = {
  [P in keyof paths]: paths[P][M] extends { responses: object } ? P : never
}[keyof paths]

export type Operation<M extends Method, P extends PathWith<M>> = paths[P][M]

type JsonOf<T> = T extends { content: { 'application/json': infer Body } } ? Body : never

/** Every JSON body the operation documents, success and error alike. */
type ResponseBody<O> = O extends { responses: infer R } ? JsonOf<R[keyof R]> : never

export type RequestBody<O> = O extends { requestBody?: infer B } ? JsonOf<NonNullable<B>> : never

type PathParams<O> = O extends { parameters: { path: infer Params } }
  ? { [K in keyof Params]: string }
  : Record<string, never>

/** `/api/suites/{testsuite}` in MSW's spelling, `/api/suites/:testsuite`. */
function mswPath(path: string): string {
  return path.replace(/\{([^}]+)\}/g, ':$1')
}

/** A handler for `method path`, with its params, request body and response typed by the schema. */
export function mockApi<M extends Method, P extends PathWith<M>>(
  method: M,
  path: P,
  resolver: HttpResponseResolver<
    PathParams<Operation<M, P>>,
    RequestBody<Operation<M, P>> & DefaultBodyType,
    ResponseBody<Operation<M, P>> & DefaultBodyType
  >,
) {
  return http[method](mswPath(path), resolver)
}

/**
 * An I4 error response. A response the API does not describe, such as the transport-level 413,
 * cannot go through `mockApi`; mock it with MSW's `http` directly.
 */
export function errorResponse(status: number, code: string, message: string) {
  return HttpResponse.json<Schemas['ErrorEnvelope']>({ error: { code, message } }, { status })
}
