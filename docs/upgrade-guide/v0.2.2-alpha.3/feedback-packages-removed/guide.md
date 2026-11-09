---
kind: upgrade-guide
description: "The `@deepseek-ai/dsh-command-feedback` and `@deepseek-ai/dsh-message-feedback` packages, the `/feedback` command, the message feedback remotes, and the production of `feedback/*` Session events are removed; existing Session logs that contain those events stay readable."
---

# Feedback packages and Session events removed

English | [中文](guide.zh.md)

## Change

The packages `@deepseek-ai/dsh-command-feedback` and `@deepseek-ai/dsh-message-feedback` are removed. With them go the `/feedback` command, which is now sent to the model as plain text, the Like/Dislike message feedback remotes (`messageFeedback` and `sessionFeedback`), and the production of the Session events `feedback/record`, `feedback/message-put`, and `feedback/message-delete`. This build no longer produces those events; their names remain in the known read vocabulary, so an existing Session log that contains them still opens and preserves them as opaque events.

The OpenTelemetry `FEEDBACK_ONLY` upload mode, which is still the default, now captures nothing because no Session event can release a prefix any more.

Affected: anyone whose `cordis.yml`, patch, overlay, or `package.json` names either package, any caller of the removed remotes, and anyone who expects OpenTelemetry to upload Session history.

## Migration

1. Remove `@deepseek-ai/dsh-command-feedback` and `@deepseek-ai/dsh-message-feedback` from every `cordis.yml`, patch, overlay, and `package.json` dependency list, then reinstall.
2. Remove calls to the `messageFeedback` and `sessionFeedback` remotes. They no longer exist.
3. If you want no OpenTelemetry upload, set `mode: DISABLED` in the `session-telemetry-otel` row, or set `DSH_TELEMETRY_MODE=DISABLED`. The default `FEEDBACK_ONLY` exports nothing, so leaving it unchanged is also safe.
4. Confirm with `dsh --profile <your profile> --dump-config`, which should list no feedback package and show `mode: DISABLED` for the OpenTelemetry row if you set it.
