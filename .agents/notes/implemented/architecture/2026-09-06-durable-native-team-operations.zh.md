# Agent Note: 共同提交并恢复原生 Team 消息与重放回执

Status: implemented

[English](2026-09-06-durable-native-team-operations.md) | 中文

## 问题

Team 接受消息后，原生工具响应仍可能丢失。没有持久操作身份的重发会重复工作；在单独的 mailbox 提交之后再记录响应，仍然存在同样的故障窗口。原生终止输出也需要以成员身份回传 Lead，不能把原生 transcript 复制到另一套存储。

## 决策

[Team mailbox](../../../../packages/experimental/agent-team/src/mailbox.ts) 在一个必需的 `team/native-operation/committed` 事件中接受有意发送的文本消息及其回执。回执绑定 Team、成员、provider、native handle 与可信轮次／调用关联。工具调用与终止结算使用不同的关联种类。模型 JSON 不提供身份或 grant 权限。

规范操作摘要选中原回执，规范输入指纹检测输入变化。目标名称沿用 mailbox 的空白规范化。[投影](../../../../packages/experimental/agent-team/src/projection.ts) 先校验持久成员、消息署名、关联种类、操作摘要和输入指纹，再重建 mailbox 与回执。终止结算的目标固定为 Lead，并独立记录 completed、failed 或 interrupted，不与 queued 接受状态混淆。

事件使用 payload version 4 的显式消息／任务变体，Team checkpoint 使用 stateVersion 5。reader 同时接受 payload-3 消息。生成的 Session 事件目录包含该必需事件；显式 payload-2 解码器保留可读历史。Session 格式 0 和 Ultra storage generation 不变。这些选择落实本地维护扩展的格式方案；旧读取器不能忽略该必需事件，也不能复用新 checkpoint。

当前 grant 在准入时和写队列中再次校验。flush 失败不返回成功，也不开始投递。重试先将原事件落盘，再发布回执并继续投递。持久接受把结算所有权交给 Team；provider 退役仍阻止旧 grant 返回成功响应。经过验证的新 grant 可以重放已接受回执。

经过验证的 grant 还提供 Host-only `turns.recover` reader。Team 将该读取与 journal 操作串行执行，flush Lead Session，并返回分离分页，依次包含该成员的 launch 关联、入站 delivery id 和已提交结算。入站消息文本、同级成员与其他 Team 的事实以及原始 provider 历史仍由各自属主保管。读取不会发布 Team 活动。当并发追加移动数字 offset 的后续页面时，稳定 launch、delivery 与 turn 身份让适配器可以对条目去重。

## 考虑过的替代方案

**分开提交变更与回执。** 两次提交之间崩溃会使原响应无法恢复，并可能重复变更。单事件使两个事实在可读日志前缀中不可分离。

**由 Ultra 拥有原生 outbox。** 第二套 mailbox 会将 Team 权威与恢复分散到不同存储所有者。现有 Team 日志和 mailbox 共同保留业务接受与投递。

**把调用文本用作操作身份。** 相同的有意消息可以属于不同调用。可信成员／会话／轮次／调用关联能够区分它们，同时允许传输重试收敛。

## 影响

回执可跨 Host 替换恢复，不暴露 grant 凭据或原始 provider payload。查询仍只读；原生消息工具与终止结算遵守同一请求上限，只发布有意回传的文本。恢复后的适配器可以让自身持久历史与 Host 所有的工作身份和已提交结果对账，无需把提示词复制到另一存储。恢复可能等待 Lead Session flush；该持久性检查失败时，恢复读取也会失败。保证覆盖单 Host 的明确重试和恢复路径，不宣称跨 Host exactly-once 执行。原生适配器仍负责保留可信 SDK 关联，并从自身持久历史恢复有意回传的终止输出。
