---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-11-03-strip-liveshare-principal

English | [中文](2026-11-03-strip-liveshare-principal.zh.md)

## Summary

Removes the ShareViewerPrincipal variant (kind "share-viewer") from the user-source principal union and the message source unions, because its only producer, the experimental liveshare package, was removed in the frontend strip.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

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
## Compatibility

No remaining producer writes the removed variant, so new records are unchanged for every kept variant. Older readers accept every record the new writer produces. An older record carrying a liveshare viewer principal (kind "share-viewer") now fails validation and is refused rather than misinterpreted, because its own discriminator still identifies it; no kept reader maps it to another variant.

<a id="verification"></a>
## Verification

pnpm run verify-persistence-catalog (passed on the regenerated docs/persistence-schema.json and catalogs); pnpm run verify-persistence-changes (reported the four unacknowledged roots before this record and is re-run after it); pnpm run verify-persistence-releases and verify-persistence-formats (re-run after this record).

<a id="dev-note"></a>
## Dev Note

None.
