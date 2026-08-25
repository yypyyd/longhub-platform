# LongHub 一键智能体切换设计

> 历史/废弃：本文只保留旧 Electron、Agent Pack 和内嵌 Control UI 的研究与验证资料，不是当前产品、构建、
> 测试、部署、销售或兼容方案。当前 clean-launch 方案请以 [README.md](README.md)、[DESIGN.md](DESIGN.md) 和
> [EXECUTION_PLAN_V2.md](EXECUTION_PLAN_V2.md) 为准；当前首发使用免费的 `apps/longhub-manager`，不接入本文路线。
>
> 状态：Agent Profile V1、双 Agent 激活、Tool Bridge、权限交集、Selector 与一键安装 E2E 已实现  
> 基线：LongHub Desktop 0.3.5，开发目标 0.3.6 / OpenClaw 2026.7.1-2  
> 更新日期：2026-07-29

## 一、目标体验

用户打开龙枢后直接进入聊天界面。侧边栏显示当前有权使用的智能体，例如“通用助手”、
“HR 助理”“销售助理”“合同审查助手”。用户点击智能体名称即可切换，不需要选择模型、安装
技能、配置 Gateway 或理解 Agent ID。

切换行为遵循以下规则：

1. 已安装智能体在 3 秒内切换到最近会话或干净新会话。
2. 已授权但未安装的智能体自动下载、验签、安装和激活，完成后进入聊天。
3. 每个智能体独立保存身份、提示词、记忆、文件、会话和能力白名单。
4. 切换智能体不会把当前会话内容带入另一个智能体。
5. 正在生成或执行任务时，切换入口应等待完成，或让用户明确停止后切换。
6. 授权到期后禁止新建和继续执行，但历史会话按企业策略保留只读或删除，不能绕过授权。
7. 模型仍由后台统一选择；不同智能体可以绑定不同后台策略，但用户不直接看到模型配置。

## 二、概念边界

| 概念 | 含义 | 是否面向用户 |
|---|---|---|
| Agent Pack | 签名、授权、下载、升级和回滚的发布制品 | 用户只看到安装状态 |
| Agent Profile | 一个可切换智能体的名称、身份、提示词、能力和策略 | 是，一键切换单位 |
| Capability | 一组业务能力声明，例如招聘、销售线索或合同审查 | 可作为功能说明 |
| Skill | Core/Worker 实际执行的最小能力 | 默认不直接展示技术 ID |
| Agent Installation | 某设备安装的 Pack 版本 | 否 |
| Agent Activation | Profile 已注册到 OpenClaw 并可创建会话 | 用户看到“可使用” |
| Agent Session | 绑定 agentId 与 profileVersion 的独立会话 | 是，会话历史 |

一个 Pack 第一阶段只包含一个 Agent Profile，后续可以扩展为多个 Profile，但客户端切换单位
始终是 Profile，而不是 Pack 或单个 Skill。

## 三、现有能力复用评估

仓库已有的阶段 0/MVP 能力大部分可以继续使用：

| 现有资产 | 当前状态 | 在一键切换中的用途 |
|---|---|---|
| `PackManifest V1` 的 `agentTemplate` 与 capabilities | 已实现并有校验测试 | 继续作为 Pack 到 Agent Profile 的引用入口 |
| Pack SHA-256、Ed25519 签名 | 已实现 | 防止下载和本地制品被篡改 |
| Pack 暂存、自检、原子切换、上一版回滚 | 已实现 | 支撑智能体安装、升级和失败恢复 |
| 云端 catalog、entitlement、签名下载和撤销 | 已实现 | 决定设备可见和可激活的智能体 |
| Core RPC 的 session、pack、task、confirm 方向 | 已有冻结草案 | 扩展为 Profile 注册与切换事件 |
| Core / Skill Worker / 权限确认 | 原型已实现 | 承担真正的能力执行与权限收敛 |
| OpenClaw Gateway 适配器 | 已完成协议与真实联调 | 继续隔离龙枢与上游协议变化 |
| HR Agent Pack、HR Profile 和技能样例 | 已实现样例 | 作为首个非通用智能体纵向验收 |
| OpenClaw 多 Agent | 上游原生支持 | 提供独立 workspace、agentDir、session store |
| Control UI Agent Selector | 上游原生支持 | `data-chat-agent-filter` 可直接承载一键切换 |

