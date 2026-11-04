import { afterEach, describe, expect, it, vi } from 'vitest'
import { WatchFanout } from '../src/fanout.ts'
import type { BrowserViewEvent, BrowserViewState } from '../src/types.ts'

afterEach(() => { vi.useRealTimers() })

const state: BrowserViewState = { status: 'ready', tabs: [], viewport: { width: 1280, height: 800 } }

/** @returns a frame event for one tab with the given sequence number. */
function frame(seq: number, targetId = 't1') {
  return { type: 'frame' as const, targetId, seq, ts: seq, jpegBase64: `f${seq}`, metadata: { deviceWidth: 1, deviceHeight: 1, pageScaleFactor: 1, scrollOffsetX: 0, scrollOffsetY: 0 } }
}

/** @returns a pointer move at the given position. */
function move(x: number, targetId = 't1'): BrowserViewEvent {
  return { type: 'pointer', targetId, ts: x, kind: 'move', x, y: 0 }
}

/** @returns a key event for the given key. */
function key(name: string): BrowserViewEvent {
  return { type: 'key', targetId: 't1', ts: 0, key: name, code: name, modifiers: 0 }
}

/**
 * Drain the whole watch until the fanout closes or the signal aborts.
 * @param fanout - delivery state.
 * @param signal - watch cancellation.
 * @returns the delivered items in order.
 */
async function collect(fanout: WatchFanout, signal = new AbortController().signal): Promise<BrowserViewEvent[]> {
  const items: BrowserViewEvent[] = []
  for await (const item of fanout.drain(signal)) items.push(item)
  return items
}

describe('WatchFanout', () => {
  it('delivers the state first, then queued events, then only the latest frame', async () => {
    const fanout = new WatchFanout(0)
    fanout.pushFrame(frame(1))
    fanout.pushEvent(key('a'))
    fanout.pushFrame(frame(2))
    fanout.pushState(state)
    fanout.close()
    expect(await collect(fanout)).toEqual([{ type: 'state', state }, key('a'), frame(2)])
  })

  it('coalesces consecutive moves of one tab and keeps the newest position', async () => {
    const fanout = new WatchFanout(0)
    fanout.pushEvent(move(1))
    fanout.pushEvent(move(2))
    fanout.pushEvent(move(3, 't2'))
    fanout.pushEvent(key('k'))
    fanout.pushEvent(move(4))
    fanout.close()
    expect(await collect(fanout)).toEqual([move(2), move(3, 't2'), key('k'), move(4)])
  })

  it('bounds the queue by dropping the oldest move before any other event', async () => {
    const fanout = new WatchFanout(0)
    fanout.pushEvent(move(1, 'm1'))
    for (let index = 0; index < 254; index++) fanout.pushEvent(key(`k${index}`))
    fanout.pushEvent(key('late1'))
    fanout.pushEvent(key('late2'))
    fanout.close()
    const items = await collect(fanout)
    expect(items).toHaveLength(256)
    expect(items.some(item => item.type === 'pointer')).toBe(false)
    expect(items[0]).toEqual(key('k0'))
    expect(items.at(-1)).toEqual(key('late2'))
  })

  it('bounds the queue by dropping the oldest event when no move is queued', async () => {
    const fanout = new WatchFanout(0)
    for (let index = 0; index < 300; index++) fanout.pushEvent(key(`k${index}`))
    fanout.close()
    const items = await collect(fanout)
    expect(items).toHaveLength(256)
    expect(items[0]).toEqual(key('k44'))
  })

  it('limits frame delivery to one per interval and then yields the latest pending frame', async () => {
    vi.useFakeTimers()
    const fanout = new WatchFanout(100)
    const signal = new AbortController().signal
    const pulls = fanout.drain(signal)
    fanout.pushFrame(frame(1))
    expect(await pulls.next()).toEqual({ done: false, value: frame(1) })
    fanout.pushFrame(frame(2))
    fanout.pushFrame(frame(3))
    const next = pulls.next()
    await vi.advanceTimersByTimeAsync(99)
    let settled = false
    void next.then(() => { settled = true })
    await Promise.resolve()
    expect(settled).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(await next).toEqual({ done: false, value: frame(3) })
  })

  it('ends when the signal aborts while waiting', async () => {
    const fanout = new WatchFanout(0)
    const controller = new AbortController()
    const pulls = fanout.drain(controller.signal)
    const waiting = pulls.next()
    controller.abort()
    expect(await waiting).toEqual({ done: true, value: undefined })
  })

  it('ends after close once pending items are delivered', async () => {
    const fanout = new WatchFanout(0)
    const pulls = fanout.drain(new AbortController().signal)
    const waiting = pulls.next()
    fanout.pushEvent(key('x'))
    expect(await waiting).toEqual({ done: false, value: key('x') })
    fanout.close()
    expect(await pulls.next()).toEqual({ done: true, value: undefined })
  })
})
