/**
 * Shared browser view: one persistent Chromium on a loopback debugging port, its page tabs, and a watch stream of
 * what the active tab shows. It also forwards user input to a tab and pauses the agent's browser tools while a user
 * holds control. The plugin contributes no tools or prompt sections.
 * @module @deepseek-ai/dsh-api-browser-view
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-subprocess'
import type {} from '@deepseek-ai/dsh-tools'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { setTimeout as delay } from 'node:timers/promises'
import { CdpClient, type CdpEvent } from './cdp.ts'
import { launchChromium, type ChromiumOptions, type LaunchedChromium } from './chromium.ts'
import { WatchFanout } from './fanout.ts'
import { inputCommand, parseInputRequest } from './input.ts'
import { parsePagePayload, POINTER_SCRIPT, type PagePayload } from './pointer-script.ts'
import type {
  BrowserInputRequest, BrowserViewEvent, BrowserViewFrameMetadata, BrowserViewState, BrowserViewTab, BrowserViewWatchRequest,
} from './types.ts'

export type * from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Shared browser view Remote controller. */
    browserViewController: BrowserViewController
  }
}

/** Page binding that carries pointer, key, and input payloads from the injected script. */
const BINDING = '__dshView'
/** Longest wait for Chromium to exit after `Browser.close`, which flushes the profile, before the process is stopped. */
const CLOSE_TIMEOUT_MS = 5000
/** Pause before relaunching Chromium after an unexpected exit or a failed launch. */
const RESTART_DELAY_MS = 1000
/** Launch failures and unexpected exits that end supervision with status `failed`. */
const MAX_FAILURES = 5
/** Encoding of every still and screencast frame. */
const JPEG = 'jpeg'

/** Browser view deployment policy; every field is read once at start. */
export interface Config {
  /** Chromium executable; empty or omitted leaves the plugin inert. */
  executablePath?: string
  /** Persistent profile directory; the Web profile passes `dshHomePath('browser-profile')`. */
  userDataDir: string
  /** Loopback debugging port. */
  port: number
  /** Run Chromium without a visible window. */
  headless: boolean
  /** Pass `--no-sandbox`. */
  noSandbox: boolean
  /** Window and page size in CSS pixels. */
  viewport: {
    /** Width in CSS pixels. */
    width: number
    /** Height in CSS pixels. */
    height: number
  }
  /** Device pixel ratio of the browser, 1 to 4. */
  deviceScaleFactor: number
  /** How long after the last forwarded input a user keeps control before the agent's browser tools resume. */
  userControlIdleMs: number
  /** Name prefixes of the agent's browser tools that wait while a user holds control. */
  readonly agentToolPrefixes: readonly string[]
  /** Screencast settings for the followed and pinned tabs. */
  screencast: {
    /** JPEG quality, 1 to 100. */
    quality: number
    /** Frame rate limit of each watch. */
    maxFps: number
    /** Frame width in pixels; height keeps the viewport aspect ratio. Set it to `viewport.width * deviceScaleFactor` for sharper frames. */
    maxWidth: number
  }
}

/** One tab tracked from DevTools target events. */
interface Tab {
  readonly targetId: string
  url: string
  title: string
  /** Activity counter of the latest pointer, key, input, navigation, creation, or URL change. */
  activity: number
  /** Flattened DevTools session; absent until the page attaches. */
  sessionId?: string | undefined
  /** Whether Page.startScreencast is active on the session. */
  screencasting: boolean
  frameSeq: number
}

/** One live watch: its delivery queue and the tab it pins, if any. */
interface Watcher {
  readonly pin?: string
  readonly fanout: WatchFanout
}

/** A user's control of the browser; the agent's browser tools wait while one is held. */
interface UserControlLease {
  readonly timer: ReturnType<typeof setTimeout>
  /** Settles once the lease ends, whether by idle timeout, explicit release, or browser loss. */
  readonly released: PromiseWithResolvers<void>
}

