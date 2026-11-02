import type { Db } from '../../db/database.ts'
import { createBackup, listBackups } from './backups.ts'

const DAY_MS = 24 * 60 * 60 * 1000
const CHECK_EVERY_MS = 60 * 60 * 1000
const FIRST_CHECK_MS = 30 * 1000

export type BackupSchedule = 'daily' | 'off'

export interface BackupScheduler {
  /** Takes a scheduled backup if none was taken in the last 24 hours. Returns the new name. */
  runIfDue(): Promise<string | undefined>
  stop(): void
}

export function startBackupSchedule(options: {
  db: Db
  dataDir: string
  schedule: BackupSchedule
  warn: (message: string) => void
  now?: () => number
}): BackupScheduler {
  const { db, dataDir, schedule, warn } = options
  const now = options.now ?? Date.now
  let running = false

  async function runIfDue(): Promise<string | undefined> {
    if (schedule === 'off' || running) return undefined
    running = true
    try {
      // Before first-run setup there is nothing to protect, and a copy taken now would be an
      // unencrypted one left behind once setup turns encryption on.
      if (!db.prepare('SELECT 1 FROM "user" LIMIT 1').get()) return undefined
      const last = listBackups(dataDir).find((b) => b.reason === 'scheduled')
      // A last backup dated in the future means the clock moved back; do not wait for it to catch up.
      const age = last ? now() - new Date(last.createdAt).getTime() : Number.POSITIVE_INFINITY
      if (age >= 0 && age < DAY_MS) return undefined
      return (await createBackup(db, dataDir, 'scheduled')).name
    } catch (err) {
      warn(`Scheduled backup failed: ${(err as Error).message}`)
      return undefined
    } finally {
      running = false
    }
  }

  const timers: NodeJS.Timeout[] = []
  if (schedule === 'daily') {
    timers.push(setTimeout(() => void runIfDue(), FIRST_CHECK_MS))
    timers.push(setInterval(() => void runIfDue(), CHECK_EVERY_MS))
    for (const t of timers) t.unref()
  }

  return {
    runIfDue,
    stop() {
      for (const t of timers) clearTimeout(t)
    },
  }
}
