import OTel from '@deepseek-ai/dsh-otel'
/**
 * OTel backend unit tier: wire assertions against a scripted `node:http`
 * mock collector through the SDK's REAL pipeline (BatchLogRecordProcessor →
 * OTLP/HTTP JSON), config fail-loud cases, and the real-Loader-path guard
 * for the default-exported Service class.
 */

import { afterAll, afterEach, beforeAll, describe, expect, expectTypeOf, it, vi } from 'vitest'
import { createServer, type Server } from 'node:http'
import { once } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gunzipSync } from 'node:zlib'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import SessionStore from '@deepseek-ai/dsh-session'
import OpenTelemetrySessionBackend, { Config, DEFAULT_TELEMETRY_MODE, SessionTelemetryMode } from '../src/index.ts'

interface Capture {
  headers: import('node:http').IncomingHttpHeaders
  body: OtlpLogsRequest
}

/** Just the slice of ExportLogsServiceRequest JSON these assertions touch. */
interface OtlpLogsRequest {
  resourceLogs: {
    resource: { attributes: { key: string; value: { stringValue?: string } }[] }
    scopeLogs: {
      scope: { name: string }
      logRecords: {
        timeUnixNano: string
        severityNumber: number
        severityText: string
        attributes?: { key: string; value: Record<string, unknown> }[]
        body?: unknown
      }[]
    }[]
  }[]
}

const servers: Server[] = []

// The backend resolves the harness home's anonymous user id at construction;
// pin DSH_HOME to a temp dir so the suite never touches the ambient ~/.dsh.
let tempHome: string
let previousDshHome: string | undefined
beforeAll(() => {
  tempHome = mkdtempSync(join(tmpdir(), 'dsh-otel-home-'))
  previousDshHome = process.env.DSH_HOME
  process.env.DSH_HOME = tempHome
})
afterAll(() => {
  if (previousDshHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = previousDshHome
  rmSync(tempHome, { recursive: true, force: true })
})

afterEach(async () => {
  for (const server of servers.splice(0)) {
    const closed = once(server, 'close')
    server.close()
    server.closeAllConnections()
    await closed
  }
})

async function mockCollector(
  beforeRespond?: (requestIndex: number) => Promise<void> | void,
): Promise<{ url: string; captures: Capture[] }> {
  const captures: Capture[] = []
  let requestIndex = 0
  const server = createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on('data', chunk => chunks.push(chunk as Buffer))
    request.on('end', () => {
      const index = requestIndex++
      void (async () => {
        await beforeRespond?.(index)
        const raw = Buffer.concat(chunks)
        const body = request.headers['content-encoding'] === 'gzip' ? gunzipSync(raw) : raw
        captures.push({
          headers: request.headers,
          body: JSON.parse(body.toString()) as OtlpLogsRequest,
        })
        response.writeHead(200, { 'content-type': 'application/json' }).end('{}')
      })()
    })
  })
  servers.push(server)
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('no port')
  return { url: `http://127.0.0.1:${address.port}/v1/logs`, captures }
}

describe('OpenTelemetrySessionBackend wire', () => {
  it('discloses the sharing policy for every mode', async () => {
    const { url, captures } = await mockCollector()

    const gatedCtx = new Context()

    gatedCtx.plugin(OTel)
    await gatedCtx.plugin(SessionStore)
    const gated = await gatedCtx.plugin(OpenTelemetrySessionBackend, { mode: SessionTelemetryMode.FEEDBACK_ONLY, exporter: { url } })
    expect(gatedCtx.sessionTelemetry.sharing).toBe('feedback-only')
    await gated.dispose()

    const disabledCtx = new Context()

    disabledCtx.plugin(OTel)
    await disabledCtx.plugin(SessionStore)
    const disabled = await disabledCtx.plugin(OpenTelemetrySessionBackend, { mode: SessionTelemetryMode.DISABLED })
    expect(disabledCtx.sessionTelemetry.sharing).toBe('disabled')
    await disabled.dispose()

    const defaultCtx = new Context()

    defaultCtx.plugin(OTel)
    await defaultCtx.plugin(SessionStore)
    const defaulted = await defaultCtx.plugin(OpenTelemetrySessionBackend, { exporter: { url } })
    expect(defaultCtx.sessionTelemetry.sharing).toBe('feedback-only')
    await defaulted.dispose()

    // No record was emitted by any mode, so nothing reached the collector.
    expect(captures).toEqual([])
  })
})

