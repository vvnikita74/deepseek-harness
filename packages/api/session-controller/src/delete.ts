/** Irreversible Session deletion: archive the closure, stop its work, unload its live Agents, then remove stored logs. */

import type { Context } from '@deepseek-ai/cordis'
import type { SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type {} from '@deepseek-ai/dsh-workspace'
import { WorkspaceUnknownSessionError } from '@deepseek-ai/dsh-workspace'
import { errorChain } from '@deepseek-ai/dsh-llm'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import type { ApiSessionAgentController } from './agent.ts'

// shortcut: polls the activity waterfall because the Workspace registry emits no activity-completion event; upgrade when it does.
const ACTIVITY_POLL_MS = 100

/** Archive order, deletion order, and the requested roots whose Agents are released directly. */
interface DeletionPlan {
  /** Requested Sessions first, then their subagent descendants in discovery order. */
  readonly archiveOrder: readonly SessionId[]
  /** Children before their parents. */
  readonly deletionOrder: readonly SessionId[]
  /** Requested Sessions that are not subagent children of another Session in the plan. */
  readonly roots: readonly SessionId[]
}

/**
 * Render identities for an error message.
 * @param ids - identities to list.
 * @returns comma-separated identities, or `none` when the list is empty.
 */
function listOf(ids: readonly SessionId[]): string {
  return ids.length === 0 ? 'none' : ids.join(', ')
}

/**
 * Whether a persistence failure reports that the stored Session is already absent.
 * @param error - failure thrown by `SessionPersistence.delete`.
 * @returns true for `SessionPersistenceNotFoundError`.
 */
function isAbsent(error: unknown): boolean {
  return error instanceof Error && error.name === 'SessionPersistenceNotFoundError'
}

/**
 * Whether a persistence failure reports that another owner holds the Session writer.
 * @param error - failure thrown by `SessionPersistence.delete`.
 * @returns true for `SessionAlreadyOwnedError`.
 */
function isOwned(error: unknown): boolean {
  return error instanceof Error && error.name === 'SessionAlreadyOwnedError'
}

/** Deletes Sessions with their subagent descendants; whole calls run one at a time. */
export class ApiSessionDeletion {
  private queue: Promise<void> = Promise.resolve()

  /**
   * @param ctx - Host context carrying the Workspace registry, Session persistence, and activity waterfall.
   * @param agents - owner of live Agent release.
   * @param stopTimeoutMs - milliseconds each Session may keep stopping work before the deletion fails.
   */
  constructor(
    private readonly ctx: Context,
    private readonly agents: ApiSessionAgentController,
    private readonly stopTimeoutMs: number,
  ) {}

  /**
   * Delete the named Sessions and their subagent descendants. A failure before the
   * irreversible removal leaves the Sessions unchanged; Sessions already removed stay removed.
   * @param sessionIds - Session identities to delete.
   * @param signal - cancellation observed before each wait and before each removal.
   * @returns the identities actually removed, in deletion order.
   * @throws RemoteError `session/not-found` when a named Session is not stored.
   * @throws RemoteError `session/active` when a Session keeps stopping work past the timeout.
   * @throws RemoteError `session/agent-busy` when a live Agent cannot be unloaded by its parent.
   * @throws RemoteError `session/writer-held` when another owner holds a Session writer.
   * @throws RemoteError `gateway/cancelled` when the signal aborts, or `gateway/internal` for other failures.
   */
  deleteSessions(sessionIds: readonly SessionId[], signal?: AbortSignal): Promise<readonly SessionId[]> {
    const result = this.queue.then(() => this.run(sessionIds, signal))
    this.queue = result.then(() => undefined, () => undefined)
    return result
  }

  private async run(sessionIds: readonly SessionId[], signal: AbortSignal | undefined): Promise<readonly SessionId[]> {
    const persistence = this.ctx.get('sessionPersistence')
    if (persistence === undefined) {
      throw new RemoteError(
        'gateway/internal',
        'session deletion is unavailable: this deployment mounts no session-persistence service',
        {},
      )
    }
    const newlyArchived: SessionId[] = []
    const deleted: SessionId[] = []
    try {
      const snapshots = await persistence.list(signal === undefined ? undefined : { signal })
      const plan = planDeletion(snapshots.map(snapshot => snapshot.header), sessionIds)
      const alreadyArchived = new Set(this.ctx.workspaceRegistry.archivedSessionIds)
      for (const id of plan.archiveOrder) {
        const wasArchived = alreadyArchived.has(id)
        await this.archive(id)
        if (!wasArchived) newlyArchived.push(id)
      }
      for (const id of plan.archiveOrder) await this.awaitIdle(id, signal)
      for (const id of plan.roots) await this.agents.release(id)
      for (const id of plan.archiveOrder) {
        if (this.ctx.agents.get(id) !== undefined) {
          throw new RemoteError('session/agent-busy', `session "${id}" still has a live Agent`, {
            reason: 'a subagent child is unloaded only with its parent Session',
          })
        }
      }
      for (const id of plan.deletionOrder) {
        try {
          await persistence.delete(id, signal === undefined ? undefined : { signal })
          deleted.push(id)
        } catch (error: unknown) {
          if (isAbsent(error)) continue
          if (isOwned(error)) {
            throw new RemoteError(
              'session/writer-held',
              `session "${id}" is written by another owner; sessions deleted before it: ${listOf(deleted)}`,
              { sessionId: id, deletedSessionIds: [...deleted] },
            )
          }
          throw error
        }
      }
      return deleted
    } catch (error: unknown) {
      await this.rollback(newlyArchived.filter(id => !deleted.includes(id)))
      throw failureOf(error, signal)
    }
  }

  private async archive(id: SessionId): Promise<void> {
    try {
      await this.ctx.workspaceRegistry.archiveSession(id, { stopActivity: true })
    } catch (error: unknown) {
      if (error instanceof WorkspaceUnknownSessionError) {
        throw new RemoteError('session/not-found', error.message, { sessionId: id })
      }
      throw error
    }
  }

  private async awaitIdle(sessionId: SessionId, signal: AbortSignal | undefined): Promise<void> {
    const started = Date.now()
    for (;;) {
      signal?.throwIfAborted()
      const activity = await this.ctx.waterfall('workspace/session-activity', { sessionId }, () => Promise.resolve([]))
      if (activity.length === 0) return
      if (Date.now() - started >= this.stopTimeoutMs) {
        throw new RemoteError('session/active', `session "${sessionId}" still has active work after ${String(this.stopTimeoutMs)} ms`, {
          sessionId,
          activity,
        })
      }
      await new Promise(resolve => setTimeout(resolve, ACTIVITY_POLL_MS))
    }
  }

  /** Best-effort unarchive; a failed unarchive is logged so the original failure stays the thrown error. */
  private async rollback(ids: readonly SessionId[]): Promise<void> {
    for (const id of ids) {
      try {
        await this.ctx.workspaceRegistry.unarchiveSession(id)
      } catch (error: unknown) {
        this.ctx.logger.warn(`session-controller: could not unarchive "${id}" after a failed deletion: ${errorChain(error)}`)
      }
    }
  }
}

/**
 * Compute the closure of the requested Sessions over stored subagent children.
 * @param headers - headers of every stored Session.
 * @param sessionIds - requested Session identities.
 * @returns archive order, deletion order, and release roots.
 * @throws RemoteError `session/not-found` when a requested identity is not stored; nothing has changed yet.
 */
function planDeletion(headers: readonly SessionHeader[], sessionIds: readonly SessionId[]): DeletionPlan {
  const byId = new Map(headers.map(header => [header.id, header]))
  for (const id of sessionIds) {
    if (!byId.has(id)) throw new RemoteError('session/not-found', `session "${id}" not found`, { sessionId: id })
  }
  const requested = [...new Set(sessionIds)]
  const archiveOrder = [...requested]
  const members = new Set(archiveOrder)
  for (let grew = true; grew;) {
    grew = false
    for (const header of byId.values()) {
      const parent = subagentParent(header)
      if (!members.has(header.id) && parent !== undefined && members.has(parent)) {
        members.add(header.id)
        archiveOrder.push(header.id)
        grew = true
      }
    }
  }
  const depth = (id: SessionId): number => {
    let count = 0
    let parent = subagentParent(byId.get(id))
    while (parent !== undefined && members.has(parent) && count <= members.size) {
      count++
      parent = subagentParent(byId.get(parent))
    }
    return count
  }
  return {
    archiveOrder,
    deletionOrder: [...archiveOrder].reverse().sort((left, right) => depth(right) - depth(left)),
    roots: requested.filter(id => depth(id) === 0),
  }
}

/**
 * The parent Session of a subagent child.
 * @param header - stored Session header, or undefined for an unknown identity.
 * @returns the direct creator when the header is a subagent child, otherwise undefined.
 */
function subagentParent(header: Pick<SessionHeader, 'origin' | 'parentSession'> | undefined): SessionId | undefined {
  return header?.origin === 'subagent' ? header.parentSession : undefined
}

/**
 * Map a deletion failure to a Remote failure, keeping an existing Remote failure unchanged.
 * @param error - failure from any deletion step.
 * @param signal - the caller's cancellation signal.
 * @returns the error to throw: the Remote failure itself, or a `RemoteError` wrapping `error`.
 */
function failureOf(error: unknown, signal: AbortSignal | undefined): Error {
  if (error instanceof RemoteError) return error
  if (signal?.aborted === true) return new RemoteError('gateway/cancelled', 'session deletion was aborted', {}, { cause: error })
  return new RemoteError('gateway/internal', `session deletion failed: ${errorChain(error)}`, {}, { cause: error })
}
