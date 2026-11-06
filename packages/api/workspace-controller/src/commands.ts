/** Workspace command implementation and stable Remote failure mapping. */

import { rm } from 'node:fs/promises'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { Workspace } from '@deepseek-ai/dsh-workspace'
import {
  WorkspaceActiveSessionError,
  WorkspaceArchivedSessionPinError,
  WorkspaceId,
  WorkspaceMoveInvalidError,
  WorkspaceOrderInvalidError,
  WorkspaceUnknownSessionError,
} from '@deepseek-ai/dsh-workspace'
import { RemoteError, remoteErrorOf } from '@deepseek-ai/dsh-typert-protocol'
import { workspaceView } from './feed.ts'
import { assertDeletable, canonicalPath, isInside } from './protected-paths.ts'
import type {
  WorkspaceArchiveSessionRequest,
  WorkspaceArchiveValue,
  WorkspaceCreateRequest,
  WorkspaceCreateValue,
  WorkspaceDeleteRequest,
  WorkspaceDeleteValue,
  WorkspaceDestroyRequest,
  WorkspaceDestroyValue,
  WorkspaceInsertBeforeRequest,
  WorkspaceInsertSessionBeforeRequest,
  WorkspaceOrderValue,
  WorkspacePinSessionRequest,
  WorkspacePinValue,
  WorkspaceRenameRequest,
  WorkspaceUnarchiveSessionRequest,
  WorkspaceUnpinSessionRequest,
  WorkspaceValue,
} from './types.ts'

/** Implements Workspace mutations against the authoritative registry. */
export class WorkspaceCommands {
  private operationTail = Promise.resolve()

  /** @param ctx - Host context containing the Workspace registry. */
  constructor(private readonly ctx: Context) {}

  /**
   * Create or resolve one Workspace over an existing directory.
   * @param request - directory path to register.
   * @returns the Workspace and whether this call created it.
   */
  create(request: WorkspaceCreateRequest): Promise<WorkspaceCreateValue> {
    return this.enqueue(async () => {
      try {
        const existing = await this.ctx.workspaceRegistry.resolveByPath(request.path)
        if (existing !== undefined) {
          return { workspace: workspaceView(existing), created: false }
        }
        const workspace = await this.ctx.workspaceRegistry.create(request.path)
        return { workspace: workspaceView(workspace), created: true }
      } catch (error) {
        if (remoteErrorOf(error) !== undefined) throw error
        throw new RemoteError(
          'workspace/invalid-path',
          `cannot create a Workspace at "${request.path}": ${errorMessage(error)}`,
          { path: request.path },
          { cause: error },
        )
      }
    })
  }

  /**
   * Rename one Workspace after serializing title ownership checks.
   * @param request - Workspace identity and proposed title.
   * @returns the updated Workspace projection.
   */
  rename(request: WorkspaceRenameRequest): Promise<WorkspaceValue> {
    const title = request.title.trim()
    if (title === '') {
      return Promise.reject(new RemoteError('gateway/bad-request', 'Workspace rename requires a non-blank title', {}))
    }
    return this.enqueue(async () => {
      const workspace = this.requireWorkspace(request.workspaceId)
      if (title !== workspace.title) {
        if (this.ctx.workspaceRegistry.list().some(candidate =>
          candidate.id !== workspace.id && candidate.title === title)) {
          throw new RemoteError(
            'workspace/name-conflict',
            `Workspace name '${title}' is already in use`,
            { name: title },
          )
        }
        await workspace.setTitle(title)
      }
      return { workspace: workspaceView(workspace) }
    })
  }

  /**
   * Delete one Workspace registration without deleting its directory or Sessions.
   * @param request - Workspace identity to remove.
   * @returns deletion confirmation.
   */
  delete(request: WorkspaceDeleteRequest): Promise<WorkspaceDeleteValue> {
    return this.enqueue(async () => {
      if (!await this.ctx.workspaceRegistry.delete(WorkspaceId(request.workspaceId))) {
        throw workspaceNotFound(request.workspaceId)
      }
      return { deleted: true }
    })
  }