因此不应重新开发套装下载器、授权系统或另一套聊天面板。近期工作重点是补齐转换、激活和执行
桥接。

## 四、当前缺口

### Agent Profile 契约（已完成 V1）

当前 Manifest 只声明 `agentTemplate.id/version`，HR Pack 的 `agent.yaml` 只是未校验文本。它还
缺少统一的显示信息、欢迎语、快捷任务、workspace 文件、能力映射、工具白名单、记忆策略和
生命周期策略。

已新增 `longhub/agent-profile/v1` 结构化契约，并要求它包含在 Pack 摘要与签名内。字段包括：

```text
schemaVersion
id / version
display: name / description / emoji / avatar / category / starterPrompts
workspace: IDENTITY / SOUL / AGENTS / USER 模板引用
capabilities: capabilityId / skillIds
openclaw: skills allowlist / tools allow-deny / sandbox policy
memory: isolated（V1 固定）
lifecycle: defaultSessionTitle / entitlementExpiryPolicy
compatibility: minDesktopVersion / openclawVersion / profileMigrationVersion
```

Profile 不得声明 Gateway 地址、Gateway Token、Provider、上游 API Key、任意插件加载路径或任意
可执行程序。模型策略只能引用后台允许的逻辑策略 ID。

实现同时修复了原 Pack 摘要只覆盖 `files`、未覆盖 Manifest 的问题；现在摘要覆盖排除自引用
`integrity.digest` 后的 Manifest 与全部文件，防止签名后修改版本、能力、权限或兼容范围。正式
契约见 [contracts/agent-profile/agent-profile-v1.md](contracts/agent-profile/agent-profile-v1.md)。

### 安装、激活与进入会话（已闭环）

PackInstaller 已能从当前 active 指针重新读取并校验制品；Desktop 启动时完成：

- 解析和校验 Agent Profile。（已完成）
- 持久化 Pack/Profile/OpenClaw agentId 稳定映射。（已完成）
- 确定性生成完整 `agents.list` 候选配置。（已完成）
- 建立独立 workspace、agentDir 和 session 目录。（已完成）
- 在 Gateway 启动前原子写入完整 OpenClaw `agents.list`。（已完成）
- 使用真实 OpenClaw Config 校验、双 Agent Gateway 冒烟和 Selector DOM 合约校验。（已完成）

运行中 `pack.enable/disable`、`config.patch + baseHash` 热加载、`agents.list` 回读、失败补偿回滚、
授权撤销后的实时停用、前台生成中切换和升级/回滚连续 E2E 已完成。全新 userData 下，Desktop
还会组合云端 catalog 与设备 entitlement，把客户端锁定认识的 HR Pack 显示为可安装 Agent；一次
点击完成下载、制品元数据核对、Ed25519 验签、公钥持久化、Pack 激活、Gateway 热更新并进入专属
会话。失败会保留可重试入口，并恢复安装前 active 指针。

云端 catalog 不能自行下发 Profile ID、agentId、安装 URL 或本机命令；它只参与筛选候选。真正的
身份和能力仍来自客户端锁定 Pack 映射与签名 Manifest/Profile，Core 执行前仍在线复验授权。

### Tool Bridge POC 已接入 Core

