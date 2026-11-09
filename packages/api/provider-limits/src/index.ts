/**
 * Last known provider usage windows, served to browser clients over Typert Remote with live updates. Producers emit
 * `llm/provider-limits`; this plugin keeps the latest value per provider route. Observation only: the plugin
 * contributes no tools, prompt sections, or Session events.
 * @module @deepseek-ai/dsh-api-provider-limits
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import type { ProviderBalance, ProviderLimits, ProviderLimitWindow } from '@deepseek-ai/dsh-llm'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type { ProviderLimitsFrame } from './types.ts'

export type * from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Provider limits Remote controller. */
    providerLimitsController: ProviderLimitsController
  }
}

/** Polled account balance of a pay-per-use provider route. Absent `balance` disables polling. */
export interface Config {
  /** Account balance polling for one pay-per-use provider route. */
  balance?: {
    /** Provider route id the balance is published under. */
    provider: string
    /** Credential reference holding the Timeweb Cloud API token. */
    tokenEnv: string
    /** Timeweb Cloud `account/finances` endpoint. */
    url: string
    /** Poll period in milliseconds. */
    intervalMs: number
  }
}

/** Serves the last published usage windows of each provider route to browser clients over Typert Remote. */
export default class ProviderLimitsController extends TypertRemoteService {
  static inject = ['llm', 'typert']
  static Config = z.object({
    balance: z.object({
      provider: z.string().default('timeweb'),
      tokenEnv: z.string().role('credential-ref').default('TIMEWEB_CLOUD_API_TOKEN'),
      url: z.string().default('https://api.timeweb.cloud/api/v1/account/finances'),
      intervalMs: z.number().step(1).min(1000).default(60_000),
    }),
  })

  private readonly stored = new Map<string, ProviderLimits>()
  private readonly followers = new Set<LimitsFollower>()
  private readonly lifetime = new AbortController()

  /**
   * @param ctx - Host context carrying the Remote registry and the producer event.
   * @param config - optional balance polling.
   */
  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'providerLimitsController', { namespace: 'providerLimits' })
    ctx.on('llm/provider-limits', (limits) => {
      this.stored.set(limits.provider, limits)
      for (const follower of this.followers) follower.mark()
    })
    ctx.effect(() => () => { this.lifetime.abort() }, 'providerLimits: follow streams')
    const balance = config.balance
    if (balance !== undefined) {
      const poll = (): void => { void this.pollBalance(balance) }
      poll()
      const timer = setInterval(poll, balance.intervalMs)
      ctx.effect(() => () => { clearInterval(timer) }, 'providerLimits: balance poll')
    }
  }

  /**
   * Fetch the account balance once and publish it; a missing token or a failed call keeps the previous value.
   * @param balance - polling settings.
   */
  private async pollBalance(balance: NonNullable<Config['balance']>): Promise<void> {
    const ref = credentialRef(balance.tokenEnv)
    const credentials = this.ctx.get('credentials')
    const token = credentials !== undefined
      ? (await credentials.resolve(ref))?.value
      : launchEnvironmentOf(this.ctx).get(ref)?.value
    if (token === undefined || token === '') return
    try {
      const amount = await fetchBalance(balance.url, token, AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(10_000)]))
      this.ctx.emit('llm/provider-limits', { provider: balance.provider, windows: [], balance: amount, updatedAt: Date.now() })
    } catch (error: unknown) {
      this.ctx.logger.warn(`providerLimits: balance poll for "${balance.provider}" failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /**
   * Current limits of every reported provider route.
   * @returns the reported providers; empty when no producer reported windows.
   */
  @Remote('get')
  get(): ProviderLimits[] {
    return this.current()
  }

  /**
   * Stream the current limits: a snapshot first, then the full list after each change. A reader that pulls slowly
   * receives the latest list once, not every intermediate change. The stream ends when `signal` aborts or the plugin
   * is disposed.
   * @param signal - stream cancellation.
   * @returns the frames of one stream.
   */
  @Remote({ mode: 'stream' })
  async * follow(signal: AbortSignal): AsyncIterable<ProviderLimitsFrame> {
    const generation = AbortSignal.any([signal, this.lifetime.signal])
    const follower = new LimitsFollower()
    this.followers.add(follower)
    try {
      yield { type: 'snapshot', limits: this.current() }
      while (await follower.changed(generation)) yield { type: 'update', limits: this.current() }
    } finally {
      this.followers.delete(follower)
    }
  }

  /**
   * @returns the stored limits read at the current instant.
   */
  private current(): ProviderLimits[] {
    return currentLimits(this.stored.values(), Date.now())
  }
}

/**
 * Read stored limits as of `now`. A window whose reset instant has passed reads as unused, and a provider without
 * windows is omitted. The stored values are not modified.
 * @param stored - last value per provider route.
 * @param now - epoch milliseconds at read time.
 * @returns the reported providers, as new provider objects with new window arrays.
 */
export function currentLimits(stored: Iterable<ProviderLimits>, now: number): ProviderLimits[] {
  const current: ProviderLimits[] = []
  for (const limits of stored) {
    if (limits.windows.length === 0 && limits.balance === undefined) continue
    current.push({ ...limits, windows: limits.windows.map(window => windowAt(window, now)) })
  }
  return current
}

/**
 * Read the account balance from the Timeweb Cloud `account/finances` endpoint.
 * @param url - endpoint address.
 * @param token - Timeweb Cloud API token.
 * @param signal - request cancellation.
 * @returns the balance.
 * @throws when the response is not OK or carries no numeric `finances.balance`.
 */
export async function fetchBalance(url: string, token: string, signal: AbortSignal): Promise<ProviderBalance> {
  const response = await fetch(url, { headers: { authorization: `Bearer ${token}` }, signal })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  const { finances } = await response.json() as { finances?: { balance?: unknown; currency?: unknown } }
  if (typeof finances?.balance !== 'number') throw new Error('response has no numeric finances.balance')
  return { amount: finances.balance, currency: typeof finances.currency === 'string' ? finances.currency : 'RUB' }
}

/**
 * @param window - one stored usage window.
 * @param now - epoch milliseconds at read time.
 * @returns the window unchanged before its reset; afterwards zero used, with status `ok` when the window reported one.
 */
function windowAt(window: ProviderLimitWindow, now: number): ProviderLimitWindow {
  if (window.resetsAt > now) return window
  return window.status === undefined ? { ...window, usedPercent: 0 } : { ...window, usedPercent: 0, status: 'ok' }
}

/** Wake-up state of one follow stream: a dirty flag coalesces changes until the stream pulls again. */
class LimitsFollower {
  private dirty = false
  private wake: (() => void) | undefined

  /** Record one change and wake the stream if it waits. */
  mark(): void {
    this.dirty = true
    const wake = this.wake
    this.wake = undefined
    wake?.()
  }

  /**
   * Wait until a change is pending.
   * @param signal - stream cancellation.
   * @returns true when the list changed since the last call, false when `signal` aborted.
   */
  async changed(signal: AbortSignal): Promise<boolean> {
    if (!this.dirty && !signal.aborted) {
      await new Promise<void>((resolve) => {
        const done = (): void => {
          signal.removeEventListener('abort', done)
          this.wake = undefined
          resolve()
        }
        this.wake = done
        signal.addEventListener('abort', done, { once: true })
      })
    }
    if (signal.aborted) return false
    this.dirty = false
    return true
  }
}
