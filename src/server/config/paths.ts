import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const DB_FILENAME = 'taxtracker.db'
const APP_DIRNAME = 'tax-tracker'

// Walks up from the module location rather than trusting process.cwd(), so the
// result is the same under tsx (src/server/...) and compiled output (dist/server/...).
export function packageRoot(fromUrl: string = import.meta.url): string {
  let dir = dirname(fileURLToPath(fromUrl))
  while (!existsSync(join(dir, 'package.json'))) {
    const parent = dirname(dir)
    if (parent === dir) throw new Error(`No package.json found above ${fileURLToPath(fromUrl)}`)
    dir = parent
  }
  return dir
}

export type DataPathSource = 'DB_PATH' | 'DATA_DIR' | 'legacy ./data' | 'OS default'

export interface DataPaths {
  dbPath: string
  dataDir: string
  source: DataPathSource
}

export interface DataPathContext {
  env: NodeJS.ProcessEnv
  cwd: string
  platform: NodeJS.Platform
  home: string
}

function osDefaultDataDir({ env, platform, home }: DataPathContext): string {
  if (platform === 'win32')
    return join(env.APPDATA || join(home, 'AppData', 'Roaming'), APP_DIRNAME)
  if (platform === 'darwin') return join(home, 'Library', 'Application Support', APP_DIRNAME)
  return join(env.XDG_DATA_HOME || join(home, '.local', 'share'), APP_DIRNAME)
}

export function resolveDataPaths(
  ctx: DataPathContext = {
    env: process.env,
    cwd: process.cwd(),
    platform: process.platform,
    home: homedir(),
  },
): DataPaths {
  const { env, cwd } = ctx

  if (env.DB_PATH) {
    const dbPath = resolve(cwd, env.DB_PATH)
    return { dbPath, dataDir: dirname(dbPath), source: 'DB_PATH' }
  }

  if (env.DATA_DIR) {
    const dataDir = resolve(cwd, env.DATA_DIR)
    return { dbPath: join(dataDir, DB_FILENAME), dataDir, source: 'DATA_DIR' }
  }

  const legacyDir = join(cwd, 'data')
  if (existsSync(join(legacyDir, DB_FILENAME))) {
    return { dbPath: join(legacyDir, DB_FILENAME), dataDir: legacyDir, source: 'legacy ./data' }
  }

  const dataDir = osDefaultDataDir(ctx)
  return { dbPath: join(dataDir, DB_FILENAME), dataDir, source: 'OS default' }
}
