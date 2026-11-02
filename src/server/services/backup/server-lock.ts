import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { hostname } from 'node:os'
import { join } from 'node:path'

const LOCK_FILENAME = 'server.lock'
const HEARTBEAT_MS = 5_000
const STALE_AFTER_MS = 30_000
// A lock that looks stale by this process's clock but not very old may only be stale because the
// two clocks disagree (a VM that drifted), so it is watched across a heartbeat before it is believed.
const SUSPECT_UNTIL_MS = 10 * 60 * 1000
const SETTLE_MS = HEARTBEAT_MS + 1_500

let ownId: string | undefined

function lockPath(dataDir: string): string {
  return join(dataDir, LOCK_FILENAME)
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

function mtimeOf(path: string): number | undefined {
  try {
    return statSync(path).mtimeMs
  } catch {
    return undefined
  }
}

function recordedId(dataDir: string): string | undefined {
  try {
    return (JSON.parse(readFileSync(lockPath(dataDir), 'utf8')) as { id?: string }).id
  } catch {
    return undefined
  }
}

// Records that a server is using this data directory, so offline commands (restore, import) can
// refuse to swap the database under it. The file is rewritten every few seconds, which works across
// containers (a process id would not: each has its own namespace and the numbers collide, usually
// both 1) and lets a crashed server's lock expire on its own. The instance id, not the process id,
// says whose lock it is.
export function writeServerLock(dataDir: string): void {
  const id = randomUUID()
  ownId = id
  const path = lockPath(dataDir)
  const write = () => {
    try {
      writeFileSync(
        path,
        JSON.stringify({ id, pid: process.pid, host: hostname(), at: new Date() }),
      )
    } catch {
      /* the directory may be gone during shutdown */
    }
  }
  write()
  const beat = setInterval(write, HEARTBEAT_MS)
  beat.unref()

  const release = () => removeServerLock(dataDir)
  process.once('exit', release)
  // Release the lock, then let the signal take its usual course (default action, same exit status).
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      release()
      process.kill(process.pid, signal)
    })
  }
}

export function removeServerLock(dataDir: string): void {
  if (ownId && recordedId(dataDir) === ownId) rmSync(lockPath(dataDir), { force: true })
}

// On the machine (or container) that wrote the lock a dead process id settles it at once: a
// restarted container, or a dev watcher that killed the previous run, does not have to wait out
// the expiry. Other hosts cannot be told apart by process id, so for them only the clock counts.
function writtenByDeadProcessHere(dataDir: string): boolean {
  try {
    const held = JSON.parse(readFileSync(lockPath(dataDir), 'utf8')) as {
      pid?: number
      host?: string
    }
    if (held.host !== hostname() || typeof held.pid !== 'number') return false
    if (held.pid === process.pid) return true
    process.kill(held.pid, 0)
    return false
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ESRCH'
  }
}

/** True if another server refreshed its lock recently. Never waits. */
export function serverLockIsFresh(dataDir: string, now: number = Date.now()): boolean {
  const modified = mtimeOf(lockPath(dataDir))
  if (modified === undefined) return false
  if (ownId && recordedId(dataDir) === ownId) return false
  if (now - modified > STALE_AFTER_MS) return false
  return !writtenByDeadProcessHere(dataDir)
}

/**
 * For offline commands. A lock that is not obviously fresh but not obviously dead either is
 * watched for one heartbeat: a server that is still alive rewrites it.
 */
export async function isServerRunning(
  dataDir: string,
  options: { now?: number; settleMs?: number } = {},
): Promise<boolean> {
  const path = lockPath(dataDir)
  if (!existsSync(path)) return false
  if (ownId && recordedId(dataDir) === ownId) return false
  if (serverLockIsFresh(dataDir, options.now)) return true
  const first = mtimeOf(path)
  if (first === undefined) return false
  if ((options.now ?? Date.now()) - first > SUSPECT_UNTIL_MS) return false
  await sleep(options.settleMs ?? SETTLE_MS)
  const second = mtimeOf(path)
  return second !== undefined && second !== first
}

/** For the server at start: wait for a previous instance's lock to expire, or give up. */
export async function waitForLockRelease(
  dataDir: string,
  options: { timeoutMs?: number; pollMs?: number } = {},
): Promise<boolean> {
  const deadline = Date.now() + (options.timeoutMs ?? STALE_AFTER_MS + 5_000)
  while (serverLockIsFresh(dataDir)) {
    if (Date.now() > deadline) return false
    await sleep(options.pollMs ?? 1_000)
  }
  return true
}
