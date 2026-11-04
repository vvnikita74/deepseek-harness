/** Jev router Remote: picks the model tier for one prompt and switches the Session's next model step. */
import type { Context, Volatile } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import type { ModelSelection } from '@deepseek-ai/dsh-agent'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { askComplexity } from './jev-client.ts'
import { selectTier, truncateTail } from './policy.ts'
import type { JevRouteRequest, JevRouteResult } from './types.ts'

export type * from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Jev router Remote controller. */
    jevRouterController: JevRouterController
  }
}

/** One model route, easiest tier first. */
export interface Tier {
  /** Registered provider route. */
  readonly provider: string
  /** Provider-owned model id. */
  readonly model: string
  /** Reasoning effort id the adapter validates; omission follows adapter defaults. */
  readonly reasoningEffort?: string
  /** Jev score criterion describing tasks for this tier; defaults to `Tier <index>`. */
  readonly description?: string
}

/** Routing policy and Jev access; every field is read per call. */
export interface Config {
  /** Model routes ordered easiest to hardest; index = tier. Two or more enable routing. */
  tiers: Volatile<Tier[]>
  /** Credential reference holding the Jev API key. */
  apiKeyEnv: Volatile<string>
  /** Jev decisions endpoint. */
  endpoint: Volatile<string>
  /** Jev model id. */
  model: Volatile<string>
  /** Confidence below which the answer escalates one tier. */
  minConfidence: Volatile<number>
  /** Upper bound on one Jev call. */
  timeoutMs: Volatile<number>
  /** Maximum prompt code points sent to Jev; the tail is kept. */
  maxChars: Volatile<number>
}

/** Routes prompts before submission; Jev failures keep the current model. */
export default class JevRouterController extends TypertRemoteService {
  static inject = ['llm', 'sessionController', 'typert']
  static Config = z.object({
    tiers: z.array(z.object({
      provider: z.string().required(),
      model: z.string().required(),
      reasoningEffort: z.string(),
      description: z.string(),
    })).default([]).volatile(),
    apiKeyEnv: z.string().role('credential-ref').default('TIMEWEB_AI_API_KEY').volatile(),
    endpoint: z.string().default('https://api.timeweb.ai/v1/systemone').volatile(),
    model: z.string().default('jev-latest').volatile(),
    minConfidence: z.number().min(0).max(1).default(0.6).volatile(),
    timeoutMs: z.number().step(1).min(1).default(3000).volatile(),
    maxChars: z.number().step(1).min(1).default(8000).volatile(),
  })

  constructor(ctx: Context, private readonly config: Config) {
    super(ctx, 'jevRouterController', { namespace: 'jevRouter' })
  }

  /**
   * Choose the model tier for one prompt and switch the Session's next model step to it.
   * @param request - Session identity and prompt text about to be submitted.
   * @param signal - Client cancellation or Remote contribution disposal.
   * @returns the routing outcome; Jev failures report `jev-unavailable` instead of throwing.
   */
  @Remote('route')
  async route(request: JevRouteRequest, signal: AbortSignal): Promise<JevRouteResult> {
    const tiers = this.config.tiers.get()
    const apiKey = await this.resolveApiKey()
    if (tiers.length < 2 || apiKey === undefined) return { routed: false, reason: 'disabled' }

    const found = await this.ctx.sessionController.resolveAgent(request.sessionId)
    if ('error' in found) throw found.error
    const { agent } = found

    let tier: number
    try {
      const answer = await askComplexity({
        endpoint: this.config.endpoint.get(),
        model: this.config.model.get(),
        apiKey,
        text: truncateTail(request.text, this.config.maxChars.get()),
        levels: tiers.map((tier, index) => tier.description ?? `Tier ${index}`),
        timeoutMs: this.config.timeoutMs.get(),
      }, signal)
      tier = selectTier(answer, this.config.minConfidence.get())
    } catch (_jevFailed) {
      signal.throwIfAborted()
      return { routed: false, reason: 'jev-unavailable' }
    }

    const target = tiers[tier]
    if (target === undefined) throw new RangeError(`Jev selected tier ${tier} outside ${tiers.length} tiers`)
    const selected: ModelSelection = {
      provider: target.provider,
      model: target.model,
      ...target.reasoningEffort === undefined ? {} : { reasoningEffort: ReasoningEffortId(target.reasoningEffort) },
    }
    const current = agent.model.current()
    if (current?.provider === selected.provider && current.model === selected.model
      && current.reasoningEffort === selected.reasoningEffort) {
      return { routed: false, tier, reason: 'unchanged' }
    }
    await this.ctx.llm.resolveCallConfig(selected, signal)
    agent.model.select(selected)
    return { routed: true, tier, selected }
  }

  /**
   * Read the Jev credential for one call. A mounted credentials service is authoritative; otherwise the launch environment supplies it.
   * @returns the key, or undefined when none is configured.
   */
  private async resolveApiKey(): Promise<string | undefined> {
    const ref = credentialRef(this.config.apiKeyEnv.get())
    const credentials = this.ctx.get('credentials')
    if (credentials !== undefined) return (await credentials.resolve(ref))?.value
    const ambient = launchEnvironmentOf(this.ctx).get(ref)
    return ambient === undefined || ambient.value.length === 0 ? undefined : ambient.value
  }
}
