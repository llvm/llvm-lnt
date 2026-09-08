function required(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`Missing required environment variable: ${name}`)
  return value
}

export const config = {
  get isProduction() {
    return process.env.NODE_ENV === 'production'
  },
  get port() {
    return Number(process.env.PORT ?? 3000)
  },
  get databaseUrl() {
    return required('DATABASE_URL')
  },
  get databaseSslCa() {
    return process.env.DATABASE_SSL_CA
  },
  /**
   * Maximum accepted request body size, in bytes.
   *
   * A run submission carries its profiles inline as base64, and a single profile may be up to 50 MB
   * decoded, already far past Fastify's 1 MB default. 128 MB leaves headroom for that plus the surrounding
   * JSON. The reverse proxy in front of the server needs a matching limit; raise both together.
   */
  get bodyLimit() {
    return Number(process.env.BODY_LIMIT ?? 128 * 1024 * 1024)
  },
}
