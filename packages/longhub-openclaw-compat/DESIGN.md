# LongHub OpenClaw Compat 设计

## 设计目标

把 LongHub 对 OpenClaw 的精确版本、路由、DOM、RPC 和视觉基线依赖从隐式实现细节提升为显式、
版本化契约。上游升级只有在契约、真实 Gateway、真实 Control UI 和视觉基线全部通过后才能进入
新的 LongHub 版本。

## 方案选择

选择独立纯 TypeScript workspace 包，而不是继续在 Desktop 文件间共享字符串，也不维护完整
OpenClaw 分叉。独立包可以被启动预检、产品策略、Selector、Gateway 客户端和测试共同引用；精确
锁版加小型薄适配的维护成本远低于长期 fork。

## 关键决策

### 精确版本并运行时核对

契约只接受 `2026.7.1-2`。Desktop 从实际 `openclaw.mjs` 同目录读取 `package.json`，不根据 PATH、
锁文件或用户安装推测版本。缺失、损坏或版本漂移时进入可诊断错误页，不启动未知 Gateway。

### 语义优先，DOM 依赖显式登记

优先使用 `data-chat-agent-filter`、Gateway RPC 和 URL 路由等语义契约。仍不可避免的 CSS class、
宿主方法和属性全部登记在 `OPENCLAW_COMPAT_CONTRACT`，禁止在新的 Desktop 代码中复制魔法字符串。

### 契约摘要不是安全签名

SHA-256 摘要用于升级审查：契约字段变化会让测试失败，要求开发者确认真实 UI/RPC 证据并更新
基线。它不证明上游制品可信，供应链信任仍依赖锁文件、发布流程和后续签名更新元数据。

### 安全边界

模型和设置入口隐藏只改善产品体验；云端强制模型覆盖、同源导航、Gateway Token 和 Core 在线
授权才是安全边界。兼容模块不接收远端配置、不执行命令，也不允许云端覆盖选择器或 RPC 方法。

### Product Extension Surface V1

主 WebUI 继续没有 preload、Node 或通用 IPC。它只能触发
`longhub-extension://open/{agents|skills|account}` 三个精确入口；入口解析拒绝 query、fragment、凭据、
端口、额外路径和 confirmations 直达。子窗口资源固定为 `longhub-product://app` 独立 origin 下的四条
路由，005 实现时必须把该 scheme 注册为 standard、secure 且只从签名应用资源提供内容。

子窗口固定 `contextIsolation=true`、`sandbox=true`、`nodeIntegration=false`、
`webSecurity=true`、`allowRunningInsecureContent=false`。V1 preload 只能暴露 context-read 和
window-close 两个 channel；每次请求严格绑定 UUID window_id、route entry、action 和 32 字节
base64url 一次性 nonce。新增文件、保存、麦克风、截图或业务动作必须建立新的单用途 channel 和契约
版本，不能复用这两个 channel 传任意 payload。

威胁模型覆盖：恶意聊天内容伪造链接、跨 origin 导航、同窗口 confused deputy、nonce 重放、Renderer
字段走私、Cloud 内容替换本机签名资源、preload 权限膨胀和上游 DOM 漂移。Feature Policy 与 Core
执行鉴权仍是最终授权；扩展面只提供受限展示和请求入口。

### OpenClaw Native Surface V3

主导航直接恢复锁定版 OpenClaw 官方侧边栏，不复制 Agents、Skills、Sessions、Usage、Activity 或 Tasks
页面。契约以同源、精确 basePath 和路由白名单开放这些原生页面；所有未登记路径默认拒绝。Agents 页面
只允许 Overview、Tools、Skills、Channels 查看，Files/Cron 和模型/工具/技能配置控件被移除；Skills
页面只允许目录、详情与安全报告查看，ClawHub 安装、启停、依赖安装和 API Key 编辑被移除。

UI 收口只负责产品体验和误操作防护，不是执行授权。模型覆盖、Skill 安装、CloudRef 调用、Pack 生命周期、
entitlement、预算和写操作仍由 Cloud/Core 在执行点复验。旧独立 sandbox webContents 只保留确认、文件、
可恢复删除等上游没有安全原生面的单用途能力，不再注入“智能体 / 能力 / 我的”主导航。

