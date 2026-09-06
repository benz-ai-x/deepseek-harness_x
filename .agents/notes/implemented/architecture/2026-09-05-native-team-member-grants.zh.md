# Agent Note: Authorize native Team members with revocable Host grants

Status: implemented

[English](2026-09-05-native-team-member-grants.md) | 中文

## 问题

原生 provider 中的 teammate 有持久 Team 身份，却没有存活的 DSH Agent 对象。把 Lead Agent 传给原生工具会授予工具 Lead 权限；接受模型提供的成员或 native handle 字符串会让模型自行选择身份。provider 替换与 Lead 恢复还会使原本正确的授权过期。

## 决策

Team 所有者在 roster 接受 native handle 后签发不可序列化的 [NativeMemberGrant](../../../../docs/subsystems/agent-team.zh.md#native-member-authorization)。grant 捕获精确存活的 Lead、不可变的成员／provider／handle 关联以及当前 provider 注册。验证恢复后签发当前权限；普通 DSH 入口仍然要求精确存活的 Agent 对象。隔离评测不会获得生产 grant。

provider 通过 `bindMemberOperations` 接收 grant。注册表只允许挂载已接受 handle 的代际获得权限。注册退役、handle 释放、原生进程离线以及 Lead 的 `agent/disposed` 事件会中止其 signal，阻止后续查询返回数据。后续在线状态不能复活旧 grant；必须在验证恢复后重新绑定授权。provider binder 抛错时，注册表撤销 grant 并隔离该代际，同时保留已经接受的 Team 事实。

首批操作通过现有 roster 和 task board 读取成员与共享任务。严格 JSON schema 拒绝身份字段与其他操作；完整请求与结果有字节上限，任务列表有分页条数上限。[包契约](../../../../packages/experimental/agent-team/README.zh.md#teammates)定义上限和 cursor 语义。grant、调用对象及查询结果不增加持久 Team 字段或另一份业务状态。

## 考虑过的替代方案

**以 Lead 身份执行。** 这会绕过成员授权，并使后续成员写操作不安全。grant 派生成员权限，同时保持现有 Lead-only API 关闭。

**认证模型提供的身份。** 字符串 handle 或角色不能证明当前进程内的所有权。Host 把权限绑定到精确注册和 runtime 挂载。

**另存原生 Team 状态。** 复制的 roster 或 task board 会在恢复和 compare-and-set 修改后发生偏离。原生查询读取与 DSH 调用方相同的权威 Team 状态。

## 影响

适配器必须把当前 grant 绑定到精确原生连接，并执行自己的协议关联校验、取消和完整工具响应大小限制。声明操作必须提供 binder；元数据只描述适配器实际实现的操作。文件系统、审批和网络策略仍由适配器负责，grant 不会扩大这些权限。

[公开 grant 测试](../../../../packages/experimental/agent-team/tests/native-member-operations.spec.ts)使用真实 Team 持久化验证当前 Team 读取、分页、大小限制、取消、身份拒绝、清理前退役、Lead 恢复与评测隔离。[Loader 场景](../../../../packages/experimental/agent-team/tests/native-member-loader.e2e.ts)通过已交付 profile 组合记录模型可见结果及撤销行为。已认证的原生产品执行属于消费方适配器的验收测试。
