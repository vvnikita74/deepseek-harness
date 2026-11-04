/** Jev wire client: one score question per prompt over the TypeSafe System One schema (Timeweb AI Gateway, TypeSafe). */
import { z } from 'zod'
import type { ComplexityAnswer } from './policy.ts'

/** One score question's wire fields; `levels` holds one criterion per tier, easiest first. */
export interface ComplexityQuery {
  readonly endpoint: string
  readonly model: string
  readonly apiKey: string
  readonly text: string
  readonly levels: readonly string[]
  readonly timeoutMs: number
}

const answerSchema = z.object({
  answers: z.object({
    complexity: z.object({
      type: z.literal('score'),
      confidence: z.number(),
      probabilities: z.record(z.string(), z.number()),
    }),
  }),
})

/**
 * Ask Jev which tier the prompt needs. Any transport, status, or shape failure throws; the caller owns the fallback.
 * @param query - endpoint, credential, model, prompt text, and levels.
 * @param signal - caller cancellation, combined with the query timeout.
 * @returns Jev's distribution over the levels.
 */
export async function askComplexity(query: ComplexityQuery, signal: AbortSignal): Promise<ComplexityAnswer> {
  const response = await globalThis.fetch(query.endpoint, {
    method: 'POST',
    headers: { authorization: `Bearer ${query.apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      model: query.model,
      state: query.text,
      questions: {
        complexity: {
          type: 'score',
          instructions: 'How much work does this request need from a coding agent? The lowest level is the simplest; the highest is the hardest.',
          criteria: query.levels,
        },
      },
    }),
    signal: AbortSignal.any([signal, AbortSignal.timeout(query.timeoutMs)]),
  })
  if (!response.ok) throw new Error(`Jev responded with HTTP ${response.status}`)
  const { complexity } = answerSchema.parse(await response.json()).answers
  const probabilities = query.levels.map((_, index) => {
    const probability = complexity.probabilities[String(index)]
    if (probability === undefined) throw new Error(`Jev omitted the probability of level ${index}`)
    return probability
  })
  return { probabilities, confidence: complexity.confidence }
}
