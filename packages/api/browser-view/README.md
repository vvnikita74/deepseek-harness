---
description: "Stream one shared persistent Chromium browser to browser clients: frames, pointer, keys, input, navigation, and tabs."
kind: "package-reference"
---

# @deepseek-ai/dsh-api-browser-view

English | [中文](README.zh.md)

## Summary

The `browserView` Remote owns one Chromium process on a loopback debugging port. Its profile directory persists, so cookies and logins survive Session and process restarts. The `watch` stream carries what the followed tab shows: screencast frames, pointer, key, and input events from the page, navigation, and tab roster changes. The plugin only observes the browser: it registers no tools and no prompt sections, and the agent cannot drive it. Input from the watching client is not forwarded to the page.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount the row with `executablePath` set to a Chromium executable and `userDataDir` set to a persistent directory. The Web profile passes `dshHomePath('browser-profile')`. An empty or omitted `executablePath` keeps the plugin inert: `state()` reports `disabled` with no tabs, and `watch` yields that state once and ends. Chromium starts when the plugin starts, on `port` (default `9333`, loopback only), with `headless` (default `true`), `noSandbox` (default `true`), `viewport` (default `1280x800`), and `screencast` (`quality` 60, `maxFps` 8, `maxWidth` 1280). Every field is read at start.

`state()` returns the status (`disabled`, `starting`, `ready`, `restarting`, `failed`), the tabs with their URL, title, and active flag, and the followed tab. `watch({ targetId? })` yields the state first, then frames and events of the followed tab, or of the pinned `targetId`. A pinned watch ends when its tab closes. The followed tab is the one with the most recent pointer, key, input, navigation, creation, or URL change. Pointer `x` and `y` are CSS pixels of the page viewport; a frame's `metadata.deviceWidth` and `deviceHeight` map them to frame pixels.

Chromium restarts after an unexpected exit, one second apart. After five launch failures or unexpected exits, status becomes `failed` until the plugin reloads. Disposal asks Chromium to close through `Browser.close`, which commits cookies and storage to the profile, waits up to five seconds for it to exit, then stops whatever remains (SIGTERM, then SIGKILL after a short grace); the profile is kept. The loopback origin is exposed to other plugins as `endpoint`.

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Maintainer details — click to expand</summary>

`src/chromium.ts` starts Chromium through `ctx.subprocess` and polls `/json/version` until it reports the browser WebSocket. `src/cdp.ts` is a minimal client over `ws`: it sends commands and matches responses and events. `src/index.ts` enables target discovery and attaches every page target with flattened sessions. Each page receives the observer from `src/pointer-script.ts` through the `__dshView` binding. Screencast runs only on the tabs that a watch shows; a watch also takes one `Page.captureScreenshot` still when it attaches, because static pages emit no screencast frames. `src/fanout.ts` gives each watch one latest-wins frame slot, one latest state slot, and a bounded event queue of 256 items that coalesces consecutive moves. The generator pulls the next item only when the consumer asks for it, so a slow socket never grows the queue beyond that bound.

</details>

-----

<a id="model-experience"></a>
## Model Experience

None, as the browser view observes Chromium and its pages without tools, prompt sections, or Session events; page content reaches a model only through the ordinary tool path of another package.

#### KV Cache effect

No direct effect; the plugin never changes a model request.

## Known Limitations and Deferred Work

- **No input from the viewer** — watching is read-only; forwarding a viewer's pointer and keyboard events to the page is deferred until a take-control design exists.
- **Navigation title may lag** — a `navigation` event carries the title known at commit time; the settled title arrives in the next `state` event.
- **No security filtering** — the stream carries whatever the page shows, including typed text outside password fields and any credentials on screen.
- **Loopback debugging port is unauthenticated** — any local process can drive the browser through `endpoint`; keep the port on loopback and do not expose it.
- **Profile flush needs an ordered teardown** — cookies and storage reach the profile only when the plugin disposes before the subprocess service that owns Chromium; a composition that tears both down at once lets the subprocess service kill Chromium before `Browser.close` commits. Unclean exits (SIGKILL, power loss) can lose the most recent writes.
- **Single browser** — one Chromium serves the whole deployment; there is no per-Session browser.

-----

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Maintainer details — click to expand</summary>

None.

</details>