主窗口直接加载 OpenClaw WebUI 且不挂载 LongHub preload；旧 Renderer IPC 仍不会暴露给模型。
当前已接入独立 `@longhub/openclaw-bridge` 插件：OpenClaw tool factory 从运行上下文取得可信
`agentId/sessionKey/sessionId`，通过随机令牌保护的 `127.0.0.1` 单路由 RPC 进入 Desktop 和 Core。
工具业务 schema 不包含身份或权限字段，缺少可信上下文时不创建工具；Core 再按已验签、已激活
Profile 编译的 `agentId + skillId` 策略检查，并只授予 Bridge 契约声明的最小权限。

POC 只开放 HR 的只读 `longhub_resume_screen`。录用通知书必须等待人工确认链路，JD 起草必须先
消除从当前 OpenClaw 工具递归创建同一 HR Agent 会话的风险，薪酬带宽要等云端技能接入。

### Core 权限链

Bridge 使用独立 `bridge.execute`，不接受调用方提交 `grantedPermissions`、确认 ID 或预算；旧
Renderer `task.submit` 也已禁止调用方传权限。Core 持有已验签 Profile/Pack 的原始声明，并在
每次实际执行前在线复验 entitlement 和已安装 Pack 版本状态，再计算完整交集：

```text
有效权限
  = Profile 声明
  ∩ 已安装 Pack 版本声明
  ∩ 云端有效 entitlement
  ∩ 租户/设备策略
  ∩ 用户确认
  ∩ 当前任务预算
```

来自模型、Profile 文本或调用参数的权限都不可信。敏感写入、发消息、付款、删除和企业数据
变更必须继续走明确的人工确认。

确认记录绑定 `agentId + profileVersion + sessionId + toolCallId + permission + payloadDigest`，切换
智能体、任务参数变化、Profile 升级或超时后不能复用旧确认。这样可以避免用户在 HR 助理中确认
的操作，被另一个智能体或修改后的任务借用。记录五分钟过期且执行前一次性消费；云端复验失败
时安全失败。当前仍只开放免确认的只读简历初筛，写工具会在确认 UI 接入后逐项开放。

## 五、推荐架构

```text
Cloud catalog + entitlement
          │
          ▼
Desktop Agent Registry
  ├─ 下载、摘要、签名、兼容检查
  ├─ 安装/升级/回滚 Pack
  ├─ 校验 Agent Profile
  └─ 计算 enabled profiles
          │
          ▼
OpenClaw Config Composer
  ├─ agents.list[]
  ├─ 独立 workspace / agentDir
  ├─ 固定后台模型别名
  └─ per-agent skills/tools/sandbox allowlist
          │ hot reload + 回读校验
          ▼
OpenClaw Control UI
  └─ 原生 Agent Selector + LongHub 允许列表薄适配 → agent 专属 session
          │
          ▼
LongHub Tool Bridge
  └─ 可信 agent/session 上下文 → Core 权限决策 → Worker/Cloud Skill
```

### OpenClaw 映射

每个启用 Profile 映射为一个 `agents.list[]` 条目：

- `id`：由 Profile ID 规范化生成，安装后保持稳定。
- `name/identity`：来自已签名 Profile 的 display 与 IDENTITY。
- `workspace`：`userData/openclaw/workspaces/<agentId>`。
- `agentDir`：`userData/openclaw/agents/<agentId>/agent`。
- `model`：后台下发的逻辑模型策略，默认仍是 `longhub/longhub-default`。
- `skills/tools/sandbox`：由 Profile、租户策略和客户端安全上限共同生成。

`main` 保留为通用龙枢助手，不允许普通 Pack 覆盖。Pack ID、Profile ID 和 OpenClaw agentId 的
映射应持久化，不能因显示名变化而改变，否则会丢失会话关联。

当前实现将 Profile ID 规范化后附加 12 位 SHA-256 后缀，生成不超过 64 字符的 OpenClaw
agentId；Registry 使用原子 JSON 文件持久化所有权和版本。Composer 强制禁用 agent-to-agent、
跨会话工具和 elevated，并只启用当前 Profile 声明的逻辑模型策略、skills、tools 与 sandbox。

