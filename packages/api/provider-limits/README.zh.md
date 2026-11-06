---
description: "向浏览器客户端提供各模型路由最近一次已知的用量窗口及其实时更新。"
kind: "package-reference"
---

# @deepseek-ai/dsh-api-provider-limits

[English](README.md) | 中文

## 概述

`providerLimits` Remote 向浏览器客户端提供每个模型路由最近一次已知的用量窗口。`get` 返回当前列表，`follow` 先推送一个快照帧，之后每次变化推送完整列表。适配器通过 `llm/provider-limits` 事件发布窗口；本包只保存每个路由的最新值，不调用任何模型服务商。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

可选配置 `balance: { provider, tokenEnv, url, intervalMs }` 每隔 `intervalMs`（默认 60 秒）使用 `tokenEnv` 指定的令牌（默认 `TIMEWEB_CLOUD_API_TOKEN`）轮询 Timeweb Cloud 的 `account/finances` 端点，并为 `provider` 发布不含窗口的 `ProviderLimits.balance`；没有令牌时不轮询。没有 `balance` 时本插件不需要配置。使用行 `{ id: 'provider-limits', name: '@deepseek-ai/dsh-api-provider-limits' }` 挂载它；Web 配置会挂载该插件。

`get()` 返回 `ProviderLimits[]`，每个至少报告过一个窗口的模型路由对应一项，按调用时刻读取。在生产者发布限额之前，它返回 `[]`。

`follow()` 先打开一个 `snapshot` 帧，内容为同一列表（列表为空时也是空列表）。每次发布限额后，它推送一个携带完整列表的 `update` 帧。读取较慢的客户端只会收到最新列表一次，而不是每次中间变化。当信号中止或插件被销毁时，流结束。

当 `resetsAt` 不晚于读取时刻的窗口，读取结果中的 `usedPercent` 为 `0`；若该窗口报告过 `status`，读取结果中的 `status` 为 `ok`。存储的值保留原始字段。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>维护者细节 — 点击展开</summary>

`src/index.ts` 为每个模型路由保存一个 `Map` 条目，键为 `provider`。`llm/provider-limits` 监听器替换该条目，并将每个打开的 follow 标记为已变化。每个 follow 持有一个变化标志：读取方忙碌时到达的事件会设置同一个标志，因此读取方的内存不会增长。`currentLimits` 是纯函数，`get` 和每个帧都在读取时使用它做归一化。`src/types.ts` 定义 `ProviderLimitsFrame`。

</details>

-----

<a id="model-experience"></a>
## 模型体验

无，因为本插件只通过 Remote 向浏览器客户端提供观察到的用量窗口；它不注册工具、提示词片段或 Session 事件，也没有模型请求会读取它的状态。

#### KV 缓存效应

没有直接影响；本插件从不改变模型请求。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与后续工作

- **只有发布限额的模型服务商会出现** — 目前只有 Anthropic 订阅账号的 pi-ai 适配器发布窗口；API 密钥和网关路由不发布，因此 `get` 不包含它们。
- **数值只保存在内存中** — 进程重启后列表为空，直到下一次模型服务商响应。
- **每个模型路由只保存一个值** — 每次发布的值替换该路由之前的窗口，不保留历史。
- **已过期的窗口按未使用读取** — 超过重置时间的窗口在下一次模型服务商响应到达之前，读取为已用 0%。

-----

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者细节 — 点击展开</summary>

无。

</details>
