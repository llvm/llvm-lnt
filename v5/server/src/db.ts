import { readFileSync } from 'node:fs'
import { drizzle } from 'drizzle-orm/node-postgres'
import { Pool } from 'pg'
import { config } from './config.js'

const pool = new Pool({
  connectionString: config.databaseUrl,
  ssl: config.databaseSslCa ? { ca: readFileSync(config.databaseSslCa, 'utf8') } : undefined,
})

export const db = drizzle(pool)