describe('OpenTelemetrySessionBackend config fails loud', () => {
  it('exposes modes through the nominal enum', () => {
    expectTypeOf<Config['mode']>().toEqualTypeOf<SessionTelemetryMode | undefined>()
    expectTypeOf<'FULL'>().not.toExtend<SessionTelemetryMode>()
    expectTypeOf<SessionTelemetryMode.FEEDBACK_ONLY>().toExtend<SessionTelemetryMode>()
    expect(Object.values(SessionTelemetryMode)).toEqual(['FEEDBACK_ONLY', 'DISABLED'])
    expect(() => Config({ mode: 'FULL' } as unknown as Config)).toThrow()
    expect(DEFAULT_TELEMETRY_MODE).toBe(SessionTelemetryMode.FEEDBACK_ONLY)
    expect(Config({}).mode).toBe(DEFAULT_TELEMETRY_MODE)
  })

  it.each([
    [{}, /exporter\.url is required/],
    [{ mode: SessionTelemetryMode.FEEDBACK_ONLY }, /exporter\.url is required/],
    [{ mode: SessionTelemetryMode.FEEDBACK_ONLY, exporter: { url: '' } }, /exporter\.url is required/],
    [{ mode: SessionTelemetryMode.FEEDBACK_ONLY, exporter: { url: 'not a url' } }, /not a valid URL/],
    [{ mode: SessionTelemetryMode.FEEDBACK_ONLY, exporter: { url: 'ftp://collector' } }, /must be http\(s\)/],
    [{ mode: 'INVALID' }, /INVALID/],
    [{ mode: 'FULL' }, /FULL/],
    // The SDK accepts a non-positive batch size but its shutdown drain then
    // splices empty batches forever — dispose would hang, so reject at load.
    [{ mode: SessionTelemetryMode.FEEDBACK_ONLY, exporter: { url: 'http://c/v1/logs' }, processor: { maxExportBatchSize: 0 } }, /maxExportBatchSize/],
    [{ mode: SessionTelemetryMode.FEEDBACK_ONLY, exporter: { url: 'http://c/v1/logs' }, processor: { maxExportBatchSize: 0.5 } }, /maxExportBatchSize/],
    [{ mode: SessionTelemetryMode.FEEDBACK_ONLY, exporter: { url: 'http://c/v1/logs' }, shutdownTimeoutMillis: 0 }, /shutdownTimeoutMillis/],
    [{ mode: SessionTelemetryMode.FEEDBACK_ONLY, exporter: { url: 'http://c/v1/logs' }, shutdownTimeoutMillis: Number.POSITIVE_INFINITY }, /shutdownTimeoutMillis/],
  ])('rejects %j at plugin load', async (config, message) => {
    const ctx = new Context()
    ctx.plugin(OTel)
    await ctx.plugin(SessionStore)
    await expect(ctx.plugin(OpenTelemetrySessionBackend, config as Config)).rejects.toThrow(message)
  })

  it.each(['INVALID', 'FULL'])('rejects direct mode %s before reading transport config', async (mode) => {
    const ctx = new Context()
    ctx.plugin(OTel)
    await ctx.plugin(SessionStore)
    let exporterRead = false
    const config = {
      mode,
      get exporter() {
        exporterRead = true
        throw new Error('transport config was read')
      },
    } as unknown as Config

    expect(() => new OpenTelemetrySessionBackend(ctx, config)).toThrow(`unsupported mode "${mode}"`)
    expect(exporterRead).toBe(false)
  })

  it('does not read any transport setting in disabled mode', async () => {
    const ctx = new Context()
    ctx.plugin(OTel)
    await ctx.plugin(SessionStore)
    const transportRead = vi.fn(() => {
      throw new Error('transport config was read')
    })
    const config = {
      mode: SessionTelemetryMode.DISABLED,
      get exporter() {
        return transportRead()
      },
      get processor() {
        return transportRead()
      },
      get shutdownTimeoutMillis() {
        return transportRead()
      },
    } as Config

    new OpenTelemetrySessionBackend(ctx, config)
    expect(transportRead).not.toHaveBeenCalled()
    await ctx.fiber.dispose()
  })
})

describe('dsh-session-telemetry-otel real-load-path guard', () => {
  it('keeps the Service class with inject/Config through unwrapExports', async () => {
    const module = await import('../src/index.ts')
    const loader = Object.create(Loader.prototype) as Loader
    const unwrapped = loader.unwrapExports(module) as typeof OpenTelemetrySessionBackend
    expect(unwrapped).toBe(OpenTelemetrySessionBackend)
    expect(unwrapped.inject).toEqual(['sessions', 'otel'])
    expect(typeof unwrapped.Config).toBe('function')
  })

  it('boots through the unwrapped class and registers ctx.sessionTelemetry', async () => {
    const { url } = await mockCollector()
    const module = await import('../src/index.ts')
    const loader = Object.create(Loader.prototype) as Loader
    const unwrapped = loader.unwrapExports(module) as Parameters<Context['plugin']>[0]
    const ctx = new Context()
    ctx.plugin(OTel)
    await ctx.plugin(SessionStore)
    const fiber = await ctx.plugin(unwrapped, { mode: SessionTelemetryMode.FEEDBACK_ONLY, exporter: { url } })
    expect(ctx.sessionTelemetry).toBeInstanceOf(OpenTelemetrySessionBackend)
    await fiber.dispose()
  })
})
