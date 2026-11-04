/** Binding payloads come from page content, which any site can forge; only bounded, well-formed reports pass. */
import { expect, it } from 'vitest'
import { parsePagePayload } from '../src/pointer-script.ts'

const rect = { x: 1, y: 2, width: 3, height: 4 }

it('accepts the reports the injected script emits', () => {
  expect(parsePagePayload(JSON.stringify({ type: 'pointer', kind: 'click', x: 10, y: 20, button: 0, target: { tag: 'button', text: 'go', rect } })))
    .toEqual({ type: 'pointer', kind: 'click', x: 10, y: 20, button: 0, target: { tag: 'button', text: 'go', rect } })
  expect(parsePagePayload(JSON.stringify({ type: 'key', key: 'Enter', code: 'Enter', modifiers: 8 }))).toMatchObject({ type: 'key', key: 'Enter' })
  expect(parsePagePayload(JSON.stringify({ type: 'input', value: 'hello' }))).toEqual({ type: 'input', value: 'hello' })
})

it('drops malformed, unknown, out-of-bounds and oversized payloads', () => {
  for (const raw of [
    'not json',
    JSON.stringify({ type: 'frame', jpegBase64: 'x' }),
    JSON.stringify({ type: 'pointer', kind: 'teleport', x: 1, y: 1 }),
    JSON.stringify({ type: 'pointer', kind: 'move', x: '1', y: 1 }),
    JSON.stringify({ type: 'key', key: 'k'.repeat(33), code: 'KeyK', modifiers: 0 }),
    JSON.stringify({ type: 'key', key: 'k', code: 'KeyK', modifiers: 16 }),
    JSON.stringify({ type: 'input', value: 'v'.repeat(201) }),
    JSON.stringify({ type: 'input', target: { tag: 'div', text: 't'.repeat(81), rect } }),
    JSON.stringify({ type: 'input', pad: 'p'.repeat(5000) }),
  ]) expect(parsePagePayload(raw), raw.slice(0, 40)).toBeUndefined()
})
