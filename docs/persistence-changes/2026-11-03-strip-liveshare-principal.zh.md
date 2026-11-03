---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-11-03-strip-liveshare-principal

[English](2026-11-03-strip-liveshare-principal.md) | 中文

## 概述

移除用户来源 principal 联合类型与消息来源联合类型中的 ShareViewerPrincipal 变体（kind 为 "share-viewer"），因为它唯一的生产者——实验性 liveshare 包——已在前端剥离中删除。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-11-03-strip-liveshare-principal
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-10-27-subagent-settlement-attribution"
    after: "5153cbf90f514ec2e7090abd0742c198b67c8b4cf922904db052b465ec37b9fa"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-10-27-subagent-settlement-attribution"
    after: "a37429a5ff8b30d4978c37ca487f1722b14136d8b56c0b14dff8d00cbe6e98be"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-10-27-subagent-settlement-attribution"
    after: "807e01aeb203e295f157e55a497e474425cbc42aecd90a478d4f4037bbab07bd"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-10-27-subagent-settlement-attribution"
    after: "9427e6d1e84ebcd62cfd59f5744e9d8e190f1ef63f2df2ca035aaea4fddf5ae0"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

保留的生产者都不再写入被移除的变体，因此新记录对所有保留的变体保持不变。较旧的读取方接受新写入方产生的每一条记录。携带 liveshare viewer principal（kind 为 "share-viewer"）的旧记录现在会校验失败并被拒绝，而不会被误解释，因为它自身的判别符仍能识别它；没有保留的读取方会把它映射到其他变体。

<a id="verification"></a>
## 验证

pnpm run verify-persistence-catalog（基于重新生成的 docs/persistence-schema.json 与各目录通过）；pnpm run verify-persistence-changes（记录前报告四个未确认的根，记录后重新运行）；pnpm run verify-persistence-releases 与 verify-persistence-formats（记录后重新运行）。

<a id="dev-note"></a>
## 开发备注

无。
