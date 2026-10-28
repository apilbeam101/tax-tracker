import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { FastifyPluginAsync } from 'fastify'
import { packageRoot } from '../config/paths.ts'

const { version } = JSON.parse(readFileSync(join(packageRoot(), 'package.json'), 'utf8')) as {
  version: string
}

export const healthRoute: FastifyPluginAsync<{ commit: string }> = async (app, opts) => {
  app.get('/health', async () => ({ status: 'ok', version, commit: opts.commit }))
}
