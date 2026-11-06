import { existsSync, lstatSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import type { RmOptions } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import type { Workspace } from '@deepseek-ai/dsh-workspace'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
import type WorkspaceController from '../src/index.ts'
import { disposeHarnesses, harness } from './helpers/workspace-harness.ts'

declare module '@deepseek-ai/dsh-workspace/types' {
  interface SessionActivityKindMap {
    probe: true
  }
}

/** Paths passed to `rm` by the code under test, in call order. */
const removals = vi.hoisted((): string[] => [])

// Records every removal and refuses any path outside the temporary root, so a
// protection regression cannot delete a real directory.
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  const { realpathSync: resolveReal } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { sep } = await import('node:path')
  const scratch = resolveReal.native(tmpdir()) + sep
  return {
    ...actual,
    rm: async (path: string, options?: RmOptions) => {
      removals.push(path)
      if (!path.startsWith(scratch)) throw new Error(`test guard: refused to remove "${path}" outside ${scratch}`)
      return actual.rm(path, options)
    },
  }
})

/** A stored Session as the fake persistence lists it. */
interface StoredSession {
  readonly id: SessionId
  readonly cwd?: string
}

/**
 * Fake Session services over a mutable stored listing. `deleteSessions` removes
 * the identities it receives from that listing.
 * @param stored - mutable stored Sessions, shared with the test.
 * @param onDelete - observer called before each deletion, while the directory still exists.
 * @returns the fake controller and persistence services, plus the recorded deletion spy.
 */
function sessionFakes(stored: StoredSession[], onDelete?: () => void) {
  const deleteSessions = vi.fn((ids: readonly SessionId[]) => {
    onDelete?.()
    for (const id of ids) {
      const index = stored.findIndex(session => session.id === id)
      if (index !== -1) stored.splice(index, 1)
    }
    return Promise.resolve(ids)
  })
  const sessionPersistence = {
    list: vi.fn(() => Promise.resolve(stored.map(session => ({ header: { id: session.id, cwd: session.cwd } })))),
  }
  return { deleteSessions, sessionController: { deleteSessions }, sessionPersistence }
}

/**
 * Build a harness whose Session services are the fakes above.
 * @param stored - mutable stored Sessions.
 * @param onDelete - observer for the deletion call.
 * @returns the harness plus the deletion spy and the stored listing.
 */
async function setup(stored: StoredSession[] = [], onDelete?: () => void) {
  const fakes = sessionFakes(stored, onDelete)
  const env = await harness({
    sessionController: fakes.sessionController,
    sessionPersistence: fakes.sessionPersistence,
  })
  return { ...env, deleteSessions: fakes.deleteSessions, stored }
}

/**
 * Create a directory, with parents, below `base`.
 * @param base - existing parent directory.
 * @param segments - child path segments.
 * @returns the created absolute path.
 */
function dirAt(base: string, ...segments: string[]): string {
  const path = join(base, ...segments)
  mkdirSync(path, { recursive: true })
  return path
}

/**
 * Register a directory as a Workspace through the public create command.
 * @param controller - Workspace controller under test.
 * @param path - directory to register.
 * @returns the registered Workspace identity.
 */
async function register(controller: WorkspaceController, path: string): Promise<WorkspaceId> {
  return (await controller.create({ path })).workspace.workspaceId
}

/**
 * Look up a registered Workspace, failing the test when it is missing.
 * @param ctx - harness Context holding the registry.
 * @param id - Workspace identity.
 * @returns the registered Workspace.
 */
function workspaceOf(ctx: Context, id: WorkspaceId): Workspace {
  const workspace = ctx.workspaceRegistry.get(id)
  if (workspace === undefined) throw new Error(`fixture Workspace ${id} is missing`)
  return workspace
}

/**
 * Destroy a Workspace, confirming with its current registered title.
 * @param controller - Workspace controller under test.
 * @param ctx - harness Context holding the registry.
 * @param id - Workspace identity.
 * @returns the destroy command result.
 */
function destroyOf(controller: WorkspaceController, ctx: Context, id: WorkspaceId) {
  const confirmTitle = workspaceOf(ctx, id).title
  return controller.destroy({ workspaceId: id, confirmTitle }, new AbortController().signal)
}

beforeEach(() => {
  removals.length = 0
})

afterEach(disposeHarnesses)

