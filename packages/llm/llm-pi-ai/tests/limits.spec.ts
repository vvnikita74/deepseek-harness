import { describe, expect, it } from 'vitest'
import { parseProviderLimits, probesResponses, retryDelayMs } from '../src/limits.ts'

/** Epoch milliseconds of 2025-12-17T00:00:00Z; every reset below is expressed relative to it. */
const NOW = Date.UTC(2025, 11, 17)
const NOW_SECONDS = NOW / 1000

/**
 * Build response headers from plain pairs.
 * @param pairs - header names and values.
 * @returns a Headers instance holding exactly those pairs.
 */
function headersOf(pairs: Record<string, string>): Headers {
  return new Headers(pairs)
}

describe('parseProviderLimits', () => {
  it('reads both usage windows in order with rounded percentages and provider statuses', () => {
    const headers = headersOf({
      'anthropic-ratelimit-unified-5h-utilization': '0.0425983',
      'anthropic-ratelimit-unified-5h-reset': String(NOW_SECONDS + 14_400),
      'anthropic-ratelimit-unified-5h-status': 'allowed',
      'anthropic-ratelimit-unified-7d-utilization': '0.5',
      'anthropic-ratelimit-unified-7d-reset': String(NOW_SECONDS + 259_200),
      'anthropic-ratelimit-unified-7d-status': 'allowed_warning',
    })

    expect(parseProviderLimits('anthropic-sub', headers, NOW)).toEqual({
      provider: 'anthropic-sub',
      updatedAt: NOW,
      windows: [
        { id: '5h', label: '5 h', usedPercent: 4.3, resetsAt: (NOW_SECONDS + 14_400) * 1000, status: 'ok' },
        { id: '7d', label: '7 d', usedPercent: 50, resetsAt: (NOW_SECONDS + 259_200) * 1000, status: 'warning' },
      ],
    })
  })

  it('maps a rejected window to exhausted and omits status when the provider reports none', () => {
    const headers = headersOf({
      'anthropic-ratelimit-unified-5h-utilization': '1',
      'anthropic-ratelimit-unified-5h-reset': String(NOW_SECONDS + 60),
      'anthropic-ratelimit-unified-5h-status': 'rejected',
      'anthropic-ratelimit-unified-7d-utilization': '0.2',
      'anthropic-ratelimit-unified-7d-reset': String(NOW_SECONDS + 60),
      'anthropic-ratelimit-unified-7d-status': 'something-new',
    })

    const limits = parseProviderLimits('anthropic-sub', headers, NOW)

    expect(limits?.windows[0]).toEqual({
      id: '5h',
      label: '5 h',
      usedPercent: 100,
      resetsAt: (NOW_SECONDS + 60) * 1000,
      status: 'exhausted',
    })
    expect(limits?.windows[1]).not.toHaveProperty('status')
  })

  it('returns undefined when no usage-window header is present', () => {
    expect(parseProviderLimits('anthropic-sub', headersOf({ 'content-type': 'application/json' }), NOW)).toBeUndefined()
  })

  it('skips windows whose utilization is not a finite non-negative number', () => {
    const headers = headersOf({
      'anthropic-ratelimit-unified-5h-utilization': 'abc',
      'anthropic-ratelimit-unified-5h-reset': String(NOW_SECONDS + 60),
      'anthropic-ratelimit-unified-7d-utilization': '-0.1',
      'anthropic-ratelimit-unified-7d-reset': String(NOW_SECONDS + 60),
    })

    expect(parseProviderLimits('anthropic-sub', headers, NOW)).toBeUndefined()
    expect(parseProviderLimits('anthropic-sub', headersOf({
      'anthropic-ratelimit-unified-5h-utilization': 'NaN',
      'anthropic-ratelimit-unified-5h-reset': String(NOW_SECONDS + 60),
    }), NOW)).toBeUndefined()
  })

  it('clamps utilization above 1 to 100 percent', () => {
    const headers = headersOf({
      'anthropic-ratelimit-unified-5h-utilization': '1.7',
      'anthropic-ratelimit-unified-5h-reset': String(NOW_SECONDS + 60),
    })

    expect(parseProviderLimits('anthropic-sub', headers, NOW)?.windows[0]?.usedPercent).toBe(100)
  })

  it('skips windows whose reset is missing, zero, non-numeric, or not later than now', () => {
    const past = headersOf({
      'anthropic-ratelimit-unified-5h-utilization': '0.3',
      'anthropic-ratelimit-unified-5h-reset': String(NOW_SECONDS - 1),
    })
    const zero = headersOf({
      'anthropic-ratelimit-unified-5h-utilization': '0.3',
      'anthropic-ratelimit-unified-5h-reset': '0',
    })
    const text = headersOf({
      'anthropic-ratelimit-unified-5h-utilization': '0.3',
      'anthropic-ratelimit-unified-5h-reset': 'tomorrow',
    })
    const missing = headersOf({ 'anthropic-ratelimit-unified-5h-utilization': '0.3' })

    for (const headers of [past, zero, text, missing]) {
      expect(parseProviderLimits('anthropic-sub', headers, NOW)).toBeUndefined()
    }
  })

  it('keeps the good window when the other window is junk', () => {
    const headers = headersOf({
      'anthropic-ratelimit-unified-5h-utilization': 'abc',
      'anthropic-ratelimit-unified-5h-reset': String(NOW_SECONDS + 60),
      'anthropic-ratelimit-unified-7d-utilization': '0.25',
      'anthropic-ratelimit-unified-7d-reset': String(NOW_SECONDS + 600),
    })

    const limits = parseProviderLimits('anthropic-sub', headers, NOW)

    expect(limits?.windows).toEqual([{ id: '7d', label: '7 d', usedPercent: 25, resetsAt: (NOW_SECONDS + 600) * 1000 }])
  })
})

