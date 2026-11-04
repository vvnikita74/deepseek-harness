/** Fake Chromium: a loopback `/json/version` endpoint and a browser-level CDP WebSocket that records commands. */
import { createServer as createNetServer } from 'node:net'
import { createServer, type Server } from 'node:http'
import { WebSocket, WebSocketServer } from 'ws'
import type { SubprocessOutcome, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'

/** One command the controller sent. */
export interface FakeCommand {
  readonly method: string
  readonly params: Record<string, unknown>
  readonly sessionId?: string
}

/** Scripted browser: records commands, answers them, and emits events on demand. */
export interface FakeBrowser {
  readonly port: number
  readonly commands: FakeCommand[]
  /**
   * Emit one CDP event to every connected client.
   * @param method - event name.
   * @param params - event parameters.
   * @param sessionId - flattened page session that produced the event.
   */
  emit(method: string, params: Record<string, unknown>, sessionId?: string): void
  /**
   * Resolve once a matching command has been received, immediately if it already was.
   * @param method - CDP method to wait for.
   * @param matches - optional parameter filter.
   * @returns the first matching command.
   */
  waitFor(method: string, matches?: (command: FakeCommand) => boolean): Promise<FakeCommand>
  close(): Promise<void>
}

/** Targets the fake browser reports at discovery. */
export interface FakeTarget { readonly targetId: string; readonly url: string; readonly title: string }

/**
 * Pick a loopback port that is free now.
 * @returns the port number.
 */
export async function freePort(): Promise<number> {
  const probe = createNetServer()
  await new Promise<void>(resolve => probe.listen(0, '127.0.0.1', resolve))
  const address = probe.address()
  await new Promise<void>((resolve) => { probe.close(() => { resolve() }) })
  if (address === null || typeof address === 'string') throw new Error('no loopback port')
  return address.port
}

/**
 * Start a fake browser on a free loopback port.
 * @param targets - page targets reported when the controller enables discovery.
 * @returns the running fake.
 */
export async function startFakeBrowser(targets: readonly FakeTarget[], onBrowserClose: () => void = () => {}): Promise<FakeBrowser> {
  const port = await freePort()
  const commands: FakeCommand[] = []
  const waiters: Array<{ method: string; matches: (command: FakeCommand) => boolean; resolve(command: FakeCommand): void }> = []
  const sockets = new Set<WebSocket>()
  const http: Server = createServer((request, response) => {
    if (request.url !== '/json/version') {
      response.writeHead(404).end()
      return
    }
    response.setHeader('content-type', 'application/json')
    response.end(JSON.stringify({ Browser: 'Fake/1', webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/browser/fake` }))
  })
  const wss = new WebSocketServer({ server: http, path: '/devtools/browser/fake' })
  const sendJson = (socket: WebSocket, frame: object): void => { socket.send(JSON.stringify(frame)) }
  wss.on('connection', (socket) => {
    sockets.add(socket)
    socket.on('close', () => { sockets.delete(socket) })
    socket.on('message', (data) => {
      const message = JSON.parse((data as Buffer).toString('utf8')) as { id: number; method: string; params: Record<string, unknown>; sessionId?: string }
      const command: FakeCommand = message.sessionId === undefined
        ? { method: message.method, params: message.params }
        : { method: message.method, params: message.params, sessionId: message.sessionId }
      commands.push(command)
      if (command.method === 'Browser.close') onBrowserClose()
      for (const waiter of [...waiters]) {
        if (waiter.method === command.method && waiter.matches(command)) {
          waiters.splice(waiters.indexOf(waiter), 1)
          waiter.resolve(command)
        }
      }
      sendJson(socket, {
        id: message.id, result: resultFor(command),
        ...command.sessionId === undefined ? {} : { sessionId: command.sessionId },
      })
      if (command.method === 'Target.setDiscoverTargets') {
        for (const target of targets) sendJson(socket, { method: 'Target.targetCreated', params: { targetInfo: { ...target, type: 'page' } } })
      }
    })
  })
  await new Promise<void>(resolve => http.listen(port, '127.0.0.1', resolve))
  return {
    port,
    commands,
    emit(method, params, sessionId) {
      for (const socket of sockets) {
        sendJson(socket, { method, params, ...sessionId === undefined ? {} : { sessionId } })
      }
    },
    waitFor(method, matches = () => true) {
      const found = commands.find(command => command.method === method && matches(command))
      if (found !== undefined) return Promise.resolve(found)
      return new Promise((resolve) => { waiters.push({ method, matches, resolve }) })
    },
    async close() {
      for (const socket of sockets) socket.terminate()
      await new Promise<void>((resolve) => { wss.close(() => { resolve() }) })
      await new Promise<void>((resolve) => { http.close(() => { resolve() }) })
    },
  }
}

/**
 * @param command - command the controller sent.
 * @returns the protocol result for the command.
 */
function resultFor(command: FakeCommand): unknown {
  if (command.method === 'Target.attachToTarget') return { sessionId: `s-${String(command.params.targetId)}` }
  if (command.method === 'Page.captureScreenshot') return { data: 'shot' }
  return {}
}

/**
 * Fake process service: `spawn` records the spec and completes its outcome when the abort signal fires or `exitAll` runs.
 * @returns the fake service, its recorded specs, and the exit trigger.
 */
export function fakeSubprocess() {
  const specs: SubprocessSpawnSpec[] = []
  const exits: Array<() => void> = []
  return {
    specs,
    /** Complete every live process outcome, as a browser exiting after `Browser.close` does. */
    exitAll(): void {
      for (const exit of exits.splice(0)) exit()
    },
    resolveExecutable: async (command: string) => command,
    spawn(spec: SubprocessSpawnSpec) {
      specs.push(spec)
      const outcome = Promise.withResolvers<SubprocessOutcome>()
      const exit = (): void => { outcome.resolve({ exitCode: null, signal: 'SIGTERM' }) }
      exits.push(exit)
      spec.signal?.addEventListener('abort', exit, { once: true })
      return {
        stdin: undefined, stdout: undefined, stderr: undefined, control: undefined,
        collected: {},
        done: outcome.promise,
        terminate: exit,
        waitForExit: async () => { await outcome.promise; return true },
      }
    },
  }
}
