import Fastify from 'fastify'
import { buildApp } from './app.ts'
import { config } from './config/env.ts'
import { loggerOptions } from './config/logging.ts'

const server = Fastify({
  logger: loggerOptions(config.logLevel),
  trustProxy: config.trustProxy,
})

try {
  await buildApp(server)
  await server.listen({ host: config.host, port: config.port })
  console.log(`\n  UK Tax Tracker running at http://${config.host}:${config.port}`)
  console.log(`  Data directory: ${config.dataDir} (from ${config.dataDirSource})`)
  console.log(
    `  Configuration: ${config.configMode}${config.configFile ? ` (${config.configFile})` : ''}\n`,
  )
} catch (err) {
  server.log.error(err)
  process.exit(1)
}
