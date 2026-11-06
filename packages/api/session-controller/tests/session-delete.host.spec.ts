/**
 * Session delete through the composed Session Controller. Agents come from a structural
 * factory whose handles unload through the real Agent registry; stored Sessions and
 * writer ownership come from an in-memory persistence double; the Workspace registry
 * is a fake whose activity answers and stop requests are Cordis listeners.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent, AgentHandle, CreateAgentOptions } from '@deepseek-ai/dsh-agent'
import SessionStore, { SESSION_FORMAT_VERSION, SessionId } from '@deepseek-ai/dsh-session'
import type { Session, SessionHeader } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import {
  SessionAlreadyOwnedError,
  SessionPersistenceNotFoundError,
  SessionPersistenceRevision,
} from '@deepseek-ai/dsh-session-persistence'
import { WorkspaceUnknownSessionError } from '@deepseek-ai/dsh-workspace'
import type { SessionActivity } from '@deepseek-ai/dsh-workspace/types'
import { createSessionTestController, createSessionTestRemote } from './test-remote.ts'

/** Stub Agent state: whether its turn runs, and how often it was cancelled, waited on, or disposed. */
interface StubState {
  running: boolean
  cancels: number
  idle: number
  disposed: number
}

/** Stored Sessions, writer ownership, and the order of persistence and event effects. */
class FakePersistence {
  readonly headers = new Map<SessionId, SessionHeader>()
  readonly owned = new Set<SessionId>()
  readonly deleted: SessionId[] = []
  readonly liveAtDelete = new Map<SessionId, boolean>()

  /**
   * @param ctx - Host context whose Agent registry and Cordis events the double consults.
   * @param log - shared effect log for ordering assertions.
   */
  constructor(private readonly ctx: Context, private readonly log: string[]) {}

  list(): Promise<readonly { readonly header: SessionHeader; readonly revision: ReturnType<typeof SessionPersistenceRevision> }[]> {
    return Promise.resolve([...this.headers.values()].map(header => ({
      header,
      revision: SessionPersistenceRevision(`test:${header.id}`),
    })))
  }

  async delete(id: SessionId): Promise<void> {
    if (!this.headers.has(id)) throw new SessionPersistenceNotFoundError(id)
    if (this.owned.has(id)) throw new SessionAlreadyOwnedError(id)
    this.liveAtDelete.set(id, this.ctx.agents.get(id) !== undefined)
    this.headers.delete(id)
    this.deleted.push(id)
    this.log.push(`persisted:${id}`)
    await this.ctx.parallel('session/deleted', { sessionId: id })
  }
}

/** Create a stored-Session header; subagent children carry `origin` and `parentSession`. */
function header(id: SessionId, meta: Pick<SessionHeader, 'origin' | 'parentSession'> = {}): SessionHeader {
  return { version: SESSION_FORMAT_VERSION, id, createdAt: 0, cwd: '/proj', isSeeded: false, ...meta }
}

/** Cancel a stub Agent's turn as the Agent registry does: the turn stops and the state records it. */
function cancelStub(state: StubState): void {
  state.cancels++
  state.running = false
}

/** Stub Agent that delegates cancel and idle to its state; the registry only needs its identity and session. */
function stubAgent(ctx: Context, session: Session, state: StubState): Agent {
  const stub: Pick<Agent, 'id' | 'session' | 'status' | 'ctx' | 'cancel' | 'whenIdle'> = {
    id: session.id,
    session,
    status: 'idle',
    ctx,
    cancel: () => { cancelStub(state) },
    whenIdle: () => {
      state.idle++
      return Promise.resolve()
    },
  }
  return stub as Agent
}

/**
 * Build the Session Controller over a fresh context with stub Agents and fake persistence.
 * @param cwd - directory used for Agent creation.
 * @param deleteStopTimeoutMs - optional deployment timeout for stopping work.
 * @returns the composed fixtures and the Remote face.
 */
