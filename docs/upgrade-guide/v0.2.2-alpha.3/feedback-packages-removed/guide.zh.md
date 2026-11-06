---
kind: upgrade-guide
description: "`@deepseek-ai/dsh-command-feedback` 与 `@deepseek-ai/dsh-message-feedback` 包、`/feedback` 命令、消息反馈远程接口和 `feedback/*` 会话事件已移除，因此包含这些事件的会话日志必须先编辑，才能被此版本读取。"
---

# 反馈包与会话事件已移除

[English](guide.md) | 中文

## 变更

`@deepseek-ai/dsh-command-feedback` 与 `@deepseek-ai/dsh-message-feedback` 包已移除。随之移除的还有 `/feedback` 命令（现在作为纯文本发送给模型）、赞/踩消息反馈远程接口（`messageFeedback` 与 `sessionFeedback`），以及会话事件 `feedback/record`、`feedback/message-put` 与 `feedback/message-delete`。此版本既不再产生也不识别这些事件。持久化读取路径会拒绝未知的不可忽略事件类型，因此包含它们的会话日志无法被此版本打开。

OpenTelemetry 的 `FEEDBACK_ONLY` 上传模式仍是默认值，但现在不捕获任何内容，因为已没有会话事件能够释放任何前缀。

受影响者：其 `cordis.yml`、patch、overlay 或 `package.json` 中列出了上述任一包的用户；调用已移除远程接口的代码；会话日志中含有 `feedback/` 事件的用户；以及期望 OpenTelemetry 上传会话历史的用户。

## 迁移

1. 从每个 `cordis.yml`、patch、overlay 与 `package.json` 依赖列表中删除 `@deepseek-ai/dsh-command-feedback` 与 `@deepseek-ai/dsh-message-feedback`，然后重新安装。
2. 用此版本打开会话前，从每个会话日志中删除 `feedback/record`、`feedback/message-put` 与 `feedback/message-delete` 行。先解压 `.zstd` 日志，并先备份日志。查找方式：运行 `grep -rl '"type":"feedback/' <session-root>`，其中 `<session-root>` 为 `session-persistence-jsonl` 行的 `root`，默认是 DSH 主目录下的 `sessions` 文件夹。
3. 删除对 `messageFeedback` 与 `sessionFeedback` 远程接口的调用，它们已不存在。
4. 若不需要 OpenTelemetry 上传，请在 `session-telemetry-otel` 行中设置 `mode: DISABLED`，或设置 `DSH_TELEMETRY_MODE=DISABLED`。默认的 `FEEDBACK_ONLY` 不导出任何内容，因此保持不变同样安全。
5. 用 `grep -rl '"type":"feedback/' <session-root>` 确认无输出；用 `dsh --profile <your profile> --dump-config` 确认配置中不再有反馈包，若已设置则 OpenTelemetry 行显示 `mode: DISABLED`。