  /**
   * Irreversibly delete one Workspace. Steps run in order and each starts only
   * after the previous one succeeded: confirm the title, check the directory
   * against the protection rules, delete the Sessions, remove the directory,
   * then remove the registration. A failure stops the sequence, so the
   * registration stays and a retry is safe: a removed directory is skipped.
   * Sessions removed before a failing step stay removed. A symlinked Workspace
   * path loses only the link; the target is not removed. Shared attachments
   * under the harness home are not removed.
   * @param request - Workspace identity and the title the caller confirms.
   * @param signal - caller lifetime; cancels Session listing and deletion.
   * @returns the deletion receipt.
   */
  destroy(request: WorkspaceDestroyRequest, signal: AbortSignal): Promise<WorkspaceDestroyValue> {
    return this.enqueue(async () => {
      const workspace = this.requireWorkspace(request.workspaceId)
      if (request.confirmTitle !== workspace.title) {
        throw new RemoteError(
          'workspace/confirm-mismatch',
          `confirmation does not match the title of Workspace "${workspace.id}"`,
          {},
        )
      }
      const real = await this.checkDirectory(workspace)
      const deleted = await this.deleteOwnedSessions(workspace, real, signal)
      if (real !== undefined) await this.removeDirectory(workspace.path, deleted.length)
      try {
        await this.ctx.workspaceRegistry.delete(workspace.id)
      } catch (error) {
        throw destroyFailed(
          `cannot remove the registration of Workspace "${workspace.id}": ${errorMessage(error)}`,
          { removedFiles: real !== undefined, removedSessions: deleted.length },
          error,
        )
      }
      return {
        deleted: true,
        removedSessions: deleted.length,
        deferredSessions: 0,
        removedFiles: real !== undefined,
      }
    })
  }

  /**
   * Move one Workspace within the durable registry order.
   * @param request - moved Workspace and optional anchor.
   * @returns the complete resulting Workspace order.
   */
  async insertBefore(request: WorkspaceInsertBeforeRequest): Promise<WorkspaceOrderValue> {
    try {
      const workspaceIds = await this.ctx.workspaceRegistry.insertBefore(
        WorkspaceId(request.workspaceId),
        request.beforeWorkspaceId === undefined
          ? undefined
          : WorkspaceId(request.beforeWorkspaceId),
      )
      return { workspaceIds: [...workspaceIds] }
    } catch (error) {
      if (!(error instanceof WorkspaceOrderInvalidError)) throw error
      throw workspaceNotFound(error.workspaceId)
    }
  }

  /**
   * Move one accounted Session within a Workspace's manual order.
   * @param request - Workspace, Session, and optional anchor identities.
   * @returns the updated Workspace projection.
   */
  async insertSessionBefore(request: WorkspaceInsertSessionBeforeRequest): Promise<WorkspaceValue> {
    const workspace = this.requireWorkspace(request.workspaceId)
    try {
      await workspace.insertSessionBefore(request.sessionId, request.beforeSessionId)
    } catch (error) {
      if (!(error instanceof WorkspaceMoveInvalidError)) throw error
      throw new RemoteError(
        'workspace/move-invalid',
        error.message,
        {
          workspaceId: request.workspaceId,
          sessionId: request.sessionId,
          ...request.beforeSessionId === undefined
            ? {}
            : { beforeSessionId: request.beforeSessionId },
        },
        { cause: error },
      )
    }
    return { workspace: workspaceView(workspace) }
  }

