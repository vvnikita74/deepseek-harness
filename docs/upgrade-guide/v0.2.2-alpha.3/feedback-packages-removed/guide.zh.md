---
kind: upgrade-guide
description: "`@deepseek-ai/dsh-command-feedback` 与 `@deepseek-ai/dsh-message-feedback` 包、`/feedback` 命令、消息反馈远程接口以及 `feedback/*` 会话事件的生产已移除；包含这些事件的既有会话日志仍可读取。"
---

# 反馈包与会话事件已移除

[English](guide.md) | 中文

## 变更

`@deepseek-ai/dsh-command-feedback` 与 `@deepseek-ai/dsh-message-feedback` 包已移除。随之移除的还有 `/feedback` 命令（现在作为纯文本发送给模型）、赞/踩消息反馈远程接口（`messageFeedback` 与 `sessionFeedback`），以及会话事件 `feedback/record`、`feedback/message-put` 与 `feedback/message-delete` 的生产。此版本不再产生这些事件；它们的名称保留在已知读取词汇中，因此包含这些事件的既有会话日志仍可打开，事件按不透明数据处理。

OpenTelemetry 的 `FEEDBACK_ONLY` 上传模式仍是默认值，但现在不捕获任何内容，因为已没有会话事件能够释放任何前缀。

受影响者：其 `cordis.yml`、patch、overlay 或 `package.json` 中列出了上述任一包的用户；调用已移除远程接口的代码；以及期望 OpenTelemetry 上传会话历史的用户。

## 迁移

1. 从每个 `cordis.yml`、patch、overlay 与 `package.json` 依赖列表中删除 `@deepseek-ai/dsh-command-feedback` 与 `@deepseek-ai/dsh-message-feedback`，然后重新安装。
2. 删除对 `messageFeedback` 与 `sessionFeedback` 远程接口的调用，它们已不存在。
3. 若不需要 OpenTelemetry 上传，请在 `session-telemetry-otel` 行中设置 `mode: DISABLED`，或设置 `DSH_TELEMETRY_MODE=DISABLED`。默认的 `FEEDBACK_ONLY` 不导出任何内容，因此保持不变同样安全。
4. 用 `dsh --profile <your profile> --dump-config` 确认配置中不再有反馈包，若已设置则 OpenTelemetry 行显示 `mode: DISABLED`。
