# Agent Note: Precompute the steering batch start in Conversation Node Definition state

Status: implemented

English | [中文](2026-10-16-steering-batch-start-in-definition-state.zh.md)

## Problem

Chat keeps a 44px slot, the height of the running status row, above the first steering row of each claim that lands after the running Turn's process output, so admitting steering swaps the status and the bubble without moving the bubble (conversation-nodes README). Deciding that a steering row starts such a batch needs two facts its own `user/message` event does not carry: whether it is the first human message of its `next-step` claim, and whether the same Turn already has durable visible output before it, which places the row after the Turn's process control. The answer must hold for live appends, replay, and loading earlier history, and must not scan the event window or the Chat Nodes.

## Decision

The batch start is a fact in Conversation Node State, computed by Definitions through the existing [`reader.previous`](2026-08-09-client-conversation-node-assembly.md) lookup:

- The steering renderer reads only `data.batchStart` and writes `data-chat-steering-batch="start"` on its bubble root; CSS gives the containing row the slot.

The lookup costs O(log N) per claim-leading human message, where N is the number of Steps with output in the loaded window. The change adds no framework API and no persisted or wire data.

## Alternatives considered

**Compute it in the renderer from props.** The renderer would need neighbouring rows and the Turn's process state, which puts a steering branch into the business-free node list and Seat, and the row would not re-render when only a neighbour changes.

**Compute it in the Chat snapshot builder.** A projector over the ordered entries would put a steering-specific rule and an extra pass into the generic build layer.

**Add tracked Turn-data reads to the framework (`reader.turnData`).** It changes the `ConversationNodeBuildReader` contract and the assembler's dependency tracking for one consumer, while `reader.previous` already gives the needed ordering, dependency, and replay.

## Consequences

The decision lives in node data, follows replay and earlier-history loading through existing dependency tracking, and leaves the renderer, Seat, node list, and ui-conversation framework unchanged. It costs one more Definition and one Context per Step with output; each State is one number, and each Context holds references to its Step's evidence events. The slot follows the claim's first human message rather than its first rendered row, so a runtime-context notice logged before that message in the same claim sits above the slot; this follows from the README's rule that the claim's first human message keeps the slot.

## Testing