/**
 * @param signal - any signal.
 * @returns whether the signal has aborted; a call keeps the check out of control-flow narrowing.
 */
function isAborted(signal: AbortSignal): boolean {
  return signal.aborted
}

/** Browser-level DevTools event parameters used by this plugin. */
interface TargetInfoParams { targetInfo: { targetId: string; type: string; url: string; title: string } }
interface ScreencastFrameParams {
  data: string
  metadata: { deviceWidth: number; deviceHeight: number; pageScaleFactor: number; scrollOffsetX: number; scrollOffsetY: number }
  sessionId: number
}

/** Shared browser Remote owner: starts one Chromium, tracks its tabs, and streams the followed tab to watches. */
export default class BrowserViewController extends TypertRemoteService {
  static inject = ['subprocess', 'typert']

  static Config = z.object({
    executablePath: z.string(),
    userDataDir: z.string().required(),
    port: z.number().step(1).min(1).max(65535).default(9333),
    headless: z.boolean().default(true),
    noSandbox: z.boolean().default(true),
    viewport: z.object({
      width: z.number().step(1).min(1).default(1600),
      height: z.number().step(1).min(1).default(900),
    }).default({}),
    deviceScaleFactor: z.number().min(1).max(4).default(1),
    userControlIdleMs: z.number().step(1).min(1).default(10000),
    agentToolPrefixes: z.array(z.string().min(1)).default(['mcp__playwright-mcp__']),
    screencast: z.object({
      quality: z.number().step(1).min(1).max(100).default(80),
      maxFps: z.number().step(1).min(1).default(10),
      maxWidth: z.number().step(1).min(1).default(1600),
    }).default({}),
  })

  /** Loopback origin of the debugging port, for other plugins that need the browser over CDP. */
  readonly endpoint: string
  private status: BrowserViewState['status'] = 'disabled'
  private readonly tabs = new Map<string, Tab>()
  private readonly watchers = new Set<Watcher>()
  private activeTargetId: string | undefined
  private clock = 0
  private publishedState = ''
  private failures = 0
  private running: LaunchedChromium | undefined
  private cdp: CdpClient | undefined
  private screencastQueue: Promise<void> = Promise.resolve()
  private userControl: UserControlLease | undefined

  /**
   * @param ctx - Host context carrying the process service and the Remote registry.
   * @param config - browser executable, profile, and streaming policy.
   */
  constructor(ctx: Context, private readonly config: Config) {
    super(ctx, 'browserViewController', { namespace: 'browserView' })
    this.endpoint = `http://127.0.0.1:${config.port}`
    const executablePath = config.executablePath
    if (executablePath === undefined || executablePath === '') return
    const chromium: ChromiumOptions = {
      executablePath,
      userDataDir: config.userDataDir,
      port: config.port,
      headless: config.headless,
      noSandbox: config.noSandbox,
      viewport: config.viewport,
      deviceScaleFactor: config.deviceScaleFactor,
    }
    ctx.on('tools/pre-execute', async (exec, next) => {
      if (!this.config.agentToolPrefixes.some(prefix => exec.name.startsWith(prefix))) return next()
      await this.untilAgentMayAct(exec.signal)
      return exec.signal.aborted ? { kind: 'cancel' } : next()
    })
    ctx.effect(() => {
      const lifecycle = new AbortController()
      this.status = 'starting'
      const supervision = this.supervise(chromium, lifecycle.signal)
      return async () => {
        this.releaseUserControl()
        lifecycle.abort()
        for (const watcher of this.watchers) watcher.fanout.close()
        await this.closeGracefully()
        await this.running?.stop()
        await supervision
      }
    })
  }

  /**
   * Current browser status and tab roster.
   * @param signal - client cancellation; the snapshot is synchronous, so it is not awaited.
   * @returns the state snapshot.
   */
  @Remote('state')
  state(signal: AbortSignal): Promise<BrowserViewState> {
    signal.throwIfAborted()
    return Promise.resolve(this.snapshot())
  }

