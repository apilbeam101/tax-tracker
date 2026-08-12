import Fastify from 'fastify'
import { buildApp } from './app.ts'
import { config } from './config/env.ts'
import { loggerOptions } from './config/logging.ts'

const server = Fastify({ logger: loggerOptions(config.isProduction) })

try {
  await buildApp(server)
  await server.listen({ host: config.host, port: config.port })
  console.log(`\n  UK Tax Tracker running at http://${config.host}:${config.port}\n`)
} catch (err) {
  server.log.error(err)
  process.exit(1)
}