### 原子激活

已授权但未安装 Agent 的发现与激活过程：

1. 组合 catalog 与设备 entitlement，只展示客户端锁定认识且尚未安装的 Pack。
2. Selector 通过单用途安装导航提交当前候选 Pack ID，不获得 preload、Node 或通用 IPC。
3. 下载制品和签名公钥，核对响应 digest、signature key ID 与 Manifest，再执行完整 Ed25519 验签。
4. 暂存并验证 Agent Profile、所有引用文件、Desktop/OpenClaw 兼容范围与 entitlement。
5. 原子持久化签名公钥，创建独立 workspace/agentDir，只写入目标 agent 路径。
6. 基于当前有效 Profile 集合重新生成完整配置候选，先替换 Core 有效 Bridge policy。
7. 使用 `config.patch + baseHash` 替换 `agents.list`，并通过原生 `agents.list` 回读确认。
8. 成功后进入稳定 agentId 的专属会话；失败恢复安装前 active 指针及 Gateway/Core/Registry 状态。

上述流程已经在 OpenClaw 2026.7.1-2 真实 Gateway 上完成
`config.get → config.patch → agents.list → 恢复` 冒烟，不要求重启 Gateway。

## 六、切换与会话语义

- 一个会话创建时绑定 `agentId + profileVersion`，生命周期内不可改绑。
- 点击 Agent Selector 时，优先恢复该 agent 最近会话；没有则创建新会话。
- 客户端启动时恢复上次 active agent；若其已停用或授权失效，则进入 `main` 新会话，不把原会话
  内容迁入 `main`。
- “新会话”始终在当前 agent 下创建。
- 会话列表默认只显示当前 agent，可提供“所有智能体会话”只读聚合入口。
- Profile 升级后新会话使用新版本；旧会话保留原版本标记，继续策略由迁移声明决定。
- 不支持把通用助手会话直接改成 HR 助理会话；需要时提供“带摘要转交”，并让用户确认。
- Agent 间默认不能读取彼此 workspace、memory 或 transcript；共享知识必须通过显式受控知识库。
- V1 同一窗口只允许一个前台 active agent。生成中或存在待确认任务时必须先完成或明确停止，
  待确认卡片始终回到原 agent/session，不能跟随当前选择漂移。
- 锁定版 Control UI 未渲染 Selector 时，适配层使用上游原生样式并调用其 `selectAgent()`；它不
  创建第二套聊天或会话实现。首次切换后等待目标 Agent 会话行加载，再恢复最近非 main 会话。
- 当前页面出现原生 Stop 控件时，选择其他 Agent 会先恢复原选项并征求确认；确认后停止原 run，
  只有 Stop 消失才完成切换，15 秒未结束则保持原 Agent。
- 上游会从历史会话重新枚举未配置 Agent；LongHub 允许列表会移除这些选项。撤销当前 Agent 时
  直接进入 `agent:main:main`，不删除、改绑或迁移原历史。

## 七、在线、离线与授权新鲜度

龙枢模型本身通过云端代理工作，因此 V1 不承诺离线聊天。为了关闭 entitlement 撤销窗口：

- Agent Catalog 可以短时缓存用于展示，但缓存必须带策略版本和过期时间。
- Desktop Selector 默认 30 秒同步一次 entitlement/release；Core 每次工具执行前都在线复验，无法
  复验时安全失败，不受 Selector 同步间隔影响。
- 云端后续增加推送失效事件；推送是加速通道，Core 执行前的授权校验仍是最终边界。
- Selector 同步暂时离线时保留最后一次确认状态，避免网络抖动误删；历史会话仍可读取，但 Core
  拒绝无法在线复验的企业执行。
- 恢复联网后先同步 entitlement 和 Profile 状态；曾被确认撤销的 Pack 不自动复活，由用户或
  控制面重新调用 `pack.enable`，再次验签并确认授权后才回到 Selector。

