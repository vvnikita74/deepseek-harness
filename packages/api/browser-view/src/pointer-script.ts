/**
 * Page-side observer, injected into every top-level document. It reports DOM input through the `__dshView`
 * binding, which the server adds before evaluating this script; the server maps each payload to a watch event.
 * @module @deepseek-ai/dsh-api-browser-view/pointer-script
 */

import { z } from 'zod'

/** Source evaluated in each top-level document; it is idempotent and reports only through `window.__dshView`. */
export const POINTER_SCRIPT = `(() => {
  if (window !== window.top || window.__dshViewInstalled) return
  window.__dshViewInstalled = true
  const send = (payload) => window.__dshView?.(JSON.stringify(payload))
  const describe = (el) => {
    if (!(el instanceof Element)) return undefined
    const rect = el.getBoundingClientRect()
    const text = (el.textContent || '').trim().slice(0, 80)
    return {
      tag: el.tagName.toLowerCase(),
      ...text === '' ? {} : { text },
      rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
    }
  }
  const options = { capture: true, passive: true }
  let lastMove = 0
  window.addEventListener('mousemove', (e) => {
    const now = Date.now()
    if (now - lastMove < 33) return
    lastMove = now
    send({ type: 'pointer', kind: 'move', x: e.clientX, y: e.clientY, button: e.button, target: describe(e.target) })
  }, options)
  for (const [event, kind] of [['mousedown', 'down'], ['mouseup', 'up'], ['click', 'click'], ['wheel', 'wheel']]) {
    window.addEventListener(event, (e) => {
      send({ type: 'pointer', kind, x: e.clientX, y: e.clientY, button: e.button, target: describe(e.target) })
    }, options)
  }
  window.addEventListener('keydown', (e) => {
    const modifiers = (e.altKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.metaKey ? 4 : 0) | (e.shiftKey ? 8 : 0)
    send({ type: 'key', key: e.key, code: e.code, modifiers, target: describe(e.target) })
  }, options)
  for (const event of ['input', 'change']) {
    window.addEventListener(event, (e) => {
      const el = e.target
      const value = 'value' in el && el.type !== 'password' ? String(el.value).slice(0, 200) : undefined
      send({ type: 'input', ...value === undefined ? {} : { value }, target: describe(el) })
    }, options)
  }
})()`

const MAX_PAYLOAD_CHARS = 4096
const element = z.object({
  tag: z.string().max(32),
  text: z.string().max(80).exactOptional(),
  rect: z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() }),
})
const pagePayload = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('pointer'), kind: z.enum(['move', 'down', 'up', 'click', 'wheel']),
    x: z.number(), y: z.number(), button: z.number().int().exactOptional(), target: element.exactOptional(),
  }),
  z.object({ type: z.literal('key'), key: z.string().max(32), code: z.string().max(32), modifiers: z.number().int().min(0).max(15), target: element.exactOptional() }),
  z.object({ type: z.literal('input'), value: z.string().max(200).exactOptional(), target: element.exactOptional() }),
])

/** Report a page posted through the binding; any page script can call it, so the shape is untrusted. */
export type PagePayload = z.infer<typeof pagePayload>

/**
 * Parse one binding payload from page content, which any site can forge.
 * @param raw - the string the page passed to `__dshView`.
 * @returns the validated report, or undefined when it is oversized, malformed, or outside the bounds the script emits.
 */
export function parsePagePayload(raw: string): PagePayload | undefined {
  if (raw.length > MAX_PAYLOAD_CHARS) return undefined
  try {
    const parsed = pagePayload.safeParse(JSON.parse(raw))
    return parsed.success ? parsed.data : undefined
  } catch {
    // JSON.parse rejects a malformed payload; it is dropped like any other invalid report.
    return undefined
  }
}
