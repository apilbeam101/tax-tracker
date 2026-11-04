import { homedir } from 'node:os'
import { ensureConfigFile } from './config/file.ts'
import { type DataPathSource, resolveDataPaths } from './config/paths.ts'

export interface InitReport {
  dataDir: string
  dataDirSource: DataPathSource
  dbPath: string
  configFile: string
  sessionSecret: 'generated' | 'already in config file' | 'supplied by environment'
}

// The explicit form of what self-configured mode does on first start. Reports locations only;
// nothing it prints or writes is key material.
export function runInit(env: NodeJS.ProcessEnv = process.env): InitReport {
  const { dataDir, dbPath, source } = resolveDataPaths({
    env,
    cwd: process.cwd(),
    platform: process.platform,
    home: homedir(),
  })
  const fromEnv = Boolean(env.SESSION_SECRET || env.SESSION_SECRET_FILE)
  const file = ensureConfigFile(dataDir, { needSessionSecret: !fromEnv })
  return {
    dataDir,
    dataDirSource: source,
    dbPath,
    configFile: file.path,
    sessionSecret: fromEnv
      ? 'supplied by environment'
      : file.created
        ? 'generated'
        : 'already in config file',
  }
}
