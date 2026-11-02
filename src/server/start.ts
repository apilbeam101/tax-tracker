import { mkdirSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import Fastify from 'fastify'
import { buildApp } from './app.ts'
import { config } from './config/current.ts'
import { loggerOptions } from './config/logging.ts'
import { waitForLockRelease, writeServerLock } from './services/backup/server-lock.ts'

export async function startServer(): Promise<string> {
  const server = Fastify({
    logger: loggerOptions(config.logLevel),
    trustProxy: config.trustProxy,
  })

  try {
    // Before migrations and any restore swap, so an offline command cannot slip in during boot.
    mkdirSync(config.dataDir, { recursive: true, mode: 0o700 })
    // A lock a previous instance (or an offline restore/import) refreshed moments ago is given time
    // to expire, which covers a supervisor restarting a server that was killed. Two live servers on
    // one database would corrupt each other's view of it, so after that we refuse.
    if (!(await waitForLockRelease(config.dataDir))) {
      throw new Error(
        `Another instance (or an offline restore/import) is using ${config.dataDir}: server.lock is still being refreshed. Stop it first.`,
      )
    }
    writeServerLock(config.dataDir)
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
