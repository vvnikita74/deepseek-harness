---
description: "Package map for the web GUI browser half: shell boot, browser-host communication, shared client services, localization, development reload, and the UI feature plugins."
kind: "package-group"
---

# client/ — web-GUI browser half

English | [中文](README.zh.md)

## Summary

The `client/` group provides the browser experience for the dsh web GUI, including conversation, navigation, settings, approvals, file access, and other interactive features. Choose packages from this family when adding browser-visible behavior; use [`host/`](../host/README.md) for server-side page delivery and host integration. Packages cover both the shared browser foundation and focused UI features, while each child README owns its configuration and behavior. Authoring rules live in [AGENTS.md](AGENTS.md), and the related documentation below explains cross-package composition.

## Table of Contents

- [Packages](#packages)
- [Related documentation](#related-documentation)
- [Dev Note](#dev-note)

-----

<a id="packages"></a>
## Packages

The kernel packages boot and serve the page; the UI feature packages present it. Each package README owns its contract and configuration.

| Package | Role | ctx key |
|---|---|---|
| [`connection/`](connection/README.md) | Maintains browser-host RPC communication and event delivery | `ctx.connection` |
| [`file-upload/`](file-upload/README.md) | Sends raw Blob and byte-stream request bodies outside the page thread | `ctx.fileUpload` |
| [`store/`](store/README.md) | Provides React-free observable and snapshot-store primitives | — |
| [`ui-renderer/`](ui-renderer/README.md) | Binds slot data to React and mounts the assembled application | `ctx.uiRenderer` |
| [`ui-slots/`](ui-slots/README.md) | Defines typed extension Slots and reusable Component Factories | — |
| [`resources/`](resources/README.md) | Unified resource model: protocol providers behind the `useResource` session standard hook | `ctx.resources` |
| [`ui-trajectory/`](ui-trajectory/README.md) | Presents alternate views of agent activity | — |
| [`ui-plugin-manager/`](ui-plugin-manager/README.md) | Contributes the sidebar Plugins panel: install, enable, disable, retry, and compose installed packages | — |

-----

<a id="related-documentation"></a>
## Related documentation

Start with the subsystem reference and the two notes that own the cross-package composition decisions, then the host half that serves this page.

- [Slot system standard](../../.agents/notes/implemented/architecture/2026-07-22-slot-type-chain-implementation.md) — the definitive slot model: registration, props shares, and stores.
- [Web client architecture reference](../../docs/subsystems/web-client.md) — the loading chain, object layer, and client services.
- [Host group map](../host/README.md) — the host half that serves this browser half.

<a id="dev-note"></a>
## Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
