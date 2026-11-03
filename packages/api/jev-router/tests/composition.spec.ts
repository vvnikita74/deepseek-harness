/**
 * Real Loader composition: the router boots from a `cordis.yml` row, while the model service, the Session Agent, the
 * launch environment, and the network are stubbed. Only the Session Agent's model selection runs the real code path.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { ModuleLoaderV2 } from '@deepseek-ai/cordis-plugin-loader'
import { boot } from '@deepseek-ai/dsh-app-boot'
import { AgentModel, type ModelSelectionProjectionState } from '@deepseek-ai/dsh-agent'
import type { Session, SessionId } from '@deepseek-ai/dsh-session'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import { createLaunchEnvironmentSnapshot } from '@deepseek-ai/dsh-launch-environment'
import type { SessionController } from '@deepseek-ai/dsh-api-session-controller'
import JevRouter from '../src/index.ts'

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  vi.unstubAllGlobals()
})

/** A Session-owned model selection whose projection state follows the appended `model/selection` events. */
function sessionModel(initial: { provider: string; model: string }) {
  const appended: Array<{ type: string; data: unknown }> = []
  let state: ModelSelectionProjectionState = { lastUsed: null, pending: null }
  const session = {
    append: (type: string, data: unknown) => {
      appended.push({ type, data })
      if (type === 'model/selection') state = { ...state, pending: data as ModelSelectionProjectionState['pending'] }
    },
  } as Pick<Session, 'append'> as Session
  const model = new AgentModel(() => state, session, initial)
  return { agent: { model, session }, appended }
}

/**
 * Boot the router beside stub services from a real `cordis.yml`.
 * @param tiers - tiers config written to the router row.
 * @param fetchResponse - the Jev response body, or an error to throw.
 * @param sessionModelState - the Agent model's starting route.
 * @param environment - launch-environment variables.
 * @returns the booted root context, the Agent under test, and the Jev request log.
 */
async function bootRouter(
  tiers: unknown[],
  fetchResponse: Response | Error,
  sessionModelState = { provider: 'p-easy', model: 'easy' },
  environment: Record<string, string> = { OPENROUTER_API_KEY: 'jev-key' },
) {
  const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => {
    if (fetchResponse instanceof Error) throw fetchResponse
    return fetchResponse.clone()
  })
  vi.stubGlobal('fetch', fetchMock)
  const root = await mkdtemp(join(tmpdir(), 'dsh-jev-router-composition-'))
  cleanups.push(async () => { await rm(root, { recursive: true, force: true }) })
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = root
  cleanups.push(async () => {
    if (previousHome === undefined) Reflect.deleteProperty(process.env, 'DSH_HOME')
    else process.env.DSH_HOME = previousHome
  })
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, JSON.stringify([
    { id: 'typert', name: '@deepseek-ai/dsh-typert-registry' },
    { id: 'jev-router', name: '@deepseek-ai/dsh-api-jev-router', config: { tiers } },
  ]))
  const agent = sessionModel(sessionModelState)
  const resolveCallConfig = vi.fn(async (selection: unknown) => selection)
  const modules: ModuleLoaderV2 = {
    version: 'v2', loadCache: new Map(),
    async import(specifier) {
      if (specifier === '@deepseek-ai/dsh-api-jev-router') return { default: JevRouter }
      if (specifier === '@deepseek-ai/dsh-typert-registry') return TypertRegistry
      throw new Error(`Unexpected fixture module ${specifier}`)
    },
    register(): never { throw new Error('Unexpected module hook registration') },
    getOrCreateModuleJob(): never { throw new Error('Unexpected module job creation') },
    resolveSync(): never { throw new Error('Unexpected synchronous module resolution') },
    load(): never { throw new Error('Unexpected module load') },
  }
  const ctx: Context = await boot('jev-router-composition', configPath, [], (host) => {
    host.loader.internal = modules
    host.provide('launchEnvironment', createLaunchEnvironmentSnapshot([{ source: 'process', values: environment }]))
    host.provide('llm', { resolveCallConfig } as Pick<LlmRuntime, 'resolveCallConfig'> as LlmRuntime)
    host.provide('sessionController', {
      resolveAgent: async (sessionId: string) => sessionId === 'known' ? { agent: agent.agent } : { error: new Error('not found') },
    } as Pick<SessionController, 'resolveAgent'> as SessionController)
  })
  cleanups.push(async () => { await ctx.fiber.dispose() })
  const router = (): JevRouter => {
    const service = ctx.get('jevRouterController')
    if (service === undefined) throw new Error('expected the jevRouter namespace')
    return service
  }
  return { ctx, router, agent, fetchMock, resolveCallConfig }
}

