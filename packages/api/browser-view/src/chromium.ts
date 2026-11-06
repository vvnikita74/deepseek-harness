/**
 * One persistent Chromium process on a fixed loopback debugging port. The profile directory is reused across
 * launches and never removed, so cookies and logins survive restarts.
 * @module @deepseek-ai/dsh-api-browser-view/chromium
 */

import { mkdir } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'

/** Launch settings; every field is read once per launch. */
export interface ChromiumOptions {
  /** Chromium executable, absolute or on the scrubbed PATH. */
  readonly executablePath: string
  /** Persistent profile directory; created when missing, never deleted. */
  readonly userDataDir: string
  /** Loopback debugging port. */
  readonly port: number
  /** Run without a visible window. */
  readonly headless: boolean
  /** Pass `--no-sandbox`, required when Chromium runs as root in a container. */
  readonly noSandbox: boolean
  /** Window and page size in CSS pixels. */
  readonly viewport: { readonly width: number; readonly height: number }
  /** Device pixel ratio of the browser; the screencast then carries this many frame pixels per CSS pixel up to `maxWidth`. */
  readonly deviceScaleFactor: number
}

/** A launched process with its browser-level debugging endpoint. */
export interface LaunchedChromium {
  /** Browser-level `ws://` endpoint from `/json/version`. */
  readonly webSocketUrl: string
  /** Settles with the reason once the process has exited, for any cause. */
  readonly exited: Promise<string>
  /** Terminate the process (SIGTERM, then SIGKILL after the grace period) and wait for it to leave. */
  stop(): Promise<void>
}

/** Stdout and stderr tails kept for diagnostics, in bytes. */
const LOG_TAIL_BYTES = 16 * 1024
/** SIGTERM-to-SIGKILL window of the subprocess provider. */
const STOP_GRACE_MS = 3000
/** Interval between readiness probes. */
const PROBE_INTERVAL_MS = 100
/** Upper bound for the debugging endpoint to answer after spawn. */
const READY_TIMEOUT_MS = 15000

/**
 * Build the fixed debugging, profile, and window arguments; headless and sandbox flags follow the options.
 * @param options - launch settings.
 * @returns the Chromium command-line arguments that follow the executable.
 */
export function chromiumArgs(options: ChromiumOptions): string[] {
  return [
    `--remote-debugging-port=${options.port}`,
    '--remote-debugging-address=127.0.0.1',
    `--user-data-dir=${options.userDataDir}`,
    `--window-size=${options.viewport.width},${options.viewport.height}`,
    `--force-device-scale-factor=${options.deviceScaleFactor}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-dev-shm-usage',
    ...options.headless ? ['--headless=new'] : [],
    ...options.noSandbox ? ['--no-sandbox'] : [],
  ]
}

/**
 * Start Chromium and wait until its debugging endpoint answers.
 * @param subprocess - process service that owns the child.
 * @param options - launch settings.
 * @param signal - cancellation; a cancelled launch stops the process before rejecting.
 * @returns the running browser once `/json/version` reports its WebSocket endpoint.
 * @throws when the executable is missing, the process exits first, or the endpoint is not ready in time.
 */
export async function launchChromium(
  subprocess: SubprocessRuntime,
  options: ChromiumOptions,
  signal: AbortSignal,
): Promise<LaunchedChromium> {
  await mkdir(options.userDataDir, { recursive: true })
  const executable = await subprocess.resolveExecutable(options.executablePath, undefined, signal)
  const stopping = new AbortController()
  const handle = subprocess.spawn({
    argv: [executable, ...chromiumArgs(options)],
    cwd: options.userDataDir,
    stdio: { stdin: 'ignore', stdout: { maxBytes: LOG_TAIL_BYTES }, stderr: { maxBytes: LOG_TAIL_BYTES } },
    graceMs: STOP_GRACE_MS,
    signal: stopping.signal,
  })
  const stop = async (): Promise<void> => {
    stopping.abort()
    await handle.waitForExit()
  }
  let exitReason: string | undefined
  const exited = handle.done.then(
    (outcome) => {
      exitReason = `exited with ${outcome.exitCode === null ? `signal ${outcome.signal ?? 'unknown'}` : `code ${outcome.exitCode}`}`
      return exitReason
    },
    (error: unknown) => {
      exitReason = `failed: ${String(error)}`
      return exitReason
    },
  )
  try {
    const webSocketUrl = await waitForBrowser(options.port, () => exitReason, signal)
    return { webSocketUrl, exited, stop }
  } catch (error) {
    await stop()
    throw error
  }
}

/**
 * Read the browser WebSocket endpoint once; a refused or malformed reply counts as not ready.
 * @param port - loopback debugging port.
 * @param signal - launch cancellation.
 * @returns the browser-level WebSocket URL, or undefined while the endpoint is not ready.
 */
async function probeVersion(port: number, signal: AbortSignal): Promise<string | undefined> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/json/version`, { signal })
    const body = (await response.json()) as { webSocketDebuggerUrl?: unknown }
    return typeof body.webSocketDebuggerUrl === 'string' ? body.webSocketDebuggerUrl : undefined
  } catch {
    // Connection refused while Chromium starts; the caller retries until its deadline.
    return undefined
  }
}

/**
 * Poll `/json/version` until it reports the browser WebSocket endpoint.
 * @param port - loopback debugging port.
 * @param exitReason - returns the exit reason once the process has ended.
 * @param signal - launch cancellation.
 * @returns the browser-level WebSocket URL.
 */
async function waitForBrowser(port: number, exitReason: () => string | undefined, signal: AbortSignal): Promise<string> {
  const deadline = Date.now() + READY_TIMEOUT_MS
  for (;;) {
    const version = await probeVersion(port, signal)
    if (version !== undefined) return version
    const reason = exitReason()
    if (reason !== undefined) throw new Error(`chromium ${reason} before its debugging endpoint was ready`)
    if (Date.now() >= deadline) throw new Error(`chromium debugging endpoint on port ${port} was not ready within ${READY_TIMEOUT_MS} ms`)
    await delay(PROBE_INTERVAL_MS, undefined, { signal })
  }
}
