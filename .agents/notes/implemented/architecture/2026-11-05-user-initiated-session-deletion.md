# Agent Note: User-initiated session deletion

Status: implemented

English | [中文](2026-11-05-user-initiated-session-deletion.zh.md)

## Problem

Stored sessions accumulate under the persistence root, and the seam had no operation that removes one. Committed generations are otherwise immutable: the [released-format migration](2026-08-31-released-session-format-migrations.md) never moves, replaces, or deletes them, and the [handle model](2026-08-27-handle-based-session-persistence.md) gives each session one writer. A deletion must therefore be an explicit, user-initiated exception that cannot race a writer and leaves migration behavior unchanged.

## Decision

- `SessionPersistence.delete(id)` is the only operation that removes committed generations. It runs only on user request. Format migrations never remove, overwrite, or move committed generations.
- Deletion requires write ownership: it takes the in-process claim and the cross-process kernel lock. A session held by a write handle of any instance or process, or by a created session this process has not materialized, rejects with `SessionAlreadyOwnedError` and removes nothing. An unknown id rejects with `SessionPersistenceNotFoundError`. A signal aborted before the removal starts rejects and removes nothing.
- The JSONL backend removes the whole session directory: every generation, `session.lock`, and session-owned files. It then removes the project directory only when it is empty.
- After the removal is durable, the backend dispatches `session/deleted` with `{ sessionId }` in parallel mode. Listeners drop derived per-session state. A listener failure is logged and does not reject the deletion.
- Read handles opened before the deletion do not stay readable. The backend clears their prepared historical prefix, so a later read raises `SessionPersistenceNotFoundError`.
- The attachments store is intentionally not cleaned. It is shared across sessions, so a per-session deletion cannot attribute its entries safely.

## Alternatives considered

**Tombstone or soft delete.** It keeps the data the user asked to remove, and it still needs the generations to stay readable or be rewritten, which the migration rules forbid.

**Age- or count-based retention.** Pruning without a user decision would remove sessions the user did not choose. `delete` removes one named session only.

**Deletion without write ownership.** A concurrent writer could append between the existence check and the removal, leaving a partial or re-created session. The ownership refusal keeps the removal exclusive against every known writer.

**Emitting the event before the removal.** Listeners would drop derived state while the session still exists, and a failed removal would leave that state gone. The event follows the durable removal.

**Cleaning attachments with the session.** Attachments are shared; a per-session cleanup could delete data another session still references.

## Consequences

Deletion is irreversible. A crash after the directory removal and before the event leaves listener-owned derived state stale until that state is rebuilt; the event is not replayed. Third-party backends must implement `delete`, a breaking change recorded in the [upgrade guide](../../../../docs/upgrade-guide/v0.2.2-alpha.3/session-persistence-delete/guide.md).

## Testing

`packages/session/session-persistence-jsonl/tests/delete.spec.ts` covers removal from `stat`, `open`, `list`, and disk; project-directory cleanup with and without a sibling; stray files; an unknown id; an in-process write handle; an unmaterialized creator; a foreign kernel lock; the event dispatch and its refusal cases; a throwing listener; an aborted signal; recreation after deletion; and read handles on current and migrated historical sessions.