  /**
   * Forward one user input event to a tab and hold user control, which pauses the agent's browser tools until the
   * idle window passes. Everything before the send runs synchronously so inputs reach Chromium in arrival order.
   * @param request - target tab and the event to forward.
   * @param signal - client cancellation, checked before the request is validated.
   * @returns settles when Chromium acknowledges the command.
   * @throws `gateway/bad-request` when the event is invalid, `browser-view/tab-not-found` when no open tab has the target id,
   * `browser-view/unavailable` when the tab is not attached, or the CDP error when Chromium rejects the command.
   */
  @Remote('input')
  async input(request: BrowserInputRequest, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    const { targetId, event } = parseInputRequest(request)
    const tab = this.tabs.get(targetId)
    if (tab === undefined) throw new RemoteError('browser-view/tab-not-found', `browser-view: no open tab ${targetId}`, { targetId })
    if (tab.sessionId === undefined || this.cdp === undefined) {
      throw new RemoteError('browser-view/unavailable', 'browser-view: the tab is not attached', {})
    }
    this.holdUserControl()
    const { method, params } = inputCommand(event)
    await this.send(method, params, tab.sessionId)
  }

  /**
   * Give control back to the agent now instead of after the idle window.
   * @param signal - client cancellation, checked before the release.
   * @returns settles immediately.
   */
  @Remote('release')
  release(signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    this.releaseUserControl()
    return Promise.resolve()
  }

  /**
   * Stream what the browser shows: the state, then frames and discrete events of the followed tab, or of the pinned
   * tab, which ends when that tab closes. Pointer coordinates are CSS pixels of the page viewport.
   * @param request - optional tab to pin; omitted follows the active tab.
   * @param signal - watch cancellation owned by the Remote stream carrier.
   * @returns the watch items in delivery order.
   * @throws when the pinned tab is not open.
   */
  @Remote({ mode: 'stream' })
  async * watch(request: BrowserViewWatchRequest, signal: AbortSignal): AsyncIterable<BrowserViewEvent> {
    if (request.targetId !== undefined && !this.tabs.has(request.targetId)) {
      throw new Error(`browser-view: no open tab ${request.targetId}`)
    }
    const fanout = new WatchFanout(1000 / this.config.screencast.maxFps)
    const watcher: Watcher = request.targetId === undefined ? { fanout } : { pin: request.targetId, fanout }
    this.watchers.add(watcher)
    fanout.pushState(this.snapshot())
    // An inert plugin has no browser to stream: the watch carries its state and ends.
    if (this.status === 'disabled') fanout.close()
    void this.captureFor(this.effective(watcher))
    void this.syncScreencast()
    try {
      yield* fanout.drain(signal)
    } finally {
      this.watchers.delete(watcher)
      fanout.close()
      void this.syncScreencast()
    }
  }

  /**
   * Ask Chromium to close itself and wait briefly for it to exit. SIGTERM alone can end the process before the
   * profile is flushed, which loses cookies and storage.
   */
  private async closeGracefully(): Promise<void> {
    const exited = this.running?.exited
    if (exited === undefined) return
    // A dead connection means the process is already gone; stop() then has nothing to end.
    await this.cdp?.send('Browser.close').catch(() => {})
    await Promise.race([exited, delay(CLOSE_TIMEOUT_MS)])
  }

  /**
   * Run the browser until the lifecycle aborts: launch, watch for exit, then relaunch within the failure budget.
   * @param chromium - launch settings.
   * @param signal - lifecycle cancellation from the plugin disposer.
   */
  private async supervise(chromium: ChromiumOptions, signal: AbortSignal): Promise<void> {
    while (!isAborted(signal)) {
      try {
        await this.startBrowser(chromium, signal)
      } catch (error) {
        if (isAborted(signal)) return
        this.ctx.logger.error(`browser-view: launch failed: ${String(error)}`)
        if (!await this.recordFailure(signal)) return
        continue
      }
      this.setStatus('ready')
      const reason = await this.running?.exited
      this.dropBrowser()
      if (isAborted(signal)) return
      this.ctx.logger.warn(`browser-view: chromium ${reason ?? 'ended'}; relaunching`)
      if (!await this.recordFailure(signal)) return
    }
  }