async function harness(cwd: string, deleteStopTimeoutMs?: number) {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(AgentRegistry)
  const log: string[] = []
  const persistence = new FakePersistence(ctx, log)
  const archived = new Set<SessionId>()
  const busy = new Set<SessionId>()
  const states = new Map<SessionId, StubState>()
  const unregisters = new Map<SessionId, () => Promise<void> | void>()
  const events: SessionId[] = []
  const workspace = {
    get archivedSessionIds(): readonly SessionId[] {
      return [...archived]
    },
    archiveSession: async (id: SessionId, options?: { readonly stopActivity?: boolean }): Promise<void> => {
      if (!persistence.headers.has(id) && ctx.sessions.get(id) === undefined) {
        throw new WorkspaceUnknownSessionError(id, 'archive')
      }
      archived.add(id)
      if (options?.stopActivity === true) await ctx.parallel('workspace/session-stop', { sessionId: id })
    },
    unarchiveSession: (id: SessionId): Promise<void> => {
      archived.delete(id)
      return Promise.resolve()
    },
  }
  ctx.provide('sessionPersistence', persistence as never)
  ctx.provide('workspaceRegistry', workspace as never)
  ctx.on('workspace/session-activity', async (request, next) => {
    const running = states.get(request.sessionId)?.running === true || busy.has(request.sessionId)
    const own: SessionActivity[] = running ? [{ kind: 'turn' }] : []
    return [...own, ...await next()]
  })
  ctx.on('workspace/session-stop', ({ sessionId }) => {
    const state = states.get(sessionId)
    if (state !== undefined && state.running) cancelStub(state)
  })
  ctx.on('api-session/deleted', (sessionId) => {
    events.push(sessionId)
    log.push(`event:${sessionId}`)
  })
  ctx.agents.setFactory({
    createAgent: async (_ownerCtx: Context, options: CreateAgentOptions): Promise<AgentHandle> => {
      const session = ctx.sessions.create(options.sessionId, options.meta === undefined ? {} : { meta: options.meta })
      persistence.headers.set(session.id, session.header)
      const state: StubState = { running: false, cancels: 0, idle: 0, disposed: 0 }
      states.set(session.id, state)
      const agent = stubAgent(ctx, session, state)
      const unregister = await ctx.agents.register(agent)
      unregisters.set(session.id, unregister)
      return {
        agent,
        dispose: async () => {
          state.disposed++
          await unregister()
        },
      }
    },
    resume: () => Promise.reject(new Error('resume is not used by these tests')),
  })
  const defaults = {
    defaultModelSelection: () => ({ provider: 'p', model: 'm' }),
    cwd,
    ...deleteStopTimeoutMs === undefined ? {} : { deleteStopTimeoutMs },
  }
  return {
    ctx,
    persistence,
    workspace,
    states,
    unregisters,
    busy,
    events,
    log,
    controller: await createSessionTestController(ctx, defaults),
    remote: await createSessionTestRemote(ctx, defaults),
  }
}

type Harness = Awaited<ReturnType<typeof harness>>

/** Create a live Agent through the Remote create path and return its Session identity. */
async function liveRoot(h: Harness, cwd: string): Promise<SessionId> {
  const created = await h.remote.create({ cwd })
  if (!created.ok) throw created.error
  return created.value.sessionId
}

/** Stub state of a live Agent created by this harness. */
function stateOf(h: Harness, id: SessionId): StubState {
  const state = h.states.get(id)
  if (state === undefined) throw new Error(`no stub Agent was created for "${id}"`)
  return state
}

const dirs: string[] = []

