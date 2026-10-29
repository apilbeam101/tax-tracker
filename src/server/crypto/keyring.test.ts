import { describe, expect, it, vi } from 'vitest'
import { LockedError } from '../errors.ts'
import { Keyring } from './keyring.ts'

const dekOf = (byte: number) => Buffer.alloc(32, byte)
const tick = () => new Promise((resolve) => setImmediate(resolve))

describe('Keyring state', () => {
  it('is unprotected, and never locked, before key slots exist', () => {
    const keyring = new Keyring({ protected: false })
    expect(keyring.state).toBe('unprotected')
    expect(keyring.isLocked).toBe(false)
    expect(() => keyring.withDek(() => 1)).toThrow(/not initialised/)
    expect(() => keyring.unlock(dekOf(1))).toThrow(/no key slots/)
  })

  it('starts locked when protected, and unlocks and locks', () => {
    const keyring = new Keyring({ protected: true })
    expect(keyring.state).toBe('locked')
    expect(keyring.isLocked).toBe(true)

    keyring.unlock(dekOf(7))
    expect(keyring.state).toBe('unlocked')
    expect(keyring.isLocked).toBe(false)

    expect(keyring.lock()).toBe(true)
    expect(keyring.state).toBe('locked')
    expect(keyring.lock()).toBe(false)
  })

  it('refuses to hand out the key while locked, with a 423', () => {
    const keyring = new Keyring({ protected: true })
    expect(() => keyring.withDek(() => 1)).toThrowError(LockedError)
    expect(() => keyring.copyDek()).toThrowError(LockedError)
  })
})

describe('Keyring key handling', () => {
  it('hands the held key to withDek and overwrites that buffer on lock', () => {
    const keyring = new Keyring({ protected: true })
    keyring.unlock(dekOf(0xab))

    let held: Buffer | undefined
    keyring.withDek((dek) => {
      held = dek
      expect(dek.equals(dekOf(0xab))).toBe(true)
    })
    keyring.lock()

    expect(held?.equals(Buffer.alloc(32, 0))).toBe(true)
  })

  it('takes ownership of the unlock buffer', () => {
    const keyring = new Keyring({ protected: true })
    const dek = dekOf(5)
    keyring.unlock(dek)
    keyring.lock()
    expect(dek.equals(Buffer.alloc(32, 0))).toBe(true)
  })

  it('wipes a second key offered while already unlocked and keeps the first', () => {
    const keyring = new Keyring({ protected: true })
    keyring.unlock(dekOf(1))
    const second = dekOf(2)
    keyring.unlock(second)
    expect(second.equals(Buffer.alloc(32, 0))).toBe(true)
    expect(keyring.withDek((dek) => dek.equals(dekOf(1)))).toBe(true)
  })

  it('copyDek returns a private copy that survives a lock', () => {
    const keyring = new Keyring({ protected: true })
    keyring.unlock(dekOf(9))
    const copy = keyring.copyDek()
    keyring.lock()
    expect(copy.equals(dekOf(9))).toBe(true)
  })
})

describe('Keyring permanent (unattended) mode', () => {
  it('ignores lock() but is still wiped by destroy()', () => {
    const keyring = new Keyring({ protected: true })
    keyring.unlock(dekOf(3), { permanent: true })
    expect(keyring.isPermanent).toBe(true)
    expect(keyring.lock()).toBe(false)
    expect(keyring.state).toBe('unlocked')

    let held: Buffer | undefined
    keyring.withDek((dek) => {
      held = dek
    })
    keyring.destroy()
    expect(keyring.state).toBe('locked')
    expect(keyring.isPermanent).toBe(false)
    expect(held?.equals(Buffer.alloc(32, 0))).toBe(true)
  })
})

describe('Keyring listeners', () => {
  it('fires onUnlock once per transition and onLock when locking', async () => {
    const keyring = new Keyring({ protected: true })
    const unlocked = vi.fn()
    const locked = vi.fn()
    keyring.onUnlock(unlocked)
    keyring.onLock(locked)

    keyring.unlock(dekOf(1))
    keyring.unlock(dekOf(1))
    await tick()
    expect(unlocked).toHaveBeenCalledTimes(1)

    keyring.lock()
    keyring.lock()
    await tick()
    expect(locked).toHaveBeenCalledTimes(1)

    keyring.unlock(dekOf(1))
    await tick()
    expect(unlocked).toHaveBeenCalledTimes(2)
  })

  it('reports a failing listener without breaking the unlock or other listeners', async () => {
    const onListenerError = vi.fn()
    const keyring = new Keyring({ protected: true, onListenerError })
    const after = vi.fn()
    keyring.onUnlock(() => {
      throw new Error('startup task failed')
    })
    keyring.onUnlock(async () => {
      throw new Error('async failure')
    })
    keyring.onUnlock(after)

    keyring.unlock(dekOf(1))
    await tick()

    expect(keyring.state).toBe('unlocked')
    expect(after).toHaveBeenCalledTimes(1)
    expect(onListenerError).toHaveBeenCalledTimes(2)
  })
})
