---
description: "Stream one shared persistent Chromium browser to browser clients: frames, pointer, keys, input, navigation, and tabs."
kind: "package-reference"
---

# @deepseek-ai/dsh-api-browser-view

English | [中文](README.zh.md)

## Summary

The `browserView` Remote owns one Chromium process on a loopback debugging port. Its profile directory persists, so cookies and logins survive Session and process restarts. The `watch` stream carries what the followed tab shows: screencast frames, pointer, key, and input events from the page, navigation, and tab roster changes. A viewer can also act on the followed tab: `input` forwards one pointer, wheel, key, text, or navigation event, and while a viewer holds control the agent's matching browser tools wait. The plugin registers no tools and no prompt sections, so the agent gains no browser actions from it.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount the row with `executablePath` set to a Chromium executable and `userDataDir` set to a persistent directory. The Web profile passes `dshHomePath('browser-profile')`. An empty or omitted `executablePath` keeps the plugin inert: `state()` reports `disabled` with no tabs, and `watch` yields that state once and ends. Chromium starts when the plugin starts, on `port` (default `9333`, loopback only), with `headless` (default `true`), `noSandbox` (default `true`), `viewport` (default `1600x900`), `deviceScaleFactor` (default `1`, 1 to 4), `userControlIdleMs` (default `10000`), `agentToolPrefixes` (default `['mcp__playwright-mcp__']`), and `screencast` (`quality` 80, `maxFps` 10, `maxWidth` 1600). Every field is read at start.

The viewport is forced with an emulation override (`Emulation.setDeviceMetricsOverride`), because headless Chromium otherwise keeps part of the window for its own UI. The page viewport therefore matches `viewport`. `--force-device-scale-factor` sets the device pixel ratio to `deviceScaleFactor`; the screencast carries that many frame pixels per CSS pixel only up to `maxWidth`, so set `maxWidth` to `viewport.width * deviceScaleFactor` for sharper frames.

`state()` returns the status (`disabled`, `starting`, `ready`, `restarting`, `failed`), the tabs with their URL, title, and active flag, and the followed tab. `watch({ targetId? })` yields the state first, then frames and events of the followed tab, or of the pinned `targetId`. A pinned watch ends when its tab closes. The followed tab is the one with the most recent pointer, key, input, navigation, creation, or URL change. Pointer `x` and `y` are CSS pixels of the page viewport; a frame's `metadata.deviceWidth` and `deviceHeight` map them to frame pixels.

`input({ targetId, event })` forwards one event to an open tab as a user would produce it, and `release()` gives control back at once. Each `input` sends exactly one CDP command on the tab's session and holds user control (see below). Coordinates are CSS pixels of the page viewport, and `modifiers` is a bit mask: Alt 1, Ctrl 2, Meta 4, Shift 8. Invalid requests fail with `gateway/bad-request`, and a `targetId` that is not an open tab fails with `browser-view/tab-not-found`.

| Event | Fields | CDP command |
|---|---|---|
| `mouse` | `action` (`move`, `down`, `up`), `x`, `y`; optional `button`, `buttons`, `clickCount` (0 to 3), `modifiers` | `Input.dispatchMouseEvent` |
| `wheel` | `x`, `y`, `deltaX`, `deltaY`; optional `modifiers` | `Input.dispatchMouseEvent` (`mouseWheel`) |
| `key` | `action` (`down`, `up`), `key`, `code`, `keyCode` (0 to 255); optional `text` (at most 8 characters, `'\r'` for Enter), `modifiers` | `Input.dispatchKeyEvent` |
| `text` | `text` (1 to 20000 characters) | `Input.insertText` |
| `navigate` | `url` (`http:` or `https:` only) | `Page.navigate` |

Ctrl or Meta with `a`, `z`, or `y` runs select all, undo, or redo, and Ctrl+Shift+Z redoes. Copy, cut, and paste are not forwarded: the page clipboard is not the user's, and pasted text arrives as a `text` event.

User control pauses the agent's browser tools. While a viewer holds control, each agent tool call whose name starts with an `agentToolPrefixes` entry waits instead of failing, and resumes where it stopped once control ends. Control is held from an `input` until `userControlIdleMs` passes without another one, or until `release()`. The watch publishes each change, and `state().userControl` reports it. A call whose signal aborts while it waits returns a cancellation.

Chromium restarts after an unexpected exit, one second apart. After five launch failures or unexpected exits, status becomes `failed` until the plugin reloads. Disposal asks Chromium to close through `Browser.close`, which commits cookies and storage to the profile, waits up to five seconds for it to exit, then stops whatever remains (SIGTERM, then SIGKILL after a short grace); the profile is kept. The loopback origin is exposed to other plugins as `endpoint`.

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Maintainer details — click to expand</summary>

`src/chromium.ts` starts Chromium through `ctx.subprocess` and polls `/json/version` until it reports the browser WebSocket. `src/cdp.ts` is a minimal client over `ws`: it sends commands and matches responses and events. `src/index.ts` enables target discovery and attaches every page target with flattened sessions. Each page receives the observer from `src/pointer-script.ts` through the `__dshView` binding. Screencast runs only on the tabs that a watch shows; a watch also takes one `Page.captureScreenshot` still when it attaches, because static pages emit no screencast frames. `src/fanout.ts` gives each watch one latest-wins frame slot, one latest state slot, and a bounded event queue of 256 items that coalesces consecutive moves. The generator pulls the next item only when the consumer asks for it, so a slow socket never grows the queue beyond that bound. `src/input.ts` validates each `input` request with a zod schema and maps it to exactly one CDP command; it does no I/O. `src/index.ts` owns the user-control lease: `input` starts or extends it, `release()`, the idle timer, or losing the browser ends it, and a `tools/pre-execute` listener makes matching tool calls wait while it is held.

</details>

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through the agent's matching browser tool calls, which wait while a user holds control, so a call can start later and its result can reflect input the user sent meanwhile; no prompt section, tool schema, or Session event changes, so the request structure stays the same.

#### KV Cache effect

No direct effect; the plugin never changes a model request. A delayed tool result enters the context at the same position, so the cache prefix is unchanged.

## Known Limitations and Deferred Work

- **Pause is global and prefix-based** — user control pauses every tab and only tool names that start with `agentToolPrefixes`; other browser providers must be added to that list.
- **Sustained input holds the agent** — every input, mouse moves included, extends the hold, so a user who keeps moving the pointer keeps the agent waiting.
- **Concurrent actions are not isolated** — the agent and a user can act on the same page at once; beyond the pause, the plugin does not serialize them.
- **Clipboard shortcuts are not forwarded** — copy, cut, and paste are not sent to the page; pasted text arrives as a `text` event.
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
