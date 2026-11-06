---
kind: upgrade-guide
description: "The `@deepseek-ai/dsh-command-feedback` and `@deepseek-ai/dsh-message-feedback` packages, the `/feedback` command, the message feedback remotes, and the `feedback/*` Session events are removed, so Session logs that contain those events must be edited before this build reads them."
---

# Feedback packages and Session events removed

English | [中文](guide.zh.md)

## Change

The packages `@deepseek-ai/dsh-command-feedback` and `@deepseek-ai/dsh-message-feedback` are removed. With them go the `/feedback` command, which is now sent to the model as plain text, the Like/Dislike message feedback remotes (`messageFeedback` and `sessionFeedback`), and the Session events `feedback/record`, `feedback/message-put`, and `feedback/message-delete`. This build neither produces nor recognizes those events. The persistence read path refuses unknown non-ignorable event types, so a Session log that already contains them cannot be opened by this build.

The OpenTelemetry `FEEDBACK_ONLY` upload mode, which is still the default, now captures nothing because no Session event can release a prefix any more.

Affected: anyone whose `cordis.yml`, patch, overlay, or `package.json` names either package, any caller of the removed remotes, anyone with Session logs that contain `feedback/` events, and anyone who expects OpenTelemetry to upload Session history.

## Migration

1. Remove `@deepseek-ai/dsh-command-feedback` and `@deepseek-ai/dsh-message-feedback` from every `cordis.yml`, patch, overlay, and `package.json` dependency list, then reinstall.
2. Delete the `feedback/record`, `feedback/message-put`, and `feedback/message-delete` lines from every Session log before opening it with this build. Decompress `.zstd` logs first. Back up the logs first. To find them, run `grep -rl '"type":"feedback/' <session-root>`, where `<session-root>` is the `root` of your `session-persistence-jsonl` row, by default the `sessions` folder under your DSH home.
3. Remove calls to the `messageFeedback` and `sessionFeedback` remotes. They no longer exist.
4. If you want no OpenTelemetry upload, set `mode: DISABLED` in the `session-telemetry-otel` row, or set `DSH_TELEMETRY_MODE=DISABLED`. The default `FEEDBACK_ONLY` exports nothing, so leaving it unchanged is also safe.
5. Confirm with `grep -rl '"type":"feedback/' <session-root>`, which should print nothing, and with `dsh --profile <your profile> --dump-config`, which should list no feedback package and show `mode: DISABLED` for the OpenTelemetry row if you set it.