/** @returns a fresh directory for Agent creation, removed after the test. */
function tempCwd(): string {
  const dir = mkdtempSync(join(tmpdir(), 'session-delete-'))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('Session delete', () => {
  it('deletes a cold Session: archived, removed from persistence, one event after the persistence dispatch', async () => {
    const h = await harness(tempCwd())
    h.persistence.headers.set(SessionId('cold'), header(SessionId('cold')))

    const response = await h.remote.delete({ sessionId: SessionId('cold') })

    expect(response).toEqual({ ok: true, value: { deletedSessionIds: [SessionId('cold')] } })
    expect(h.workspace.archivedSessionIds).toEqual([SessionId('cold')])
    expect(h.persistence.headers.has(SessionId('cold'))).toBe(false)
    expect(h.events).toEqual([SessionId('cold')])
    expect(h.log).toEqual(['persisted:cold', 'event:cold'])
  })

  it('releases a live idle Agent before its persistence delete', async () => {
    const h = await harness(tempCwd())
    const root = await liveRoot(h, tempCwd())
    expect(h.ctx.agents.get(root)).toBeDefined()

    const response = await h.remote.delete({ sessionId: root })

    expect(response).toMatchObject({ ok: true, value: { deletedSessionIds: [root] } })
    expect(h.persistence.liveAtDelete.get(root)).toBe(false)
    expect(stateOf(h, root).disposed).toBe(1)
    expect(h.ctx.agents.get(root)).toBeUndefined()
  })

  it('stops a running turn, waits for idle, then releases the Agent', async () => {
    const h = await harness(tempCwd())
    const root = await liveRoot(h, tempCwd())
    stateOf(h, root).running = true

    const response = await h.remote.delete({ sessionId: root })

    expect(response).toMatchObject({ ok: true })
    expect(stateOf(h, root).cancels).toBeGreaterThanOrEqual(1)
    expect(stateOf(h, root).idle).toBe(1)
    expect(h.persistence.liveAtDelete.get(root)).toBe(false)
  })

  it('deletes subagent descendants before their parent and leaves an ordinary fork intact', async () => {
    const h = await harness(tempCwd())
    const root = await liveRoot(h, tempCwd())
    h.persistence.headers.set(SessionId('child'), header(SessionId('child'), { origin: 'subagent', parentSession: root }))
    h.persistence.headers.set(SessionId('grandchild'), header(SessionId('grandchild'), {
      origin: 'subagent',
      parentSession: SessionId('child'),
    }))
    h.persistence.headers.set(SessionId('fork'), header(SessionId('fork'), { parentSession: root }))

    const response = await h.remote.delete({ sessionId: root })

    expect(response).toEqual({
      ok: true,
      value: { deletedSessionIds: [SessionId('grandchild'), SessionId('child'), root] },
    })
    expect(h.persistence.headers.has(SessionId('fork'))).toBe(true)
    expect(h.log.filter(entry => entry.startsWith('persisted:'))).toEqual([
      'persisted:grandchild',
      'persisted:child',
      `persisted:${root}`,
    ])
  })

  it('answers session/not-found for an unknown identity before archiving anything', async () => {
    const h = await harness(tempCwd())

    const response = await h.remote.delete({ sessionId: SessionId('nowhere') })

    expect(response).toMatchObject({ ok: false, error: { code: 'session/not-found', details: { sessionId: SessionId('nowhere') } } })
    expect(h.workspace.archivedSessionIds).toEqual([])
  })

  it('keeps the first removal, reports writer-held, and unarchives only the ids it did not remove', async () => {
    const h = await harness(tempCwd())
    h.persistence.headers.set(SessionId('held'), header(SessionId('held')))
    h.persistence.headers.set(SessionId('free'), header(SessionId('free')))
    h.persistence.owned.add(SessionId('held'))

    await expect(h.controller.deleteSessions([SessionId('held'), SessionId('free')])).rejects.toMatchObject({
      code: 'session/writer-held',
      details: { sessionId: SessionId('held'), deletedSessionIds: [SessionId('free')] },
    })

    expect(h.persistence.deleted).toEqual([SessionId('free')])
    expect(h.workspace.archivedSessionIds).not.toContain(SessionId('held'))
    expect(h.persistence.headers.has(SessionId('held'))).toBe(true)
  })

  it('keeps a Session archived that was archived before the request when the deletion is refused', async () => {
    const h = await harness(tempCwd())
    h.persistence.headers.set(SessionId('pre'), header(SessionId('pre')))
    h.persistence.headers.set(SessionId('held'), header(SessionId('held')))
    h.persistence.owned.add(SessionId('held'))
    await h.workspace.archiveSession(SessionId('pre'))

    await expect(h.controller.deleteSessions([SessionId('pre'), SessionId('held')])).rejects.toMatchObject({
      code: 'session/writer-held',
    })

    expect(h.persistence.deleted).toEqual([])
    expect(h.workspace.archivedSessionIds).toEqual([SessionId('pre')])
  })

  it('answers session/active after the configured timeout, unarchives everything, and deletes nothing', async () => {
    const h = await harness(tempCwd(), 1)
    h.persistence.headers.set(SessionId('stuck'), header(SessionId('stuck')))
    h.busy.add(SessionId('stuck'))

    await expect(h.controller.deleteSessions([SessionId('stuck')])).rejects.toMatchObject({
      code: 'session/active',
      details: { sessionId: SessionId('stuck'), activity: [{ kind: 'turn' }] },
    })

    expect(h.workspace.archivedSessionIds).toEqual([])
    expect(h.persistence.deleted).toEqual([])
  })

  it('answers session/agent-busy for a live Agent this controller did not create and rolls the archive back', async () => {
    const h = await harness(tempCwd())
    const alien = SessionId('alien')
    const session = h.ctx.sessions.create(alien)
    h.persistence.headers.set(alien, session.header)
    await h.ctx.agents.register(stubAgent(h.ctx, session, { running: false, cancels: 0, idle: 0, disposed: 0 }))

    await expect(h.controller.deleteSessions([alien])).rejects.toMatchObject({ code: 'session/agent-busy' })

    expect(h.workspace.archivedSessionIds).toEqual([])
    expect(h.persistence.deleted).toEqual([])
  })

  it('drops the tracked handle when its Agent is disposed elsewhere, so a later delete does not dispose it again', async () => {
    const h = await harness(tempCwd())
    const root = await liveRoot(h, tempCwd())
    const unregister = h.unregisters.get(root)
    if (unregister === undefined) throw new Error('the stub Agent was not registered')
    await unregister()
    expect(h.ctx.agents.get(root)).toBeUndefined()

    const response = await h.remote.delete({ sessionId: root })

    expect(response).toMatchObject({ ok: true, value: { deletedSessionIds: [root] } })
    expect(stateOf(h, root).disposed).toBe(0)
  })
})
