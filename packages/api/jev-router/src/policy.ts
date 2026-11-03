/** Pure tier policy over Jev's complexity score. */

/** Jev's probability distribution over complexity levels, index = tier. */
export interface ComplexityAnswer {
  readonly probabilities: readonly number[]
  readonly confidence: number
}

/**
 * Pick the tier with the highest probability; a low-confidence answer steps one tier up, capped at the hardest tier.
 * @param answer - Jev's distribution over one level per tier, easiest first.
 * @param minConfidence - confidence below which the answer is escalated.
 * @returns the zero-based tier index.
 */
export function selectTier(answer: ComplexityAnswer, minConfidence: number): number {
  const top = answer.probabilities.indexOf(Math.max(...answer.probabilities))
  return answer.confidence < minConfidence ? Math.min(top + 1, answer.probabilities.length - 1) : top
}

/**
 * Keep the last `maxChars` code points, so the most recent part of a long prompt reaches Jev.
 * @param text - prompt text.
 * @param maxChars - maximum code points to keep.
 * @returns the unchanged text, or its tail.
 */
export function truncateTail(text: string, maxChars: number): string {
  const chars = Array.from(text)
  return chars.length > maxChars ? chars.slice(chars.length - maxChars).join('') : text
}