describe('retryDelayMs', () => {
  it('reads a standard retry-after given in seconds', () => {
    expect(retryDelayMs(headersOf({ 'retry-after': '7' }), NOW)).toBe(7000)
    expect(retryDelayMs(headersOf({ 'retry-after': '0.5' }), NOW)).toBe(500)
  })

  it('reads a retry-after HTTP-date later than now and ignores one not later', () => {
    const later = new Date(NOW + 60_000).toUTCString()
    const earlier = new Date(NOW - 60_000).toUTCString()

    expect(retryDelayMs(headersOf({ 'retry-after': later }), NOW)).toBe(60_000)
    expect(retryDelayMs(headersOf({ 'retry-after': earlier }), NOW)).toBeUndefined()
  })

  it('returns undefined for a junk retry-after value', () => {
    expect(retryDelayMs(headersOf({ 'retry-after': 'soon' }), NOW)).toBeUndefined()
    expect(retryDelayMs(headersOf({ 'retry-after': '0' }), NOW)).toBeUndefined()
    expect(retryDelayMs(headersOf({ 'retry-after': '-3' }), NOW)).toBeUndefined()
  })

  it('uses the overall unified reset when the overall unified status is rejected', () => {
    const headers = headersOf({
      'anthropic-ratelimit-unified-status': 'rejected',
      'anthropic-ratelimit-unified-reset': String(NOW_SECONDS + 3600),
      'anthropic-ratelimit-unified-5h-status': 'rejected',
      'anthropic-ratelimit-unified-5h-reset': String(NOW_SECONDS + 60),
    })

    expect(retryDelayMs(headers, NOW)).toBe(3_600_000)
  })

  it('falls back to the latest reset among rejected windows when no overall reset is usable', () => {
    const headers = headersOf({
      'anthropic-ratelimit-unified-status': 'rejected',
      'anthropic-ratelimit-unified-5h-status': 'rejected',
      'anthropic-ratelimit-unified-5h-reset': String(NOW_SECONDS + 1000),
      'anthropic-ratelimit-unified-7d-status': 'rejected',
      'anthropic-ratelimit-unified-7d-reset': String(NOW_SECONDS + 7200),
    })

    expect(retryDelayMs(headers, NOW)).toBe(7_200_000)
  })

  it('returns undefined when the unified status is not rejected or no reset can be used', () => {
    expect(retryDelayMs(headersOf({
      'anthropic-ratelimit-unified-status': 'allowed',
      'anthropic-ratelimit-unified-reset': String(NOW_SECONDS + 3600),
    }), NOW)).toBeUndefined()
    expect(retryDelayMs(headersOf({ 'anthropic-ratelimit-unified-status': 'rejected' }), NOW)).toBeUndefined()
    expect(retryDelayMs(headersOf({
      'anthropic-ratelimit-unified-status': 'rejected',
      'anthropic-ratelimit-unified-reset': String(NOW_SECONDS - 10),
    }), NOW)).toBeUndefined()
  })
})

describe('probesResponses', () => {
  it('inspects only the APIs that accept an injected fetch', () => {
    expect(probesResponses('anthropic-messages')).toBe(true)
    expect(probesResponses('openai-completions')).toBe(true)
    expect(probesResponses('openai-responses')).toBe(true)
    expect(probesResponses('google-generative-ai')).toBe(false)
    expect(probesResponses('google-vertex')).toBe(false)
  })
})
