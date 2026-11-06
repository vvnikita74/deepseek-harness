import { afterEach, describe, expect, it, vi } from 'vitest'
import type { FinishReason, LlmFailure, ProviderLimits } from '@deepseek-ai/dsh-llm'
import { PiAiAdapter } from '../src/adapter.ts'
import { resolveProfiles } from '../src/config.ts'
import { memoryAuth } from './auth-double.ts'
import { anthropicTextEvents, closeMockServers, mockServer } from './mock-server.ts'

afterEach(async () => {
  await closeMockServers()
})

const PROVIDER = 'anthropic-sub'
const MODEL = 'claude-test'

/**
 * Direct adapter over one hand-declared Anthropic Messages route.
 * @param baseURL - local mock server URL that answers the route.
 * @param onProviderLimits - listener under test; omitted when undefined.
 * @returns the adapter whose stream calls reach the mock server.
 */
function adapterOf(baseURL: string, onProviderLimits?: (limits: ProviderLimits) => void): PiAiAdapter {
  return new PiAiAdapter({
    profiles: () => resolveProfiles({
      [PROVIDER]: {
        api: 'anthropic-messages',
        baseURL,
        models: [{ id: MODEL, contextWindow: 200_000, maxTokens: 1024 }],
      },
    }),
    resolveApiKey: () => Promise.resolve('test-key'),
    auth: memoryAuth(),
    ...onProviderLimits === undefined ? {} : { onProviderLimits },
  })
}

/**
 * Drain one stream call and return its terminal finish reason.
 * @param adapter - adapter to call on the fixed route.
 * @returns the finish reason of the stream.
 */
async function finishOf(adapter: PiAiAdapter): Promise<FinishReason> {
  let finish: FinishReason | undefined
  for await (const chunk of adapter.stream({ provider: PROVIDER, model: MODEL, messages: [], maxTokens: 64 })) {
    if (chunk.type === 'finish') finish = chunk.reason
  }
  if (finish === undefined) throw new Error('stream ended without a finish chunk')
  return finish
}

/**
 * Failure carried by an error finish.
 * @param finish - finish reason expected to be an error.
 * @returns the serializable failure facts.
 */
function failureOf(finish: FinishReason): LlmFailure {
  if (finish.kind !== 'error') throw new Error(`expected an error finish, got ${finish.kind}`)
  return finish.failure
}

/**
 * Unified-family headers for one 5-hour window, reset `seconds` after `nowSeconds`.
 * @param nowSeconds - epoch seconds the reset is measured from.
 * @param seconds - reset offset in seconds.
 * @returns the window headers reporting the window as allowed at 25 percent.
 */
function fiveHourHeaders(nowSeconds: number, seconds: number): Record<string, string> {
  return {
    'anthropic-ratelimit-unified-5h-utilization': '0.25',
    'anthropic-ratelimit-unified-5h-reset': String(nowSeconds + seconds),
    'anthropic-ratelimit-unified-5h-status': 'allowed',
  }
}

