/**
 * Per-watcher delivery: one latest-wins state slot and frame slot, plus a bounded FIFO of discrete events.
 * A slow consumer never grows memory: the generator pulls the next item only when the previous one was consumed.
 * @module @deepseek-ai/dsh-api-browser-view/fanout
 */

import type { BrowserViewEvent, BrowserViewState } from './types.ts'

/** Discrete events one watcher may hold; past this, the oldest move (else the oldest event) is dropped. */
const MAX_QUEUED_EVENTS = 256

type FrameEvent = Extract<BrowserViewEvent, { type: 'frame' }>
type PointerEvent = Extract<BrowserViewEvent, { type: 'pointer' }>

/** Delivery state of one watch; the watch generator drains it. */
export class WatchFanout {
  private state: BrowserViewState | undefined
  private frame: FrameEvent | undefined
  private readonly queue: BrowserViewEvent[] = []
  private closed = false
  private lastFrameAt = Number.NEGATIVE_INFINITY
  private wake: (() => void) | undefined

  /**
   * @param minFrameIntervalMs - smallest gap between two delivered frames; the screencast fps limit.
   */
  constructor(private readonly minFrameIntervalMs: number) {}

  /**
   * Replace the pending state; the newest state is delivered before queued events.
   * @param state - browser state snapshot.
   */
  pushState(state: BrowserViewState): void {
    this.state = state
    this.notify()
  }

  /**
   * Replace the pending frame; frames arriving faster than the fps limit are dropped.
   * @param frame - the newest stored frame of the watched tab.
   */
  pushFrame(frame: FrameEvent): void {
    this.frame = frame
    this.notify()
  }

  /**
   * Discard the pending frame, for a watch that switched to another tab.
   */
  resetFrame(): void {
    this.frame = undefined
  }

  /**
   * Queue one discrete event; a new move replaces a queued move of the same tab.
   * @param event - pointer, key, input, or navigation event.
   */
  pushEvent(event: BrowserViewEvent): void {
    const last = this.queue.at(-1)
    if (isMove(event) && last !== undefined && isMove(last) && last.targetId === event.targetId) {
      this.queue[this.queue.length - 1] = event
    } else {
      if (this.queue.length >= MAX_QUEUED_EVENTS) this.queue.splice(Math.max(this.queue.findIndex(isMove), 0), 1)
      this.queue.push(event)
    }
    this.notify()
  }

  /** End the stream after the items already pending are delivered. */
  close(): void {
    this.closed = true
    this.notify()
  }

  /**
   * Yield the pending state, queued events, and then the latest frame, one item per pull.
   * @param signal - watch cancellation; ends the generator without yielding further items.
   * @returns the watch items in delivery order.
   */
  async * drain(signal: AbortSignal): AsyncGenerator<BrowserViewEvent> {
    while (!signal.aborted) {
      if (this.state !== undefined) {
        const state = this.state
        this.state = undefined
        yield { type: 'state', state }
        continue
      }
      const queued = this.queue.shift()
      if (queued !== undefined) {
        yield queued
        continue
      }
      if (this.frame !== undefined) {
        const wait = this.lastFrameAt + this.minFrameIntervalMs - Date.now()
        if (wait <= 0) {
          const frame = this.frame
          this.frame = undefined
          this.lastFrameAt = Date.now()
          yield frame
          continue
        }
        await this.park(signal, wait)
        continue
      }
      if (this.closed) return
      await this.park(signal)
    }
  }

  private park(signal: AbortSignal, ms?: number): Promise<void> {
    return new Promise((resolve) => {
      const done = (): void => {
        clearTimeout(timer)
        signal.removeEventListener('abort', done)
        if (this.wake === done) this.wake = undefined
        resolve()
      }
      const timer = ms === undefined ? undefined : setTimeout(done, ms)
      this.wake = done
      signal.addEventListener('abort', done, { once: true })
    })
  }

  private notify(): void {
    const wake = this.wake
    this.wake = undefined
    wake?.()
  }
}

/**
 * @param event - any watch item.
 * @returns whether the item is a pointer move, the only event kind that coalesces.
 */
function isMove(event: BrowserViewEvent): event is PointerEvent {
  return event.type === 'pointer' && event.kind === 'move'
}
