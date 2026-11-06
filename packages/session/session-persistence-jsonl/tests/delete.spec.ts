/**
 * Whole-session deletion through `SessionPersistence.delete`: removal of every
 * generation and session-owned file, project-directory cleanup, refusals while
 * a write owner exists in this process or another, cancellation, and the
 * `session/deleted` dispatch. Foreign ownership is simulated with a kernel
 * lock on the session directory, so a second process is not required.
 */

import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import {
  SessionAlreadyOwnedError,
  SessionPersistenceNotFoundError,
} from '@deepseek-ai/dsh-session-persistence'
import type { SessionPersistence } from '@deepseek-ai/dsh-session-persistence'
import * as JsonlSessionPersistence from '../src/index.ts'
import { generationLogPath, projectDir, sessionDir } from '../src/format.ts'
import { SessionWriteLease } from '../src/lease.ts'
import { meta, oneTurnLog, releasedV1OneTurnLog } from '../../session-persistence/tests/contract.ts'

const dirs: string[] = []
const contexts: Context[] = []

afterEach(async () => {
  vi.restoreAllMocks()
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

async function freshRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-jsonl-delete-'))
  dirs.push(root)
  return root
}

async function mount(root: string): Promise<{ ctx: Context; persistence: SessionPersistence }> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(JsonlSessionPersistence, { root, compression: 'none' })
  return { ctx, persistence: ctx.sessionPersistence }
}

/** Create, append one turn, and close: a materialized session in `cwd`. */
async function store(persistence: SessionPersistence, header: SessionHeader): Promise<void> {
  const handle = await persistence.create(header)
  try {
    await handle.append(oneTurnLog())
  } finally {
    await handle.close()
  }
}