  /**
   * Count one failure and wait before the next launch.
   * @param signal - lifecycle cancellation.
   * @returns false when supervision must stop: the budget is spent or the lifecycle aborted.
   */
  private async recordFailure(signal: AbortSignal): Promise<boolean> {
    this.failures++
    if (this.failures >= MAX_FAILURES) {
      this.setStatus('failed')
      return false
    }
    this.setStatus('restarting')
    try {
      await delay(RESTART_DELAY_MS, undefined, { signal })
    } catch {
      // Only lifecycle cancellation rejects the delay; supervision then stops.
      return false
    }
    return true
  }

  /**
   * Launch Chromium, connect to its browser endpoint, and enable target discovery.
   * @param chromium - launch settings.
   * @param signal - lifecycle cancellation; a cancelled start stops the process.
   */
  private async startBrowser(chromium: ChromiumOptions, signal: AbortSignal): Promise<void> {
    const running = await launchChromium(this.ctx.subprocess, chromium, signal)
    this.running = running
    try {
      const cdp = await CdpClient.connect(running.webSocketUrl)
      this.cdp = cdp
      cdp.onEvent((event) => { this.handle(event) })
      await cdp.send('Target.setDiscoverTargets', { discover: true })
      signal.throwIfAborted()
    } catch (error) {
      await running.stop()
      this.dropBrowser()
      throw error
    }
  }

  /** Forget the process and its connection, close every tab, and end any user control. */
  private dropBrowser(): void {
    const cdp = this.cdp
    this.running = undefined
    this.cdp = undefined
    this.tabs.clear()
    this.activeTargetId = undefined
    for (const watcher of this.watchers) if (watcher.pin !== undefined) watcher.fanout.close()
    this.releaseUserControl()
    this.publish()
    void cdp?.close()
  }

  /**
   * Route one DevTools event. Handler failures are logged so one bad payload cannot stop the connection.
   * @param event - event from the browser connection.
   */
  private handle(event: CdpEvent): void {
    try {
      this.dispatch(event)
    } catch (error) {
      this.ctx.logger.warn(`browser-view: ${event.method} failed: ${String(error)}`)
    }
  }

  private dispatch(event: CdpEvent): void {
    switch (event.method) {
      case 'Target.targetCreated': {
        const { targetInfo } = event.params as TargetInfoParams
        if (targetInfo.type === 'page') this.addTab(targetInfo)
        return
      }
      case 'Target.targetInfoChanged': {
        const { targetInfo } = event.params as TargetInfoParams
        const tab = this.tabs.get(targetInfo.targetId)
        if (tab === undefined) return
        tab.title = targetInfo.title
        if (tab.url !== targetInfo.url) {
          tab.url = targetInfo.url
          tab.activity = ++this.clock
        }
        this.refresh()
        return
      }
      case 'Target.targetDestroyed': {
        const { targetId } = event.params as { targetId: string }
        this.tabs.delete(targetId)
        for (const watcher of this.watchers) if (watcher.pin === targetId) watcher.fanout.close()
        this.refresh()
        return
      }
      case 'Target.detachedFromTarget': {
        const tab = this.tabBySession(event.sessionId)
        if (tab === undefined) return
        tab.sessionId = undefined
        tab.screencasting = false
        return
      }
      case 'Runtime.bindingCalled': {
        const { name, payload } = event.params as { name: string; payload: string }
        const tab = this.tabBySession(event.sessionId)
        const report = name === BINDING && tab !== undefined ? parsePagePayload(payload) : undefined
        if (tab !== undefined && report !== undefined) this.onPagePayload(tab, report)
        return
      }
      case 'Page.frameNavigated': {
        const { frame } = event.params as { frame: { parentId?: string; url: string } }
        const tab = this.tabBySession(event.sessionId)
        if (tab === undefined || frame.parentId !== undefined) return
        tab.url = frame.url
        tab.activity = ++this.clock
        this.refresh()
        this.deliver(tab.targetId, { type: 'navigation', targetId: tab.targetId, ts: Date.now(), url: tab.url, title: tab.title })
        return
      }
      case 'Page.screencastFrame': {
        const params = event.params as ScreencastFrameParams
        const sessionId = event.sessionId
        if (sessionId === undefined) return
        void this.send('Page.screencastFrameAck', { sessionId: params.sessionId }, sessionId).catch((error: unknown) => {
          this.ctx.logger.warn(`browser-view: screencast ack failed: ${String(error)}`)
        })
        const tab = this.tabBySession(sessionId)
        if (tab?.screencasting === true) this.emitFrame(tab.targetId, params.data, params.metadata)
        return
      }
    }
  }

