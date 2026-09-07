---
description: "使用并排查实验性 Web Agent Teams roster、任务板、teammate 导航与公开子视图。"
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-client-ui-agent-team

[English](README.md) | 中文

## 概述

本包向 Web 会话页头添加唯一的 Agent Teams action 与 dialog，让用户检查当前 roster、在列表与依赖图之间切换共享任务板、导航到 teammate 会话并打开扩展拥有的 Team 视图。它通过生成的 `ctx.remote.agentTeams` contribution 读取权威 Team 状态，并让普通 child history 导航继续使用稳定的 addressed-subagent 路径。需要实验性源码 checkout Web profile 时选择本包；正式发布会排除它。这个浏览器 projection 不扩展稳定 API Proxy、不存储 Team 状态，也不注册面向模型的输入。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

在稳定 Web bundle 与 Host-side Agent Teams profile 之后，通过 [`@deepseek-ai/dsh-experimental-agent-team-web-profile`](../agent-team-web-profile/README.zh.md) 安装本包。Web Client loader 挂载 `/client` export；root Host export 不执行行为，本包也没有用户配置字段。

### 检查并导航 roster

打开 panel 会调用 `agentTeams/view`。Roster row 展示持久 name、运行时 status、model 与 diagnostics。选择健康 teammate 时，系统刷新既有直接 child catalog，并打开普通的 `{ parentSessionId, childSessionId, mode: 'continuable' }` address。History 与后续人类 prompt 继续使用稳定 addressed-subagent 会话路径；本包不会添加 Team 专用 address 字段。

### 管理任务板

列表与依赖图由同一份 `agentTeams/view` task snapshot 派生，共用一个已选任务、详情面板与变更控件。图节点使用真实 task id，并显示 Host 给出的 owner、status、readiness 与 blocker 事实；每条有向边从前置任务指向依赖它的任务。图提供确定性自动布局、有界缩放与平移、适配视野、感知依赖的键盘导航，并以原生 button 列表作为等价替代。过滤只隐藏呈现、标明被过滤掉的前置，从不重新计算 Host readiness。

用户可以通过 `agentTeams/createTask` 与 `agentTeams/updateTask` 创建、编辑、分配或取消分配、完成、重开和删除任务。每次 update 都发送当前显示的 revision，create 或 update rejection 都保留为显式 business result。

### 扩展 Team 面板

页头 action 拥有唯一的 Team dialog，并在其中声明 session-scoped list Slot `agent-team.panel.view`。Client 扩展通过该公开 Slot 提供稳定 id、顺序、本地化标签与组件；Team owner 会传入当前会话解析出的精确 Lead `teamSessionId`。Contribution 会作为“概览”旁的 tab 出现，无需导入本包的私有组件。注册、locale 变化与移除会更新导航列表，释放任一 Fiber 都会移除相应权限与 UI。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

Client export 挂载来自 [`@deepseek-ai/dsh-experimental-agent-team/remote`](../agent-team/README.zh.md) 的生成式 `ctx.remote.agentTeams` contribution，然后通过 Cordis effect 注册 locale dictionary 与一个 conversation-header entry。该 entry 声明 `agent-team.panel.view`，观察其公开 contribution 与本地化标签，并在既有 dialog 内渲染所选 contribution。释放 plugin Fiber 会移除 Remote、locale、entry、子 Slot、subscription 与 contribution navigation。

开始 create 或 update 会让更早的 refresh 失效。成功后会重新读取完整 Team view，使每个 task 的派生字段保持最新。`team-task-conflict` 结果仅在重新读取成功后显示状态陈旧提示；如果重新读取失败，则保留该错误。由于 Team service 把任务文本或 scope 编辑与 dependency 修改公开为独立 action，两者使用两个连续的 compare-and-set mutation。列表／图模式、选择、过滤与视口变换都是可释放的组件状态；布局与可见性都不会新建 task projection 或改变 readiness。

| 文件 | 职责 |
|---|---|
| [`src/client/mount.ts`](src/client/mount.ts) | 生成式 Remote、locale、导航、公开子视图 projection 与 slot registration |
| [`src/client/TeamAction.tsx`](src/client/TeamAction.tsx) | Team dialog、子视图 tab、roster 与任务板交互状态 |
| [`src/client/locales.ts`](src/client/locales.ts) | 中英文 panel 文案 |
| [`src/index.ts`](src/index.ts) | 不执行行为的 Host entry |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [Agent Teams Web profile](../agent-team-web-profile/README.zh.md)——挂载本 Client plugin 的源码 checkout bundle。
- [Agent Teams service](../agent-team/README.zh.md)——权威 roster、task 与 Remote 行为。
- [会话 UI](../../client/ui-conversation/README.zh.md)——稳定 header slot 与 addressed-subagent 导航表层。
- [实验性包](../README.zh.md)——孵化状态与发布排除规则。

-----

<a id="model-experience"></a>
## 模型体验

无直接影响，因为该浏览器 projection 与任务控制界面不注册面向模型的输入。

#### KV Cache 影响

无直接影响；Team 工具与普通会话提交负责后续任何模型可见用途。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **Snapshot refresh**——“概览”会在打开、显式 refresh 与 mutation 后刷新；它没有实时 event subscription。
- **仅提供概览**——本基础包提供 roster 与 task control；消息或其他 Team 视图需要单独的 `agent-team.panel.view` contribution。
- **普通 child continuation**——导航后发送的人类消息使用稳定 addressed-subagent prompt 路径，而不是 Team peer mailbox。
- **没有 lifecycle 或 workspace control**——panel 不能 spawn、rename、delete 或 interrupt teammate，write scope 仍只是提示性 metadata。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>

**运行时不变式：** 不发布伴生入口。RPC 是权威来源，本包持有一个可释放的 header entry，由它声明并渲染公开 Team 子 Slot。
