/**
 * Validation of user input requests and their mapping to one CDP command per event. Pure: no I/O.
 * @module @deepseek-ai/dsh-api-browser-view/input
 */

import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { z } from 'zod'
import type { BrowserInputEvent, BrowserInputRequest } from './types.ts'

const MODIFIERS = z.number().int().min(0).max(15)
const COORDINATE = z.number().min(0).max(100000)
const DELTA = z.number().min(-100000).max(100000)

/**
 * @param url - candidate URL from the wire.
 * @returns whether the URL parses and uses the `http:` or `https:` scheme.
 */
function isWebUrl(url: string): boolean {
  try {
    const { protocol } = new URL(url)
    return protocol === 'http:' || protocol === 'https:'
  } catch {
    // `new URL` throws on any string that is not an absolute URL; such a string is not a web URL.
    return false
  }
}

const mouseEvent = z.strictObject({
  type: z.literal('mouse'),
  action: z.enum(['move', 'down', 'up']),
  x: COORDINATE,
  y: COORDINATE,
  button: z.enum(['left', 'middle', 'right', 'none']).exactOptional(),
  buttons: z.number().int().min(0).max(31).exactOptional(),
  clickCount: z.number().int().min(0).max(3).exactOptional(),
  modifiers: MODIFIERS.exactOptional(),
})
const wheelEvent = z.strictObject({
  type: z.literal('wheel'),
  x: COORDINATE,
  y: COORDINATE,
  deltaX: DELTA,
  deltaY: DELTA,
  modifiers: MODIFIERS.exactOptional(),
})
const keyEvent = z.strictObject({
  type: z.literal('key'),
  action: z.enum(['down', 'up']),
  key: z.string().min(1).max(32),
  code: z.string().max(32),
  keyCode: z.number().int().min(0).max(255),
  text: z.string().max(8).exactOptional(),
  modifiers: MODIFIERS.exactOptional(),
})
const textEvent = z.strictObject({ type: z.literal('text'), text: z.string().min(1).max(20000) })
const navigateEvent = z.strictObject({
  type: z.literal('navigate'),
  url: z.string().max(8192).refine(isWebUrl, 'must be an http: or https: URL'),
})
const inputRequest = z.strictObject({
  targetId: z.string().min(1).max(128),
  event: z.discriminatedUnion('type', [mouseEvent, wheelEvent, keyEvent, textEvent, navigateEvent]),
})

/**
 * Check one input request from the wire before it reaches Chromium.
 * @param raw - request as received from the client.
 * @returns the same request, typed as {@link BrowserInputRequest}.
 * @throws `gateway/bad-request` naming the first invalid field when the request does not match the bounds.
 */
export function parseInputRequest(raw: BrowserInputRequest): BrowserInputRequest {
  const parsed = inputRequest.safeParse(raw)
  if (parsed.success) return parsed.data
  const [issue] = parsed.error.issues
  const where = issue === undefined || issue.path.length === 0 ? 'request' : issue.path.join('.')
  throw new RemoteError('gateway/bad-request', `browser input: ${where} ${issue?.message ?? 'is invalid'}`, { issues: parsed.error.issues })
}

const MOUSE_TYPES = { move: 'mouseMoved', down: 'mousePressed', up: 'mouseReleased' } as const
const BUTTON_BITS = { none: 0, left: 1, right: 2, middle: 4 } as const
/** Editing shortcuts that Chromium runs only when a key event names them; `z` with Shift is redo. */
const EDITING_COMMANDS = new Map<string, readonly string[]>([['a', ['selectAll']], ['y', ['redo']], ['z', ['undo']]])
const CTRL = 2
const META = 4
const ALT = 1
const SHIFT = 8

/**
 * Map one input event to the single CDP command that performs it.
 * @param event - validated input event.
 * @returns the CDP method and its parameters.
 */
export function inputCommand(event: BrowserInputEvent): { method: string; params: Record<string, unknown> } {
  switch (event.type) {
    case 'mouse': {
      const button = event.button ?? (event.action === 'move' ? 'none' : 'left')
      const pressed = event.action === 'down' ? BUTTON_BITS[button] : 0
      return {
        method: 'Input.dispatchMouseEvent',
        params: {
          type: MOUSE_TYPES[event.action],
          x: event.x,
          y: event.y,
          button,
          buttons: event.buttons ?? pressed,
          clickCount: event.clickCount ?? (event.action === 'move' ? 0 : 1),
          modifiers: event.modifiers ?? 0,
        },
      }
    }
    case 'wheel':
      return {
        method: 'Input.dispatchMouseEvent',
        params: {
          type: 'mouseWheel', x: event.x, y: event.y, deltaX: event.deltaX, deltaY: event.deltaY, modifiers: event.modifiers ?? 0,
        },
      }
    case 'key': {
      const modifiers = event.modifiers ?? 0
      const base = {
        key: event.key, code: event.code, windowsVirtualKeyCode: event.keyCode, nativeVirtualKeyCode: event.keyCode, modifiers,
      }
      if (event.action === 'up') return { method: 'Input.dispatchKeyEvent', params: { ...base, type: 'keyUp' } }
      const text = event.text ?? ''
      // Copy, cut, and paste are left out on purpose: the page clipboard is not the user's, and pasted text arrives as a `text` event.
      const commandKey = event.key.toLowerCase()
      const shortcut = (modifiers & (CTRL | META)) !== 0 && (modifiers & ALT) === 0
      const commands = commandKey === 'z' && (modifiers & SHIFT) !== 0 ? ['redo'] : EDITING_COMMANDS.get(commandKey)
      return {
        method: 'Input.dispatchKeyEvent',
        params: {
          ...base,
          type: text === '' ? 'rawKeyDown' : 'keyDown',
          ...text === '' ? {} : { text, unmodifiedText: text },
          ...shortcut && commands !== undefined ? { commands } : {},
        },
      }
    }
    case 'text':
      return { method: 'Input.insertText', params: { text: event.text } }
    case 'navigate':
      return { method: 'Page.navigate', params: { url: event.url } }
  }
}
