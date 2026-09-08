# Agent Note: 在 Session v2 上保留维护版 Team 契约

Status: implemented

[English](2026-09-08-maintained-team-on-session-v2.md) | 中文

## 问题

维护版 Team 服务负责固定路由、持久外部成员、原生操作回执、人类消息请求和单一可导航任务面板。用官方基线服务替换它会移除已经接受的产品行为。保留旧 Session 表示则缺少内嵌 Assistant 流和已发布格式恢复能力。

## 决策

集成将固定官方 Session v2 实现与完整维护版 Team 所有者组合。Session 表示与 Team payload 版本保持独立：Team schema 和投影保留既有身份，当前恢复使用安装版本生成的事件清单，包含必需的 native-operation 和 message-request 记录。

历史恢复仍受[相邻格式规则](2026-08-31-released-session-format-migrations.zh.md)约束。冻结迁移边显式校验维护版 Team 字段与必需回执，不导入当前 Team 服务。未知字段、错误身份和冲突的外部成员元数据会使恢复失败。只有测试 replay 适配器会物化并恢复原生回执的手写身份占位符；生产格式读取器不接受此类占位符。跨业务域迁移和外部应用发布资格与本次源码集成分开验证。

手写的 [Team 面板场景](../../../../snapshots/web/agent-team-panel/snapshot.yml)拥有任务依赖和控件相同的 v2 场景。标题引用实际存在的更早用户事件。历史手写场景接受相同的夹具引用修正；这是源码树测试整理，不是运行时迁移。共享导航场景引用其所有者选中的 v2 代际。Python SDK 场景通过构建后的 CLI 记录当前输出，同时保留原生回执与任务 CAS 断言。

## 考虑过的替代方案

**用官方 Team 替换维护版 Team 服务。** 这会移除固定路由和持久原生行为，因此公开所有者仍是维护版服务。

**保留旧 Session 写入器，或不转换就重命名 v0 文件。** 这会误报持久化表示，也不能提供 v2 流和 lineage 语义。

**给全部 Team payload 一个新版本。** Session 编码本身不改变业务字段，也不构成合并独立版本操作回执的理由。

## 后果

该集成是维护 fork，不代表无需扩展即可兼容官方版本。当前 Team、generated Remote、浏览器和 SDK 检查覆盖组合运行时。维护版历史格式迁移、完整外部包升级和真实认证原生验收需要各自证据；本决策不将这些检查标为完成。