const tiers = [
  { provider: 'p-easy', model: 'easy' },
  { provider: 'p-hard', model: 'hard', reasoningEffort: 'high' },
]

/** Jev response scoring the two tiers. */
function jevAnswer(probabilities: Record<string, number>, confidence = 0.9): Response {
  return Response.json({ model: 'typesafe/jev-1.14', answers: { complexity: { type: 'score', score: 1, confidence, legend: {}, probabilities } }, usage: { input_tokens: 1, output_tokens: 1 } })
}

describe('jev-router over the real Loader', () => {
  it('switches the Session to the Jev-selected tier and records the selection', async () => {
    const { router, agent, fetchMock, resolveCallConfig } = await bootRouter(tiers, jevAnswer({ '0': 0.1, '1': 0.9 }))
    const result = await router().route({ sessionId: 'known' as SessionId, text: 'refactor the scheduler' }, new AbortController().signal)
    expect(result).toEqual({ routed: true, tier: 1, selected: { provider: 'p-hard', model: 'hard', reasoningEffort: 'high' } })
    expect(agent.agent.model.current()).toEqual({ provider: 'p-hard', model: 'hard', reasoningEffort: 'high' })
    expect(agent.appended).toEqual([{ type: 'model/selection', data: { provider: 'p-hard', model: 'hard', reasoningEffort: 'high' } }])
    expect(resolveCallConfig).toHaveBeenCalledWith({ provider: 'p-hard', model: 'hard', reasoningEffort: 'high' }, expect.any(AbortSignal))
    expect(fetchMock).toHaveBeenCalledWith('https://openrouter.ai/api/alpha/decisions', expect.objectContaining({ method: 'POST' }))
  })

  it('reports unchanged when the Session already uses the selected route', async () => {
    const { router, agent } = await bootRouter(tiers, jevAnswer({ '0': 0.9, '1': 0.1 }))
    const result = await router().route({ sessionId: 'known' as SessionId, text: 'hi' }, new AbortController().signal)
    expect(result).toEqual({ routed: false, tier: 0, reason: 'unchanged' })
    expect(agent.appended).toEqual([])
  })

  it('keeps the current model when Jev fails', async () => {
    const { router, agent } = await bootRouter(tiers, new Error('socket hang up'))
    const result = await router().route({ sessionId: 'known' as SessionId, text: 'hi' }, new AbortController().signal)
    expect(result).toEqual({ routed: false, reason: 'jev-unavailable' })
    expect(agent.agent.model.current()).toEqual({ provider: 'p-easy', model: 'easy' })
  })

  it('stays inert without a credential or with fewer than two tiers, without calling Jev or the Session', async () => {
    const noKey = await bootRouter(tiers, jevAnswer({ '0': 1, '1': 0 }), undefined, {})
    expect(await noKey.router().route({ sessionId: 'known' as SessionId, text: 'hi' }, new AbortController().signal)).toEqual({ routed: false, reason: 'disabled' })
    const oneTier = await bootRouter([tiers[0]], jevAnswer({ '0': 1, '1': 0 }))
    expect(await oneTier.router().route({ sessionId: 'known' as SessionId, text: 'hi' }, new AbortController().signal)).toEqual({ routed: false, reason: 'disabled' })
    expect(noKey.fetchMock).not.toHaveBeenCalled()
    expect(oneTier.fetchMock).not.toHaveBeenCalled()
  })

  it('rejects an unknown Session with the Session error', async () => {
    const { router } = await bootRouter(tiers, jevAnswer({ '0': 0.1, '1': 0.9 }))
    await expect(router().route({ sessionId: 'missing' as SessionId, text: 'hi' }, new AbortController().signal)).rejects.toThrow('not found')
  })

  it('withdraws the namespace when its fiber is disposed', async () => {
    const { ctx, router } = await bootRouter(tiers, jevAnswer({ '0': 0.1, '1': 0.9 }))
    expect(router()).toBeInstanceOf(JevRouter)
    const entry = [...ctx.loader.entries()].find(row => row.options.id === 'jev-router')
    await entry?.fiber?.dispose()
    expect(ctx.get('jevRouterController')).toBeUndefined()
  })
})