## 八、安装、停用、撤销与卸载

| 操作 | 预期行为 |
|---|---|
| 安装 | 验签并落盘，但只有有效授权和通过激活校验后才出现在 Selector |
| 启用 | 写入 `agents.list`，验证热加载，保留独立状态 |
| 停用 | 不再允许新会话和工具执行；历史按策略只读保留 |
| 授权撤销/到期 | Core 立即拒绝新执行，随后从可选列表移除，不依赖下次重启 |
| 升级 | 暂存、自检、Profile 兼容检查、原子切换，旧版本用于回滚 |
| 回滚 | 恢复旧 Profile/能力映射；不把新版本状态错误写回旧版本 |
| 卸载 | 先停用；workspace、记忆、会话是否删除必须单独确认，默认不静默删除用户数据 |

## 九、首个纵向 MVP

第一阶段只验证两个智能体：

1. `main`：龙枢通用助手，无企业写权限。
2. `longhub.agent.hr`：HR 助理，来自现有 HR Pack，包含 JD 起草、简历初筛和录用通知书能力。

MVP 必须证明：

- 两个智能体同时出现在原生 Agent Selector。
- 点击切换后身份、欢迎语和会话立即对应目标 agent。
- 两边会话、workspace、memory 和工具清单互不串用。
- HR Agent 只能使用 HR Pack 声明且已授权的技能。
- 录用通知书等写权限仍弹出人工确认。
- 撤销 HR entitlement 后，已打开页面也不能继续执行 HR 技能。
- 已授权但未安装的 HR Agent 可以从 Selector/目录入口一键下载、验签、激活并进入专属会话。
- Gateway 重启、客户端升级和 Pack 回滚后映射仍稳定。

上述重启、状态升级、Pack 升级/回滚和既有 OpenClaw 共存场景已通过 0.3.6 候选版连续 E2E；
证据见 [LH-036-08 验收报告](docs/validation/LH-036-08-candidate-continuity.md)。全新 userData 的
云端授权、一键下载验签、真实 Gateway 激活和真实 Electron 点击证据见
[LH-036-09 验收报告](docs/validation/LH-036-09-agent-provisioning-e2e.md)。
OpenClaw 精确版本、Selector/Stop/模型控件、路由和 Gateway RPC 已集中到版本化兼容契约；真实
Gateway + Electron UI 合约和视觉签名证据见
[LH-037-01 验收报告](docs/validation/LH-037-01-openclaw-compat.md)。

## 十、验收与测试

### 契约测试

- Agent Profile schema、禁止字段、引用文件和 Pack ID/Profile ID 一致性。
- Profile → OpenClaw agent config 的确定性快照。
- 权限交集、过期授权、停用、撤销和预算边界。
- Pack 升级、回滚与不可兼容 Profile 迁移。

### 集成测试

- Cloud entitlement → 下载 → 验签 → 安装 → 激活 → Selector 可见。
- `agents.list` 热加载和失败回滚。
- Tool Bridge 传递可信 agent/session 上下文，伪造参数不能越权。
- Core/Worker 的 L1、L2 和敏感确认链路。
- 授权缓存过期、离线、高风险在线复验和撤销推送丢失后的安全失败。

### UI/E2E

- [x] 通用助手与 HR 助理一键切换。
- [x] 切换时有活动任务的阻止/停止流程。
- [x] 每个 agent 的最近会话、新会话和标题。
- [x] 已授权未安装 Agent 的安装中、失败重试和成功后专属会话进入。
- [x] 锁定版 Selector、模型隐藏、受限导航和宿主方法的 UI 合约与容差视觉回归。
- [x] 龙枢品牌、中文状态、可读会话标题、基础设施词汇隐藏和 `/chat` 路由白名单回归。
- 授权过期、离线和回滚状态的完整截图回归。
- 上游升级后 Agent Selector、会话过滤和工具展示截图回归。

