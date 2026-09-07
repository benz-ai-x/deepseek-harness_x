# Agent Note: 共同提交人类 Team 消息请求与其排队消息

Status: implemented

[English](2026-09-07-durable-human-team-message-requests.md) | 中文

## 问题

Team 接受工作后，browser submission 的响应仍可能丢失。重新发起普通 mailbox send 会创建另一条消息，而在第二条 event 中保存 reply correlation 或 replay receipt 会留下崩溃窗口。Host 还必须从精确的 live Team authority 推导人类发送者，而不是接受 Client 数据声称的身份。

## 决策

[Team service](../../../../packages/experimental/agent-team/src/index.ts) 公开仅限 Lead 的 `submitMessage()` operation 与生成式 `agentTeams/sendMessage` Remote。输入携带调用方所有的 request id、显式 active recipient、字面 text，以及可选的早先 message id。注入的 live `Agent` 提供 sender 与 Team；请求不接受这两项。

request identity 是最多 200 UTF-8 字节的非空 opaque 字符串。在 Team projection 内，`(senderId, requestId)` 选中唯一 receipt。SHA-256 fingerprint 覆盖精确 recipient、text 与可为 null 的 reply id：匹配的重试返回原 message id，改变输入则在不 append 的情况下冲突。Team-scoped projection state 使同一 request id 在另一 Team 中独立。

一条必需的 `team/message/request-committed` payload-version-1 event 以原子方式存储 request receipt、可选 reply relation 与 queued message。projection 要求 sender 为 Team Lead、recipient 为 active，reply target 为同一 Team 中较早的真实消息。它重算 fingerprint，并拒绝重复 request 或 message identity。Projection stateVersion 7 从 Lead 日志重建这些事实；旧 queue 与 delivery payload 仍可读，未来 request version 则失败关闭。

caller cancellation 只在持久 append 开始前拥有新请求。接受之后，Team lifecycle cancellation 拥有投递，因此调用方断开不能擦除已排队工作。submission acceptance 与当前 `pending` 或 `delivered` delivery fact 保持分离。provider 缺失会保留同一 queued message；provider 回归与 Host recovery 投递该身份，target-side Session 去重则阻止另一条 delivery fact。

本决策部分取代[实验性 Agent Teams Web 控件](../feature/2026-08-06-agent-teams-web.zh.md)中「不发送／不回复」和「人类只能继续 addressed-child 会话」的边界。该 Note 仍是消息读取、分页、任务、teammate 导航与 Client Slot 组合的当前归属；本 Note 则负责生成式人类提交 Remote、reply 关联和持久重试语义。

## 考虑过的替代方案

**复用普通 `sendMessage()` 并让 Client 推断成功。** 重试会分配新 message id，因此双击与未知 transport outcome 可能复制工作。

**在不同 event 中存储 request receipt 或 reply。** 两次提交之间崩溃可能留下无法重放的 acceptance 或无关联 reply。一条必需 event 使每个可读日志前缀都自洽。

**让 Client 提供 sender 或 Team id。** 这会把 presentation state 变成 authority credential。Host injection 与 exact-live membership check 把授权保留在 Team owner。

## 影响

人类发送可在双击、transport 丢失、持久性不确定和重启后重试，而不分配另一条消息。回执为每条人类撰写的消息增加持久 SHA-256 digest 与 request id，必需事件读取器必须理解 payload version 1 与 projection stateVersion 7。投递仍是进程内重试加 target-owned 去重，不是跨 Host exactly-once execution；持续 Client watch 也不在本决策内。