/** A released v0 log in the raw historical layout, with a migratable body. */
async function storeReleasedV0(root: string, header: SessionHeader): Promise<void> {
  const path = generationLogPath(root, header.cwd, header.id, 0, 'none')
  const [turn, user, step, ...tail] = releasedV1OneTurnLog()
  const body: SessionEvent[] = [turn!, { ...step!, time: 2 }, { ...user!, time: 3 }, ...tail]
    .map((event, seq) => ({ ...event, seq: SessionSeq(seq) }))
  const v0Header = { type: 'session', version: 0, id: header.id, createdAt: header.createdAt, cwd: header.cwd, delegationDepth: 0 }
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(v0Header)}\n${body.map(event => JSON.stringify(event)).join('\n')}\n`)
}

describe('SessionPersistence.delete (JSONL)', () => {
  it('removes the session from stat, open, list, and disk while other sessions stay listed', async () => {
    const root = await freshRoot()
    const { persistence } = await mount(root)
    await store(persistence, meta('gone', '/work'))
    await store(persistence, meta('kept', '/work'))
    const directory = sessionDir(root, '/work', SessionId('gone'))

    await persistence.delete(SessionId('gone'))

    expect(await persistence.stat(SessionId('gone'))).toBeUndefined()
    await expect(persistence.open(SessionId('gone'), 'read')).rejects.toBeInstanceOf(SessionPersistenceNotFoundError)
    expect((await persistence.list()).map(snapshot => snapshot.header.id)).toEqual(['kept'])
    expect(existsSync(directory)).toBe(false)
  })

  it('removes the project directory with its last session', async () => {
    const root = await freshRoot()
    const { persistence } = await mount(root)
    await store(persistence, meta('solo', '/shared'))

    await persistence.delete(SessionId('solo'))

    expect(existsSync(projectDir(root, '/shared'))).toBe(false)
    expect(existsSync(root)).toBe(true)
  })

  it('keeps the project directory while a sibling session of the same cwd remains', async () => {
    const root = await freshRoot()
    const { persistence } = await mount(root)
    await store(persistence, meta('departing', '/shared'))
    await store(persistence, meta('sibling', '/shared'))

    await persistence.delete(SessionId('departing'))

    expect(existsSync(projectDir(root, '/shared'))).toBe(true)
    const reader = await persistence.open(SessionId('sibling'), 'read')
    expect((await reader.read()).events).toHaveLength(oneTurnLog().length)
    await reader.close()
  })

  it('removes stray files in the session directory together with it', async () => {
    const root = await freshRoot()
    const { persistence } = await mount(root)
    await store(persistence, meta('stray', '/work'))
    const directory = sessionDir(root, '/work', SessionId('stray'))
    await writeFile(join(directory, 'session.v2.jsonl'), 'older generation residue\n')

    await persistence.delete(SessionId('stray'))

    expect(existsSync(directory)).toBe(false)
  })

  it('rejects an unknown id with SessionPersistenceNotFoundError', async () => {
    const root = await freshRoot()
    const { persistence } = await mount(root)

    await expect(persistence.delete(SessionId('never-stored'))).rejects.toBeInstanceOf(SessionPersistenceNotFoundError)
  })

  it('refuses while this instance holds a write handle, keeps the session intact, and succeeds after close', async () => {
    const root = await freshRoot()
    const { persistence } = await mount(root)
    await store(persistence, meta('owned', '/work'))
    const writer = await persistence.open(SessionId('owned'), 'write')

    await expect(persistence.delete(SessionId('owned'))).rejects.toBeInstanceOf(SessionAlreadyOwnedError)

    expect(await persistence.stat(SessionId('owned'))).toMatchObject({ header: { id: 'owned' } })
    const reader = await persistence.open(SessionId('owned'), 'read')
    expect((await reader.read()).events).toHaveLength(oneTurnLog().length)
    await reader.close()
    await writer.close()

    await persistence.delete(SessionId('owned'))
    expect(await persistence.stat(SessionId('owned'))).toBeUndefined()
  })

  it('refuses a created session that this instance has not materialized', async () => {
    const root = await freshRoot()
    const { persistence } = await mount(root)
    const creator = await persistence.create(meta('pending', '/work'))

    await expect(persistence.delete(SessionId('pending'))).rejects.toBeInstanceOf(SessionAlreadyOwnedError)
    expect(await persistence.stat(SessionId('pending'))).toMatchObject({ header: { id: 'pending' } })
    await creator.close()
  })

  it('refuses while another process holds the session lock, removes nothing, and succeeds after release', async () => {
    const root = await freshRoot()
    const { persistence } = await mount(root)
    await store(persistence, meta('foreign', '/work'))
    const directory = sessionDir(root, '/work', SessionId('foreign'))
    const foreign = await SessionWriteLease.acquire(directory, SessionId('foreign'))

    await expect(persistence.delete(SessionId('foreign'))).rejects.toBeInstanceOf(SessionAlreadyOwnedError)
    expect(existsSync(directory)).toBe(true)
    expect(await persistence.stat(SessionId('foreign'))).toMatchObject({ header: { id: 'foreign' } })

    await foreign.release()
    await persistence.delete(SessionId('foreign'))
    expect(existsSync(directory)).toBe(false)
  })

  it('dispatches session/deleted once with the id, and never on a refusal', async () => {
    const root = await freshRoot()
    const { ctx, persistence } = await mount(root)
    const seen: unknown[] = []
    ctx.on('session/deleted', (event) => { seen.push(event) })
    await store(persistence, meta('announced', '/work'))
    const writer = await persistence.open(SessionId('announced'), 'write')

    await expect(persistence.delete(SessionId('announced'))).rejects.toBeInstanceOf(SessionAlreadyOwnedError)
    await expect(persistence.delete(SessionId('never-stored'))).rejects.toBeInstanceOf(SessionPersistenceNotFoundError)
    expect(seen).toEqual([])

    await writer.close()
    await persistence.delete(SessionId('announced'))
    expect(seen).toEqual([{ sessionId: 'announced' }])
  })

  it('does not reject when a session/deleted listener throws, and logs the failure', async () => {
    const root = await freshRoot()
    const { ctx, persistence } = await mount(root)
    const warn = vi.spyOn(ctx.logger, 'warn')
    ctx.on('session/deleted', () => { throw new Error('listener failure') })
    await store(persistence, meta('listened', '/work'))

    await expect(persistence.delete(SessionId('listened'))).resolves.toBeUndefined()

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('session/deleted listener for "listened" failed'))
    expect(await persistence.stat(SessionId('listened'))).toBeUndefined()
  })

  it('resolves, dispatches session/deleted once, and warns when the lock release fails after the removal', async () => {
    const root = await freshRoot()
    const { ctx, persistence } = await mount(root)
    const seen: unknown[] = []
    ctx.on('session/deleted', (event) => { seen.push(event) })
    const warn = vi.spyOn(ctx.logger, 'warn')
    await store(persistence, meta('unlocked', '/work'))
    const directory = sessionDir(root, '/work', SessionId('unlocked'))
    vi.spyOn(SessionWriteLease.prototype, 'release').mockRejectedValueOnce(new Error('release failure'))

    await expect(persistence.delete(SessionId('unlocked'))).resolves.toBeUndefined()

    expect(seen).toEqual([{ sessionId: 'unlocked' }])
    expect(existsSync(directory)).toBe(false)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('session "unlocked" was deleted but its lock release failed'))
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Error: release failure'))
  })

  it('rejects an already-aborted signal and erases nothing', async () => {
    const root = await freshRoot()
    const { persistence } = await mount(root)
    await store(persistence, meta('cancelled', '/work'))
    const controller = new AbortController()
    controller.abort()

    await expect(persistence.delete(SessionId('cancelled'), { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' })

    expect(await persistence.stat(SessionId('cancelled'))).toMatchObject({ header: { id: 'cancelled' } })
  })

  it('makes a read handle opened before deletion refuse further reads, including a migrated historical body', async () => {
    const root = await freshRoot()
    const { persistence } = await mount(root)
    await store(persistence, meta('current-reader', '/work'))
    const header = meta('historical-reader', '/work')
    await storeReleasedV0(root, header)
    const currentReader = await persistence.open(SessionId('current-reader'), 'read')
    const historicalReader = await persistence.open(SessionId('historical-reader'), 'read')
    expect((await historicalReader.read()).events.length).toBeGreaterThan(0)

    await persistence.delete(SessionId('current-reader'))
    await persistence.delete(SessionId('historical-reader'))

    await expect(currentReader.read()).rejects.toBeInstanceOf(SessionPersistenceNotFoundError)
    await expect(historicalReader.read()).rejects.toBeInstanceOf(SessionPersistenceNotFoundError)
    await currentReader.close()
    await historicalReader.close()
  })

  it('allows the same id to be created again after deletion', async () => {
    const root = await freshRoot()
    const { persistence } = await mount(root)
    await store(persistence, meta('reborn', '/work'))
    await persistence.delete(SessionId('reborn'))

    await store(persistence, meta('reborn', '/work'))

    expect((await persistence.list()).map(snapshot => snapshot.header.id)).toEqual(['reborn'])
    expect(await persistence.stat(SessionId('reborn'))).toMatchObject({ header: { id: 'reborn' } })
  })
})
