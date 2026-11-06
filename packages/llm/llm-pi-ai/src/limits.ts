/**
 * Provider usage-window and retry-time facts read from response headers.
 *
 * Only the whitelisted Anthropic `unified` headers are read: per-window
 * utilization, reset, and status, plus the overall status and reset. Every
 * other header is ignored and never stored. Parsing is pure; the response
 * probe is the only part that touches `fetch`.
 *
 * @module dsh-llm-pi-ai/limits
 */

import type { FetchFunction } from '@earendil-works/pi-ai'
import type { ProviderLimits, ProviderLimitWindow } from '@deepseek-ai/dsh-llm'

/** Usage windows reported by the unified family, in publication order. */
const WINDOWS = [
  { id: '5h', label: '5 h' },
  { id: '7d', label: '7 d' },
] as const

/** Header values of `anthropic-ratelimit-unified-*-status` mapped to the neutral window status. */
const STATUS_OF: Readonly<Record<string, NonNullable<ProviderLimitWindow['status']>>> = {
  'allowed': 'ok',
  'allowed_warning': 'warning',
  'rejected': 'exhausted',
}

/**
 * Response APIs whose pi-ai provider accepts an injected `fetch`. Other pi-ai
 * APIs reject or ignore an injected fetch, so the probe is never installed for them.
 */
export const PROBED_APIS: ReadonlySet<string> = new Set(['anthropic-messages', 'openai-completions', 'openai-responses'])

/**
 * Parse a numeric header value, rejecting absent, blank, and non-finite values.
 * @param text - raw header value, or null when the header is absent.
 * @returns the finite number, or undefined when the value is unusable.
 */
function numberOf(text: string | null): number | undefined {
  if (text === null || text.trim() === '') return undefined
  const value = Number(text)
  return Number.isFinite(value) ? value : undefined
}

/**
 * Convert an epoch-seconds reset header to an instant in milliseconds.
 * @param text - raw reset header value in epoch seconds.
 * @returns the instant in epoch milliseconds, or undefined when the value is not a positive finite number.
 */
function resetInstantOf(text: string | null): number | undefined {
  const seconds = numberOf(text)
  return seconds === undefined || seconds <= 0 ? undefined : seconds * 1000
}

/**
 * Read one usage window from the unified headers.
 * @param headers - response headers of one provider call.
 * @param id - window id, e.g. `5h`.
 * @param now - current epoch milliseconds; a reset not later than this is stale.
 * @returns the window, or undefined when its utilization or reset is unusable.
 */
function windowOf(headers: Headers, id: string, now: number): Omit<ProviderLimitWindow, 'label'> | undefined {
  const utilization = numberOf(headers.get(`anthropic-ratelimit-unified-${id}-utilization`))
  if (utilization === undefined || utilization < 0) return undefined
  const resetsAt = resetInstantOf(headers.get(`anthropic-ratelimit-unified-${id}-reset`))
  if (resetsAt === undefined || resetsAt <= now) return undefined
  const status = STATUS_OF[headers.get(`anthropic-ratelimit-unified-${id}-status`) ?? '']
  return {
    id,
    usedPercent: Math.round(Math.min(utilization, 1) * 1000) / 10,
    resetsAt,
    ...status === undefined ? {} : { status },
  }
}

/**
 * Parse the usage windows of one provider response.
 * @param provider - provider route id that produced the response.
 * @param headers - response headers of that call.
 * @param now - epoch milliseconds stamped as `updatedAt` and used to drop stale resets.
 * @returns the limits with the windows present in the headers, or undefined when none is usable.
 */
export function parseProviderLimits(provider: string, headers: Headers, now: number): ProviderLimits | undefined {
  const windows: ProviderLimitWindow[] = []
  for (const { id, label } of WINDOWS) {
    const window = windowOf(headers, id, now)
    if (window !== undefined) windows.push({ ...window, label })
  }
  return windows.length === 0 ? undefined : { provider, windows, updatedAt: now }
}

