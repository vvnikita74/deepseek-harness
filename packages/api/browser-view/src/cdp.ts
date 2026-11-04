/** Minimal Chrome DevTools Protocol client over one WebSocket: commands, responses, and events. @module */

import WebSocket from 'ws'

/** One CDP event; `sessionId` names the flattened target session, absent for browser-level events. */
export interface CdpEvent {
  readonly method: string
  readonly params: unknown
  readonly sessionId?: string
}

/** Wire frame from the browser: a response when `id` is present, otherwise an event. */
interface CdpMessage {
  readonly id?: number
  readonly method?: string
  readonly params?: unknown
  readonly result?: unknown
  readonly error?: { readonly message: string }
  readonly sessionId?: string
}

/** One browser-level DevTools connection. */
export class CdpClient {
  private nextId = 1
  private readonly pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void; method: string }>()
  private readonly listeners = new Set<(event: CdpEvent) => void>()
  private readonly socket: WebSocket
  /** Settles when the socket closes, for any reason. */
  readonly closed: Promise<void>

  private constructor(socket: WebSocket) {
    this.socket = socket
    // A socket error is always followed by `close`, which rejects pending commands.
    socket.on('error', () => {})
    socket.on('message', (data: WebSocket.RawData) => { this.receive((data as Buffer).toString('utf8')) })
    this.closed = new Promise<void>((resolve) => {
      socket.once('close', () => {
        const error = new Error('CDP connection closed')
        for (const request of this.pending.values()) request.reject(error)
        this.pending.clear()
        resolve()
      })
    })
  }

  /**
   * Open one DevTools WebSocket.
   * @param url - `ws://` endpoint, normally a browser `webSocketDebuggerUrl`.
   * @returns the connected client; rejects when the socket fails before opening.
   */
  static connect(url: string): Promise<CdpClient> {
    const socket = new WebSocket(url, { perMessageDeflate: false, maxPayload: 256 * 1024 * 1024 })
    return new Promise((resolve, reject) => {
      socket.once('open', () => { resolve(new CdpClient(socket)) })
      socket.once('error', reject)
    })
  }

  /**
   * Send one command and await its response.
   * @param method - CDP method name.
   * @param params - command parameters.
   * @param sessionId - flattened target session; omit for browser-level commands.
   * @returns the command result, typed by the caller per the protocol.
   * @throws when the browser returns an error or the connection closes first.
   */
  send<T = unknown>(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<T> {
    const id = this.nextId++
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: (value) => { resolve(value as T) }, reject, method })
      const frame = sessionId === undefined ? { id, method, params } : { id, method, params, sessionId }
      this.socket.send(JSON.stringify(frame), (error) => {
        if (!error) return
        this.pending.delete(id)
        reject(error)
      })
    })
  }

  /**
   * Observe every event on this connection.
   * @param listener - called for each event in arrival order.
   * @returns the unsubscribe function.
   */
  onEvent(listener: (event: CdpEvent) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /** Close the socket and wait until it reports closed. */
  async close(): Promise<void> {
    this.socket.close()
    await this.closed
  }

  private receive(text: string): void {
    const message = JSON.parse(text) as CdpMessage
    if (message.id !== undefined) {
      const request = this.pending.get(message.id)
      this.pending.delete(message.id)
      if (request === undefined) return
      if (message.error !== undefined) request.reject(new Error(`${request.method}: ${message.error.message}`))
      else request.resolve(message.result)
      return
    }
    if (message.method === undefined) return
    const event: CdpEvent = {
      method: message.method,
      params: message.params,
      ...message.sessionId === undefined ? {} : { sessionId: message.sessionId },
    }
    for (const listener of this.listeners) listener(event)
  }
}
