---
description: "变更请求服务与 worktree Session；本分支不提供面板。"
kind: "package-bundle"
---

# @deepseek-ai/dsh-experimental-forge-bundle

[English](README.md) | 中文

## 概述

此可选 Bundle 挂载变更请求服务、GitHub 提供方和模型的工作树工具，使模型能在对话中创建 Git 工作树。本分支没有变更请求面板或输入框控件；发布的 profile 默认禁用该 Bundle。GitHub 状态来自宿主上已登录的 `gh` 命令行；创建本地工作树无需 GitHub 认证。

## 目录

- [使用本包](#use-this-package)
- [了解实现](#understand-the-implementation)
- [深入探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与待办工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

本分支没有此 Bundle 的面板、输入框控件或插件页开关，因此没有界面展示变更请求或工作树选项。在终端运行 `gh auth login --hostname <host>` 登录；GitHub 提供方使用已登录的 `gh` 命令行。

此 Bundle 挂载模型的 [`create_worktree`](../tool-worktree/README.zh.md) 工具。禁用该 Bundle 会移除此工具，已有检出目录与分支仍然保留。已选中独立工作树组合包的 profile，请在启用本组合包前按[升级指南](../../../docs/upgrade-guide/v0.2.2-alpha.2/forge-worktree-entry/guide.zh.md)调整配置。

-----

<a id="understand-the-implementation"></a>
## 了解实现

<details>
<summary>维护者细节——点击展开</summary>

组合包挂载 Forge 注册表、GitHub 提供方、Session 绑定和工作树模型工具。工具使用顶层 `worktree` 服务。这些行使用基于 base 的 profile 提供的 Session 投影、工作目录、文件系统、子进程和沙箱服务。

</details>

-----

<a id="further-exploration"></a>
## 深入探索

[Forge 子系统](../../../docs/subsystems/forge.zh.md) · [Session 绑定](../forge-session/README.zh.md)

-----

<a id="model-experience"></a>
## 模型体验

间接影响：通过 [`create_worktree`](../tool-worktree/README.zh.md#model-experience) 工具。

#### KV Cache 影响

启用或关闭组合包会改变模型的工具 schema 列表。调用追加工具结果和目录上下文；参见[工具的缓存行为](../tool-worktree/README.zh.md#model-experience)。

## 已知限制与待办工作

<a id="known-limitations-and-deferred-work"></a>

- 只有 GitHub 一个代码托管提供方，且本 Bundle 只服务 github.com；GitHub Enterprise 主机需要用 profile patch 把它列入 `forge-github` 行的 [`hosts`](../forge-github/README.zh.md#use-this-package)。没有提供方识别 GitLab 等其他平台。
- 模型目前还没有读取已绑定变更请求的工具。

-----

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
