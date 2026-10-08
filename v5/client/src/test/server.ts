import { setupServer } from 'msw/node'

/**
 * The mock API every test runs against. Tests add handlers with `server.use(mockApi(...))`; they
 * are reset after each test. A request no handler matches fails, and so does the test that made
 * it, even if the code under test handled the failure (see setupTests.ts).
 */
export const server = setupServer()