/**
 * Delay until the provider accepts requests again, from `retry-after` or from
 * an overall unified `rejected` status.
 * @param headers - response headers of a failed provider call.
 * @param now - current epoch milliseconds, the origin for HTTP-date and reset instants.
 * @returns a positive integer number of milliseconds, or undefined when no usable delay is reported.
 */
export function retryDelayMs(headers: Headers, now: number): number | undefined {
  const retryAfter = headers.get('retry-after')?.trim() ?? ''
  if (/^\d+(?:\.\d+)?$/.test(retryAfter)) {
    const seconds = Number(retryAfter)
    if (seconds > 0) return Math.ceil(seconds * 1000)
  }
  if (retryAfter !== '' && !/^\d/.test(retryAfter)) {
    const at = Date.parse(retryAfter)
    if (Number.isFinite(at) && at > now) return Math.ceil(at - now)
  }
  if (headers.get('anthropic-ratelimit-unified-status') !== 'rejected') return undefined
  const instant = resetInstantOf(headers.get('anthropic-ratelimit-unified-reset')) ?? latestRejectedReset(headers)
  if (instant === undefined) return undefined
  const delay = instant - now
  return Number.isFinite(delay) && delay > 0 ? Math.ceil(delay) : undefined
}

/**
 * Latest reset instant among the windows whose own status is `rejected`.
 * @param headers - response headers of a failed provider call.
 * @returns the latest instant in epoch milliseconds, or undefined when no rejected window has a usable reset.
 */
function latestRejectedReset(headers: Headers): number | undefined {
  let latest: number | undefined
  for (const { id } of WINDOWS) {
    if (headers.get(`anthropic-ratelimit-unified-${id}-status`) !== 'rejected') continue
    const instant = resetInstantOf(headers.get(`anthropic-ratelimit-unified-${id}-reset`))
    if (instant !== undefined && (latest === undefined || instant > latest)) latest = instant
  }
  return latest
}

/**
 * Whether the probe may wrap `fetch` for this pi-ai API.
 * @param api - pi-ai model API identifier.
 * @returns true for the APIs in {@link PROBED_APIS}.
 */
export function probesResponses(api: string): boolean {
  return PROBED_APIS.has(api)
}

/** Status and optional retry delay of the last failed provider response. */
export interface ProviderFailureFacts {
  /** HTTP status of the failed response. */
  readonly status: number
  /** Provider-requested delay in milliseconds, when the response reports one. */
  readonly providerRetryAfterMs?: number
}

/** Pass-through `fetch` that records the last response's status and headers. */
export interface ResponseProbe {
  /** Drop-in `fetch` for pi-ai options; returns each response unchanged. */
  readonly fetch: FetchFunction
  /**
   * Facts of the last response when it failed.
   * @returns the status and retry delay, or undefined when no response was seen or its status is below 400.
   */
  failureFacts(): ProviderFailureFacts | undefined
}

/**
 * Wrap provider HTTP calls to publish usage windows and keep the last failure's facts.
 * @param onLimits - listener for parsed usage windows; undefined publishes nothing.
 * @param provider - provider route id stamped on published limits.
 * @param now - clock in epoch milliseconds, read at each response and each failure query.
 * @returns the probe whose `fetch` replaces pi-ai's transport for one call.
 */
export function createResponseProbe(
  onLimits: ((limits: ProviderLimits) => void) | undefined,
  provider: string,
  now: () => number = () => Date.now(),
): ResponseProbe {
  let last: { status: number; headers: Headers } | undefined
  const fetch: FetchFunction = async (input, init) => {
    const response = await globalThis.fetch(input, init)
    last = { status: response.status, headers: response.headers }
    const limits = parseProviderLimits(provider, response.headers, now())
    if (limits !== undefined && onLimits !== undefined) {
      try {
        onLimits(limits)
      } catch (_error: unknown) {
        // The listener's `_error` is contained: a failing observer must not fail a provider request that already succeeded.
      }
    }
    return response
  }
  return {
    fetch,
    failureFacts() {
      if (last === undefined || last.status < 400) return undefined
      const delay = retryDelayMs(last.headers, now())
      return { status: last.status, ...delay === undefined ? {} : { providerRetryAfterMs: delay } }
    },
  }
}
