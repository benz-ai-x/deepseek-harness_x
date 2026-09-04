# Agent Note: 目录属主拥有的持久运行时注册

Status: implemented

[English](2026-09-04-catalog-owned-durable-runtime-registration.md) | 中文

## 问题

持久 Codex 适配器会把提供方直接注册进 Agent Teams。另一个同时拥有用户可见 Runtime Backend 目录的组合无法通过自己的原子注册操作发布该提供方，因为 Agent Teams 既不提供提供方枚举，也不提供注册事件。再次注册同一提供方会造成身份冲突，而镜像目录会让路由权威与展示元数据分裂。

## 决策

Codex 适配器接受可选的 `catalogOwnerService` 名称。省略时，适配器直接注册进 Agent Teams。配置后，子 `ctx.inject()` 会等待该服务，并调用其 `registerExternalRuntimeProvider(provider)` 操作；该操作以一个世代同时拥有目录发布与对应的 Agent Teams 注册。适配器会校验该操作存在，且返回可调用的同步或异步 disposer。适配器不包含部署专用服务名。

子注入会在已配置服务消失前卸载，并通过 once guard 调用返回的 disposer。替换服务会用同一提供方对象启动新的注册世代。适配器拆卸会先等待注册世代消失，再关闭提供方接纳与原生资源。

## 考虑过的替代方案

**把 Agent Teams 提供方镜像进组合目录。** 否决：Agent Teams 没有注册枚举或观察 API，第二份元数据存储可能与拥有路由的提供方世代发生分歧。

**替换或代理 Agent Teams 服务。** 否决：一个目录消费方会因此包装 Team 的权威、roster、mailbox、evaluation 与 runtime 操作，而不是只拥有自己的目录注册。

**在适配器中硬编码组合服务名。** 否决：实验性提供方必须仍可用于独立组合，并且不得依赖某个树外产品包。

## 后果

部署方可以让一个服务原子地拥有 Runtime Backend 发现与 Agent Teams 路由，而不会产生部分直接注册。目录属主缺失时会延期注册且不回退；服务替换与适配器释放会各自只移除一次注册世代。独立 Codex 行为、提供方能力、原生资格校验、持久身份与持久化格式保持不变。真实 Cordis 生命周期测试覆盖服务缺席、出现、替换与 Fiber 释放。
