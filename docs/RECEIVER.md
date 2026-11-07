# 接收模式：从"排队"到"值守"

现在的 `peer_send` 是把消息塞进对方 inbox 的 nextTurn 队列 —— 对方这一轮跑完才读得到。实测下来，
一个长回合（比如半小时的开发）里，别人发来的消息会一直躺着，观感就是"没送到"。

这个分支换一种接收方式：**给对方派一个值守子代理（receiver）**，由它当场处理这条消息，而不是让主代理等到下一轮。

## 两种模式

`settings.receiver.mode`：

| 值 | 行为 |
| --- | --- |
| `queue` | 旧行为：消息进 nextTurn 队列，等主代理这一轮结束 |
| `handler`（默认） | 给目标会话派生一个 receiver 子代理，由它决定怎么处理 |

派生失败（没有 `subagents` 服务、目标本身是子代理、超深度等）就自动退回 `queue`，不会丢消息。

## receiver 怎么工作

`peer_send` 派生子代理时带上：发送方名字/工作区、目标会话、消息正文，以及一段固定职责说明：

1. **能直接答** → `peer_reply`：以目标会话的身份把回复发回给发送方。主代理完全不被打扰。
2. **该让主代理知道，但不急** → `peer_handoff`：把消息**总结**成两三句，投给主代理。
   - `delivery: steer` → 主代理下一个 step 就看见（即时）；
   - `delivery: queue` → 等它这一轮结束。
3. **只在"冲突"时打断** → `peer_interrupt`：消息和主代理当前在做的事矛盾（继续做会白干/跑偏）时，
   取消主代理当前回合，然后把总结投进去，让它改道。**这是唯一会打断主代理的路径**，默认允许但可关。

receiver 还有 `peer_context`：读主代理最近在干什么（最近几条消息、工具调用、当前 turn/step、是否在跑），
用来判断"到底要不要打断"。

## 为什么这样不脏上下文

主代理的上下文里只会出现两种东西：一条**总结**（handoff/interrupt 时才发），
或者什么都不出现（receiver 自己答完）。原始消息正文不进主代理。

## 边界

- 每条消息最多派生一个 receiver；同一目标并发 receiver 数量受限（超了退回 queue）。
- receiver 是目标的**直接子代理**，会出现在它的子代理列表里；跑完即止，不常驻。
- `canInterrupt = false` 时，receiver 只能 reply / handoff，不能取消主代理。
- 打断用的是 Agent 的 cancel（保留 inbox），然后把总结作为新消息投进去，不会丢主代理已排队的其它输入。

## 开关

- 配置文件：`receiver.mode` / `receiver.canInterrupt`
- 设置页「跨会话消息」里加一行选择：值守（即时）/ 排队（等下一轮）

## 实现细节（v0.1）

- 派生：`subagents.startActivation({ provider: 'spawn', parent: 目标会话的 live agent, delivery: 'caller' })`。
  目标空闲时 `sessionController.resolveAgent` 会先把它恢复出来；恢复不了就退回 queue。
- receiver 的四个工具注册在子代理自己的 agent context 上（`child.ctx.tools.register`），只有它看得见。
- 模型：默认跟随部署默认模型；可用 `receiver.model`（"provider/model"）单独指定一个快模型 ——
  实测默认模型 429 时 receiver 会白跑，给它配一个稳定的小模型很值。
- 兜底：receiver 结束（`activation.result` 落定）时如果一次 action 都没成功（`record.handled !== true`），
  就把原始消息按旧的 queue 路径投进目标会话，**保证不丢**。
- 防环：receiver 自己发消息时（`receivers.has(selfId)`）永远不派生新的 receiver，
  所以即使它误用 `peer_send` 也只会普通投递，不会来回套娃。
- 并发：同一目标最多 2 个 receiver 同时在跑，超了退回 queue。
- 已知限制：receiver 继承父会话的工具集（`restrict` 在这个 scope 上没绑定成功），
  所以它理论上还能 `write`/`bash` —— 靠提示词（"never do the task yourself"）约束，不是硬隔离。
