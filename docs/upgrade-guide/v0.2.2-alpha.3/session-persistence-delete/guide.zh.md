---
kind: upgrade-guide
description: "SessionPersistence 服务新增抽象方法 delete(id) 与 session/deleted 事件，因此扩展 SessionPersistence 的第三方持久化后端必须实现 delete。"
---

# 会话持久化后端需实现 `delete`

[English](guide.md) | 中文

## 变更

`SessionPersistence` 新增抽象方法 `delete(id, options?)`，它不可逆地移除一个已存储的会话；同时新增事件 `session/deleted`，后端在移除持久化之后分发该事件。扩展 `SessionPersistence` 却未实现 `delete` 的后端类不再能通过编译。随产品交付的 JSONL 后端已实现该方法。服务的调用方不受影响。

## 迁移

1. 在每个扩展 `SessionPersistence` 的后端类中，按 [`packages/session/session-persistence/src/index.ts`](../../../../packages/session/session-persistence/src/index.ts) 中的 JSDoc 契约实现 `delete(id: SessionId, options?: SessionPersistenceDeleteOptions): Promise<void>`：要求写所有权；在所有权被持有时以 `SessionAlreadyOwnedError` 拒绝；对未知 id 以 `SessionPersistenceNotFoundError` 拒绝；仅在移除持久化之后分发 `session/deleted`。
2. 若后端需要，从 `@deepseek-ai/dsh-session-persistence` 导入 `SessionPersistenceDeleteOptions` 与 `SessionDeletedEvent`。
3. 使用 `npx tsc -b <backend-package>/tsconfig.json` 确认：构建不再报告缺少 `delete` 成员。
