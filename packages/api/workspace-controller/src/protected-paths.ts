/**
 * Path guards for destructive Workspace removal. A Workspace directory is
 * refused when it is a shallow system path, contains a protected location, or
 * contains another registered Workspace.
 */

import { realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { sep } from 'node:path'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'

/** Non-empty path segments a removable directory must have; shallower paths are system roots. */
const MIN_SEGMENTS = 3

/**
 * Refuse to remove a Workspace directory that is a protected location.
 * @param real - canonical path of the Workspace directory.
 * @param otherWorkspaces - paths of the other registered Workspaces; missing ones are skipped.
 * @returns when every rule passes; resolves without removing anything.
 * @throws RemoteError `workspace/path-protected` when `real` has fewer than three segments, equals or
 * contains the Host home, the harness home, or the Host working directory, or equals or contains another Workspace.
 * @throws any non-ENOENT filesystem error from resolving a protected path.
 */
export async function assertDeletable(real: string, otherWorkspaces: readonly string[]): Promise<void> {
  if (real.split(sep).filter(Boolean).length < MIN_SEGMENTS) throw protectedPath(real)
  const protectedPaths = [homedir(), resolveDshHome(), process.cwd(), ...otherWorkspaces]
  for (const path of protectedPaths) {
    const canonical = await canonicalPath(path)
    if (canonical !== undefined && isInside(canonical, real)) throw protectedPath(real)
  }
}

/**
 * Resolve a path to its canonical form, or report that it does not exist.
 * @param path - absolute or working-directory-relative path to resolve.
 * @returns the canonical path, or undefined when the path does not exist.
 * @throws any filesystem error other than ENOENT.
 */
export async function canonicalPath(path: string): Promise<string | undefined> {
  try {
    return await realpath(path)
  } catch (error) {
    // ENOENT is the expected "already gone" answer; every other errno is a real failure for the caller.
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined
    throw error
  }
}

/**
 * Whether `child` is `parent` or a path below it, for canonical absolute paths.
 * @param child - path to test.
 * @param parent - directory path to test against.
 * @returns true when `child` equals `parent` or lies under it.
 */
export function isInside(child: string, parent: string): boolean {
  return child === parent || child.startsWith(parent + sep)
}

function protectedPath(path: string): RemoteError<'workspace/path-protected'> {
  return new RemoteError(
    'workspace/path-protected',
    `refusing to remove protected directory "${path}"`,
    { path },
  )
}
