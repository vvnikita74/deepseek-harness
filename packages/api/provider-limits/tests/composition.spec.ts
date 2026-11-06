/**
 * Real Loader composition: the provider limits controller boots from a `cordis.yml` row beside the real model
 * service. The test emits the producer event on the root context and reads it through the mounted Remote namespace.
 */
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { ModuleLoaderV2 } from '@deepseek-ai/cordis-plugin-loader'
import { boot } from '@deepseek-ai/dsh-app-boot'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import type { ProviderLimits } from '@deepseek-ai/dsh-llm'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import { createLaunchEnvironmentSnapshot } from '@deepseek-ai/dsh-launch-environment'
import ProviderLimitsPlugin from '../src/index.ts'

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

/**
 * Boot the controller from a real `cordis.yml` with the model service beside it.
 * @returns the booted root context and the controller's Remote namespace owner.
 */
async function bootLimits(balance?: { url: string }) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-provider-limits-composition-'))
  cleanups.push(async () => { await rm(root, { recursive: true, force: true }) })
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, JSON.stringify([
    { id: 'typert', name: '@deepseek-ai/dsh-typert-registry' },
    { id: 'llm', name: '@deepseek-ai/dsh-llm' },
    { id: 'provider-limits', name: '@deepseek-ai/dsh-api-provider-limits', ...balance === undefined ? {} : { config: { balance: { provider: 'timeweb', url: balance.url } } } },
  ]))
  const modules: ModuleLoaderV2 = {
    version: 'v2', loadCache: new Map(),
    async import(specifier) {
      if (specifier === '@deepseek-ai/dsh-api-provider-limits') return { default: ProviderLimitsPlugin }
      if (specifier === '@deepseek-ai/dsh-typert-registry') return TypertRegistry
      if (specifier === '@deepseek-ai/dsh-llm') return { default: LlmRuntime }
      throw new Error(`Unexpected fixture module ${specifier}`)
    },
    register(): never { throw new Error('Unexpected module hook registration') },
    getOrCreateModuleJob(): never { throw new Error('Unexpected module job creation') },
    resolveSync(): never { throw new Error('Unexpected synchronous module resolution') },
    load(): never { throw new Error('Unexpected module load') },
  }
  const ctx: Context = await boot('provider-limits-composition', configPath, [], (host) => {
    host.loader.internal = modules
    host.provide('launchEnvironment', createLaunchEnvironmentSnapshot([{ source: 'process', values: { TIMEWEB_CLOUD_API_TOKEN: 'tok' } }]))
  })
  cleanups.push(async () => { await ctx.fiber.dispose() })
  const service = ctx.get('providerLimitsController')
  if (service === undefined) throw new Error('expected the providerLimits namespace')
  return { ctx, service }
}

describe('provider limits over the real Loader', () => {
  it('mounts the get and follow Remotes under the providerLimits namespace and serves emitted limits', async () => {
    const { ctx, service } = await bootLimits()
    expect(service.typertRemote.namespace).toBe('providerLimits')
    expect(service.get()).toEqual([])

    const limits: ProviderLimits = {
      provider: 'anthropic-sub',
      windows: [{ id: '5h', label: '5 h', usedPercent: 42, resetsAt: Date.now() + 3_600_000, status: 'ok' }],
      updatedAt: Date.now(),
    }
    const abort = new AbortController()
    const frames = service.follow(abort.signal)[Symbol.asyncIterator]()
    expect(await frames.next()).toEqual({ done: false, value: { type: 'snapshot', limits: [] } })
    ctx.emit('llm/provider-limits', limits)
    expect(await frames.next()).toEqual({ done: false, value: { type: 'update', limits: [limits] } })
    expect(service.get()).toEqual([limits])
    abort.abort()
    expect(await frames.next()).toEqual({ done: true, value: undefined })
  })

  it('polls the configured balance endpoint with the token and publishes it', async () => {
    const server = createServer((request, response) => {
      response.setHeader('content-type', 'application/json')
      response.end(request.headers.authorization === 'Bearer tok' ? '{"finances":{"balance":77.7,"currency":"RUB"}}' : '{}')
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    cleanups.push(async () => { server.close() })
    const { service } = await bootLimits({ url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/` })
    await vi.waitFor(() => expect(service.get()).toEqual([
      { provider: 'timeweb', windows: [], balance: { amount: 77.7, currency: 'RUB' }, updatedAt: expect.any(Number) },
    ]))
  })

  it('withdraws the namespace when its fiber is disposed', async () => {
    const { ctx } = await bootLimits()
    const entry = [...ctx.loader.entries()].find(row => row.options.id === 'provider-limits')
    await entry?.fiber?.dispose()
    expect(ctx.get('providerLimitsController')).toBeUndefined()
  })
})
