/**
 * Real Chromium: the shared browser streams a click and a frame, and its profile keeps cookies and storage across a
 * relaunch. Runs only when DSH_BROWSER_EXECUTABLE names a Chromium executable.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { LocalSubprocessRuntime } from '@deepseek-ai/dsh-subprocess-local'
import BrowserView, { type Config } from '../src/index.ts'
import { CdpClient } from '../src/cdp.ts'
import type { BrowserInputEvent, BrowserViewEvent } from '../src/types.ts'
import { freePort } from './fake-browser.ts'

const executablePath = process.env.DSH_BROWSER_EXECUTABLE
const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

/**
 * Start the shared browser on a profile directory and wait until it is ready.
 * @param userDataDir - persistent profile directory.
 * @param port - loopback debugging port.
 * @returns the controller, its context, and the browser-level CDP client.
 */
async function launch(userDataDir: string, port: number) {
  const ctx = new Context()
  new LocalSubprocessRuntime(ctx)
  const config: Config = {
    executablePath: executablePath ?? '', userDataDir, port, headless: true, noSandbox: true,
    viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1, userControlIdleMs: 10000,
    agentToolPrefixes: ['mcp__playwright-mcp__'], screencast: { quality: 60, maxFps: 8, maxWidth: 1280 },
  }
  let view!: BrowserView
  const fork = ctx.plugin({ name: 'bv-probe', apply: (child: Context) => { view = new BrowserView(child, config) } })
  await fork
  const signal = new AbortController().signal
  await vi.waitFor(async () => { expect((await view.state(signal)).status).toBe('ready') }, { timeout: 60_000, interval: 100 })
  const version = await fetch(`http://127.0.0.1:${port}/json/version`).then(async response => (await response.json()) as { webSocketDebuggerUrl: string })
  const browser = await CdpClient.connect(version.webSocketDebuggerUrl)
  return { ctx, view, browser, signal, stop: async () => { await browser.close(); await fork.dispose(); await ctx.fiber.dispose() } }
}

/**
 * Attach a page target and return its flattened session.
 * @param browser - browser-level CDP client.
 * @param targetId - page target.
 * @returns the page session id.
 */
async function attach(browser: CdpClient, targetId: string): Promise<string> {
  const { sessionId } = await browser.send<{ sessionId: string }>('Target.attachToTarget', { targetId, flatten: true })
  return sessionId
}

/**
 * Open a URL in a new page target and load it into the given session.
 * @param browser - browser-level CDP client.
 * @param url - document to open.
 * @returns the page target and its session.
 */
async function openPage(browser: CdpClient, url: string): Promise<{ targetId: string; sessionId: string }> {
  const { targetId } = await browser.send<{ targetId: string }>('Target.createTarget', { url })
  const sessionId = await attach(browser, targetId)
  await browser.send('Page.enable', {}, sessionId)
  return { targetId, sessionId }
}

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
 * Navigate a page session and wait for its load event.
 * @param browser - browser-level CDP client.
 * @param sessionId - page session.
 * @param url - document to load.
 */
async function load(browser: CdpClient, sessionId: string, url: string): Promise<void> {
  const loaded = Promise.withResolvers<undefined>()
  const off = browser.onEvent((event) => {
    if (event.method === 'Page.loadEventFired' && event.sessionId === sessionId) {
      off()
      loaded.resolve(undefined)
    }
  })
  await browser.send('Page.navigate', { url }, sessionId)
  await loaded.promise
}

/**
 * Serve one static HTML document on a loopback port until the test ends.
 * @param html - document served for every path.
 * @returns the server, its origin, and the page URL.
 */
