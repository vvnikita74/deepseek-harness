---
description: "把一个共享的持久 Chromium 浏览器的画面、指针、按键、输入、导航与标签页串流给浏览器客户端。"
kind: "package-reference"
---

# @deepseek-ai/dsh-api-browser-view

[English](README.md) | 中文

## 概述

`browserView` Remote 持有一个 Chromium 进程，监听回环调试端口。其 profile 目录持久保存，因此 Cookie 与登录状态在 Session 与进程重启后仍然保留。`watch` 流承载被跟随标签页的内容：截屏帧、来自页面的指针、按键与输入事件、导航，以及标签页列表变化。本插件只观察浏览器：不注册工具，也不注册提示词片段，智能体无法操作它。观看端的输入不会转发到页面。

## 目录

- [使用此包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发说明](#dev-note)

-----

<a id="use-this-package"></a>
## 使用此包

在配置行中把 `executablePath` 设为 Chromium 可执行文件，并把 `userDataDir` 设为持久目录。Web profile 传入 `dshHomePath('browser-profile')`。`executablePath` 为空或省略时插件保持惰性：`state()` 返回 `disabled` 且没有标签页，`watch` 只产出这一次状态后结束。Chromium 随插件启动，监听 `port`（默认 `9333`，仅回环地址），并使用 `headless`（默认 `true`）、`noSandbox`（默认 `true`）、`viewport`（默认 `1280x800`）与 `screencast`（`quality` 60、`maxFps` 8、`maxWidth` 1280）。所有字段在启动时读取。

`state()` 返回状态（`disabled`、`starting`、`ready`、`restarting`、`failed`）、标签页（URL、标题与是否激活）以及被跟随的标签页。`watch({ targetId? })` 先产出状态，然后产出被跟随标签页或被固定 `targetId` 标签页的帧与事件。固定的 watch 在其标签页关闭时结束。被跟随的标签页是最近一次指针、按键、输入、导航、创建或 URL 变化所在的标签页。指针的 `x`、`y` 是页面视口的 CSS 像素；帧的 `metadata.deviceWidth` 与 `deviceHeight` 把它们映射到帧像素。

Chromium 在意外退出后以一秒间隔重启。累计五次启动失败或意外退出后，状态变为 `failed`，直到插件重新加载。销毁时先通过 `Browser.close` 请求 Chromium 关闭，使 Cookie 与存储写入 profile，最多等待五秒退出，再停止残留进程（先 SIGTERM，宽限期后 SIGKILL）；profile 保留。其他插件可通过 `endpoint` 获取回环来源。

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>维护者细节 — 点击展开</summary>

`src/chromium.ts` 通过 `ctx.subprocess` 启动 Chromium，并轮询 `/json/version` 直到它返回浏览器 WebSocket。`src/cdp.ts` 是基于 `ws` 的最小客户端，负责发送命令并匹配响应与事件。`src/index.ts` 启用目标发现，并以扁平会话附加每个页面目标。每个页面通过 `__dshView` 绑定接收 `src/pointer-script.ts` 的观察脚本。截屏只在 watch 显示的标签页上运行；watch 附加时还会取一张 `Page.captureScreenshot` 静态帧，因为静态页面不产生截屏帧。`src/fanout.ts` 为每个 watch 提供一个最新值优先的帧槽、一个最新状态槽，以及上限 256 项、连续移动合并的有界事件队列。生成器只在消费者请求时取下一项，因此慢速套接字不会使队列超过该上限。

</details>

-----

<a id="model-experience"></a>
## 模型体验

无。浏览器视图只观察 Chromium 及其页面，不添加工具、提示词片段或 Session 事件；页面内容只能通过其他包的常规工具路径进入模型。

#### KV 缓存影响

无直接影响；本插件从不改变模型请求。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与后续工作

- **观看端不能输入** — 观看只读；把观看端的指针与键盘事件转发到页面，需等待接管设计后再实现。
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
