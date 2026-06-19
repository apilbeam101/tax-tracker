import Fastify from 'fastify'
import { config } from './config/env.ts'
import { buildApp } from './app.ts'

const server = Fastify({
  logger: config.isProduction
    ? { level: 'warn' }
    : { level: 'info', transport: { target: 'pino-pretty' } },
})

try {
  await buildApp(server)
  await server.listen({ host: config.host, port: config.port })
  console.log(`\n  UK Tax Tracker running at http://${config.host}:${config.port}\n`)
} catch (err) {
  server.log.error(err)
  process.exit(1)
}