describe('WorkspaceController destroy', () => {
  it('reports unknown ids and refuses any title that differs from the Workspace title', async () => {
    const { controller, ctx, root, deleteSessions } = await setup()
    const dir = dirAt(root, 'alpha')
    const id = await register(controller, dir)
    await expect(controller.destroy({ workspaceId: 'missing' as WorkspaceId, confirmTitle: 'alpha' }, new AbortController().signal))
      .rejects.toMatchObject({ code: 'workspace/not-found' })
    for (const confirmTitle of ['Alpha', ' alpha', 'alpha ', 'alph', '']) {
      await expect(controller.destroy({ workspaceId: id, confirmTitle }, new AbortController().signal))
        .rejects.toMatchObject({ code: 'workspace/confirm-mismatch' })
    }
    expect(existsSync(dir)).toBe(true)
    expect(ctx.workspaceRegistry.get(id)).toBeDefined()
    expect(deleteSessions).not.toHaveBeenCalled()
    expect(removals).toEqual([])
  })

  for (const shallow of ['/usr', '/usr/lib']) {
    it.skipIf(!existsSync(shallow))(`refuses the shallow directory ${shallow} and touches nothing`, async () => {
      const { controller, ctx, deleteSessions } = await setup()
      const path = realpathSync.native(shallow)
      const id = await register(controller, path)
      await expect(destroyOf(controller, ctx, id))
        .rejects.toMatchObject({ code: 'workspace/path-protected', details: { path } })
      expect(existsSync(path)).toBe(true)
      expect(ctx.workspaceRegistry.get(id)).toBeDefined()
      expect(deleteSessions).not.toHaveBeenCalled()
      expect(removals).toEqual([])
    })
  }

  it('refuses the server user home directory', async () => {
    const { controller, ctx, deleteSessions } = await setup()
    const home = realpathSync.native(homedir())
    const id = await register(controller, home)
    await expect(destroyOf(controller, ctx, id))
      .rejects.toMatchObject({ code: 'workspace/path-protected', details: { path: home } })
    expect(existsSync(home)).toBe(true)
    expect(ctx.workspaceRegistry.get(id)).toBeDefined()
    expect(deleteSessions).not.toHaveBeenCalled()
    expect(removals).toEqual([])
  })

  it('refuses the harness home directory', async () => {
    const { controller, ctx, root, deleteSessions } = await setup()
    const home = dirAt(root, 'dsh-home')
    const previous = process.env.DSH_HOME
    process.env.DSH_HOME = home
    try {
      const id = await register(controller, home)
      await expect(destroyOf(controller, ctx, id))
        .rejects.toMatchObject({ code: 'workspace/path-protected', details: { path: home } })
      expect(resolveDshHome()).toBe(home)
      expect(existsSync(home)).toBe(true)
      expect(ctx.workspaceRegistry.get(id)).toBeDefined()
      expect(deleteSessions).not.toHaveBeenCalled()
      expect(removals).toEqual([])
    } finally {
      if (previous === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previous
    }
  })

  it('refuses the Host working directory', async () => {
    const { controller, ctx, deleteSessions } = await setup()
    const cwd = realpathSync.native(process.cwd())
    const id = await register(controller, cwd)
    await expect(destroyOf(controller, ctx, id))
      .rejects.toMatchObject({ code: 'workspace/path-protected', details: { path: cwd } })
    expect(existsSync(cwd)).toBe(true)
    expect(ctx.workspaceRegistry.get(id)).toBeDefined()
    expect(deleteSessions).not.toHaveBeenCalled()
    expect(removals).toEqual([])
  })

  it('refuses a directory that contains another registered Workspace', async () => {
    const { controller, ctx, root, deleteSessions } = await setup()
    const outer = dirAt(root, 'outer')
    const inner = dirAt(outer, 'inner')
    const outerId = await register(controller, outer)
    const innerId = await register(controller, inner)
    await expect(destroyOf(controller, ctx, outerId))
      .rejects.toMatchObject({ code: 'workspace/path-protected', details: { path: outer } })
    expect(existsSync(inner)).toBe(true)
    expect(ctx.workspaceRegistry.get(outerId)).toBeDefined()
    expect(ctx.workspaceRegistry.get(innerId)).toBeDefined()
    expect(deleteSessions).not.toHaveBeenCalled()
    expect(removals).toEqual([])
  })

  it('removes the directory tree, its registration, and exactly the Sessions it owns', async () => {
    const stored: StoredSession[] = []
    let dir = ''
    let existedAtDelete: boolean | undefined
    const { controller, ctx, root, deleteSessions } = await setup(stored, () => {
      existedAtDelete = existsSync(dir)
    })
    dir = dirAt(root, 'alpha')
    const nested = dirAt(dir, 'nested', 'subdir')
    const beta = dirAt(root, 'beta')
    writeFileSync(join(dir, 'a.txt'), 'a')
    writeFileSync(join(nested, 'b.txt'), 'b')
    const id = await register(controller, dir)
    await register(controller, beta)
    for (const sessionId of ['accounted', 'ghost']) {
      ctx.sessions.create(SessionId(sessionId), { meta: { cwd: dir } })
      await workspaceOf(ctx, id).attachSession(SessionId(sessionId))
    }
    stored.push(
      { id: SessionId('accounted'), cwd: dir },
      { id: SessionId('root-level'), cwd: dir },
      { id: SessionId('nested'), cwd: nested },
      { id: SessionId('elsewhere'), cwd: beta },
    )

    await expect(controller.destroy({ workspaceId: id, confirmTitle: 'alpha' }, new AbortController().signal))
      .resolves.toEqual({ deleted: true, removedSessions: 3, deferredSessions: 0, removedFiles: true })
    expect(deleteSessions).toHaveBeenCalledTimes(1)
    const requested = deleteSessions.mock.calls[0]?.[0] ?? []
    expect([...requested].sort())
      .toEqual([SessionId('accounted'), SessionId('nested'), SessionId('root-level')])
    expect(existedAtDelete).toBe(true)
    expect(existsSync(dir)).toBe(false)
    expect(removals).toEqual([dir])
    expect(ctx.workspaceRegistry.get(id)).toBeUndefined()
    expect(ctx.workspaceRegistry.list().map(workspace => workspace.path)).toEqual([beta])
    expect(stored.map(session => session.id)).toEqual([SessionId('elsewhere')])
  })

  it('succeeds without calling deleteSessions when the Workspace owns no Session', async () => {
    const { controller, ctx, root, deleteSessions } = await setup()
    const dir = dirAt(root, 'empty')
    const id = await register(controller, dir)
    await expect(destroyOf(controller, ctx, id))
      .resolves.toEqual({ deleted: true, removedSessions: 0, deferredSessions: 0, removedFiles: true })
    expect(deleteSessions).not.toHaveBeenCalled()
    expect(existsSync(dir)).toBe(false)
    expect(ctx.workspaceRegistry.get(id)).toBeUndefined()
  })

  it('removes only the link when the Workspace path is a symlink, keeping the target and its Sessions', async () => {
    const stored: StoredSession[] = []
    const { controller, ctx, root, deleteSessions } = await setup(stored)
    const linkPath = dirAt(root, 'linked')
    const id = await register(controller, linkPath)
    const target = dirAt(root, 'target')
    const sub = dirAt(target, 'sub')
    writeFileSync(join(target, 'keep.txt'), 'keep')
    rmSync(linkPath, { recursive: true })
    symlinkSync(target, linkPath)
    stored.push({ id: SessionId('in-target'), cwd: sub })

    await expect(destroyOf(controller, ctx, id))
      .resolves.toEqual({ deleted: true, removedSessions: 1, deferredSessions: 0, removedFiles: true })
    expect(deleteSessions).toHaveBeenCalledWith([SessionId('in-target')], expect.anything())
    expect(lstatSync(linkPath, { throwIfNoEntry: false })).toBeUndefined()
    expect(existsSync(join(target, 'keep.txt'))).toBe(true)
    expect(removals).toEqual([linkPath])
    expect(ctx.workspaceRegistry.get(id)).toBeUndefined()
  })

  it('removes the registration without file removal when the directory is already gone', async () => {
    const { controller, ctx, root, deleteSessions } = await setup()
    const dir = dirAt(root, 'gone')
    const id = await register(controller, dir)
    rmSync(dir, { recursive: true })
    await expect(destroyOf(controller, ctx, id))
      .resolves.toEqual({ deleted: true, removedSessions: 0, deferredSessions: 0, removedFiles: false })
    expect(deleteSessions).not.toHaveBeenCalled()
    expect(removals).toEqual([])
    expect(ctx.workspaceRegistry.get(id)).toBeUndefined()
  })

  it('maps an active Session to workspace/session-active and changes nothing', async () => {
    const stored: StoredSession[] = []
    const { controller, ctx, root, deleteSessions } = await setup(stored)
    const dir = dirAt(root, 'busy-dir')
    stored.push({ id: SessionId('busy'), cwd: dir })
    const id = await register(controller, dir)
    const activity = [{ kind: 'probe' as const }]
    deleteSessions.mockRejectedValueOnce(new RemoteError(
      'session/active',
      'still active',
      { sessionId: SessionId('busy'), activity },
    ))
    await expect(destroyOf(controller, ctx, id)).rejects.toMatchObject({
      code: 'workspace/session-active',
      details: { sessionId: SessionId('busy'), activity },
    })
    expect(existsSync(dir)).toBe(true)
    expect(ctx.workspaceRegistry.get(id)).toBeDefined()
    expect(removals).toEqual([])
    expect(stored.map(session => session.id)).toEqual([SessionId('busy')])
  })

  it('reports Sessions a writer-held deletion already removed, leaving files and registration', async () => {
    const stored: StoredSession[] = []
    const { controller, ctx, root, deleteSessions } = await setup(stored)
    const dir = dirAt(root, 'held')
    stored.push({ id: SessionId('busy'), cwd: dir })
    const id = await register(controller, dir)
    deleteSessions.mockRejectedValueOnce(new RemoteError(
      'session/writer-held',
      'writer held',
      { sessionId: SessionId('busy'), deletedSessionIds: [SessionId('first')] },
    ))
    await expect(destroyOf(controller, ctx, id)).rejects.toMatchObject({
      code: 'workspace/destroy-failed',
      details: { removedFiles: false, removedSessions: 1 },
    })
    expect(existsSync(dir)).toBe(true)
    expect(ctx.workspaceRegistry.get(id)).toBeDefined()
    expect(removals).toEqual([])
  })

  it('maps any other Session deletion failure to workspace/destroy-failed with nothing removed', async () => {
    const stored: StoredSession[] = []
    const { controller, ctx, root, deleteSessions } = await setup(stored)
    const dir = dirAt(root, 'offline')
    stored.push({ id: SessionId('busy'), cwd: dir })
    const id = await register(controller, dir)
    deleteSessions.mockRejectedValueOnce(new Error('storage offline'))
    await expect(destroyOf(controller, ctx, id)).rejects.toMatchObject({
      code: 'workspace/destroy-failed',
      details: { removedFiles: false, removedSessions: 0 },
    })
    expect(existsSync(dir)).toBe(true)
    expect(ctx.workspaceRegistry.get(id)).toBeDefined()
    expect(removals).toEqual([])
  })

  it('keeps the registration after a failure following the removal, and a retry succeeds', async () => {
    const stored: StoredSession[] = []
    const { controller, ctx, root, deleteSessions } = await setup(stored)
    const dir = dirAt(root, 'retry')
    const id = await register(controller, dir)
    stored.push({ id: SessionId('retried'), cwd: dir })
    const registry = vi.spyOn(ctx.workspaceRegistry, 'delete').mockRejectedValueOnce(new Error('registry write failed'))

    await expect(destroyOf(controller, ctx, id)).rejects.toMatchObject({
      code: 'workspace/destroy-failed',
      details: { removedFiles: true, removedSessions: 1 },
    })
    expect(existsSync(dir)).toBe(false)
    expect(ctx.workspaceRegistry.get(id)).toBeDefined()
    registry.mockRestore()

    await expect(destroyOf(controller, ctx, id))
      .resolves.toEqual({ deleted: true, removedSessions: 0, deferredSessions: 0, removedFiles: false })
    expect(deleteSessions).toHaveBeenCalledTimes(1)
    expect(ctx.workspaceRegistry.get(id)).toBeUndefined()
  })

  it('serializes concurrent destroy calls so the second sees the Workspace as gone', async () => {
    const { controller, root } = await setup()
    const dir = dirAt(root, 'twice')
    const id = await register(controller, dir)
    const request = { workspaceId: id, confirmTitle: 'twice' }
    const [first, second] = await Promise.allSettled([
      controller.destroy(request, new AbortController().signal),
      controller.destroy(request, new AbortController().signal),
    ])
    expect(first).toMatchObject({ status: 'fulfilled', value: { deleted: true, removedFiles: true } })
    expect(second).toMatchObject({ status: 'rejected', reason: { code: 'workspace/not-found' } })
    expect(removals).toEqual([dir])
  })
})
