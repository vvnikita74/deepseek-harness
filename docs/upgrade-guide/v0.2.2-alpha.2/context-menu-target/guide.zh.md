---
kind: upgrade-guide
description: "Client 插件须使用带前缀的右键菜单类型和 hook，并注册 keyed 图标组件。"
---

# 右键菜单类型和图标

[English](guide.md) | 中文

## 变更

`@deepseek-ai/dsh-client-ui-context-menu/client` 导出的 `MenuTarget` 更名为 `ContextMenuTarget`，与 `ContextMenuTargetMap` 保持一致。旧名不保留兼容别名，目标字段和运行时行为不变。工作区与侧栏注入的 `menuTarget` / `useMenuTarget` 改为 `contextMenuTarget` / `useContextMenuTarget`。操作图标改用 `{ key, src? }`，通过 keyed Slot `contextMenu.icon` 渲染，不再接收 React 节点。

## 迁移

1. 将 `MenuTarget` 导入及类型引用替换为 `ContextMenuTarget`。
2. 将注入源 `menuTarget` 和消费者 `useMenuTarget` 分别改为 `contextMenuTarget`、`useContextMenuTarget`。
4. 重新构建自定义 Client 插件，确认类型检查通过，并打开菜单验证图标渲染和插件卸载后的清理。
