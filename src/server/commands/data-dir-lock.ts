import { isServerRunning, writeServerLock } from '../services/backup/server-lock.ts'
import { CliError } from './util.ts'

export const RUNNING_MESSAGE = (dataDir: string) =>
  `The app appears to be running: server.lock in ${dataDir} was refreshed recently. Stop it first (in a container, stop the app container; a one-off container on the same volume is fine). If it was just stopped or crashed, wait 30 seconds and retry.`

// Refuses while a server holds the data directory, then holds it itself for the rest of the
// command, so a server that starts meanwhile waits instead of opening a database that is about to
// be swapped, rewritten or re-keyed.
export async function claimDataDir(dataDir: string): Promise<void> {
  if (await isServerRunning(dataDir)) throw new CliError(RUNNING_MESSAGE(dataDir))
  writeServerLock(dataDir)
}
