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
import type { BrowserViewEvent } from '../src/types.ts'
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
    viewport: { width: 1280, height: 800 }, screencast: { quality: 60, maxFps: 8, maxWidth: 1280 },
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
 * Serve one static page for the persistence check.
 * @returns the server, its origin, and the page URL.
 */
async function startPageServer(): Promise<{ server: Server; url: string }> {
  const server = createServer((_request, response) => {
    response.setHeader('content-type', 'text/html')
    response.end('<!doctype html><title>kept</title><body>kept</body>')
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('no loopback port')
  return { server, url: `http://127.0.0.1:${address.port}/` }
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

  it('keeps cookies and localStorage in the profile across a relaunch', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-browser-view-profile-'))
    cleanups.push(async () => { await rm(dir, { recursive: true, force: true }) })
    const port = await freePort()
    const { server, url } = await startPageServer()
    cleanups.push(async () => { await new Promise<void>((resolve) => { server.close(() => { resolve() }) }) })

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
