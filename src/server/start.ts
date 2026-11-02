import type { AddressInfo } from 'node:net'
import Fastify from 'fastify'
import { buildApp } from './app.ts'
import { config } from './config/current.ts'
import { loggerOptions } from './config/logging.ts'

export async function startServer(): Promise<string> {
  const server = Fastify({
    logger: loggerOptions(config.logLevel),
    trustProxy: config.trustProxy,
  })

  try {
    await buildApp(server)
    await server.listen({ host: config.host, port: config.port })
  } catch (err) {
    server.log.error(err)
    process.exit(1)
  }

  const { port } = server.server.address() as AddressInfo
  const host = config.host.includes(':') ? `[${config.host}]` : config.host
  const url = `http://${host}:${port}`
  console.log(`\n  UK Tax Tracker running at ${url}`)
  console.log(`  Data directory: ${config.dataDir} (from ${config.dataDirSource})`)
  console.log(
    `  Configuration: ${config.configMode}${config.configFile ? ` (${config.configFile})` : ''}\n`,
  )
  return url
}
