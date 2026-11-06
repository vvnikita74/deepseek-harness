/**
 * Host Context harness for Workspace controller specs: a real WorkspaceRegistry
 * over a memory storage domain, with the Session services injected as fakes.
 */

import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore from '@deepseek-ai/dsh-session'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import WorkspaceRegistry from '@deepseek-ai/dsh-workspace'
import RemoteAccessService from '@deepseek-ai/dsh-api-remote-access'
import WorkspaceController from '../../src/index.ts'
import { MemoryStorageBackend } from '../../../../storage/storage-domain/tests/helpers/memory-backend.ts'

/** Host contexts created by {@link harness}, disposed by {@link disposeHarnesses}. */
export const roots: Context[] = []

/** Temporary roots created by {@link harness}, removed by {@link disposeHarnesses}. */
export const tempDirs: string[] = []

/** Options for {@link harness}. */
export interface HarnessOptions {
  /** Keep the system Documents lookup instead of pinning the default directory to the temporary root. */
  readonly systemDocuments?: boolean
  /** Fake `sessionController`; defaults to a `deleteSessions` that removes nothing. */
  readonly sessionController?: object
  /** Fake `sessionPersistence`; defaults to an empty listing. */
  readonly sessionPersistence?: object
}

/**
 * Dispose every harness context and remove every temporary root it created.
 * @returns when all contexts are disposed and the roots are removed.
 */
export async function disposeHarnesses(): Promise<void> {
  await Promise.all(roots.splice(0).map(ctx => ctx.fiber.dispose()))
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
}

/**
 * Build a Host Context with a real Workspace registry and a WorkspaceController.
 * @param options - fake Session services and the Documents policy.
 * @returns the controller, its Context, the canonical temporary root, and the storage domain.
 */
export async function harness(options: HarnessOptions = {}) {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'dsh-workspace-controller-')))
  tempDirs.push(root)
  const ctx = new Context()
  roots.push(ctx)
  await ctx.plugin(SessionStore)
  await ctx.plugin(Storage)
  ctx.storage.backend.register('memory', new MemoryStorageBackend())
  const storageDomain = new DomainFacility(ctx, { backend: 'memory', routes: {} })
  ctx.storage.mount('domain', storageDomain)
  ctx.provide('storageDomain', storageDomain)
  ctx.provide('sessionPersistence', options.sessionPersistence ?? { list: () => Promise.resolve([]) } as never)
  ctx.provide('sessionController', options.sessionController ?? { deleteSessions: () => Promise.resolve([]) } as never)
  await ctx.plugin(WorkspaceRegistry)
  const dispose = (): void => {}
  ctx.provide('typert', {
    lookups: { configure: () => dispose },
    contexts: { configureHost: () => dispose },
    resources: { register: vi.fn(() => dispose) },
  } as never)
  new RemoteAccessService(ctx)
  const controller = new WorkspaceController(ctx, options.systemDocuments === true ? {} : { documentsDirectory: root })
  return { controller, ctx, root, storageDomain }
}
