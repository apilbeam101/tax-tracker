import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { packageRoot } from '../config/paths.ts'
import { hasUnattendedSlot, isEncryptedDatabase, listSlots } from '../crypto/keyslots.ts'
import { dataPaths, openExistingDb } from './util.ts'

export function appVersion(): string {
  const pkg = JSON.parse(readFileSync(join(packageRoot(), 'package.json'), 'utf8')) as {
    version: string
  }
  return pkg.version
}

export function lastBackup(dataDir: string): string | undefined {
  const dir = join(dataDir, 'backups')
  if (!existsSync(dir)) return undefined
  const newest = readdirSync(dir)
    .filter((f) => f.endsWith('.db'))
    .map((f) => ({ f, mtime: statSync(join(dir, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)[0]
  return newest ? join(dir, newest.f) : undefined
}

export interface InfoReport {
  version: string
  dataDir: string
  dataDirSource: string
  dbPath: string
  database: 'not created yet' | 'unprotected' | 'protected'
  unlockMode: 'unprotected' | 'passphrase' | 'unattended slot present'
  keySlots: string[]
  dbSizeBytes: number | undefined
  configMode: 'self-configured' | 'env-supplied'
  lastBackup: string | undefined
}

// Reports locations and state only; nothing it reads or prints is key material.
export function gatherInfo(env: NodeJS.ProcessEnv = process.env): InfoReport {
  const { dataDir, dbPath, source } = dataPaths(env)
  const base = {
    version: appVersion(),
    dataDir,
    dataDirSource: source,
    dbPath,
    configMode: (env.AUTO_CONFIG === 'true' ? 'self-configured' : 'env-supplied') as
      | 'self-configured'
      | 'env-supplied',
    lastBackup: lastBackup(dataDir),
  }
  if (!existsSync(dbPath)) {
    return {
      ...base,
      database: 'not created yet',
      unlockMode: 'unprotected',
      keySlots: [],
      dbSizeBytes: undefined,
    }
  }

  const db = openExistingDb(dbPath, { readOnly: true })
  try {
    const protectedDb = isEncryptedDatabase(db)
    return {
      ...base,
      database: protectedDb ? 'protected' : 'unprotected',
      unlockMode: !protectedDb
        ? 'unprotected'
        : hasUnattendedSlot(db)
          ? 'unattended slot present'
          : 'passphrase',
      keySlots: protectedDb ? listSlots(db).map((s) => s.slotType) : [],
      dbSizeBytes: statSync(dbPath).size,
    }
  } finally {
    db.close()
  }
}

export function formatInfo(info: InfoReport): string {
  return [
    `Version:        ${info.version}`,
    `Data directory: ${info.dataDir} (from ${info.dataDirSource})`,
    `Database:       ${info.dbPath} (${info.database}${info.dbSizeBytes === undefined ? '' : `, ${info.dbSizeBytes} bytes`})`,
    `Configuration:  ${info.configMode}`,
    `Unlock mode:    ${info.unlockMode}${info.keySlots.length ? ` (slots: ${info.keySlots.join(', ')})` : ''}`,
    `Last backup:    ${info.lastBackup ?? 'none'}`,
  ].join('\n')
}
