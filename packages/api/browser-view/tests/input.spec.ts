/** User input: request validation, its mapping to CDP commands, the control lease, and the agent tool pause. */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import BrowserView, { type Config } from '../src/index.ts'
import { inputCommand, parseInputRequest } from '../src/input.ts'
import type { BrowserInputEvent, BrowserInputRequest, BrowserViewEvent } from '../src/types.ts'
import { fakeSubprocess, startFakeBrowser, type FakeBrowser } from './fake-browser.ts'

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

/**
 * Boot the controller against a fake browser that reports the given page targets and wait until every tab is attached.
 * @param targets - page targets reported at discovery.
 * @param overrides - config fields that differ from the defaults below.
 * @returns the context, the controller, the fake browser, the fake process service, and a signal that never aborts.
 */
async function boot(targets: Array<{ targetId: string; url: string; title: string }>, overrides: Partial<Config> = {}) {
  const subprocess = fakeSubprocess()
  const browser: FakeBrowser = await startFakeBrowser(targets, () => { subprocess.exitAll() })
  const dir = await mkdtemp(join(tmpdir(), 'dsh-browser-view-input-'))
  cleanups.push(async () => { await browser.close(); await rm(dir, { recursive: true, force: true }) })
  const ctx = new Context()
  ctx.provide('subprocess', subprocess as never)
  const config: Config = {
    executablePath: '/fake/chrome', userDataDir: dir, port: browser.port, headless: true, noSandbox: true,
    viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1, userControlIdleMs: 10000,
    agentToolPrefixes: ['mcp__playwright-mcp__'], screencast: { quality: 60, maxFps: 8, maxWidth: 1280 }, ...overrides,
  }
  const view = new BrowserView(ctx, config)
  cleanups.push(async () => { await ctx.fiber.dispose() })
  await vi.waitFor(async () => { expect((await view.state(new AbortController().signal)).status).toBe('ready') })
  for (const target of targets) {
    await browser.waitFor('Emulation.setDeviceMetricsOverride', command => command.sessionId === `s-${target.targetId}`)
  }
  return { ctx, view, browser, subprocess, signal: new AbortController().signal }
}

const TAB = { targetId: 'p1', url: 'about:blank', title: '' }
const HOLD: BrowserInputRequest = { targetId: 'p1', event: { type: 'text', text: 'x' } }
const CLICK = 'mcp__playwright-mcp__browser_click'

/**
 * Pull watch items until one matches.
 * @param stream - watch iterator.
 * @param matches - predicate.
 * @returns the matching item.
 */
async function until(stream: AsyncIterator<BrowserViewEvent>, matches: (item: BrowserViewEvent) => boolean): Promise<BrowserViewEvent> {
  for (;;) {
    const next = await stream.next()
    if (next.done === true) throw new Error('watch ended before the expected item')
    if (matches(next.value)) return next.value
  }
}

/**
 * @param promise - call under test.
 * @returns the settled value, or `'pending'` when the call has not settled within 50 ms.
 */
async function pendingOr<T>(promise: Promise<T>): Promise<T | 'pending'> {
  return await Promise.race([promise, delay(50, 'pending' as const)])
}

/**
 * @param event - event to send to tab `p1`.
 * @returns the request carrying that event.
 */
function request(event: object): BrowserInputRequest {
  return { targetId: 'p1', event } as BrowserInputRequest
}

/**
 * @param raw - request to check.
 * @returns the RemoteError the check threw, or undefined when the request passed.
 */
function rejectionOf(raw: BrowserInputRequest): RemoteError | undefined {
  try {
    parseInputRequest(raw)
    return undefined
  } catch (error) {
    return error instanceof RemoteError ? error : undefined
  }
}

/**
 * @param key - DOM key value of a letter or word.
 * @param modifiers - modifier bit mask.
 * @returns the CDP parameters of a key down without text.
 */
function shortcut(key: string, modifiers: number): Record<string, unknown> {
  const upper = key.toUpperCase()
  return inputCommand({ type: 'key', action: 'down', key, code: `Key${upper}`, keyCode: upper.charCodeAt(0), modifiers }).params
}

