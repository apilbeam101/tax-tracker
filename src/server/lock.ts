import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { Keyring } from './crypto/keyring.ts'
import { hasKeySlots, hasUnattendedSlot, unlockWithUnattendedKey } from './crypto/keyslots.ts'
import { SessionTracker } from './crypto/session-tracker.ts'
import type { Db } from './db/database.ts'
import { LOCKED_CODE, LOCKED_MESSAGE } from './errors.ts'
import { SESSION_IDLE_MS } from './session.ts'

export function lockedBody(code = LOCKED_CODE, message = LOCKED_MESSAGE) {
  return { error: message, message, code }
}

export type BootUnlockMode = 'unprotected' | 'passphrase' | 'unattended'

export interface BootUnlockOptions {
  db: Db
  keyring: Keyring
  encryptionKey: string | undefined
  warn: (message: string) => void
}

// Called once at startup. With no key slots the database is not encrypted yet, so nothing is
// locked. Otherwise the app starts locked, unless the deployment supplied an unattended key that
// opens its slot, in which case the key stays in memory for the life of the process.
export async function unlockAtBoot(options: BootUnlockOptions): Promise<BootUnlockMode> {
  const { db, keyring, encryptionKey, warn } = options
  if (!hasKeySlots(db)) return 'unprotected'

  if (!encryptionKey) return 'passphrase'

  if (!hasUnattendedSlot(db)) {
    warn(
      'ENCRYPTION_KEY is set but no unattended key slot exists, so it is being ignored. ' +
        'The app starts locked until someone signs in.',
    )
    return 'passphrase'
  }

  const dek = await unlockWithUnattendedKey(db, encryptionKey)
  if (!dek) {
    throw new Error(
      'ENCRYPTION_KEY does not open the unattended key slot. Refusing to start: fix the key, or ' +
        'remove the unattended slot, rather than silently starting locked.',
    )
  }
  keyring.unlock(dek, { permanent: true })
  return 'unattended'
}

export interface LockStateOptions {
  db: Db
  encryptionKey: string | undefined
  // Work that touches decrypted data. Runs at boot when there is nothing to unlock (or an
  // unattended key opens it), otherwise on the first unlock. Retried on the next unlock if it throws.
  startupTasks: () => void
  sweepIntervalMs?: number
  now?: () => number
}

export interface LockState {
  /** Decides the boot unlock mode and runs the startup work. Call once the stores exist. */
  boot: () => Promise<BootUnlockMode>
}

// Creates the keyring and session tracker and decorates the app with them, so the stores can be
// built on top of the keyring; boot() then decides the unlock mode. Shared by buildApp() and the
// tests, so the wiring that is tested is the wiring that runs.
export function registerLockState(app: FastifyInstance, options: LockStateOptions): LockState {
  const { db, encryptionKey, startupTasks } = options

  const keyring = new Keyring({
    protected: hasKeySlots(db),
    onListenerError: (err) => app.log.error(err),
  })
  const sessionTracker = new SessionTracker({
    idleMs: SESSION_IDLE_MS,
    onEmpty: () => keyring.lock(),
    ...(options.now ? { now: options.now } : {}),
  })
  app.decorate('keyring', keyring)
  app.decorate('sessionTracker', sessionTracker)

  const sweeper = setInterval(() => sessionTracker.sweep(), options.sweepIntervalMs ?? 60_000)
  sweeper.unref()
  app.addHook('onClose', async () => {
    clearInterval(sweeper)
    keyring.destroy()
  })

  let tasksRan = false
  const runStartupTasks = () => {
    if (tasksRan) return
    startupTasks()
    tasksRan = true
  }
  keyring.onUnlock(runStartupTasks)

  return {
    async boot() {
      const mode = await unlockAtBoot({ db, keyring, encryptionKey, warn: (m) => app.log.warn(m) })
      app.log.info(`Unlock mode: ${mode}`)
      if (mode === 'unprotected') runStartupTasks()
      return mode
    },
  }
}

// Locked: only /health, /api/auth/* and the static client are served. This runs before the
// authentication check on purpose, so a client with a stale session cookie sees "locked" and
// shows the unlock screen instead of a bare 401.
export async function requireUnlocked(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (req.server.keyring.isLocked) return reply.status(423).send(lockedBody())
}

// A session counts only while the tracker knows it and it has been active within the idle
// window. Credential changes drop every other session from the tracker, so this is also how they
// are revoked, even though their cookies are still valid.
export async function requireLiveSession(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (!req.server.sessionTracker.touch(req.session.sessionId)) {
    await req.session.destroy()
    return reply.status(401).send({ error: 'Session expired' })
  }
}
