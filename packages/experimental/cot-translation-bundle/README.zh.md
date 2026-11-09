---
description: "已展示思考内容的机器翻译服务；本分支不提供对应的浏览器界面。"
kind: "package-bundle"
---

# @deepseek-ai/dsh-experimental-cot-translation-bundle

[English](README.md) | 中文

## 概述

此可选 Bundle 挂载 `translator` 服务，可通过 Bing 或 Google 翻译展开的思考内容。本分支没有翻译的浏览器界面，因此启用 Bundle 不会增加可见控件。发布的 profile 默认禁用该功能。Session 与模型输入中的原始思考内容保持不变。

## 目录

- [使用本包](#use-this-package)
- [了解实现](#understand-the-implementation)
- [延伸阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

本分支没有此 Bundle 的插件页开关、翻译工具栏或思考行控件，因此没有任何界面会启动翻译。它挂载的 `translator` 服务可供调用它的代码使用。

所选服务会接收展开的思考内容，其中可能包含私有代码与对话细节。Google 和 Bing 通过 POST 请求体接收原文。Bing 和 Google 无需额外登录或 API key，但两种免登录端点均不保证可用性或免费额度。符合条件的原生 `deepseek-flash` 路由显示为显式的付费选项，使用已配置的 DeepSeek 账号或官方 API 凭据。每个未缓存片段执行一次关闭思考的独立查询。重新展开复用已保存结果；改变 Provider、语言、原文或翻译规则时可能需要再次付费查询。匹配模型 ID 时不限制版本号，且排除 pi-ai 路由。Provider 失败后不会自动将文本发送给其他服务。

-----

<a id="understand-the-implementation"></a>
## 了解实现

<details>
<summary>维护者细节 — 点击展开</summary>

Bundle 补丁插入 `translator` 行。Translator 负责 Provider 协议、网络限制及统一持久保存的请求与结果。随前端一起移除的浏览器消费者曾负责段落调度和当前展示使用的本地缓存。翻译包装与 Chat 默认 Body 条目均调用官方思考 Content Factory。

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

[文本翻译子系统](../../../docs/subsystems/translation.zh.md) · [Translator 服务](../translator/README.zh.md)

-----

<a id="model-experience"></a>
## 模型体验

间接影响来自可选的独立付费 Flash 请求，以及缓存未命中时的正常 Session 激活；translator 负责翻译提示词，Session 的 preset 负责启动上下文。

#### KV Cache 效果

翻译记录保留原始思考内容；本分支没有触发翻译的消费者，因此该 Bundle 不增加请求缓存影响。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- 本分支中没有任何界面启动翻译，在消费者调用 translator 服务之前，该 Bundle 没有可见效果。
- 免登录 Google 和 Bing 浏览器端点可能失败、限制请求或更改响应格式。中国大陆连通性取决于部署的网络与代理配置。成功译文在移除 Bundle 或重启后仍保留在 Session 中。实验性记录在未来 Session 格式迁移中仅提供尽力保留。

-----

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

无。

</details>
