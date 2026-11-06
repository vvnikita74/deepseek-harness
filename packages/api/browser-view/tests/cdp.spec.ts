import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import BrowserView, { type Config } from '../src/index.ts'
import { POINTER_SCRIPT } from '../src/pointer-script.ts'
import { fakeSubprocess, startFakeBrowser, type FakeBrowser } from './fake-browser.ts'

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

/**
 * Boot the controller against a fake browser that reports the given page targets.
 * @param targets - page targets reported at discovery.
 * @returns the controller, the fake browser, and the fake process service.
 */
async function boot(targets: Array<{ targetId: string; url: string; title: string }>) {
  const subprocess = fakeSubprocess()
  const browser: FakeBrowser = await startFakeBrowser(targets, () => { subprocess.exitAll() })
  const dir = await mkdtemp(join(tmpdir(), 'dsh-browser-view-cdp-'))
  cleanups.push(async () => { await browser.close(); await rm(dir, { recursive: true, force: true }) })
  const ctx = new Context()
  ctx.provide('subprocess', subprocess as never)
  const config: Config = {
    executablePath: '/fake/chrome', userDataDir: dir, port: browser.port, headless: true, noSandbox: true,
    viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1, userControlIdleMs: 10000,
    agentToolPrefixes: ['mcp__playwright-mcp__'], screencast: { quality: 60, maxFps: 8, maxWidth: 1280 },
  }
  const view = new BrowserView(ctx, config)
  cleanups.push(async () => { await ctx.fiber.dispose() })
  await vi.waitFor(async () => { expect((await view.state(new AbortController().signal)).status).toBe('ready') })
  return { view, browser, subprocess, signal: new AbortController().signal }
}

/** Frame and event shapes the watch delivers. */
const metadata = { deviceWidth: 1280, deviceHeight: 800, pageScaleFactor: 1, scrollOffsetX: 0, scrollOffsetY: 0 }

/**
 * Pull watch items until one matches.
 * @param stream - the watch iterable.
 * @param matches - item predicate.
 * @returns the first matching item.
 */
async function until<T extends { type: string }>(
  stream: AsyncIterator<{ type: string }>,
  matches: (item: { type: string }) => item is T,
): Promise<T> {
  for (;;) {
    const next = await stream.next()
    if (next.done === true) throw new Error('watch ended before the expected item')
    if (matches(next.value)) return next.value
  }
}

it('attaches every page target and installs the page observer before reporting ready', async () => {
  const { view, browser, signal } = await boot([{ targetId: 'p1', url: 'about:blank', title: '' }])
  await browser.waitFor('Emulation.setDeviceMetricsOverride', command => command.sessionId === 's-p1')
  expect(browser.commands.find(command => command.method === 'Target.attachToTarget')?.params).toEqual({ targetId: 'p1', flatten: true })
  expect(browser.commands.find(command => command.method === 'Target.setDiscoverTargets')?.params).toEqual({ discover: true })
  expect(browser.commands.filter(command => command.sessionId === 's-p1').map(command => command.method)).toEqual([
    'Page.enable', 'Runtime.enable', 'Runtime.addBinding', 'Page.addScriptToEvaluateOnNewDocument', 'Runtime.evaluate',
    'Emulation.setDeviceMetricsOverride',
  ])
  expect(browser.commands.find(command => command.method === 'Emulation.setDeviceMetricsOverride')?.params).toEqual({
    width: 1280, height: 800, deviceScaleFactor: 0, mobile: false,
  })
  expect(browser.commands.find(command => command.method === 'Runtime.addBinding')?.params).toEqual({ name: '__dshView' })
  expect(browser.commands.find(command => command.method === 'Runtime.evaluate')?.params).toEqual({ expression: POINTER_SCRIPT })
  expect(await view.state(signal)).toEqual({
    status: 'ready',
    tabs: [{ targetId: 'p1', url: 'about:blank', title: '', active: true }],
    activeTargetId: 'p1',
    viewport: { width: 1280, height: 800 },
    userControl: false,
  })
})

it('turns a page binding call into a pointer event for the followed tab', async () => {
  const { view, browser, signal } = await boot([{ targetId: 'p1', url: 'about:blank', title: '' }])
  await browser.waitFor('Runtime.addBinding', command => command.sessionId === 's-p1')
  const watch = view.watch({}, signal)[Symbol.asyncIterator]()
  const payload = JSON.stringify({ type: 'pointer', kind: 'click', x: 12, y: 34, button: 0, target: { tag: 'button', text: 'Go', rect: { x: 1, y: 2, width: 3, height: 4 } } })
  browser.emit('Runtime.bindingCalled', { name: '__dshView', payload, executionContextId: 1 }, 's-p1')
  const pointer = await until(watch, (item): item is { type: 'pointer'; targetId: string; kind: string; x: number; y: number } => item.type === 'pointer')
  expect(pointer).toMatchObject({ type: 'pointer', targetId: 'p1', kind: 'click', x: 12, y: 34, button: 0, target: { tag: 'button', text: 'Go' } })
  await watch.return?.(undefined)
})

it('acknowledges each screencast frame and delivers it as a frame event', async () => {
  const { view, browser, signal } = await boot([{ targetId: 'p1', url: 'about:blank', title: '' }])
  const watch = view.watch({}, signal)[Symbol.asyncIterator]()
  expect((await watch.next()).value).toMatchObject({ type: 'state' })
  const start = await browser.waitFor('Page.startScreencast', command => command.sessionId === 's-p1')
  expect(start.params).toEqual({ format: 'jpeg', quality: 60, maxWidth: 1280, maxHeight: 800, everyNthFrame: 1 })
  browser.emit('Page.screencastFrame', { data: 'frame-bytes', metadata, sessionId: 7 }, 's-p1')
  const ack = await browser.waitFor('Page.screencastFrameAck', command => command.sessionId === 's-p1')
  expect(ack.params).toEqual({ sessionId: 7 })
  const frame = await until(watch, (item): item is { type: 'frame'; targetId: string; jpegBase64: string } => item.type === 'frame' && (item as { jpegBase64?: string }).jpegBase64 === 'frame-bytes')
  expect(frame).toMatchObject({ type: 'frame', targetId: 'p1', jpegBase64: 'frame-bytes', metadata })
  await watch.return?.(undefined)
})

it('moves the screencast to the tab with the most recent activity', async () => {
  const { view, browser, signal } = await boot([{ targetId: 'p1', url: 'about:blank', title: '' }])
  const watch = view.watch({}, signal)[Symbol.asyncIterator]()
  expect((await watch.next()).value).toMatchObject({ type: 'state' })
  await browser.waitFor('Page.startScreencast', command => command.sessionId === 's-p1')
  browser.emit('Target.targetCreated', { targetInfo: { targetId: 'p2', type: 'page', url: 'about:blank', title: '' } })
  await browser.waitFor('Page.startScreencast', command => command.sessionId === 's-p2')
  expect(await view.state(signal)).toMatchObject({ activeTargetId: 'p2' })
  browser.emit('Runtime.bindingCalled', { name: '__dshView', payload: JSON.stringify({ type: 'key', key: 'a', code: 'KeyA', modifiers: 0 }), executionContextId: 1 }, 's-p1')
  await browser.waitFor('Page.stopScreencast', command => command.sessionId === 's-p2')
  await browser.waitFor('Page.startScreencast', command => command.sessionId === 's-p1' && browser.commands.length > 0)
  expect(await view.state(signal)).toMatchObject({ activeTargetId: 'p1' })
  await watch.return?.(undefined)
})
