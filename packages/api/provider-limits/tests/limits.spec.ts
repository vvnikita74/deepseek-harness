import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { ProviderLimits, ProviderLimitWindow } from '@deepseek-ai/dsh-llm'
import ProviderLimitsController, { currentLimits, fetchBalance } from '../src/index.ts'
import type { ProviderLimitsFrame } from '../src/index.ts'

const HOUR = 3_600_000
const NOW = 1_000_000

/**
 * @param id - window id.
 * @param resetsAt - reset instant, epoch milliseconds.
 * @param overrides - fields that differ from the defaults.
 * @returns one usage window.
 */
function window(id: string, resetsAt: number, overrides: Partial<ProviderLimitWindow> = {}): ProviderLimitWindow {
  return { id, label: id, usedPercent: 40, resetsAt, ...overrides }
}

/**
 * @param provider - route id.
 * @param windows - usage windows of the route.
 * @returns the stored limits of one route.
 */
function limits(provider: string, windows: ProviderLimitWindow[]): ProviderLimits {
  return { provider, windows, updatedAt: NOW - 1 }
}

describe('currentLimits', () => {
  it('keeps a window whose reset is ahead unchanged', () => {
    const stored = limits('anthropic-sub', [window('5h', NOW + HOUR, { status: 'warning' })])
    expect(currentLimits([stored], NOW)).toEqual([stored])
  })

  it('reads an expired window as unused with status ok', () => {
    const stored = limits('anthropic-sub', [window('5h', NOW, { usedPercent: 100, status: 'exhausted' })])
    expect(currentLimits([stored], NOW)).toEqual([limits('anthropic-sub', [window('5h', NOW, { usedPercent: 0, status: 'ok' })])])
  })

  it('reads an expired window without a status as unused and leaves it without a status', () => {
    const [current] = currentLimits([limits('p', [window('7d', NOW - 1, { usedPercent: 90 })])], NOW)
    expect(current?.windows[0]).toEqual({ id: '7d', label: '7d', usedPercent: 0, resetsAt: NOW - 1 })
    expect(current?.windows[0]).not.toHaveProperty('status')
  })

  it('skips a provider with no windows', () => {
    expect(currentLimits([limits('empty', []), limits('p', [window('5h', NOW + HOUR)])], NOW).map(item => item.provider)).toEqual(['p'])
  })

  it('does not modify the stored values', () => {
    const stored = [limits('p', [window('5h', NOW, { usedPercent: 100, status: 'exhausted' })])]
    const before = structuredClone(stored)
    const current = currentLimits(stored, NOW)
    expect(stored).toEqual(before)
    expect(current[0]?.windows).not.toBe(stored[0]?.windows)
  })
})

describe('ProviderLimitsController', () => {
  const contexts: Context[] = []

  afterEach(async () => {
    await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  })

  /**
   * @returns a fresh root context with the controller registered on it.
   */
  function setup(): { ctx: Context; service: ProviderLimitsController } {
    const ctx = new Context()
    contexts.push(ctx)
    return { ctx, service: new ProviderLimitsController(ctx) }
  }

  it('returns an empty list before any event', () => {
    expect(setup().service.get()).toEqual([])
  })

  it('returns the limits of an emitted event, and a later event replaces its provider', () => {
    const { ctx, service } = setup()
    const first = limits('anthropic-sub', [window('5h', Date.now() + HOUR)])
    ctx.emit('llm/provider-limits', first)
    expect(service.get()).toEqual([first])
    const second = limits('anthropic-sub', [window('5h', Date.now() + HOUR, { usedPercent: 75 })])
    ctx.emit('llm/provider-limits', second)
    expect(service.get()).toEqual([second])
  })

  it('lists two providers side by side', () => {
    const { ctx, service } = setup()
    const a = limits('a', [window('5h', Date.now() + HOUR)])
    const b = limits('b', [window('7d', Date.now() + HOUR)])
    ctx.emit('llm/provider-limits', a)
    ctx.emit('llm/provider-limits', b)
    expect(service.get()).toEqual([a, b])
  })

  it('opens a follow with a snapshot even when empty, then sends one update with the latest list after bursts', async () => {
    const { ctx, service } = setup()
    const abort = new AbortController()
    const iterator = service.follow(abort.signal)[Symbol.asyncIterator]()
    expect(await iterator.next()).toEqual({ done: false, value: { type: 'snapshot', limits: [] } satisfies ProviderLimitsFrame })

    const a1 = limits('a', [window('5h', Date.now() + HOUR)])
    const a2 = limits('a', [window('5h', Date.now() + HOUR, { usedPercent: 60 })])
    const b = limits('b', [window('7d', Date.now() + HOUR)])
    ctx.emit('llm/provider-limits', a1)
    ctx.emit('llm/provider-limits', a2)
    ctx.emit('llm/provider-limits', b)
    expect(await iterator.next()).toEqual({ done: false, value: { type: 'update', limits: [a2, b] } })

    abort.abort()
    expect(await iterator.next()).toEqual({ done: true, value: undefined })
  })

  it('sends an update for each event the reader pulls after', async () => {
    const { ctx, service } = setup()
    const abort = new AbortController()
    const iterator = service.follow(abort.signal)[Symbol.asyncIterator]()
    await iterator.next()
    const first = limits('a', [window('5h', Date.now() + HOUR)])
    const pending = iterator.next()
    ctx.emit('llm/provider-limits', first)
    expect(await pending).toEqual({ done: false, value: { type: 'update', limits: [first] } })
    abort.abort()
  })

  it('ends an open follow when its signal aborts', async () => {
    const { service } = setup()
    const abort = new AbortController()
    const iterator = service.follow(abort.signal)[Symbol.asyncIterator]()
    await iterator.next()
    const pending = iterator.next()
    abort.abort()
    expect(await pending).toEqual({ done: true, value: undefined })
  })

  it('ends every open follow when the plugin is disposed', async () => {
    const { ctx, service } = setup()
    const iterator = service.follow(new AbortController().signal)[Symbol.asyncIterator]()
    await iterator.next()
    const pending = iterator.next()
    await ctx.fiber.dispose()
    expect(await pending).toEqual({ done: true, value: undefined })
  })
})

describe('balance', () => {
  it('keeps a balance-only route and drops a route with neither windows nor balance', () => {
    const withBalance: ProviderLimits = { provider: 'timeweb', windows: [], balance: { amount: 12.5, currency: 'RUB' }, updatedAt: NOW }
    expect(currentLimits([withBalance, limits('empty', [])], NOW)).toEqual([withBalance])
  })

  it('reads finances.balance from the Timeweb Cloud response', async () => {
    const real = globalThis.fetch
    let auth = ''
    globalThis.fetch = async (_url: unknown, init?: RequestInit) => {
      auth = String((init?.headers as Record<string, string>).authorization)
      return Response.json({ finances: { balance: 321.5, currency: 'RUB' } })
    }
    try {
      expect(await fetchBalance('http://x', 'tok', new AbortController().signal)).toEqual({ amount: 321.5, currency: 'RUB' })
      expect(auth).toBe('Bearer tok')
      globalThis.fetch = async () => new Response('{}', { status: 401 })
      await expect(fetchBalance('http://x', 'tok', new AbortController().signal)).rejects.toThrow('HTTP 401')
    } finally {
      globalThis.fetch = real
    }
  })
})