  /**
   * Record one page payload as activity and deliver it to the watches that follow its tab.
   * @param tab - tab whose page posted the payload.
   * @param payload - pointer, key, or input report from the injected script.
   */
  private onPagePayload(tab: Tab, payload: PagePayload): void {
    tab.activity = ++this.clock
    const ts = Date.now()
    this.refresh()
    const targetId = tab.targetId
    if (payload.type === 'pointer') {
      this.deliver(targetId, { type: 'pointer', targetId, ts, kind: payload.kind, x: payload.x, y: payload.y, ...payload.button === undefined ? {} : { button: payload.button }, ...payload.target === undefined ? {} : { target: payload.target } })
    } else if (payload.type === 'key') {
      this.deliver(targetId, { type: 'key', targetId, ts, key: payload.key, code: payload.code, modifiers: payload.modifiers, ...payload.target === undefined ? {} : { target: payload.target } })
    } else {
      this.deliver(targetId, { type: 'input', targetId, ts, ...payload.value === undefined ? {} : { value: payload.value }, ...payload.target === undefined ? {} : { target: payload.target } })
    }
  }

  /**
   * Start tracking a page target and attach its session.
   * @param info - DevTools target info of the new page.
   */
  private addTab(info: TargetInfoParams['targetInfo']): void {
    this.tabs.set(info.targetId, {
      targetId: info.targetId, url: info.url, title: info.title, activity: ++this.clock, screencasting: false, frameSeq: 0,
    })
    this.refresh()
    void this.attachPage(info.targetId)
  }

  /**
   * Attach one page target with the flattened session and install the page observer.
   * @param targetId - page target to attach.
   */
  private async attachPage(targetId: string): Promise<void> {
    try {
      const { sessionId } = await this.send<{ sessionId: string }>('Target.attachToTarget', { targetId, flatten: true })
      const tab = this.tabs.get(targetId)
      if (tab === undefined) return
      tab.sessionId = sessionId
      await this.send('Page.enable', {}, sessionId)
      await this.send('Runtime.enable', {}, sessionId)
      await this.send('Runtime.addBinding', { name: BINDING }, sessionId)
      await this.send('Page.addScriptToEvaluateOnNewDocument', { source: POINTER_SCRIPT }, sessionId)
      await this.send('Runtime.evaluate', { expression: POINTER_SCRIPT }, sessionId)
      // `--window-size` sets the outer window; headless Chromium keeps about 143 px of browser UI, so without this
      // override the page viewport was shorter than configured and frame metadata disagreed with it.
      await this.send('Emulation.setDeviceMetricsOverride', {
        width: this.config.viewport.width, height: this.config.viewport.height, deviceScaleFactor: 0, mobile: false,
      }, sessionId)
      this.refresh()
      await this.captureFor(targetId)
    } catch (error) {
      if (this.tabs.has(targetId)) this.ctx.logger.warn(`browser-view: attaching ${targetId} failed: ${String(error)}`)
    }
  }

