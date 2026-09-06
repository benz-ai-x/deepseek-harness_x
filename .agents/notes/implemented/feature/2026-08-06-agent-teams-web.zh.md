# Agent Note：实验性 Agent Teams Web 控件

状态：已实现

[English](2026-08-06-agent-teams-web.md) | 中文

## 问题

持久 Agent Teams runtime 负责 roster、mailbox 与 task 状态，但只提供模型工具和 Host service method。Web 用户需要查看 teammate 活动、按同样的 compare-and-set 规则管理共享任务、打开 teammate 会话，并浏览说明 Team 协作过程的持久消息。Agent Teams 仍处于实验阶段，因此这些能力不能向稳定 API Proxy、Session Controller、Client UI package 或 Web bundle 增加 Team 专用 contract 或依赖。

## 决策

私有 `ctx.agentTeams` service 除 domain operation 外，还直接负责生成式 `agentTeams/view`、`agentTeams/listMessages`、`agentTeams/getMessage`、`agentTeams/createTask` 与 `agentTeams/updateTask` Remote method。Team package 负责浏览器安全的 view、已提交消息、净化内容与 mutation-result type。Team view 包含 roster 与当前 task 状态，但不包含 pending mailbox 内容或已删除 task tombstone。消息页面只包含 metadata；detail 需要稳定 id 与 list window 返回的 committed cursor，然后公开原样的有意文本和图片事实，并把私有或不支持的 block 替换为显式省略项。Create 与 update rejection 通过封闭 business result 跨越 Remote；消息读取和意外 failure 保留为普通 `RemoteResult` failure。

只有精确的 live Lead 能读取 Team message index。每次读取都与 Team journal 串行执行，并在固定 event-sequence cutoff 前 flush Lead Session。Cursor 将该 cutoff 与 Team 及规范化查询绑定，能在 projection 冷重建后继续使用，并拒绝损坏、未来历史、其他 Team 或改变后的 filter。Reader 会在筛选前验证 Host-owned participant，因此查询不能隐藏伪造 sender。Queue 与 delivery event sequence 和 time 会与正文内容分开投影。投递事实不表示用户已读消息或相关工作已完成。

`@deepseek-ai/dsh-experimental-client-ui-agent-team` 通过稳定 `ctx.remote` service 挂载 `@deepseek-ai/dsh-experimental-agent-team/remote` contribution，随后直接消费生成式 `ctx.remote.agentTeams` method，不增加 Client result 包装层。它为 roster status、model diagnostics、task control 与扩展视图持有唯一 Team dialog。该 dialog 的 header entry 声明公开的 session-scoped `agent-team.panel.view` list Slot，把本地化 contribution label 投影为 tab，并在 render site 传递精确 Lead `teamSessionId`。Contribution 只使用公开 Slot 与生成式 Remote type；释放任一 Fiber 都会移除其 UI 与权限。

每次 task update 都发送当前显示的 revision。每个 create 或 update 都独立持有 pending token，在开始前使更早的 refresh 失效，并在成功后重新读取完整 Team view。Conflict 仅在其 reload 成功后要求用户检查；如果重新读取失败，则保留该错误。重叠 refresh 只发布所选 Session 的最新请求。

Teammate navigation 使用既有 `{ parentSessionId, childSessionId, mode: 'continuable' }` Subagent address，不带 Team tag。UI 刷新直接 child catalog、再次检查所选 Session，然后打开 addressed conversation。History 与后续人类 prompt 使用稳定 Subagent 路径；Team mailbox 只用于 Team 工具发起的 Team peer delivery。

`@deepseek-ai/dsh-experimental-agent-team-web-profile` 在稳定 Web bundle 之后只插入 UI。它与 Host 侧 `@deepseek-ai/dsh-experimental-agent-team-profile` 一起应用，后者已经插入 `ctx.agentTeams` 与模型工具。两个稳定 bundle 都不包含禁用的 Team row 或依赖。

稳定 Web preset 仍会在自身 preset scope 内注册 continuable Subagent control。顶层 Agent Teams profile override 无法替换这些 registration，因此该实验性 composition 可能同时暴露 Team roster 与 legacy child control。Team-aware Web preset 暂缓实现；[Web profile README](../../../../packages/experimental/agent-team-web-profile/README.zh.md#known-limitations-and-deferred-work)负责记录当前限制。

## 边界

Web 消息 reader 不提供 send、reply、read receipt 或实时 subscription operation。它绝不会把消息正文复制进 Team view、全局 Client store 或 run index。Web UI 不提供 worktree 或 Git control、teammate creation、rename、deletion、interrupt 或自动 merge。它不会从 task ownership 或 write scope 推断文件系统权限。导航到 teammate 后的人类 continuation 是普通 addressed-child prompt，不是 Team mailbox message。

## 考虑过的替代方案

**扩展 legacy API Proxy Team RPC map。** 拒绝，因为这会把实验性 domain 放入稳定 wire package，并重复生成式 Remote vocabulary 与 validation。

**引入独立的浏览器 Remote service。** 拒绝，因为这些 method 没有区别于 `ctx.agentTeams` 的状态、lifecycle 或 policy owner；第二个 Cordis service 会重复 Team injection，并要求另一个 package 提供同一个 Typert namespace。

**向稳定 Subagent address 与 prompt routing 添加 Team metadata。** 拒绝，因为普通 child navigation 已经标识会话；Team tag 会让稳定 Client 与 Subagent contract 耦合实验性 mailbox policy。

**在稳定 Web bundle 中加入禁用 Team row。** 拒绝，因为禁用 row 仍会产生 release 依赖，并让实验性 package 成为随附 composition 的一部分。

**让每个扩展导入私有 Team component。** 拒绝，因为这会重复 panel ownership，并使扩展耦合实现文件。由 owner 声明的 child Slot 保留唯一 dialog 与唯一公开组合点。

**在 `agentTeams/view` 或 list page 中返回消息正文。** 拒绝，因为宽泛 snapshot 与常规 refresh 会保留敏感内容，并扩大每个 response。按需 detail 会把权限与内容选择留在 Host read。

## 测试

Team service test 覆盖固定 window 分页、filter、detail authorization、净化内容、participant forgery、过期身份、cursor scope 与损坏、持久化 failure、无 activity 读取和冷启动。逐文件 coverage 固定 message reader 的每条路径；生成流程与 plain-Node built-artifact smoke 校验导出的 Remote descriptor。Client typecheck 与浏览器 component test 覆盖 owner 声明的子导航、动态注册与 dispose、挂载 namespace、Lead routing、task control、陈旧 async result，以及状态或错误呈现。无密钥 Agent Team profile snapshot 通过真实 Host service 执行元数据与净化详情读取；Web 端到端测试则在真实 Remote composition 上固定单一可导航 panel。

## 后果

Team service 是 domain state、读取权限与公开选定 Team value 的 Remote operation 的唯一 Cordis owner。Team UI 拥有唯一可扩展 dialog，而消息内容仍是按需 Host result。这会增加 projection index 与不透明 cursor protocol，扩展必须通过 owner Slot 注册。稳定 API Proxy、Session Controller、Client UI package 和 Web bundle 保持 Team 无关。Promotion 会重命名实验性 npm package，但不要求新的生成式 namespace。