describe('parseInputRequest', () => {
  it('accepts an event of every type within its bounds', () => {
    const valid: BrowserInputEvent[] = [
      { type: 'mouse', action: 'down', x: 10, y: 20, button: 'left', buttons: 1, clickCount: 1, modifiers: 15 },
      { type: 'mouse', action: 'move', x: 0, y: 100000 },
      { type: 'wheel', x: 1, y: 2, deltaX: -100000, deltaY: 120 },
      { type: 'key', action: 'down', key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' },
      { type: 'key', action: 'up', key: 'k'.repeat(32), code: '', keyCode: 255 },
      { type: 'text', text: 'x'.repeat(20000) },
      { type: 'navigate', url: 'https://example.com/' },
      { type: 'navigate', url: 'http://127.0.0.1:8080/page' },
    ]
    for (const event of valid) expect(parseInputRequest(request(event))).toEqual(request(event))
  })

  it.each<[string, object]>([
    ['a negative x', { type: 'mouse', action: 'move', x: -1, y: 0 }],
    ['a y past the coordinate bound', { type: 'mouse', action: 'down', x: 0, y: 100001 }],
    ['modifiers above 15', { type: 'mouse', action: 'up', x: 0, y: 0, modifiers: 16 }],
    ['a wheel delta past 100000', { type: 'wheel', x: 0, y: 0, deltaX: 0, deltaY: 100001 }],
    ['a keyCode above 255', { type: 'key', action: 'down', key: 'a', code: 'KeyA', keyCode: 256 }],
    ['an empty key name', { type: 'key', action: 'down', key: '', code: '', keyCode: 0 }],
    ['a key name longer than 32 characters', { type: 'key', action: 'down', key: 'k'.repeat(33), code: 'KeyK', keyCode: 75 }],
    ['an action outside down and up', { type: 'key', action: 'press', key: 'a', code: 'KeyA', keyCode: 65 }],
    ['text longer than 8 characters on a key', { type: 'key', action: 'down', key: 'a', code: 'KeyA', keyCode: 65, text: 'x'.repeat(9) }],
    ['empty text', { type: 'text', text: '' }],
    ['text longer than 20000 characters', { type: 'text', text: 'x'.repeat(20001) }],
    ['a file: URL', { type: 'navigate', url: 'file:///etc/passwd' }],
    ['a javascript: URL', { type: 'navigate', url: 'javascript:alert(1)' }],
    ['a data: URL', { type: 'navigate', url: 'data:text/html,hi' }],
    ['an unparsable URL', { type: 'navigate', url: 'not a url' }],
    ['an unknown event type', { type: 'drag', x: 0, y: 0 }],
    ['an extra field', { type: 'text', text: 'x', extra: 1 }],
  ])('rejects %s with gateway/bad-request', (_name, event) => {
    expect(rejectionOf(request(event))?.code).toBe('gateway/bad-request')
  })

  it('rejects a request without a target id', () => {
    expect(rejectionOf({ event: { type: 'text', text: 'x' } } as BrowserInputRequest)?.code).toBe('gateway/bad-request')
  })
})

describe('inputCommand', () => {
  it('maps a mouse move to mouseMoved without a button', () => {
    expect(inputCommand({ type: 'mouse', action: 'move', x: 5, y: 6 })).toEqual({
      method: 'Input.dispatchMouseEvent',
      params: { type: 'mouseMoved', x: 5, y: 6, button: 'none', buttons: 0, clickCount: 0, modifiers: 0 },
    })
  })

  it('defaults a press to the left button and a release to no pressed buttons', () => {
    expect(inputCommand({ type: 'mouse', action: 'down', x: 1, y: 2 })).toEqual({
      method: 'Input.dispatchMouseEvent',
      params: { type: 'mousePressed', x: 1, y: 2, button: 'left', buttons: 1, clickCount: 1, modifiers: 0 },
    })
    expect(inputCommand({ type: 'mouse', action: 'up', x: 1, y: 2 })).toEqual({
      method: 'Input.dispatchMouseEvent',
      params: { type: 'mouseReleased', x: 1, y: 2, button: 'left', buttons: 0, clickCount: 1, modifiers: 0 },
    })
  })

  it('takes an explicit button, buttons, click count, and modifiers', () => {
    expect(inputCommand({ type: 'mouse', action: 'down', x: 1, y: 2, button: 'right', buttons: 6, clickCount: 2, modifiers: 2 })).toEqual({
      method: 'Input.dispatchMouseEvent',
      params: { type: 'mousePressed', x: 1, y: 2, button: 'right', buttons: 6, clickCount: 2, modifiers: 2 },
    })
  })

  it('maps a wheel to mouseWheel with its deltas', () => {
    expect(inputCommand({ type: 'wheel', x: 3, y: 4, deltaX: 0, deltaY: -120, modifiers: 8 })).toEqual({
      method: 'Input.dispatchMouseEvent',
      params: { type: 'mouseWheel', x: 3, y: 4, deltaX: 0, deltaY: -120, modifiers: 8 },
    })
  })

  it('sends a printable key down as keyDown with its text', () => {
    expect(inputCommand({ type: 'key', action: 'down', key: 'a', code: 'KeyA', keyCode: 65, text: 'a' })).toEqual({
      method: 'Input.dispatchKeyEvent',
      params: {
        type: 'keyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65, modifiers: 0,
        text: 'a', unmodifiedText: 'a',
      },
    })
  })

  it('sends a key down without text, such as Backspace, as rawKeyDown', () => {
    expect(inputCommand({ type: 'key', action: 'down', key: 'Backspace', code: 'Backspace', keyCode: 8 })).toEqual({
      method: 'Input.dispatchKeyEvent',
      params: { type: 'rawKeyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8, modifiers: 0 },
    })
  })

  it('sends a key up as keyUp', () => {
    expect(inputCommand({ type: 'key', action: 'up', key: 'a', code: 'KeyA', keyCode: 65 })).toEqual({
      method: 'Input.dispatchKeyEvent',
      params: { type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65, modifiers: 0 },
    })
  })

  it('sends Enter with its carriage return as keyDown', () => {
    expect(inputCommand({ type: 'key', action: 'down', key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' }).params).toEqual({
      type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, modifiers: 0,
      text: '\r', unmodifiedText: '\r',
    })
  })

  it('maps Ctrl+A, Meta+Z, Ctrl+Shift+Z, and Ctrl+Y to editing commands', () => {
    expect(shortcut('a', 2).commands).toEqual(['selectAll'])
    expect(shortcut('z', 4).commands).toEqual(['undo'])
    expect(shortcut('Z', 10).commands).toEqual(['redo'])
    expect(shortcut('y', 2).commands).toEqual(['redo'])
  })

  it('leaves out editing commands for Ctrl+Alt+A and for clipboard shortcuts', () => {
    expect(shortcut('a', 3)).not.toHaveProperty('commands')
    expect(shortcut('v', 2)).not.toHaveProperty('commands')
    expect(shortcut('c', 2)).not.toHaveProperty('commands')
    expect(shortcut('x', 2)).not.toHaveProperty('commands')
  })

  it('sends text as Input.insertText and navigate as Page.navigate', () => {
    expect(inputCommand({ type: 'text', text: 'héllo' })).toEqual({ method: 'Input.insertText', params: { text: 'héllo' } })
    expect(inputCommand({ type: 'navigate', url: 'https://example.com/' })).toEqual({
      method: 'Page.navigate', params: { url: 'https://example.com/' },
    })
  })
})

describe('browser input over the controller', () => {
  it('sends the mapped command on the session of the addressed tab', async () => {
    const { view, browser, signal } = await boot([TAB])
    await view.input({ targetId: 'p1', event: { type: 'mouse', action: 'down', x: 10, y: 20 } }, signal)
    expect(browser.commands.filter(command => command.method === 'Input.dispatchMouseEvent')).toEqual([{
      method: 'Input.dispatchMouseEvent',
      params: { type: 'mousePressed', x: 10, y: 20, button: 'left', buttons: 1, clickCount: 1, modifiers: 0 },
      sessionId: 's-p1',
    }])
  })

  it('delivers three events to Chromium in the order they arrived', async () => {
    const { view, browser, signal } = await boot([TAB])
    await Promise.all([
      view.input({ targetId: 'p1', event: { type: 'mouse', action: 'move', x: 1, y: 1 } }, signal),
      view.input({ targetId: 'p1', event: { type: 'mouse', action: 'down', x: 1, y: 1 } }, signal),
      view.input({ targetId: 'p1', event: { type: 'mouse', action: 'up', x: 1, y: 1 } }, signal),
    ])
    expect(browser.commands.filter(command => command.method === 'Input.dispatchMouseEvent').map(command => command.params.type))
      .toEqual(['mouseMoved', 'mousePressed', 'mouseReleased'])
  })

  it('rejects an event addressed to a tab that is not open', async () => {
    const { view, signal } = await boot([TAB])
    await expect(view.input({ targetId: 'nope', event: { type: 'text', text: 'x' } }, signal))
      .rejects.toMatchObject({ code: 'browser-view/tab-not-found' })
  })

  it('rejects an invalid event before any command reaches Chromium', async () => {
    const { view, browser, signal } = await boot([TAB])
    const before = browser.commands.length
    await expect(view.input({ targetId: 'p1', event: { type: 'mouse', action: 'down', x: -1, y: 0 } } as never, signal))
      .rejects.toMatchObject({ code: 'gateway/bad-request' })
    expect(browser.commands.slice(before).filter(command => command.method.startsWith('Input.'))).toEqual([])
  })

  it('holds user control after an input and gives it back on release', async () => {
    const { view, signal } = await boot([TAB])
    expect((await view.state(signal)).userControl).toBe(false)
    await view.input(HOLD, signal)
    expect((await view.state(signal)).userControl).toBe(true)
    await view.release(signal)
    expect((await view.state(signal)).userControl).toBe(false)
  })

  it('gives control back after the idle window passes without input', async () => {
    const { view, signal } = await boot([TAB], { userControlIdleMs: 50 })
    await view.input(HOLD, signal)
    expect((await view.state(signal)).userControl).toBe(true)
    await vi.waitFor(async () => { expect((await view.state(signal)).userControl).toBe(false) })
  })

  it('publishes the control change to a watch: held, then released', async () => {
    const { view, signal } = await boot([TAB])
    const watch = view.watch({}, signal)[Symbol.asyncIterator]()
    expect((await watch.next()).value).toMatchObject({ type: 'state', state: { userControl: false } })
    const held = until(watch, item => item.type === 'state' && item.state.userControl)
    await view.input(HOLD, signal)
    expect(await held).toMatchObject({ type: 'state', state: { userControl: true } })
    const released = until(watch, item => item.type === 'state' && !item.state.userControl)
    await view.release(signal)
    expect(await released).toMatchObject({ type: 'state', state: { userControl: false } })
    await watch.return?.(undefined)
  })

  it('rejects input once the browser connection is gone', async () => {
    const { view, browser, signal } = await boot([TAB])
    await browser.close()
    // The socket close reaches the client asynchronously; until then a send would wait for a reply that never comes.
    await delay(50)
    await expect(view.input(HOLD, signal)).rejects.toThrow()
  })
})

describe('agent tool pause', () => {
  it('holds a matching tool call while control is held, and lets it through on release', async () => {
    const { ctx, view, signal } = await boot([TAB])
    await view.input(HOLD, signal)
    const call = ctx.waterfall('tools/pre-execute', { name: CLICK, signal } as never, () => Promise.resolve({ kind: 'allow' }))
    expect(await pendingOr(call)).toBe('pending')
    await view.release(signal)
    expect(await call).toEqual({ kind: 'allow' })
  })

  it('lets a tool outside the configured prefixes through while control is held', async () => {
    const { ctx, view, signal } = await boot([TAB])
    await view.input(HOLD, signal)
    expect(await ctx.waterfall('tools/pre-execute', { name: 'bash', signal } as never, () => Promise.resolve({ kind: 'allow' })))
      .toEqual({ kind: 'allow' })
  })

  it('cancels a held call when its signal aborts', async () => {
    const { ctx, view, signal } = await boot([TAB])
    await view.input(HOLD, signal)
    const abort = new AbortController()
    const call = ctx.waterfall(
      'tools/pre-execute', { name: CLICK, signal: abort.signal } as never, () => Promise.resolve({ kind: 'allow' }),
    )
    expect(await pendingOr(call)).toBe('pending')
    abort.abort()
    expect(await call).toEqual({ kind: 'cancel' })
  })

  it('lets a held call through once the idle window passes', async () => {
    const { ctx, view, signal } = await boot([TAB], { userControlIdleMs: 50 })
    await view.input(HOLD, signal)
    expect(await ctx.waterfall('tools/pre-execute', { name: CLICK, signal } as never, () => Promise.resolve({ kind: 'allow' })))
      .toEqual({ kind: 'allow' })
  })
})

describe('chromium launch', () => {
  it('passes the configured device scale factor to Chromium', async () => {
    const { subprocess } = await boot([TAB], { deviceScaleFactor: 2 })
    expect(subprocess.specs[0]?.argv).toContain('--force-device-scale-factor=2')
  })
})
