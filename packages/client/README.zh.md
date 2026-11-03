---
description: "web GUI 浏览器侧的包映射：外壳启动、浏览器与宿主通信、共享客户端服务、本地化、开发重载与 UI 功能插件。"
kind: "package-group"
---

# client/ — Web GUI 浏览器侧

[English](README.md) | 中文

## 概述

`client/` 组提供 dsh web GUI 的浏览器体验，包括对话、导航、设置、批准、文件访问及其他交互功能。添加浏览器中可见的行为时，请选择本系列中的包；服务端页面交付与宿主集成则使用 [`host/`](../host/README.zh.md)。本系列同时涵盖共享浏览器基础与专门的 UI 功能，各子包 README 拥有其配置与行为说明。编写规则见 [AGENTS.md](AGENTS.md)，下方相关文档解释跨包组合方式。

## 目录

- [包](#packages)
- [相关文档](#related-documentation)
- [开发备注](#dev-note)

-----

<a id="packages"></a>
## 包

内核包负责启动与服务于页面，UI 功能包负责呈现页面。各包的 README 拥有自己的约定与配置。

| 包 | 职责 | ctx 键 |
|---|---|---|
| [`connection/`](connection/README.zh.md) | 维护浏览器与宿主之间的 RPC 通信与事件投递 | `ctx.connection` |
| [`file-upload/`](file-upload/README.zh.md) | 在页面线程之外发送原始 Blob 与字节流请求体 | `ctx.fileUpload` |
| [`store/`](store/README.zh.md) | 提供不依赖 React 的 observable 与快照存储原语 | — |
| [`ui-renderer/`](ui-renderer/README.zh.md) | 将 slot 数据绑定到 React，并挂载组装完成的应用 | `ctx.uiRenderer` |
| [`ui-slots/`](ui-slots/README.zh.md) | 定义类型化扩展 Slots 与可复用 Component Factory | — |
| [`resources/`](resources/README.zh.md) | 统一资源模型：`useResource` 会话标准钩子背后的协议提供方 | `ctx.resources` |
| [`ui-trajectory/`](ui-trajectory/README.zh.md) | 提供 agent（智能体）活动的其他视图 | — |
| [`ui-plugin-manager/`](ui-plugin-manager/README.zh.md) | 贡献侧栏的“插件”面板：安装、启用、停用、重试与组合已安装的包 | — |

-----

<a id="related-documentation"></a>
## 相关文档

先从子系统参考与两份拥有跨包组合决策的 Agent Note 读起，再看服务于本页的宿主半侧。

- [slot 系统标准](../../.agents/notes/implemented/architecture/2026-07-22-slot-type-chain-implementation.zh.md)——权威 slot 模型：注册、props 份额与存储。
- [web 客户端架构 reference](../../docs/subsystems/web-client.zh.md)——加载链、对象层与客户端服务。
- [宿主组地图](../host/README.zh.md)——服务于本浏览器半侧的宿主半侧。

<a id="dev-note"></a>
## 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