  /**
   * Add one known Session to the registry-global archive set. Without
   * `stopActivity` a Session with running work is refused as
   * `workspace/session-active` with the activity the registry's providers
   * reported; with it, the providers stop that work first.
   * @param request - Session identity to archive and whether to stop its work.
   * @returns the complete resulting archive set.
   */
  async archiveSession(request: WorkspaceArchiveSessionRequest): Promise<WorkspaceArchiveValue> {
    try {
      await this.ctx.workspaceRegistry.archiveSession(
        request.sessionId,
        request.stopActivity === true ? { stopActivity: true } : {},
      )
    } catch (error) {
      if (error instanceof WorkspaceUnknownSessionError) {
        throw new RemoteError('session/not-found', error.message, { sessionId: request.sessionId }, { cause: error })
      }
      if (error instanceof WorkspaceActiveSessionError) {
        throw new RemoteError(
          'workspace/session-active',
          error.message,
          { sessionId: request.sessionId, activity: error.activity },
          { cause: error },
        )
      }
      throw error
    }
    return { archivedSessionIds: [...this.ctx.workspaceRegistry.archivedSessionIds] }
  }

  /**
   * Drop one Session from the registry-global archive set. An id that is not
   * archived is not an error: the call is idempotent, so a lost race with
   * another surface resolves as a no-op.
   * @param request - Session identity to unarchive.
   * @returns the complete resulting archive set.
   */
  async unarchiveSession(request: WorkspaceUnarchiveSessionRequest): Promise<WorkspaceArchiveValue> {
    await this.ctx.workspaceRegistry.unarchiveSession(request.sessionId)
    return { archivedSessionIds: [...this.ctx.workspaceRegistry.archivedSessionIds] }
  }

  /**
   * Add one known unarchived Session to the registry-global pin set.
   * @param request - Session identity to pin.
   * @returns the complete resulting pin set, most recently pinned first.
   */
  async pinSession(request: WorkspacePinSessionRequest): Promise<WorkspacePinValue> {
    try {
      await this.ctx.workspaceRegistry.pinSession(request.sessionId)
    } catch (error) {
      if (error instanceof WorkspaceUnknownSessionError) {
        throw new RemoteError('session/not-found', error.message, { sessionId: request.sessionId }, { cause: error })
      }
      if (error instanceof WorkspaceArchivedSessionPinError) {
        throw new RemoteError('gateway/bad-request', error.message, {}, { cause: error })
      }
      throw error
    }
    return { pinnedSessionIds: [...this.ctx.workspaceRegistry.pinnedSessionIds] }
  }

  /**
   * Drop one Session from the registry-global pin set. An id that is not
   * pinned is not an error: the call is idempotent, so a lost race with
   * another surface resolves as a no-op.
   * @param request - Session identity to unpin.
   * @returns the complete resulting pin set, most recently pinned first.
   */
  async unpinSession(request: WorkspaceUnpinSessionRequest): Promise<WorkspacePinValue> {
    await this.ctx.workspaceRegistry.unpinSession(request.sessionId)
    return { pinnedSessionIds: [...this.ctx.workspaceRegistry.pinnedSessionIds] }
  }

  private requireWorkspace(workspaceId: WorkspaceId): Workspace {
    const workspace = this.ctx.workspaceRegistry.get(WorkspaceId(workspaceId))
    if (workspace === undefined) throw workspaceNotFound(workspaceId)
    return workspace
  }

  /**
   * Resolve the Workspace directory and run the protection rules on it.
   * @param workspace - Workspace whose directory is about to be removed.
   * @returns the canonical directory, or undefined when the directory is already gone.
   * @throws RemoteError `workspace/path-protected` when the directory is protected.
   * @throws RemoteError `workspace/destroy-failed` when the directory cannot be inspected.
   */
  private async checkDirectory(workspace: Workspace): Promise<string | undefined> {
    try {
      const real = await canonicalPath(workspace.path)
      if (real === undefined) return undefined
      const others = this.ctx.workspaceRegistry.list()
        .filter(candidate => candidate.id !== workspace.id)
        .map(candidate => candidate.path)
      await assertDeletable(real, others)
      return real
    } catch (error) {
      if (remoteErrorOf(error) !== undefined) throw error
      throw destroyFailed(
        `cannot inspect the directory of Workspace "${workspace.id}": ${errorMessage(error)}`,
        { removedFiles: false, removedSessions: 0 },
        error,
      )
    }
  }

