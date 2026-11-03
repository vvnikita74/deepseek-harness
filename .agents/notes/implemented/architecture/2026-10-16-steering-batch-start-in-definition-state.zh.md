# Agent Note: 在 Conversation Node Definition 的 State 中预计算插话批首

Status: implemented

[English](2026-10-16-steering-batch-start-in-definition-state.md) | 中文

## 问题

Chat 在每次 claim 的第一条插话行上方保留 44px 的位置（等于运行状态行的高度），条件是这批插话落在运行中 Turn 的过程输出之后；这样插话被领取时，运行状态与气泡交换位置，气泡不动（conversation-nodes README）。判断一条插话是否是批首，需要两个它自己的 `user/message` 事件里没有的事实：它是否是所在 `next-step` claim 的第一条人类消息；同一 Turn 在它之前是否已有持久可见的输出，也就是这一行是否排在 Turn 过程控件之后。结论在实时追加、回放和加载更早历史时都必须成立，并且不能扫描事件窗口或 Chat Node。

## 决策

批首是 Conversation Node State 中的事实，由 Definition 通过现有的 [`reader.previous`](2026-08-09-client-conversation-node-assembly.zh.md) 查询计算：

- 插话渲染器只读取 `data.batchStart`，在气泡根元素上写 `data-chat-steering-batch="start"`；CSS 给所在行保留这个位置。

每条领头的人类消息做一次 O(log N) 查询，N 为已加载窗口中有输出的 Step 数。这一改动不新增框架 API，也不涉及持久化或传输数据。

## 考虑过的替代方案

**在渲染器里根据 props 计算。** 渲染器需要相邻行和 Turn 的过程状态，这会把插话分支带进本应不含业务的节点列表和 Seat；而且只有相邻行变化时，这一行不会重新渲染。

**在 Chat 快照构建层计算。** 对有序条目做一次投影，会把插话专用的规则和额外一轮遍历放进通用构建层。

**给框架增加带追踪的 Turn 数据读取（`reader.turnData`）。** 为了一个使用方修改 `ConversationNodeBuildReader` 的约定和组装器的依赖追踪；而 `reader.previous` 已经提供所需的顺序、依赖与重放。

## 后果

结论保存在节点数据中，借助现有依赖追踪在回放和加载更早历史时保持正确；渲染器、Seat、节点列表和 ui-conversation 框架都不变。代价是多一个 Definition，每个有输出的 Step 多一个 Context：每个 State 只有一个数字，每个 Context 持有该 Step 证据事件的引用。保留的位置跟随 claim 的第一条人类消息，而不是该批第一条渲染出来的行；因此同一次 claim 中记录在它之前的 runtime-context 通知会排在这个位置上方；这由 README 中“claim 的第一条人类消息保留该位置”的规则推出。

## 测试
