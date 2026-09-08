import path from 'node:path'
import Fastify from 'fastify'
import { healthRoutes } from './routes/health.js'
import { registerSpa } from './spa.js'
import { config } from './config.js'

const app = Fastify({ logger: true, bodyLimit: config.bodyLimit })

await app.register(healthRoutes)

// Migrations are deliberately not run here yet: the v5 schema has no global tables so far, and the
// per-suite tables are created by the application rather than by a migration (see src/schema.ts).
await registerSpa(app, path.join(import.meta.dirname, '../../client/dist'))

try {
  await app.listen({ port: config.port, host: '0.0.0.0' })
} catch (error) {
  app.log.error(error)
  process.exit(1)
}
