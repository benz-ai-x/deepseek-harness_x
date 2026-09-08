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

打开 panel 会启动 `agentTeams/watch` 并读取 `agentTeams/view`。Roster row 展示持久 name、运行时 status、model 与 diagnostics。选择健康 teammate 时，系统刷新既有直接 child catalog，并打开普通的 `{ parentSessionId, childSessionId, mode: 'continuable' }` address。History 与后续人类 prompt 继续使用稳定 addressed-subagent 会话路径；本包不会添加 Team 专用 address 字段。

### 管理任务板

列表与依赖图由同一份 `agentTeams/view` task snapshot 派生，共用一个已选任务、详情面板与变更控件。图节点使用真实 task id，并显示 Host 给出的 owner、status、readiness 与 blocker 事实；每条有向边从前置任务指向依赖它的任务。图提供确定性自动布局、有界缩放与平移、适配视野、感知依赖的键盘导航，并以原生 button 列表作为等价替代。过滤只隐藏呈现、标明被过滤掉的前置，从不重新计算 Host readiness。左方向键会跳过隐藏项，选择第一个可见前置任务。

用户可以通过 `agentTeams/createTask` 与 `agentTeams/updateTask` 创建、编辑、分配或取消分配、完成、重开和删除任务。Create 与 edit form 会把当前真实 task id 显示为原生依赖 checkbox，并排除正在编辑的任务。非 edit update 发送当前显示的 revision；edit 保留 form 打开时捕获的 revision，直至 conflict 触发的权威 reload 成功。Create 或 update rejection 都保留为显式 business result。

### 扩展 Team 面板

页头 action 拥有唯一的 Team dialog，并在其中声明 session-scoped list Slot `agent-team.panel.view`。Client 扩展通过该公开 Slot 提供稳定 id、顺序、本地化标签与组件；Team owner 会传入已导出的 `AgentTeamPanelViewOwnerProps`：精确 Lead `teamSessionId`、可选定址 `selectedMemberId` 与可选单调 `navigationRevision`。Contribution 会作为“概览”旁的 tab 出现，无需导入本包的私有组件。注册、locale 变化与移除会更新导航列表，释放任一 Fiber 都会移除相应权限与 UI。

另一个 Client 扩展可以调用 `ctx.agentTeamPanelNavigation.open({ teamSessionId, viewId, memberId })`，链接到已注册的某个 child，并可指定精确 Team member。Owner 会打开同一个 dialog、选择该公开 child，并通过 Slot owner props 传入 `selectedMemberId` 与单调递增的 `navigationRevision`。匹配的 panel 只消费一次 retained request；未知 child 或另一个 Team 无法消费。该提示只选择 Client UI，绝不授予 Team 读取或写入权限。

浏览器导出还提供 `createTeamWatchOwner()`，供任务面板与消费 Team 变化的扩展使用。每个 Client registration 创建自己的 owner，并把 React 组件打开的 watch 交给它。组件 cleanup 立即且幂等地关闭 watch；registration 通过 Cordis effect 等待 `owner.dispose()`，包括此前已经开始但尚未结束的关闭。所有已接纳的关闭完成后，由 owner 报告关闭失败。该辅助模块不挂载 Remote namespace，也不保留 Team 数据。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

Client export 挂载来自 [`@deepseek-ai/dsh-experimental-agent-team/remote`](../agent-team/README.zh.md) 的生成式 `ctx.remote.agentTeams` contribution，然后通过 Cordis effect 注册 locale dictionary 与一个 conversation-header entry。该 entry 声明 `agent-team.panel.view`，观察其公开 contribution 与本地化标签，并在既有 dialog 内渲染所选 contribution。它的 Client registration 生命周期拥有 React 创建的每个 watch control：unmount 会同步开始幂等关闭，而 Fiber 或 service generation 释放会等待所有已触发及仍存活的 control，然后才移除生成式 Remote。释放失败会进入 Cordis 生命周期错误边界，同时不会保留 Remote、locale、entry、子 Slot、subscription 或 contribution navigation。

同一个 Fiber 还负责 `ctx.agentTeamPanelNavigation` service 及其“保留至消费”的请求交换。这个很小的纯 Client service 只携带 Team Session、公开 child id、可选 member id 与 revision；不携带消息正文、凭据、provider 对象或 Host 权限。订阅者异常会按 listener 分别记录并隔离，因此一个错误扩展不会阻止后续 listener 观察已保留请求。

打开的面板把每个重连 watch generation 作为一份完整 baseline 加后续有界 invalidation 消费。Baseline 会原子替换更早的 unary read；invalidation 只调用既有权威 view reader，不携带 task state。权威读取在一个共享 refresh cycle 中严格串行：读取期间任意数量的 invalidation 都只设置一个 dirty bit 并共享唯一 completion；只要该 bit 曾被设置，cycle 就会再读取一次。这样 completion 状态保持常数空间，同时保证最后一次已观测失效之后仍有权威读取。Carrier 丢失会保留最后已发布 view，并显示明确的 disconnected 或 stale 状态；重连只读取新 baseline。Session 变化与 service replacement 会隔离迟到 generation、终止旧 cycle 并让新 generation 独立继续；关闭面板会主动停止 control，而所属 Client 生命周期会等待 stream 静止。

开始 create 或 update 会让更早的 refresh 失效。成功后会重新读取完整 Team view，使每个 task 的派生字段保持最新。如果所选 id 从这份非删除 view 中消失，选择会保持不变，同时通过生成式 `agentTeams/getTask` 读取它的权威 tombstone；同一详情面板显示删除事实但不提供 mutation control，session 或 service 变化会隔离迟到 detail read。任务文本、scope 与完整 dependency 草稿使用同一个 `edit` compare-and-set mutation；expected revision 在开始编辑时捕获，watch refresh 不会推进它。如果草稿里已选的 dependency 从当前 view 消失，它会保留为明确的「不可用或已删除」checkbox，直至用户移除或保存。Edit conflict 发生后，UI 保留旧 form 与 dependency 草稿，并且绝不自动重试。由 conflict 触发的权威 reload 成功后，才会推进下一次显式 Save 使用的基准并标明草稿未保存；reload 失败则不推进基准，并保持真实错误可见。列表／图模式、选择、过滤与视口变换都是可释放的组件状态；布局与可见性都不会新建 task projection 或改变 readiness。

| 文件 | 职责 |
|---|---|
| [`src/client/mount.ts`](src/client/mount.ts) | 生成式 Remote、locale、导航、公开子视图 projection 与 slot registration |
| [`src/client/TeamAction.tsx`](src/client/TeamAction.tsx) | Team dialog、子视图 tab、roster 与任务板交互状态 |
| [`src/client/navigation.ts`](src/client/navigation.ts) | 进入唯一 Team panel 的 Fiber-owned 公开导航请求 |
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

- **失效粒度**——实时变更会刷新完整权威 Team view；stream 有意不携带 task delta 或 Client-owned projection。
- **仅提供概览**——本基础包提供 roster 与 task control；消息或其他 Team 视图需要单独的 `agent-team.panel.view` contribution。
- **普通 child continuation**——导航后发送的人类消息使用稳定 addressed-subagent prompt 路径，而不是 Team peer mailbox。
- **没有 lifecycle 或 workspace control**——panel 不能 spawn、rename、delete 或 interrupt teammate，write scope 仍只是提示性 metadata。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>

**运行时不变式：** 不发布伴生入口。RPC 是权威来源，本包持有一个可释放的 header entry、子 Slot 与可重连 Team stream control。
