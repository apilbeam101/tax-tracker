import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import Fastify from 'fastify'
import { describe, expect, it } from 'vitest'
import { packageRoot } from '../config/paths.ts'
import { healthRoute } from './health.ts'

const pkgVersion = JSON.parse(readFileSync(join(packageRoot(), 'package.json'), 'utf8')).version

describe('GET /health', () => {
  it('reports status, the package version and the configured commit', async () => {
    const app = Fastify()
    await app.register(healthRoute, { commit: 'abc1234' })
    const res = await app.inject({ method: 'GET', url: '/health' })
    await app.close()

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ status: 'ok', version: pkgVersion, commit: 'abc1234' })
    expect(res.json().version).toMatch(/^\d+\.\d+\.\d+/)
  })
})
