import type { Context } from '@deepseek-ai/cordis'
import { credentialKey, type CredentialKey, type CredentialProvider, type CredentialRecord } from '@deepseek-ai/dsh-credentials'

/** Record key of the browser-session signing secret. */
export const SIGNING_SECRET_KEY = credentialKey('client-connection', 'browser-session')
/** Record key of the persistent access key. */
export const ACCESS_KEY_KEY = credentialKey('client-connection', 'access-key')

/** Keyed credential-record double for Connection authentication tests. */
export class RecordCredentials {
  readonly records = new Map<string, CredentialRecord>()
  discardWrites = false
  reads = 0
  modifies = 0

  readRecord(key: CredentialKey): Promise<CredentialRecord | undefined> {
    this.reads += 1
    return Promise.resolve(this.records.get(key))
  }

  async modifyRecord(
    key: CredentialKey,
    mutate: (current: CredentialRecord | undefined) => Promise<CredentialRecord | undefined>,
  ): Promise<CredentialRecord | undefined> {
    this.modifies += 1
    const next = await mutate(this.records.get(key))
    if (this.discardWrites) return undefined
    if (next !== undefined) this.records.set(key, next)
    return this.records.get(key)
  }

  deleteRecord(key: CredentialKey): Promise<void> {
    this.records.delete(key)
    return Promise.resolve()
  }
}

/** Provide the record operations Connection needs during authentication setup. */
export function provideBrowserCredentials(ctx: Context): void {
  ctx.provide('credentials', new RecordCredentials() as unknown as CredentialProvider)
}
