---
kind: upgrade-guide
description: "The SessionPersistence service gains an abstract delete(id) method and the session/deleted event, so a third-party persistence backend that extends SessionPersistence must implement delete."
---

# Session persistence backends implement `delete`

English | [中文](guide.zh.md)

## Change

`SessionPersistence` gains the abstract method `delete(id, options?)`, which removes one stored session irreversibly, and the event `session/deleted`, which the backend dispatches after the removal is durable. A backend class that extends `SessionPersistence` without `delete` no longer compiles. The shipped JSONL backend implements it. Callers of the service are unaffected.

## Migration

1. In each backend class that extends `SessionPersistence`, implement `delete(id: SessionId, options?: SessionPersistenceDeleteOptions): Promise<void>` using the JSDoc contract in [`packages/session/session-persistence/src/index.ts`](../../../../packages/session/session-persistence/src/index.ts): require write ownership, reject with `SessionAlreadyOwnedError` while it is held, reject with `SessionPersistenceNotFoundError` for an unknown id, and dispatch `session/deleted` only after the removal is durable.
2. Import `SessionPersistenceDeleteOptions` and `SessionDeletedEvent` from `@deepseek-ai/dsh-session-persistence` where the backend needs them.
3. Confirm with `npx tsc -b <backend-package>/tsconfig.json`: the build reports no missing `delete` member.
