/**
 * Real Loader composition: the browser view boots from a `cordis.yml` row. Only the process service is stubbed, and an
 * unconfigured executable must leave it inert without launching anything.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { ModuleLoaderV2 } from '@deepseek-ai/cordis-plugin-loader'
import { boot } from '@deepseek-ai/dsh-app-boot'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import { createLaunchEnvironmentSnapshot } from '@deepseek-ai/dsh-launch-environment'
import BrowserView from '../src/index.ts'
import { fakeSubprocess } from './fake-browser.ts'

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

/**
 * Boot the browser view from a real `cordis.yml` row.
 * @param row - the browser-view row's config; omitted keys use the plugin defaults.
 * @returns the booted root context and the Loader entry of the browser view.
 */
async function bootView(row: Record<string, unknown>) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-browser-view-composition-'))
  cleanups.push(async () => { await rm(root, { recursive: true, force: true }) })
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, JSON.stringify([
    { id: 'typert', name: '@deepseek-ai/dsh-typert-registry' },
    { id: 'browser-view', name: '@deepseek-ai/dsh-api-browser-view', config: { userDataDir: join(root, 'profile'), ...row } },
  ]))
  const modules: ModuleLoaderV2 = {
    version: 'v2', loadCache: new Map(),
    async import(specifier) {
      if (specifier === '@deepseek-ai/dsh-api-browser-view') return { default: BrowserView }
      if (specifier === '@deepseek-ai/dsh-typert-registry') return TypertRegistry
      throw new Error(`Unexpected fixture module ${specifier}`)
    },
    register(): never { throw new Error('Unexpected module hook registration') },
    getOrCreateModuleJob(): never { throw new Error('Unexpected module job creation') },
    resolveSync(): never { throw new Error('Unexpected synchronous module resolution') },
    load(): never { throw new Error('Unexpected module load') },
  }
  const ctx: Context = await boot('browser-view-composition', configPath, [], (host) => {
    host.loader.internal = modules
    host.provide('launchEnvironment', createLaunchEnvironmentSnapshot([{ source: 'process', values: {} }]))
    host.provide('subprocess', fakeSubprocess() as never)
  })
  cleanups.push(async () => { await ctx.fiber.dispose() })
  const entry = [...ctx.loader.entries()].find(row => row.options.id === 'browser-view')
  return { ctx, entry }
}

describe('browser view over the real Loader', () => {
  it('stays inert without an executable: state is disabled and a watch yields one state then ends', async () => {
    const { ctx } = await bootView({})
    const view = ctx.get('browserViewController')
    if (view === undefined) throw new Error('expected the browserView namespace')
    const signal = new AbortController().signal
    expect(await view.state(signal)).toEqual({ status: 'disabled', tabs: [], viewport: { width: 1280, height: 800 } })
    const watch = view.watch({}, signal)[Symbol.asyncIterator]()
    expect(await watch.next()).toEqual({ done: false, value: { type: 'state', state: { status: 'disabled', tabs: [], viewport: { width: 1280, height: 800 } } } })
    expect(await watch.next()).toEqual({ done: true, value: undefined })
  })

  it('withdraws the namespace when its fiber is disposed', async () => {
    const { ctx, entry } = await bootView({})
    expect(ctx.get('browserViewController')).toBeInstanceOf(BrowserView)
    await entry?.fiber?.dispose()
    expect(ctx.get('browserViewController')).toBeUndefined()
  })
})