  /** Recompute the followed tab, reset followers on a switch, publish state, and reconcile screencasts. */
  private refresh(): void {
    const active = this.computeActive()
    if (active !== this.activeTargetId) {
      this.activeTargetId = active
      for (const watcher of this.watchers) if (watcher.pin === undefined) watcher.fanout.resetFrame()
      if (active !== undefined) void this.captureFor(active)
    }
    this.publish()
    void this.syncScreencast()
  }

  /**
   * @returns the tab with the most recent activity, or undefined when no tab is open.
   */
  private computeActive(): string | undefined {
    let best: Tab | undefined
    for (const tab of this.tabs.values()) if (best === undefined || tab.activity > best.activity) best = tab
    return best?.targetId
  }

  /**
   * @param watcher - one live watch.
   * @returns the tab the watch shows: its pin, or the followed tab.
   */
  private effective(watcher: Watcher): string | undefined {
    return watcher.pin ?? this.activeTargetId
  }

  /**
   * Set the process status and publish it.
   * @param status - new status.
   */
  private setStatus(status: BrowserViewState['status']): void {
    this.status = status
    this.publish()
  }

  /** Take or extend user control: the idle window restarts from now, and the first hold publishes the new state. */
  private holdUserControl(): void {
    const previous = this.userControl
    if (previous !== undefined) clearTimeout(previous.timer)
    const timer = setTimeout(() => { this.releaseUserControl() }, this.config.userControlIdleMs)
    this.userControl = { timer, released: previous?.released ?? Promise.withResolvers<void>() }
    if (previous === undefined) this.publish()
  }

  /** End user control, wake any tool call waiting on it, and publish the new state. */
  private releaseUserControl(): void {
    const lease = this.userControl
    if (lease === undefined) return
    clearTimeout(lease.timer)
    this.userControl = undefined
    lease.released.resolve()
    this.publish()
  }

  /**
   * Wait while a user holds control. Browser tools wait rather than fail, so the agent resumes where it stopped.
   * @param signal - the tool call's cancellation; an abort ends the wait.
   * @returns settles when control is released or the call is aborted.
   */
  private async untilAgentMayAct(signal: AbortSignal): Promise<void> {
    while (this.userControl !== undefined && !signal.aborted) {
      const { released } = this.userControl
      const aborted = Promise.withResolvers<void>()
      const onAbort = (): void => { aborted.resolve() }
      signal.addEventListener('abort', onAbort, { once: true })
      await Promise.race([released.promise, aborted.promise])
      signal.removeEventListener('abort', onAbort)
    }
  }

  /** Send the current snapshot to every watch when it differs from the last one published. */
  private publish(): void {
    const state = this.snapshot()
    const json = JSON.stringify(state)
    if (json === this.publishedState) return
    this.publishedState = json
    for (const watcher of this.watchers) watcher.fanout.pushState(state)
  }

  /**
   * @returns the current status, tab roster, followed tab, and viewport.
   */
  private snapshot(): BrowserViewState {
    const tabs: BrowserViewTab[] = [...this.tabs.values()].map(tab => ({
      targetId: tab.targetId,
      url: tab.url,
      title: tab.title,
      active: tab.targetId === this.activeTargetId,
    }))
    return {
      status: this.status,
      tabs,
      ...this.activeTargetId === undefined ? {} : { activeTargetId: this.activeTargetId },
      viewport: { width: this.config.viewport.width, height: this.config.viewport.height },
      userControl: this.userControl !== undefined,
    }
  }

  /**
   * Start screencasts for the tabs the watches show and stop the rest, one command at a time.
   * @returns settles after the queued reconciliation finishes.
   */
  private syncScreencast(): Promise<void> {
    this.screencastQueue = this.screencastQueue
      .then(() => this.applyScreencast())
      .catch((error: unknown) => { this.ctx.logger.warn(`browser-view: screencast reconciliation failed: ${String(error)}`) })
    return this.screencastQueue
  }

