import { HttpResponse } from 'msw'
import { setupServer } from 'msw/node'
import { mockApi } from './mock-api'

/**
 * The API index (E1), the one request mocked by default: the footer of every page asks for it
 * (AR4), and no test of anything else is about it.
 */
export const INDEX = {
  links: { suites: '/api/suites', openapi: '/api/openapi.json', docs: '/api/docs' },
  revision: null,
}

/**
 * The mock API every test runs against. Tests add handlers with `server.use(mockApi(...))`; they
 * are reset after each test. Apart from the API index, a request no handler matches fails, and so
 * does the test that made it, even if the code under test handled the failure (see setupTests.ts).
 */
export const server = setupServer(mockApi('get', '/api', () => HttpResponse.json(INDEX)))
