import { LockedError } from '../errors.ts'

export type LockState = 'unprotected' | 'locked' | 'unlocked'

type Listener = () => void | Promise<void>

export interface KeyringOptions {
  // False for databases that have no key slots yet: nothing is encrypted, so nothing is locked.
  protected: boolean
  onListenerError?: (err: unknown) => void
}

function wipe(buffer: Buffer): void {
  buffer.fill(0)
}

// The only place the data encryption key lives while the process runs. The key is kept in one
// private buffer that is overwritten on lock. This is best-effort: strings or copies derived from
// it elsewhere cannot be zeroised.
export class Keyring {
  #dek: Buffer | null = null
  #protected: boolean
  #permanent = false
  #unlockListeners: Listener[] = []
  #lockListeners: Listener[] = []
  #onListenerError: (err: unknown) => void

  constructor(options: KeyringOptions) {
    this.#protected = options.protected
    this.#onListenerError = options.onListenerError ?? ((err) => console.error(err))
  }

  get state(): LockState {
    if (!this.#protected) return 'unprotected'
    return this.#dek ? 'unlocked' : 'locked'
  }

  get isProtected(): boolean {
    return this.#protected
  }

  get isLocked(): boolean {
    return this.#protected && this.#dek === null
  }

  // True when the key was supplied by the deployment and stays in memory for the process lifetime.
  get isPermanent(): boolean {
    return this.#permanent
  }

  onUnlock(listener: Listener): void {
    this.#unlockListeners.push(listener)
  }

  onLock(listener: Listener): void {
    this.#lockListeners.push(listener)
  }

  // Takes ownership of `dek`: it is kept as-is while unlocked and wiped on lock. If the keyring
  // is already unlocked the argument is wiped and the held key is left untouched.
  unlock(dek: Buffer, options: { permanent?: boolean } = {}): void {
    if (!this.#protected) {
      wipe(dek)
      throw new Error('Cannot unlock: no key slots exist yet')
    }
    if (this.#dek) {
      wipe(dek)
      return
    }
    this.#dek = dek
    this.#permanent = options.permanent === true
    this.#notify(this.#unlockListeners)
  }

  // One-way switch for a database that has just gained its key slots: from now on values are
  // encrypted, and the keyring starts out unlocked with the key that was just created. Takes
  // ownership of `dek`.
  protect(dek: Buffer, options: { permanent?: boolean } = {}): void {
    if (this.#protected) {
      wipe(dek)
      throw new Error('Keyring is already protected')
    }
    this.#protected = true
    this.unlock(dek, options)
  }

  // Wipes the key. Ignored while the key is permanent (unattended mode) or already locked.
  lock(): boolean {
    if (!this.#dek || this.#permanent) return false
    this.#forget()
    this.#notify(this.#lockListeners)
    return true
  }

  // Unconditional wipe for shutdown, regardless of unattended mode.
  destroy(): void {
    if (!this.#dek) return
    this.#forget()
    this.#permanent = false
  }

  // Runs `fn` with the live key. Do not keep the buffer or use it across an await: it is wiped on
  // lock. For asynchronous work take copyDek() instead.
  withDek<T>(fn: (dek: Buffer) => T): T {
    if (!this.#protected) throw new Error('Key slots are not initialised')
    if (!this.#dek) throw new LockedError()
    return fn(this.#dek)
  }

  // A private copy for work that spans an await. The caller must wipe it.
  copyDek(): Buffer {
    return this.withDek((dek) => {
      const copy = Buffer.alloc(dek.length)
      dek.copy(copy)
      return copy
    })
  }

  #forget(): void {
    if (this.#dek) wipe(this.#dek)
    this.#dek = null
  }

  #notify(listeners: Listener[]): void {
    for (const listener of listeners) {
      Promise.resolve()
        .then(listener)
        .catch((err) => this.#onListenerError(err))
    }
  }
}