describe('pi-ai provider limits', () => {
  it('publishes the usage windows of a successful response once, for its route', async () => {
    const startedAt = Date.now()
    const nowSeconds = Math.floor(startedAt / 1000)
    const onLimits = vi.fn<(limits: ProviderLimits) => void>()
    const server = await mockServer([{
      events: anthropicTextEvents,
      headers: {
        ...fiveHourHeaders(nowSeconds, 3600),
        'anthropic-ratelimit-unified-7d-utilization': '0.5',
        'anthropic-ratelimit-unified-7d-reset': String(nowSeconds + 259_200),
        'anthropic-ratelimit-unified-7d-status': 'allowed_warning',
      },
    }])

    const finish = await finishOf(adapterOf(server.url, onLimits))

    expect(finish).toEqual({ kind: 'stop' })
    expect(onLimits).toHaveBeenCalledOnce()
    const limits = onLimits.mock.calls[0]?.[0]
    expect(limits?.provider).toBe(PROVIDER)
    expect(limits?.updatedAt).toBeGreaterThanOrEqual(startedAt)
    expect(limits?.windows).toEqual([
      { id: '5h', label: '5 h', usedPercent: 25, resetsAt: (nowSeconds + 3600) * 1000, status: 'ok' },
      { id: '7d', label: '7 d', usedPercent: 50, resetsAt: (nowSeconds + 259_200) * 1000, status: 'warning' },
    ])
  })

  it('publishes nothing for a successful response without usage-window headers', async () => {
    const onLimits = vi.fn()
    const server = await mockServer([{ events: anthropicTextEvents }])

    const finish = await finishOf(adapterOf(server.url, onLimits))

    expect(finish).toEqual({ kind: 'stop' })
    expect(onLimits).not.toHaveBeenCalled()
  })

  it('reports retry-after seconds on a rate-limited turn', async () => {
    const server = await mockServer([{
      status: 429,
      body: '{"type":"error","error":{"type":"rate_limit_error","message":"slow down"}}',
      headers: { 'retry-after': '7' },
    }])

    const finish = await finishOf(adapterOf(server.url))

    expect(finish).toMatchObject({
      kind: 'error',
      failure: { code: 'RATE_LIMIT', status: 429, providerRetryAfterMs: 7000 },
    })
  })

  it('reports the exhausted window reset as the retry delay and publishes that window from the 429', async () => {
    const nowSeconds = Math.floor(Date.now() / 1000)
    const onLimits = vi.fn()
    const server = await mockServer([{
      status: 429,
      body: '{"type":"error","error":{"type":"rate_limit_error","message":"limit reached"}}',
      headers: {
        'anthropic-ratelimit-unified-status': 'rejected',
        'anthropic-ratelimit-unified-reset': String(nowSeconds + 3600),
        'anthropic-ratelimit-unified-5h-utilization': '1',
        'anthropic-ratelimit-unified-5h-reset': String(nowSeconds + 3600),
        'anthropic-ratelimit-unified-5h-status': 'rejected',
      },
    }])

    const failure = failureOf(await finishOf(adapterOf(server.url, onLimits)))

    // The delay is measured from the response instant, so it sits just under the hour.
    expect(failure.code).toBe('RATE_LIMIT')
    expect(failure.status).toBe(429)
    expect(failure.providerRetryAfterMs).toBeGreaterThan(3_595_000)
    expect(failure.providerRetryAfterMs).toBeLessThanOrEqual(3_600_000)
    expect(onLimits).toHaveBeenCalledWith(expect.objectContaining({
      provider: PROVIDER,
      windows: [{
        id: '5h',
        label: '5 h',
        usedPercent: 100,
        resetsAt: (nowSeconds + 3600) * 1000,
        status: 'exhausted',
      }],
    }))
  })

  it('reports the status alone for a rate-limited turn without retry headers', async () => {
    const server = await mockServer([{
      status: 429,
      body: '{"type":"error","error":{"type":"rate_limit_error","message":"slow down"}}',
    }])

    const failure = failureOf(await finishOf(adapterOf(server.url)))

    expect(failure).toMatchObject({ code: 'RATE_LIMIT', status: 429 })
    expect(failure).not.toHaveProperty('providerRetryAfterMs')
  })

  it('leaves a 400 failure without status or retry facts', async () => {
    const server = await mockServer([{
      status: 400,
      body: '{"type":"error","error":{"type":"invalid_request_error","message":"messages: invalid"}}',
      headers: { 'retry-after': '7' },
    }])

    const failure = failureOf(await finishOf(adapterOf(server.url)))

    expect(failure.code).toBe('INVALID_REQUEST')
    expect(failure).not.toHaveProperty('status')
    expect(failure).not.toHaveProperty('providerRetryAfterMs')
  })

  it('completes the request when the usage-window listener throws', async () => {
    const nowSeconds = Math.floor(Date.now() / 1000)
    const server = await mockServer([{ events: anthropicTextEvents, headers: fiveHourHeaders(nowSeconds, 3600) }])
    const listener = vi.fn(() => {
      throw new Error('listener broke')
    })

    const finish = await finishOf(adapterOf(server.url, listener))

    expect(listener).toHaveBeenCalledOnce()
    expect(finish).toEqual({ kind: 'stop' })
  })
})
