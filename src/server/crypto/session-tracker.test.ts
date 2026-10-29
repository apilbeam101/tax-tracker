import { beforeEach, describe, expect, it, type Mock, vi } from 'vitest'
import { SessionTracker } from './session-tracker.ts'

const HOUR = 60 * 60 * 1000

let now: number
let onEmpty: Mock<() => void>
let tracker: SessionTracker

beforeEach(() => {
  now = 1_000_000
  onEmpty = vi.fn()
  tracker = new SessionTracker({ idleMs: 8 * HOUR, onEmpty, now: () => now })
})

describe('SessionTracker', () => {
  it('knows the sessions it was told about and nothing else', () => {
    tracker.add('a')
    expect(tracker.touch('a')).toBe(true)
    expect(tracker.touch('unknown')).toBe(false)
    expect(onEmpty).not.toHaveBeenCalled()
  })

  it('signals empty only when the last session is released', () => {
    tracker.add('a')
    tracker.add('b')
    tracker.release('a')
    expect(onEmpty).not.toHaveBeenCalled()
    tracker.release('b')
    expect(onEmpty).toHaveBeenCalledTimes(1)
  })

  it('does not signal for releasing a session it never held', () => {
    tracker.release('ghost')
    expect(onEmpty).not.toHaveBeenCalled()
  })

  it('treats activity as extending the idle window', () => {
    tracker.add('a')
    now += 7 * HOUR
    expect(tracker.touch('a')).toBe(true)
    now += 7 * HOUR
    expect(tracker.touch('a')).toBe(true)
  })

  it('expires a session idle for longer than the window and signals when none remain', () => {
    tracker.add('a')
    now += 8 * HOUR + 1
    expect(tracker.touch('a')).toBe(false)
    expect(tracker.size).toBe(0)
    expect(onEmpty).toHaveBeenCalledTimes(1)
  })

  it('keeps a session idle for exactly the window', () => {
    tracker.add('a')
    now += 8 * HOUR
    expect(tracker.touch('a')).toBe(true)
  })

  it('sweep drops only the idle sessions and signals only when all are gone', () => {
    tracker.add('old')
    now += 5 * HOUR
    tracker.add('recent')
    now += 4 * HOUR

    tracker.sweep()
    expect(tracker.size).toBe(1)
    expect(tracker.touch('recent')).toBe(true)
    expect(onEmpty).not.toHaveBeenCalled()

    now += 9 * HOUR
    tracker.sweep()
    expect(tracker.size).toBe(0)
    expect(onEmpty).toHaveBeenCalledTimes(1)
  })

  it('sweep with nothing expired does nothing', () => {
    tracker.add('a')
    tracker.sweep()
    expect(tracker.size).toBe(1)
    expect(onEmpty).not.toHaveBeenCalled()
  })
})
