export interface SessionTrackerOptions {
  idleMs: number
  // Called when the last live session goes away, so the key can be dropped.
  onEmpty: () => void
  now?: () => number
}

// Mirrors the session idle timeout for the purpose of holding the data key: the key stays in
// memory only while at least one session has been active within `idleMs`.
export class SessionTracker {
  #lastSeen = new Map<string, number>()
  #idleMs: number
  #onEmpty: () => void
  #now: () => number

  constructor(options: SessionTrackerOptions) {
    this.#idleMs = options.idleMs
    this.#onEmpty = options.onEmpty
    this.#now = options.now ?? Date.now
  }

  get size(): number {
    return this.#lastSeen.size
  }

  add(sessionId: string): void {
    this.#lastSeen.set(sessionId, this.#now())
  }

  // False when the session is unknown or has been idle too long; it is dropped in the latter case.
  touch(sessionId: string): boolean {
    const seen = this.#lastSeen.get(sessionId)
    if (seen === undefined) return false
    if (this.#now() - seen > this.#idleMs) {
      this.#lastSeen.delete(sessionId)
      this.#emptyCheck()
      return false
    }
    this.#lastSeen.set(sessionId, this.#now())
    return true
  }

  release(sessionId: string): void {
    if (this.#lastSeen.delete(sessionId)) this.#emptyCheck()
  }

  // Revokes every session except `sessionId`, e.g. after the credentials changed. The kept session
  // guarantees the tracker is not empty, so the key stays held.
  retainOnly(sessionId: string): void {
    for (const id of this.#lastSeen.keys()) {
      if (id !== sessionId) this.#lastSeen.delete(id)
    }
  }

  // Also the backstop for an empty tracker: if a key is somehow held with no session to justify
  // it, the next sweep drops it.
  sweep(): void {
    const cutoff = this.#now() - this.#idleMs
    for (const [id, seen] of this.#lastSeen) {
      if (seen < cutoff) this.#lastSeen.delete(id)
    }
    this.#emptyCheck()
  }

  #emptyCheck(): void {
    if (this.#lastSeen.size === 0) this.#onEmpty()
  }
}
