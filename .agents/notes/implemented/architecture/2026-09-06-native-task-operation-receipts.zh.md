# Agent Note: 持久化原生任务变更及其原始接受结果

Status: implemented

[English](2026-09-06-native-task-operation-receipts.md) | 中文

## Problem

原生任务调用可能在响应到达原生进程前已经提交。重试必须恢复原始接受结果，不能在新 Revision 上再执行一次转换。原生成员也需要与 DSH 成员相同的所有权和依赖规则，同时不获得伪 Agent 或 Lead 权限。

## Decision

[任务板](../../../../packages/experimental/agent-team/src/task-board.ts)在现有 Lead journal 中串行化原生任务写入，并在写队列内再次检查当前 grant 和取消状态。回执查找先于 expectedRevision 比较：输入匹配时先 flush，再返回原始接受结果；输入改变则冲突。[共用任务规则](../../../../packages/experimental/agent-team/src/task-state.ts)同时约束精确 live-Agent 调用和获授权原生成员调用，包括 Lead-only 重新分配、所有权、DAG 校验和墓碑。

一个必需的 payload-4 任务事件同时存储任务变更与回执。回执保留已校验请求，以及仅含任务 id、revision、状态、所有者名称和就绪状态的精简结果。任务文本和依赖列表仍通过任务读取获得；变更响应排除这些字段，即使任务描述很大，转义后的原生文本封装仍然有界。Projection version 5 在变更状态前核对成员身份、规范调用／输入摘要、获授权转换和原始结果。显式 payload-3 消息和 payload-2 读取分支保留既有历史；Session format 0 不变。

同一 grant 通过现有等待者观察后续活动，超时范围为十秒至一小时。等待没有回执，不启动成员工作。调用方取消和 grant 撤销会结束等待。认领或解除任务依赖不获取文件锁；被中断的原生轮次保留任务所有权，直到显式获授权转换改变它。

## Alternatives considered

**任务与回执分别记录。** 两者之间的可读前缀无法重建已提交响应。一个必需事件使变更与原始结果不可分割。

**先重复 CAS，再查找回执。** 原始成功调用会与自己产生的 Revision 冲突。优先查找回执，即使任务随后发生有效变更，也能保留重试语义。

**使用原生专用任务状态机或伪 Agent。** 独立转换会偏离 DSH 规则，外形像 Agent 的身份则可能意外获得 live-Agent 权限。共用纯任务规则位于两种准入路径之下，接受 roster 授权的角色和持久成员 id。

**在变更回执中返回完整任务。** 原生文本响应会再次 JSON 编码结果；转义描述可能在提交后超过传输上限。精简接受结果保留已提交 Revision，完整任务读取继续执行其明确结果上限。

## Consequences

Team journal 仍是唯一任务权威。Host 回执恢复不会还原已死亡原生进程的 RPC callback；适配器校验当前原生轮次，并单独结算冷恢复后的中断工作。公开服务测试、持久事件损坏测试、真实 profile Loader 和两个 SDK 事件录制覆盖操作与重放路径。原生适配器仍负责将该 grant 对应到其可信的当前轮次与调用身份。
