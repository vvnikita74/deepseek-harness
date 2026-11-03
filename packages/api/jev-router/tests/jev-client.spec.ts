/** Jev wire client: request shape, response parsing, and failure propagation with a stubbed fetch. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { askComplexity, type ComplexityQuery } from '../src/jev-client.ts'

afterEach(() => { vi.unstubAllGlobals() })

const query: ComplexityQuery = {
  endpoint: 'https://jev.test/decisions',
  model: 'typesafe/jev-1.14',
  apiKey: 'key-1',
  text: 'refactor the parser',
  levels: ['Tier 0', 'Tier 1', 'Tier 2'],
  timeoutMs: 3000,
}

function answer(complexity: unknown): Response {
  return Response.json({ model: 'typesafe/jev-1.14', answers: { complexity }, usage: { input_tokens: 1, output_tokens: 1 } })
}

describe('askComplexity', () => {
  it('posts one score question and reads the level probabilities', async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => answer({ type: 'score', score: 1.4, confidence: 0.8, legend: {}, probabilities: { '0': 0.1, '1': 0.2, '2': 0.7 } }))
    vi.stubGlobal('fetch', fetchMock)
    const result = await askComplexity(query, new AbortController().signal)
    expect(result).toEqual({ probabilities: [0.1, 0.2, 0.7], confidence: 0.8 })
    const [endpoint, init] = fetchMock.mock.calls[0] ?? []
    expect(endpoint).toBe('https://jev.test/decisions')
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer key-1')
    expect(JSON.parse(init?.body as string)).toMatchObject({
      model: 'typesafe/jev-1.14',
      state: 'refactor the parser',
      questions: { complexity: { type: 'score', criteria: ['Tier 0', 'Tier 1', 'Tier 2'] } },
    })
  })

  it('rejects non-2xx, malformed, and incomplete answers', async () => {
    const signal = new AbortController().signal
    vi.stubGlobal('fetch', async () => new Response('down', { status: 529 }))
    await expect(askComplexity(query, signal)).rejects.toThrow('HTTP 529')
    vi.stubGlobal('fetch', async () => Response.json({ answers: { complexity: { type: 'choice' } } }))
    await expect(askComplexity(query, signal)).rejects.toThrow()
    vi.stubGlobal('fetch', async () => answer({ type: 'score', confidence: 0.9, probabilities: { '0': 1 } }))
    await expect(askComplexity(query, signal)).rejects.toThrow('level 1')
  })
})