## 十一、暂不包含

- V1 不允许一个会话同时绑定多个主智能体。
- V1 不做 Agent 自动路由；用户显式选择是权威来源。
- V1 不共享不同 Agent 的私人记忆或原始会话。
- V1 不允许第三方 Pack 携带任意原生代码或自行加载 OpenClaw 插件。
- V1 不让 Pack 直接选择真实模型或绕过龙枢模型代理。

## 十二、变更历史

### 2026-07-29 - 完成一键切换界面产品化

**变更内容**：将 Agent Selector 所在原生页面统一为龙枢品牌与中文 UI，默认会话显示可读标题，
悬停不泄露内部 session key；管理导航和管理员欢迎建议从普通用户页面移除。

**变更理由**：一键切换的对象应是可理解的功能智能体，底层 agent/session/Gateway 术语不应成为
用户配置负担；产品化不能改变 Agent 隔离、路由或 Core 权限边界。

### 2026-07-29 - Agent UI 依赖纳入版本化兼容契约

**变更内容**：把 Agent Selector、Stop 控件、`selectAgent()`、会话宿主属性、模型/管理入口选择器、
Gateway RPC 和固定 UI 基线集中到 `@longhub/openclaw-compat`，并增加真实 UI 合约与视觉回归。

**变更理由**：一键切换依赖上游 UI 与 RPC 语义，必须在升级时显式失败并重新验收，不能让选择器
变化、模型入口回归或会话路由错误静默进入客户端。

### 2026-07-29 - 完成已授权未安装 Agent 一键安装验收

**变更内容**：全新 userData 可从 Selector 发现已授权 HR，一次点击完成下载、元数据核对、验签、
信任持久化、激活和专属会话进入；增加真实 OpenClaw Gateway 与真实 Electron 点击 E2E。

**变更理由**：智能体授权必须直接转化为普通用户可理解的一键体验，同时保持 WebUI 无本机通用
权限、云端目录无权注入任意 Agent 身份、Core 最终授权不下放到 Selector。

### 2026-07-29 - 完成真实 Selector 一键切换验收

**变更内容**：增加已启用 Agent 允许列表、原生样式 Selector 补齐、最近会话恢复、执行中确认停止、
历史 Agent 隐藏和 `agent:main:main` 回退，并用真实 Gateway + Electron 点击 E2E 验证。

**变更理由**：上游 Control UI 可能不渲染非默认 Agent，且会从历史会话重新枚举已撤销 Agent；
配置/RPC 层通过不足以证明最终用户体验与撤销语义。

### 2026-07-29 - 完成 Pack 运行时生命周期

**变更内容**：实现 Pack 启用/停用、active 制品签名复验、30 秒 entitlement/release 同步、Core
动态策略撤销、OpenClaw `config.patch + baseHash` 热加载与 `agents.list` 回读，以及三方状态回滚。

**变更理由**：授权撤销必须同时满足“旧会话不能执行、Selector 实时移除、历史不删除”，并在
配置并发冲突或 Gateway 失败时恢复一致状态。

### 2026-07-29 - Core 收口执行授权

**变更内容**：Bridge 增加可信 ToolCall 绑定；Core 每次执行在线复验 entitlement 与 Pack 版本，
计算 Profile/Pack/租户/设备权限和预算交集，并实现绑定输入摘要的一次性人工确认。旧任务入口不再
接受调用方权限。

**变更理由**：撤销、确认重放、参数替换和调用方伪造权限必须在最终执行边界统一阻断。

### 2026-07-29 - 建立一键智能体切换设计

**变更内容**：复用 Agent Pack、Core/Worker、OpenClaw 多 Agent 和原生 Agent Selector，定义
Profile 契约、激活流程、会话隔离、Tool Bridge 和权限边界。

**变更理由**：一键切换不同功能智能体是龙枢的核心产品目标，必须先于远期能力市场建设。
