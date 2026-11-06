---
description: "Serve the last known provider usage windows and their live updates to browser clients."
kind: "package-reference"
---

# @deepseek-ai/dsh-api-provider-limits

English | [中文](README.zh.md)

## Summary

The `providerLimits` Remote serves the last known usage windows of each provider route to browser clients. `get` returns the current list, and `follow` streams a snapshot followed by the full list after each change. Adapters publish windows through the `llm/provider-limits` event; this package stores the latest value per route and calls no provider.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Optional config `balance: { provider, tokenEnv, url, intervalMs }` polls the Timeweb Cloud `account/finances` endpoint every `intervalMs` (default 60 s) with the token named by `tokenEnv` (default `TIMEWEB_CLOUD_API_TOKEN`) and publishes `ProviderLimits.balance` for `provider` with no windows; without the token nothing is polled. Without `balance` the plugin takes no configuration. Mount it with the row `{ id: 'provider-limits', name: '@deepseek-ai/dsh-api-provider-limits' }`; the Web profile mounts it.

`get()` returns `ProviderLimits[]`, one entry per provider route that reported at least one window, as read at call time. It returns `[]` until a producer publishes limits.

`follow()` opens with a `snapshot` frame that carries the same list, including an empty list. After each published limit it sends an `update` frame that carries the full list. A reader that pulls slowly receives the latest list once, not every intermediate change. The stream ends when its signal aborts or the plugin is disposed.

A window whose `resetsAt` is not after the read instant reads as `usedPercent: 0`; when the window reported a `status`, the read reports `ok`. The stored value keeps its original fields.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Maintainer details — click to expand</summary>

`src/index.ts` keeps one `Map` entry per provider route, keyed by `provider`. The `llm/provider-limits` listener replaces the entry and marks every open follow as changed. Each follow holds one changed flag: events that arrive while the reader is busy set the same flag, so the reader's memory does not grow. `currentLimits` is the pure read-time normalization used by `get` and by every frame. `src/types.ts` defines `ProviderLimitsFrame`.

</details>

-----

<a id="model-experience"></a>
## Model Experience

None, as the plugin only serves observed usage windows to browser clients over Remote; it registers no tools, prompt sections, or Session events, and no model request reads its state.

#### KV Cache effect

No direct effect; the plugin never changes a model request.

## Known Limitations and Deferred Work

- **Only providers that publish limits appear** — today only the pi-ai adapter for Anthropic subscription accounts publishes windows; API-key and gateway routes publish none, so `get` omits them.
- **Values live in memory** — a restart empties the list until the next provider response.
- **One value per provider route** — each published value replaces the earlier windows of its route; no history is kept.
- **Expired windows read as unused** — a window that passed its reset reads as 0% used until a new provider response arrives.

-----

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Maintainer details — click to expand</summary>

None.

</details>
