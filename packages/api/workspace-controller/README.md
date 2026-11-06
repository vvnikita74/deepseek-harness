---
description: "Host and Client workspace control: mutate workspace navigation and follow its complete projection."
kind: "package-reference"
---
# Workspace Controller

English | [中文](README.zh.md)

## Summary

`@deepseek-ai/dsh-api-workspace-controller` owns the Host `ctx.workspaceController` service and the generated Client `ctx.remote.workspace` namespace. Its Remote methods create, rename, remove, destroy, and reorder Workspaces, reorder Sessions within a Workspace, archive and unarchive Sessions from Workspace navigation, and follow the complete Workspace projection. Use it through API Gateway when a Client must change or follow Workspace navigation. The package also owns `ctx.directoryPickerController` and the generated `ctx.remote.directoryPicker` namespace, because the directory-picking seam it carries is abstract and never a Loader entry of its own.

## Table of Contents

- [Use this package](#use-this-package)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

The Host controller serializes mutations whose correctness depends on current registry state and throws `RemoteError` with a stable error code for expected failures. Its `follow()` stream synchronously attaches to durable Workspace changes, emits one complete baseline first, then emits ordered `upsert`, `remove`, `order`, `archived`, and `pinned` increments. Archive and pin sets are Session id arrays, with the most recently pinned id first in the pin array. A reconnect starts another generation with a replacement baseline, so consumers do not depend on receiving every increment while disconnected. `archiveSession` without `stopActivity` refuses a Session with running work as `workspace/session-active`, whose details list that work by family (`turn`, `subagent`, `job`, `schedule`) with item ids and labels; with `stopActivity: true` the registry's providers stop the work first and the response arrives once the archive set is durable, while the stops settle in the background.

The controller injects `remoteAccess` and registers the `workspace` resource kind with the default field `workspaceId` through `typert.resources`. `workspace/follow` reads no resource, so its call touches the `global` resource: a Peer whose principal is not the owner may follow it only when its principal kind's policy in [`dsh-api-remote-access`](../remote-access/README.md) binds a `global` role listing the action. For that caller, the baseline, `upsert` frames, and `order` ids keep only the Workspaces `ctx.remoteAccess.allows()` admits as `workspace` resources, and only the Session ids it admits as `session` resources, within each Workspace and in the archived and pinned sets, so `workspace` and `session` roles list the same action. The stream tracks the Workspaces it delivered. When one is no longer admitted at its next change or in a new order, the stream sends a `replace` increment carrying the complete filtered state instead of a `remove`, because a removed id is never resurrected on the Client; `replace` is an ordinary increment that the Client applies like an opening baseline, not the start of a new generation, so it neither reports an error nor reconnects; once access returns, the Workspace reappears through an ordinary `upsert`. A `remove` frame reports a deletion and reaches only a caller that received that Workspace. Owner frames are unfiltered.

The Client entry provides `ClientWorkspaceModel` and `createWorkspaceStateStream()`. The model owns Workspace rows, registry order, archived and pinned Session identities, unary mutation echoes, and stream/unary race resolution. A newer Host row wins by `updatedAt`; a committed stream order outranks an older unary response; a removed Workspace id cannot be resurrected by delayed data. Pin snapshots change only when their identities or order change. The package exposes framework-neutral snapshots and subscriptions, leaving navigation policy and React hooks to the UI owner. `WorkspaceController.archiveSession(sessionId, { stopActivity })` throws `WorkspaceArchiveError` with the Host's `rpcError`, so a surface can tell the running-work refusal from a missing Session or a carrier fault and offer to stop the work.

<a id="destroy-workspace"></a>
### Destroy a Workspace

`workspace/destroy` irreversibly deletes one Workspace, its directory, and its Sessions. Its request is `{ workspaceId, confirmTitle }`; `confirmTitle` must equal the Workspace title exactly, without trimming or case folding, and any other value fails as `workspace/confirm-mismatch` with nothing changed. Its value is `{ deleted: true, removedSessions, deferredSessions: 0, removedFiles }`; `deferredSessions` is always 0 and stays so the browser contract does not change. `removedFiles` is false when the directory was already gone.

The command runs as one serialized operation in this order:

1. Resolve the Workspace id; an unknown id fails as `workspace/not-found`.
2. Confirm the title.
3. Resolve the directory to its canonical path and apply the protection rules; a directory that is already gone skips this step and the file removal. A violation fails as `workspace/path-protected`, with the canonical path in `details`.
4. Collect the Sessions to delete: the Workspace's accounted Sessions plus every stored Session whose `cwd` lies inside the Workspace path or its canonical directory. Only Sessions with a stored log are kept.
5. Delete the Sessions through `ctx.sessionController.deleteSessions`. A Session with running work fails as `workspace/session-active`, with its `sessionId` and `activity` in `details`; any other failure fails as `workspace/destroy-failed`.
6. Remove the directory recursively. A failure fails as `workspace/destroy-failed`.
7. Remove the registration. A failure fails as `workspace/destroy-failed`.

Protection rules apply in step 3. A canonical directory is refused when it has fewer than three non-empty path segments, when it equals or contains the Host user's home directory, the harness home, or the Host process working directory, or when it equals or contains the canonical path of another registered Workspace. Each protected path is resolved with `realpath`, and a protected path that does not exist is skipped.

A `workspace/destroy-failed` error reports `removedFiles` and `removedSessions`. Sessions removed before the failing step stay removed, and the registration stays. A retry is safe: when the directory is already gone, the retry skips the file removal and removes the registration. A failure in step 6 can leave part of the directory tree removed.

When the registered path is a symbolic link, only the link is removed; the target directory and its files stay. Protection and Session collection use the resolved target. Attachments under the harness home are shared and are not removed.

`workspace/delete` removes only the registration and keeps the directory and Sessions; `workspace/destroy` removes all three.

<a id="first-use-workspace"></a>
### First-use Workspace

`workspace.initializeDefault()` returns the durable default Workspace; the Client service exposes it as `workspaces.initializeDefault(signal?)`. It takes no request: the Host owns the fixed `default-workspace` directory name, and the registry derives the initial title from that same segment, so one installation keeps one on-disk path and one stored title in every language. The Host places the directory under its account's `<Documents>/deepseek-harness`, including on remote Web hosts. OS filename restrictions apply. Linux system lookup requires `xdg-user-dir` with an enabled Documents directory; hosts without it must configure `documentsDirectory` or use the folder picker.

The [Workspace registry](../../workspace/workspace/README.md#first-use-workspace) owns eligibility, directory creation, and durable initialization. An existing default Workspace is returned without another Documents lookup and is never renamed or relocated. Ineligible first use returns `undefined`, so startup can leave directory selection to the user. Lookup and creation failures use standard Remote error handling. Initialization creates no Session and sends no message.

`DEFAULT_WORKSPACE_DIRECTORY` and `workspaceDisplayTitle(title, localizedDefault)` are published from `./default-workspace` for browser consumers: a Workspace still carrying the automatic title reads as the reader's localized default name, and every other title reads verbatim. A Workspace the user renamed to exactly `default-workspace` — or a folder of that name adopted from the picker — is labeled as the default; nothing else depends on the distinction.

| Configuration | Default | Purpose |
| --- | --- | --- |
| `documentsDirectory` | System Documents directory | Fully qualified Host directory override |
| `documentsLookupTimeoutMs` | `10000` | Positive maximum duration of OS directory lookup, in milliseconds |

Documents lookup holds the registry mutation queue, so other Workspace mutations, including registration of a picked directory, can wait up to `documentsLookupTimeoutMs`. Cancellation can stop the lookup; after resolution succeeds, it does not roll back creation or registration.

-----

<a id="model-experience"></a>
## Model Experience

None, as Workspace organization is browser and Host control state and registers no prompt, tool, or session event.

#### KV Cache effect

No direct effect; Workspace mutations do not alter model requests.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- `follow()` replaces the whole projection after reconnect and has no durable cursor or incremental catch-up protocol.
- Process-local deletion markers prevent delayed data from reviving a removed Workspace only for the lifetime of the Client model.
- `workspace/destroy` checks the directory and then removes it; a process that renames the path between those steps can make the removal target a different directory.


<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