## 已知限制

- 当前契约仍登记少量 OpenClaw 私有 DOM/CSS 和 `selectAgent()` 宿主方法。
- 视觉指纹主要阻断同一 Windows/Electron 基线上的明显变化，不能代替人工视觉评审。
- 上游版本变化必须人工阅读发布说明，不能仅通过修改版本和摘要绕过升级流程。
- 本模块只声明品牌、中文化和可读会话标题契约；实际页面改写由 Desktop 的受限产品化薄层执行。
- UI 产品化仍依赖少量锁定版 class；正式视觉稿可以替换同名资源，但选择器变化必须重新验收。

## 变更历史

### 2026-08-01 - 恢复官方原生导航与安全页面

**变更内容**：普通用户开放 Chat、Activity、Agents、Sessions、Usage、Tasks、Skills 官方路由；删除自制
三入口注入，增加精确 basePath 路由白名单和 Agents/Skills 高风险控件契约。

**变更理由**：仿原生同壳仍与 OpenClaw 官方页面不一致，也让 Agent 切换和 Skill 发现出现双重入口。

**影响范围**：Desktop 导航、产品 CSS、Agents 初始面板、OpenClaw 升级回归与安全文档。

**决策依据**：尽量零复制复用上游页面；只在控制面、凭据、任意执行和私有 Skill 分发边界收口。

**兼容摘要**：`EDC310A59F7B4C029C77A8FD5B98F8F9AFC0A433E04C6192E46CC1DC3415C88F`。

### 2026-07-31 - 冻结 Product Native Shell V2

**变更内容**：增加同壳纵向导航、单 Agent 常显 Selector、抽屉视觉区和智能体管理动作；OpenClaw
兼容摘要更新为 `6BCD8EB1D6D6EB56B409EBA60F38BD42B68664207BAA53D954045E0831CB28B3`，产品扩展面摘要更新为
`87184A95526757029FA13C82B18DF7478626B7E99518FC9B4174379D9EF73208`。

**变更理由**：0.8.2 的入口可见性通过，但横排裸链接、独立页面和单 Agent 隐藏不满足原生产品验收。

**影响范围**：Desktop 入口、Selector、智能体管理、隔离抽屉和真实 UI 基线。

### 2026-07-30 - 冻结 Product Extension Surface V1

**变更内容**：登记三入口、四路由、独立 origin、窗口参数、最小 IPC、动作绑定、视觉区域和严格解析
函数；005 登记固定入口挂载点和标签后，独立契约摘要为
`50EE109D6EA808160143517B0466C41D0A2DB8A5ECA3746A1702A898B4D46939`（006 增加三个确认
单用途 channel 后）。

**变更理由**：005/006 需要先共享不可放宽的窗口与 IPC 边界，避免新增入口继续扩大 OpenClaw DOM
补丁或给主 WebUI 暴露 Electron 权限。

**影响范围**：后续 Desktop 产品子窗口、preload、导航策略、确认中心和 OpenClaw 升级审查。

### 2026-07-29 - 扩展龙枢产品 UI 契约

**变更内容**：登记品牌图文、会话名称/链接、运行状态、欢迎建议、普通用户隐藏入口和固定中文词表，
契约摘要更新为 `0A59AE77AED4081717E57A5211150F62A1C15569BBF0F92EE0714EE5E903F030`。

**变更理由**：LH-037-02 的 DOM 和文案依赖必须与精确上游版本共同审查，不能重新散落到 Desktop。

**影响范围**：产品 CSS、页面产品化脚本、UI 合约、视觉基线和后续 OpenClaw 升级审核。

### 2026-07-29 - 建立 v1 兼容契约

**变更内容**：集中 OpenClaw 精确版本、路由、Selector/Stop/模型控件 DOM、Gateway RPC、
`replacePaths`、固定视口和契约摘要，并提供实际安装版本预检。

**变更理由**：阻止上游升级后 UI 或 RPC 变化静默进入客户端，同时保持薄适配而非完整分叉。

**影响范围**：Desktop 启动、Control UI 地址、产品导航、Selector、Gateway 热更新和升级测试。

**决策依据**：单一事实来源加真实上游测试可以在减少分叉面积的同时建立明确发布阻断条件。