  /**
   * Delete every Session the Workspace owns; no Session is deleted when the call fails before the deletion starts.
   * @param workspace - Workspace whose Sessions are deleted.
   * @param real - canonical Workspace directory, or undefined when it is already gone.
   * @param signal - caller lifetime forwarded to Session listing and deletion.
   * @returns the identities removed by the Session deletion.
   * @throws RemoteError `workspace/session-active` when a Session still has running work.
   * @throws RemoteError `workspace/destroy-failed` for any other deletion failure, counting the Sessions already removed.
   */
  private async deleteOwnedSessions(
    workspace: Workspace,
    real: string | undefined,
    signal: AbortSignal,
  ): Promise<readonly SessionId[]> {
    try {
      const ids = await this.ownedSessionIds(workspace, real, signal)
      if (ids.length === 0) return []
      return await this.ctx.sessionController.deleteSessions(ids, signal)
    } catch (error) {
      const failure = remoteErrorOf(error)
      if (failure?.code === 'session/active') {
        throw new RemoteError(
          'workspace/session-active',
          failure.message,
          { sessionId: failure.details.sessionId, activity: failure.details.activity },
          { cause: error },
        )
      }
      const removedSessions = failure?.code === 'session/writer-held' ? (failure.details.deletedSessionIds?.length ?? 0) : 0
      throw destroyFailed(
        `cannot delete the Sessions of Workspace "${workspace.id}": ${errorMessage(error)}`,
        { removedFiles: false, removedSessions },
        error,
      )
    }
  }

  /**
   * Collect the accounted Sessions and the stored Sessions whose cwd lies in the Workspace; only stored ids are returned.
   * @param workspace - Workspace whose Sessions are collected.
   * @param real - canonical Workspace directory, or undefined when it is already gone.
   * @param signal - caller lifetime forwarded to Session listing.
   * @returns stored Session identities owned by the Workspace.
   */
  private async ownedSessionIds(workspace: Workspace, real: string | undefined, signal: AbortSignal): Promise<SessionId[]> {
    const stored = await this.ctx.sessionPersistence.list({ signal })
    const storedIds = new Set(stored.map(snapshot => snapshot.header.id))
    const owned = new Set<SessionId>(workspace.sessionIds)
    for (const { header } of stored) {
      const cwd = header.cwd
      if (cwd !== undefined && (isInside(cwd, workspace.path) || (real !== undefined && isInside(cwd, real)))) {
        owned.add(header.id)
      }
    }
    return [...owned].filter(id => storedIds.has(id))
  }

  /**
   * Remove the Workspace directory tree. A symlink at the path is removed as a link; its target is kept.
   * @param path - Workspace path as registered, not resolved, so a symlink is removed as a link.
   * @param removedSessions - Sessions already removed before this step, reported on failure.
   * @throws RemoteError `workspace/destroy-failed` when removal fails; the registration stays for a retry.
   */
  private async removeDirectory(path: string, removedSessions: number): Promise<void> {
    try {
      await rm(path, { recursive: true, force: true })
    } catch (error) {
      throw destroyFailed(
        `cannot remove directory "${path}": ${errorMessage(error)}`,
        { removedFiles: false, removedSessions },
        error,
      )
    }
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationTail.then(operation)
    this.operationTail = result.then(() => undefined, () => undefined)
    return result
  }
}

function workspaceNotFound(workspaceId: WorkspaceId): RemoteError<'workspace/not-found'> {
  return new RemoteError(
    'workspace/not-found',
    `Workspace "${workspaceId}" not found`,
    { workspaceId },
  )
}

/**
 * Build the failure for a stopped Workspace destruction, reporting what was already removed.
 * @param message - human diagnostic naming the failed step.
 * @param details - removals completed before the failing step.
 * @param cause - the original failure.
 * @returns the typed `workspace/destroy-failed` error.
 */
function destroyFailed(
  message: string,
  details: { readonly removedFiles: boolean; readonly removedSessions: number },
  cause: unknown,
): RemoteError<'workspace/destroy-failed'> {
  return new RemoteError('workspace/destroy-failed', message, details, { cause })
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
