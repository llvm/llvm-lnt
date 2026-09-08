import { afterEach, describe, expect, it } from 'vitest'
import { config } from './config.js'

describe('config', () => {
  const originalEnv = { ...process.env }

  afterEach(() => {
    process.env = { ...originalEnv }
  })

  describe('isProduction', () => {
    it('is false when NODE_ENV is not production', () => {
      delete process.env.NODE_ENV
      expect(config.isProduction).toBe(false)
    })

    it('is true when NODE_ENV is production', () => {
      process.env.NODE_ENV = 'production'
      expect(config.isProduction).toBe(true)
    })
  })

  describe('port', () => {
    it('defaults to 3000 when PORT is unset', () => {
      delete process.env.PORT
      expect(config.port).toBe(3000)
    })

    it('reads PORT when set', () => {
      process.env.PORT = '4000'
      expect(config.port).toBe(4000)
    })
  })

  describe('databaseUrl', () => {
    it('throws a clear error when DATABASE_URL is unset', () => {
      delete process.env.DATABASE_URL
      expect(() => config.databaseUrl).toThrow('Missing required environment variable: DATABASE_URL')
    })

    it('returns DATABASE_URL when set', () => {
      process.env.DATABASE_URL = 'postgres://localhost/test'
      expect(config.databaseUrl).toBe('postgres://localhost/test')
    })
  })

  describe('databaseSslCa', () => {
    it('is undefined when DATABASE_SSL_CA is unset', () => {
      delete process.env.DATABASE_SSL_CA
      expect(config.databaseSslCa).toBeUndefined()
    })
  })

  describe('bodyLimit', () => {
    it('defaults to a limit large enough for a base64-encoded 50 MB profile', () => {
      delete process.env.BODY_LIMIT
      expect(config.bodyLimit).toBeGreaterThan((50 * 1024 * 1024 * 4) / 3)
    })

    it('reads BODY_LIMIT when set', () => {
      process.env.BODY_LIMIT = '1048576'
      expect(config.bodyLimit).toBe(1048576)
    })
  })
})