  private async applyScreencast(): Promise<void> {
    if (this.cdp === undefined) return
    const wanted = new Set([...this.watchers].map(watcher => this.effective(watcher)))
    const { quality, maxWidth } = this.config.screencast
    const maxHeight = Math.round(maxWidth * this.config.viewport.height / this.config.viewport.width)
    for (const tab of this.tabs.values()) {
      if (tab.sessionId === undefined) continue
      const want = wanted.has(tab.targetId)
      if (want === tab.screencasting) continue
      tab.screencasting = want
      const sessionId = tab.sessionId
      const command = want
        ? this.send('Page.startScreencast', { format: JPEG, quality, maxWidth, maxHeight, everyNthFrame: 1 }, sessionId)
        : this.send('Page.stopScreencast', {}, sessionId)
      await command.catch((error: unknown) => {
        tab.screencasting = false
        this.ctx.logger.warn(`browser-view: screencast of ${tab.targetId} failed: ${String(error)}`)
      })
    }
  }

  /**
   * Capture one still frame of a tab for the watches that show it; static pages emit no screencast frames.
   * @param targetId - tab to capture, or undefined when nothing is followed.
   */
  private async captureFor(targetId: string | undefined): Promise<void> {
    const tab = targetId === undefined ? undefined : this.tabs.get(targetId)
    if (tab?.sessionId === undefined || !this.showsTarget(tab.targetId)) return
    const { quality } = this.config.screencast
    const seq = tab.frameSeq
    try {
      const { data } = await this.send<{ data: string }>('Page.captureScreenshot', { format: JPEG, quality }, tab.sessionId)
      // A screencast frame stored meanwhile is newer than this still.
      if (tab.frameSeq !== seq) return
      this.emitFrame(tab.targetId, data, {
        deviceWidth: this.config.viewport.width, deviceHeight: this.config.viewport.height,
        pageScaleFactor: 1, scrollOffsetX: 0, scrollOffsetY: 0,
      })
    } catch (error) {
      this.ctx.logger.warn(`browser-view: capture of ${tab.targetId} failed: ${String(error)}`)
    }
  }

  /**
   * @param targetId - tab id.
   * @returns whether a live watch shows this tab.
   */
  private showsTarget(targetId: string): boolean {
    for (const watcher of this.watchers) if (this.effective(watcher) === targetId) return true
    return false
  }

  /**
   * Store one frame as the latest of its tab and hand it to the watches that show that tab.
   * @param targetId - tab that produced the frame.
   * @param jpegBase64 - JPEG bytes.
   * @param metadata - DevTools frame metadata.
   */
  private emitFrame(targetId: string, jpegBase64: string, metadata: BrowserViewFrameMetadata): void {
    const tab = this.tabs.get(targetId)
    if (tab === undefined) return
    const frame = { type: 'frame' as const, targetId, seq: ++tab.frameSeq, ts: Date.now(), jpegBase64, metadata }
    for (const watcher of this.watchers) if (this.effective(watcher) === targetId) watcher.fanout.pushFrame(frame)
  }

  /**
   * Hand one discrete event to the watches that show its tab.
   * @param targetId - tab that produced the event.
   * @param event - event to deliver.
   */
  private deliver(targetId: string, event: BrowserViewEvent): void {
    for (const watcher of this.watchers) if (this.effective(watcher) === targetId) watcher.fanout.pushEvent(event)
  }

  /**
   * @param sessionId - DevTools session id.
   * @returns the tab attached under that session.
   */
  private tabBySession(sessionId: string | undefined): Tab | undefined {
    for (const tab of this.tabs.values()) if (tab.sessionId === sessionId) return tab
    return undefined
  }

  /**
   * Send one DevTools command on the live browser connection.
   * @param method - CDP method.
   * @param params - command parameters.
   * @param sessionId - flattened page session; omit for browser-level commands.
   * @returns the command result.
   * @throws when no browser connection exists.
   */
  private send<T = unknown>(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<T> {
    if (this.cdp === undefined) throw new Error('browser-view: browser is not running')
    return this.cdp.send<T>(method, params, sessionId)
  }
}
