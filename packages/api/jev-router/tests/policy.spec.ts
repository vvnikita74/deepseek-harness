/** Tier choice and prompt truncation over Jev's distribution. */
import { describe, expect, it } from 'vitest'
import { selectTier, truncateTail } from '../src/policy.ts'

describe('selectTier', () => {
  it('picks the most probable level when confident', () => {
    expect(selectTier({ probabilities: [0.1, 0.7, 0.2], confidence: 0.9 }, 0.6)).toBe(1)
  })

  it('steps one tier higher below the confidence floor, capped at the hardest tier', () => {
    expect(selectTier({ probabilities: [0.1, 0.7, 0.2], confidence: 0.59 }, 0.6)).toBe(2)
    expect(selectTier({ probabilities: [0.1, 0.2, 0.7], confidence: 0.1 }, 0.6)).toBe(2)
  })
})

describe('truncateTail', () => {
  it('keeps the tail of a long prompt and leaves a short one whole', () => {
    expect(truncateTail('abcdef', 4)).toBe('cdef')
    expect(truncateTail('abc', 4)).toBe('abc')
  })

  it('counts code points so a surrogate pair is never split', () => {
    expect(truncateTail('a😀b', 2)).toBe('😀b')
  })
})
