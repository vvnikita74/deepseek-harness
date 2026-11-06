---
description: "把一个共享的持久 Chromium 浏览器的画面、指针、按键、输入、导航与标签页串流给浏览器客户端。"
kind: "package-reference"
---

# @deepseek-ai/dsh-api-browser-view

[English](README.md) | 中文

## 概述

`browserView` Remote 持有一个 Chromium 进程，监听回环调试端口。其 profile 目录持久保存，因此 Cookie 与登录状态在 Session 与进程重启后仍然保留。`watch` 流承载被跟随标签页的内容：截屏帧、来自页面的指针、按键与输入事件、导航，以及标签页列表变化。观看者还能操作被跟随的标签页：`input` 转发一个指针、滚轮、按键、文本或导航事件，观看者持有控制权期间，智能体的对应浏览器工具会等待。本插件不注册工具，也不注册提示词片段，因此智能体不会因它获得任何浏览器操作能力。

## 目录

- [使用此包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发说明](#dev-note)

-----

<a id="use-this-package"></a>
## 使用此包

在配置行中把 `executablePath` 设为 Chromium 可执行文件，并把 `userDataDir` 设为持久目录。Web profile 传入 `dshHomePath('browser-profile')`。`executablePath` 为空或省略时插件保持惰性：`state()` 返回 `disabled` 且没有标签页，`watch` 只产出这一次状态后结束。Chromium 随插件启动，监听 `port`（默认 `9333`，仅回环地址），并使用 `headless`（默认 `true`）、`noSandbox`（默认 `true`）、`viewport`（默认 `1600x900`）、`deviceScaleFactor`（默认 `1`，取值 1 到 4）、`userControlIdleMs`（默认 `10000`）、`agentToolPrefixes`（默认 `['mcp__playwright-mcp__']`），以及 `screencast`（`quality` 80、`maxFps` 10、`maxWidth` 1600）。所有字段在启动时读取。

视口通过模拟覆盖（`Emulation.setDeviceMetricsOverride`）固定，因为无头 Chromium 否则会为自身界面保留一部分窗口。因此页面视口与 `viewport` 一致。`--force-device-scale-factor` 把设备像素比设为 `deviceScaleFactor`；截屏每个 CSS 像素只携带这么多帧像素，且上限为 `maxWidth`，因此要获得更清晰的帧，请把 `maxWidth` 设为 `viewport.width * deviceScaleFactor`。

`state()` 返回状态（`disabled`、`starting`、`ready`、`restarting`、`failed`）、标签页（URL、标题与是否激活）以及被跟随的标签页。`watch({ targetId? })` 先产出状态，然后产出被跟随标签页或被固定 `targetId` 标签页的帧与事件。固定的 watch 在其标签页关闭时结束。被跟随的标签页是最近一次指针、按键、输入、导航、创建或 URL 变化所在的标签页。指针的 `x`、`y` 是页面视口的 CSS 像素；帧的 `metadata.deviceWidth` 与 `deviceHeight` 把它们映射到帧像素。

`input({ targetId, event })` 把一个事件以用户操作的方式转发到已打开的标签页，`release()` 立即交还控制权。每次 `input` 在该标签页的会话上发送恰好一条 CDP 命令，并持有用户控制权（见下文）。坐标为页面视口的 CSS 像素；`modifiers` 为位掩码：Alt 1、Ctrl 2、Meta 4、Shift 8。无效请求以 `gateway/bad-request` 失败；`targetId` 不是已打开的标签页时以 `browser-view/tab-not-found` 失败。

| 事件 | 字段 | CDP 命令 |
|---|---|---|
| `mouse` | `action`（`move`、`down`、`up`）、`x`、`y`；可选 `button`、`buttons`、`clickCount`（0 到 3）、`modifiers` | `Input.dispatchMouseEvent` |
| `wheel` | `x`、`y`、`deltaX`、`deltaY`；可选 `modifiers` | `Input.dispatchMouseEvent`（`mouseWheel`） |
| `key` | `action`（`down`、`up`）、`key`、`code`、`keyCode`（0 到 255）；可选 `text`（至多 8 个字符，回车为 `'\r'`）、`modifiers` | `Input.dispatchKeyEvent` |
| `text` | `text`（1 到 20000 个字符） | `Input.insertText` |
| `navigate` | `url`（仅 `http:` 或 `https:`） | `Page.navigate` |

按住 Ctrl 或 Meta 加 `a`、`z`、`y` 分别执行全选、撤销、重做；Ctrl+Shift+Z 为重做。复制、剪切与粘贴不会转发到页面：页面剪贴板不属于用户，粘贴的文本以 `text` 事件到达。

用户控制会暂停智能体的浏览器工具。观看者持有控制权期间，名称以 `agentToolPrefixes` 中某项开头的智能体工具调用会等待而不是失败，控制结束后从停下处继续。每次 `input` 持有控制权，直到 `userControlIdleMs` 时间内没有新的输入，或调用 `release()`。watch 会推送每次变化，`state().userControl` 报告当前状态。等待期间调用的信号中止时，该调用返回取消。

Chromium 在意外退出后以一秒间隔重启。累计五次启动失败或意外退出后，状态变为 `failed`，直到插件重新加载。销毁时先通过 `Browser.close` 请求 Chromium 关闭，使 Cookie 与存储写入 profile，最多等待五秒退出，再停止残留进程（先 SIGTERM，宽限期后 SIGKILL）；profile 保留。其他插件可通过 `endpoint` 获取回环来源。

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>维护者细节 — 点击展开</summary>

`src/chromium.ts` 通过 `ctx.subprocess` 启动 Chromium，并轮询 `/json/version` 直到它返回浏览器 WebSocket。`src/cdp.ts` 是基于 `ws` 的最小客户端，负责发送命令并匹配响应与事件。`src/index.ts` 启用目标发现，并以扁平会话附加每个页面目标。每个页面通过 `__dshView` 绑定接收 `src/pointer-script.ts` 的观察脚本。截屏只在 watch 显示的标签页上运行；watch 附加时还会取一张 `Page.captureScreenshot` 静态帧，因为静态页面不产生截屏帧。`src/fanout.ts` 为每个 watch 提供一个最新值优先的帧槽、一个最新状态槽，以及上限 256 项、连续移动合并的有界事件队列。生成器只在消费者请求时取下一项，因此慢速套接字不会使队列超过该上限。`src/input.ts` 用 zod 校验每个 `input` 请求，并把它映射为恰好一条 CDP 命令；该模块不做 I/O。`src/index.ts` 持有用户控制租约：`input` 开始或延长控制，`release()`、空闲计时器或浏览器丢失会结束控制，`tools/pre-execute` 监听器则在控制期间让匹配的工具调用等待。

</details>

-----

<a id="model-experience"></a>
## 模型体验

间接影响，通过智能体对应的浏览器工具调用：用户持有控制权时这些调用会等待，因此调用可能晚些开始，其结果也可能反映这段时间内用户发出的输入；不会新增或改变提示词片段、工具 schema 或 Session 事件，因此请求结构保持不变。

#### KV 缓存影响

无直接影响；本插件从不改变模型请求。延后返回的工具结果仍进入上下文的同一位置，因此缓存前缀不变。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与后续工作

- **暂停是全局的，按名称前缀匹配** — 用户控制会暂停所有标签页，且只作用于名称以 `agentToolPrefixes` 开头的工具；其他浏览器提供方必须加入该列表。
- **持续输入会让智能体一直等待** — 每次输入（包括鼠标移动）都会延长持有时间，因此持续移动指针的用户会让智能体持续等待。
- **并发操作不做隔离** — 智能体与用户可能同时操作同一页面；除暂停外，本插件不再串行化两者。
- **不转发剪贴板快捷键** — 复制、剪切与粘贴不会发送到页面；粘贴的文本以 `text` 事件到达。
- **导航标题可能滞后** — `navigation` 事件携带提交时已知的标题；稳定后的标题在下一条 `state` 事件中到达。
- **没有安全过滤** — 串流包含页面显示的全部内容，包括密码框之外输入的文字以及屏幕上的任何凭据。
- **回环调试端口未鉴权** — 任何本地进程都可通过 `endpoint` 操作浏览器；请保持端口仅监听回环地址，不要对外暴露。
- **profile 落盘依赖有序销毁** — 只有当本插件先于拥有 Chromium 的子进程服务销毁时，Cookie 与存储才会写入 profile；若组合同时销毁两者，子进程服务可能在 `Browser.close` 提交前杀死 Chromium。非正常退出（SIGKILL、断电）可能丢失最近的写入。
- **单个浏览器** — 整个部署共用一个 Chromium，没有按 Session 划分的浏览器。

-----

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者细节 — 点击展开</summary>

无。

</details>