async function startPageServer(html: string): Promise<{ server: Server; url: string }> {
  const server = createServer((_request, response) => {
    response.setHeader('content-type', 'text/html')
    response.end(html)
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  cleanups.push(async () => { await new Promise<void>((resolve) => { server.close(() => { resolve() }) }) })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('no loopback port')
  return { server, url: `http://127.0.0.1:${address.port}/` }
}

/**
 * Evaluate an expression in a page session.
 * @param browser - browser-level CDP client.
 * @param sessionId - page session.
 * @param expression - script to run.
 * @returns the value of the expression.
 */
async function evaluate(browser: CdpClient, sessionId: string, expression: string): Promise<unknown> {
  const { result } = await browser.send<{ result: { value: unknown } }>('Runtime.evaluate', { expression, returnByValue: true }, sessionId)
  return result.value
}

/**
 * Read the pixel size from the start-of-frame segment of a JPEG.
 * @param base64 - JPEG bytes in base64.
 * @returns width and height in pixels.
 */
function jpegSize(base64: string): { width: number; height: number } {
  const bytes = Buffer.from(base64, 'base64')
  let offset = 2
  while (offset + 9 < bytes.length) {
    const marker = bytes.readUInt16BE(offset)
    if (marker === 0xffc0 || marker === 0xffc2) return { height: bytes.readUInt16BE(offset + 5), width: bytes.readUInt16BE(offset + 7) }
    offset += 2 + bytes.readUInt16BE(offset + 2)
  }
  throw new Error('no JPEG start-of-frame segment')
}

/**
 * @param key - one printable character.
 * @param modifiers - modifier bit mask, 0 for none.
 * @returns the key-down and key-up events that press the character.
 */
function keyPress(key: string, modifiers = 0): BrowserInputEvent[] {
  const keyCode = key.toUpperCase().charCodeAt(0)
  const code = `Key${key.toUpperCase()}`
  return [
    { type: 'key', action: 'down', key, code, keyCode, modifiers, ...modifiers === 0 ? { text: key } : {} },
    { type: 'key', action: 'up', key, code, keyCode, modifiers },
  ]
}

describe.skipIf(executablePath === undefined)('shared browser over real Chromium', () => {
  it('streams a frame and the pointer click of a dispatched mouse event', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-browser-view-e2e-'))
    cleanups.push(async () => { await rm(dir, { recursive: true, force: true }) })
    const run = await launch(dir, await freePort())
    cleanups.push(run.stop)
    const page = await openPage(run.browser, 'data:text/html,<body style="margin:0"><button style="position:absolute;left:100px;top:100px;width:200px;height:100px">go</button></body>')
    const watch = run.view.watch({}, run.signal)[Symbol.asyncIterator]()
    const frame = await until(watch, item => item.type === 'frame' && item.targetId === page.targetId)
    expect(frame).toMatchObject({ type: 'frame', metadata: { deviceWidth: 1280 } })
    await run.browser.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 200, y: 150, button: 'left', clickCount: 1 }, page.sessionId)
    await run.browser.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 200, y: 150, button: 'left', clickCount: 1 }, page.sessionId)
    const click = await until(watch, item => item.type === 'pointer' && item.kind === 'click')
    expect(click).toMatchObject({ type: 'pointer', targetId: page.targetId, x: 200, y: 150, target: { tag: 'button', text: 'go' } })
    await watch.return?.(undefined)
  }, 120_000)

  it('shows the configured viewport, forwards clicks, typing and navigation to the tab', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-browser-view-input-'))
    cleanups.push(async () => { await rm(dir, { recursive: true, force: true }) })
    const run = await launch(dir, await freePort())
    cleanups.push(run.stop)
    const form = await startPageServer(
      '<!doctype html><title>form</title><body style="margin:0">'
      + '<button id="go" style="position:absolute;left:100px;top:100px;width:200px;height:100px" '
      + 'onclick="window.clicks=(window.clicks||0)+1">go</button>'
      + '<input id="field" style="position:absolute;left:100px;top:300px;width:300px;height:40px">'
      + '</body>',
    )
    const other = await startPageServer('<!doctype html><title>other</title><body>other</body>')
    const page = await openPage(run.browser, 'about:blank')
    await load(run.browser, page.sessionId, form.url)
    const watch = run.view.watch({}, run.signal)[Symbol.asyncIterator]()
    const frame = await until(watch, item => item.type === 'frame' && item.targetId === page.targetId)
    expect(frame).toMatchObject({ type: 'frame', metadata: { deviceWidth: 1280, deviceHeight: 800 } })
    // The override is per DevTools session, so only the controller's session shows the configured height; its JPEG carries that.
    expect(jpegSize(frame.type === 'frame' ? frame.jpegBase64 : '')).toEqual({ width: 1280, height: 800 })

    const send = (event: BrowserInputEvent): Promise<void> => run.view.input({ targetId: page.targetId, event }, run.signal)
    await send({ type: 'mouse', action: 'down', x: 200, y: 150 })
    await send({ type: 'mouse', action: 'up', x: 200, y: 150 })
    await vi.waitFor(async () => { expect(await evaluate(run.browser, page.sessionId, 'window.clicks')).toBe(1) })

    await send({ type: 'mouse', action: 'down', x: 250, y: 320 })
    await send({ type: 'mouse', action: 'up', x: 250, y: 320 })
    for (const event of [...keyPress('a'), ...keyPress('b'), ...keyPress('a', 2), ...keyPress('X')]) await send(event)
    expect(await evaluate(run.browser, page.sessionId, "document.getElementById('field').value")).toBe('X')

    await send({ type: 'navigate', url: other.url })
    await vi.waitFor(async () => {
      expect((await run.view.state(run.signal)).tabs.find(tab => tab.targetId === page.targetId)?.url).toBe(other.url)
    }, { timeout: 10_000 })
    await expect(send({ type: 'navigate', url: 'file:///etc/passwd' })).rejects.toMatchObject({ code: 'gateway/bad-request' })
    await watch.return?.(undefined)
  }, 120_000)

  it('keeps cookies and localStorage in the profile across a relaunch', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-browser-view-profile-'))
    cleanups.push(async () => { await rm(dir, { recursive: true, force: true }) })
    const port = await freePort()
    const { url } = await startPageServer('<!doctype html><title>kept</title><body>kept</body>')

    const first = await launch(dir, port)
    const page = await openPage(first.browser, 'about:blank')
    await load(first.browser, page.sessionId, url)
    await first.browser.send('Network.setCookie', { name: 'sid', value: 'kept', url, expires: Date.now() / 1000 + 3600 }, page.sessionId)
    await first.browser.send('Runtime.evaluate', { expression: "localStorage.setItem('dsh', 'kept')" }, page.sessionId)
    await first.stop()

    const second = await launch(dir, port)
    cleanups.push(second.stop)
    const again = await openPage(second.browser, 'about:blank')
    await load(second.browser, again.sessionId, url)
    const stored = await second.browser.send<{ result: { value: string } }>('Runtime.evaluate', { expression: "localStorage.getItem('dsh')" }, again.sessionId)
    expect(stored.result.value).toBe('kept')
    const cookies = await second.browser.send<{ cookies: Array<{ name: string; value: string }> }>('Network.getCookies', { urls: [url] }, again.sessionId)
    expect(cookies.cookies).toContainEqual(expect.objectContaining({ name: 'sid', value: 'kept' }))
  }, 180_000)
})
