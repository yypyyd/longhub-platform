# LongHub Desktop 设计

## 界面与运行边界

LongHub Desktop 是 OpenClaw 的 Windows 桌面宿主。Electron Main 负责启动和回收
Gateway、Core 与 Worker；用户主界面直接使用 Gateway 同端口提供的 OpenClaw
Control UI。原有 LongHub React Renderer 仅作为历史原型保留，不再是产品默认入口。

```text
Electron Main
  ├─ Agent Registry / Config Composer ── Profile → agents.list
  ├─ 启动 OpenClaw Gateway ── HTTP/WS :18789 或空闲回环端口
  ├─ 启动 LongHub Core / Skill Worker
  └─ BrowserWindow ────────── OpenClaw Control UI / Agent Selector
                                  │
                                  └─ LongHub Tool Bridge → Core RPC
```

后续品牌、文案或导航的小改应优先基于上游 Control UI 的扩展点或维护最小补丁，避免
重新创建一套与 OpenClaw 功能平行的面板。

## 首次授权码激活

启动顺序固定为“注册/复用设备 → 查询激活状态 → 必要时核销授权码 → 准备运行配置 → 启动
Core/Gateway → 打开原生 `/chat`”。设备注册本身不放行后续步骤。未激活设备只看到 520 × 620
的独立窗口；关闭窗口等同取消启动，不能进入聊天页。

激活窗口使用 `sandbox=true`、`contextIsolation=true`、`nodeIntegration=false`，最小 preload 只暴露
`longhubActivation.submit(code)`。Main 同时校验 IPC sender 的 webContents ID 和精确 file URL，
其他窗口即使知道 channel 也不能核销。窗口销毁后 handler 与 preload 一并退出，主 OpenClaw
BrowserWindow 继续保持无 preload、无 Node、无 LongHub IPC。

企业无人值守安装可通过 `LONGHUB_ACTIVATION_CODE` 提交预分配授权码，但仍调用同一云端核销接口，
不提供离线或环境变量绕过。授权码撤销/过期后，云端立即阻断模型和产品 API；当前客户端在下次
启动显示激活页，运行中的体验回退留作后续优化。设备 Token 由 Windows Credential Manager
保存，`device.json` 只保留设备指纹、非敏感设备 ID 和 schema 版本。

## Windows Credential Manager 与旧凭据迁移

每个规范化 Cloud Base URL 映射为 `LongHub Desktop/device/<SHA-256>` 类型的 Generic Credential，
Target 不暴露服务地址，Credential Blob 保存版本化设备 ID 与 Token。Desktop 通过固定内嵌的
Win32 `CredReadW/CredWriteW/CredDeleteW` 适配器访问当前 Windows 用户的 Credential Manager；
秘密只从隐藏 PowerShell 子进程 stdin 传入，不进入命令参数、仓库或错误文本。

旧 `device.json#tokensByBaseUrl` 按事务迁移：先写 Credential Manager，再重新读取并使用
constant-time 比较 Token；只有设备 ID 和 Token 都一致才原子重写 `device.json`。写入失败、超时、
回读不一致、旧文件损坏或云端无法恢复旧设备 ID 时都保留旧文件原文并停止启动，不能静默注册新设备
导致原授权丢失。多 Cloud URL 会全部写入并验证，只有全部成功后才一次性清空旧文件。

更早版本可能只保存 Token、没有设备 ID。Cloud API 的已认证激活状态因此返回当前凭据所属
`device_id`；部署顺序必须是“兼容 Cloud API → Desktop 0.4.0”。Credential Manager 主要防止备份、
日志或普通本地文件读取造成的静态泄露，不承诺抵御已取得同一 Windows 用户权限的恶意进程或管理员。

## Windows 发布签名与品牌门禁

`dist:internal` 与 `dist` 是两条不同发布路径。内部路径在未显式提供证书时关闭本机证书自动发现，允许安装包和龙枢
主程序保持 `NotSigned`，但仍校验资源完整性、内置 Node 官方签名和运行时版本；正式路径在构建前
要求品牌清单为 `approved`，构建后要求安装包与 `龙枢.exe` 的 Authenticode 状态为 `Valid`、签名
Subject 包含 `LONGHUB_EXPECTED_SIGNER_SUBJECT`，并存在可信时间戳。任一条件失败都不能发布。

签名证书由 electron-builder 从受控构建环境读取，推荐使用 `CSC_LINK` / `CSC_KEY_PASSWORD` 或
受保护的证书存储；PFX、私钥、密码和签名服务凭据禁止进入仓库。内置 Node 必须继续保留 OpenJS
Foundation 的有效签名与时间戳，不能因为龙枢签名流程覆盖或破坏第三方来源证明。

品牌资产通过 `assets/brand-manifest.json` 固定状态、审批人、审批时间和 SVG/PNG/ICO SHA-256。
正式 ICO 必须包含 16、24、32、48、64、128、256 像素图层，PNG 为 256×256。当前产品选定头像源为
`assets/longhub-avatar-source.png`，脚本确定性生成头像、SVG、PNG 和 ICO，并同步用于主 Agent 原生头像、
Control UI、激活页、BrowserWindow 与安装包。清单仍标记 `temporary`，因此只能构建内部候选；完成正式
品牌审批后补齐审批人与时间即可，不需要再次修改应用代码。

## ASAR 与外置运行时边界

生产包启用 ASAR。Electron Main、激活页、Renderer、Core 和 Skill Worker 保留在 `app.asar`；
Core/Worker 由带 `ELECTRON_RUN_AS_NODE=1` 的龙枢 Electron 主程序执行，能够读取 ASAR，不能因为
实现方便而外置。随安装包分发的独立 `node.exe` 只负责 OpenClaw CLI/Gateway，它不认识 ASAR，
因此 OpenClaw、LongHub Tool Bridge 及其实际生产依赖闭包位于 `app.asar.unpacked/node_modules`。

外置集合由 `openclaw-runtime-packages.json` 锁定，以 `openclaw` 和
`@longhub/openclaw-bridge` 为根递归解析 dependencies、已安装 optional dependencies 和 peers。
构建前重新计算并与清单逐字比较；上游升级或 lockfile 变化导致闭包漂移时 fail-closed，必须先执行
`pnpm runtime:manifest`、审查新增包和原生制品，再提交清单。Windows 构建明确排除 Darwin、Linux
和 win32-arm64 的可选原生包，避免 electron-builder 自动解包无关平台二进制。

pnpm workspace 依赖在开发树中是应用目录外符号链接，不能直接和 electron-builder 的
`asarUnpack` 过滤器组合。发布脚本先用冻结 lockfile 生成仓库级 `.release-stage/desktop` 生产部署树，
再从物理文件构建并在结束后删除暂存目录。验收拒绝 `resources/app` 残留，检查 ASAR 内应用资产、
外置文件所属包白名单和品牌摘要，并使用安装目录中的真实可执行文件运行 Core hello、Worker echo、
Bridge runtime inspect 以及 Gateway `/chat`。

## 零配置启动与固定模型

客户端启动时先用设备凭据请求龙枢云端 `/v1/client/runtime-config`，再原子写入独立的
`userData/openclaw/openclaw.json`。配置只包含一个 `longhub/longhub-default` allowlist；
设备 Token 通过 `${LONGHUB_MODEL_TOKEN}` 环境变量注入，不写入 OpenClaw 配置文件。

配置同时显式指定 `agents.defaults.workspace=userData/openclaw/workspace` 并关闭上游自动
Bootstrap。龙枢只在身份文件缺失时预置“龙枢助手”，不复制 `~/.openclaw/workspace`，也不
覆盖后续品牌定制；因此用户已有 OpenClaw 的身份、记忆、技能和提示文件不会串入内嵌实例。

Gateway 使用显式 `--auth token` 和 `gateway.mode=local` 启动。Control UI 地址固定为 `/chat`，
同时传入 URL 编码的 `gatewayUrl` 与 fragment Token。产品策略隐藏聊天模型选择器和设置入口，
并拦截 `/settings/*` 导航；即使绕过 UI，云端代理仍会覆盖真实模型 ID。

### 运行配置退避与安全缓存

运行配置响应必须精确符合 `longhub/runtime-config/v1`，包含配置版本、签发时间和最长十分钟有效期；
未知字段、非固定 provider/model/base path、异常 token 上限、未来签发或已过期响应都在启动 Gateway
之前失败。网络错误、HTTP 429 和 5xx 最多尝试三次，默认按 500ms、1s 指数退避并加入最多 25% jitter。
401/403、成功响应协议不兼容或严格校验失败不重试，也不能读取旧缓存掩盖授权或协议错误。

缓存位于龙枢独立 `userData/openclaw/runtime-config-cache.json`，通过同目录临时文件和 rename 提交，
只接受普通文件并按 `0600` 创建。记录绑定规范化 Cloud origin 与设备 ID，在线响应和缓存复用同一
白名单解析器；缓存配置自身有效期与本地缓存年龄均不能超过十分钟，检测到过期、时钟异常、损坏、
跨设备或跨 Cloud 时 fail-closed。写缓存失败不阻断本次已经严格验证的在线启动。

缓存只含公开固定路由元数据，不保存设备 Token、上游 API Key、真实上游地址或真实模型 ID，也不是
身份或授权证明。即使从缓存启动，OpenClaw 后续每次模型调用仍携带 Credential Manager 中的设备
凭据访问 Cloud，服务端逐请求复验激活状态并强制覆盖真实模型，因此授权撤销不会被本地缓存绕过。

## 一键智能体切换

Agent Pack 是安装、签名、授权、升级和回滚的制品，Agent Profile 才是用户实际切换的智能体。
Pack 激活时，Desktop Agent Registry 校验签名 Profile，持久化 Pack ID、Profile ID 与 OpenClaw
agentId 的稳定映射；Config Composer 再把全部已安装且已授权 Profile 编译为完整的
`agents.list`。普通 Pack 不得覆盖内置 `main`。

PackInstaller 在落盘前执行 Agent Profile V1 联合校验，并对 Manifest 与全部 Pack 文件统一验签；
启动时还会从 current active 指针重新读取制品、校验内容和摘要，再注册 Profile。无 Profile、引用
缺失、能力/权限不一致、危险路径、指针穿越或摘要被篡改时不会进入 Gateway 配置。

Desktop 现在会在 Gateway 启动前把 `main + 已安装且启用 Profile` 编译并原子写入
`userData/openclaw/openclaw.json`。Profile 的 IDENTITY/SOUL/AGENTS 模板由 Pack 管理，USER 模板
只在首次落盘，避免重启覆盖该智能体自己的用户偏好。运行时启用/停用和 entitlement 撤销已经
进入统一生命周期协调器。已授权但未安装的 HR Pack 会出现在原生 Selector，一次点击完成下载、
验签、公钥持久化、Pack 激活、Gateway 热更新和专属会话进入；升级/回滚继续复用同一稳定映射与
补偿事务。

可安装目录由云端 catalog 与当前设备 entitlement 取交集，但 Desktop 只映射客户端锁定版本认识的
Pack。云端目录不能声明 Profile ID、OpenClaw agentId、安装导航或本地命令；真正安装时仍以下载
制品内签名保护的 Manifest/Profile 为准，并重新检查 digest、signature key ID、entitlement、版本和
兼容性。这样 catalog 只决定“已授权候选”，不成为本机执行或身份配置来源。

Selector 的安装入口只产生固定格式
`longhub-agent://install/?packId=<known-pack-id>`。Main 仅接受固定 scheme、host、path 和唯一
`packId` 参数，拒绝凭据、fragment、额外参数和其他协议；请求还必须命中本轮已授权候选列表。
安装时显示安装中和失败重试状态。成功后策略列表先更新，再进入稳定 agentId 对应的
`agent:<agentId>:main`；WebUI 始终没有 preload、Node 或通用 IPC。

Registry 存放于龙枢 `userData`，使用严格版本化 JSON 和同目录临时文件 rename 原子提交。每个
Profile ID 映射为“规范化 ID + 12 位 SHA-256 后缀”，更新显示名、Pack 版本或 Profile 版本不会
改变 agentId；另一个 Pack 也不能接管已经登记的 Profile ID。Registry 损坏时安全失败，不自动
重建映射，避免旧会话被静默绑定到新 agent。

Config Composer 只接收已经通过 Pack 联合校验且 Registry 状态一致的 Profile。输出始终以
`main` 为唯一 default，并按 agentId 排序，保证相同输入生成相同配置；模型来自后台逻辑策略。
V1 同时关闭 `agentToAgent`、subagent、跨会话工具和 elevated，memory search 只允许当前 agent 的
`memory`。生成结果由测试直接调用 OpenClaw 2026.7.1-2 `config validate`，而非只验证自定义类型。

每个 agent 固定使用独立目录：

```text
userData/openclaw/workspaces/<agentId>
userData/openclaw/agents/<agentId>/agent
userData/openclaw/agents/<agentId>/sessions
```

Profile 的身份文件、skills、tools 和 sandbox 策略只写入目标 agent 边界。启动流程使用临时文件
rename 原子写入完整配置；运行中的配置变更使用锁定 OpenClaw 的
`config.patch(raw, baseHash, replacePaths=["agents.list"])`，再通过原生 `agents.list` RPC 回读。
Registry、Core policy 和 Gateway 配置组成同一补偿事务，提交或回读失败时恢复旧状态。

Desktop 默认每 30 秒并发获取 entitlement 与 release check。确认撤销/到期后，协调器先从 Core
动态策略移除目标 Agent，使已打开会话立即失去工具执行权，再从 Selector 移除并让前台回退
`main`。网络暂时不可达时不根据不完整响应误删 Selector，但 Core 每次执行仍在线复验并
fail-closed。停用和撤销都不删除 workspace、agentDir 或 session，因此历史仍可读取且不会改绑。

手工重新启用不信任安装时的旧结论：PackInstaller 从 active 目录重新校验内容摘要、Desktop
兼容性和安装时保存的 Ed25519 签名，再要求当前设备 entitlement 与精确 release 状态均有效。
旧版没有保存签名的安装必须重新下载，不能直接启用。

Control UI 包含原生 Agent Selector 和 `selectAgent()` 会话路由，但 2026.7.1-2 的聊天启动响应在
部分状态下只渲染 default agent；同时上游会把历史会话所属 Agent 重新加入 Selector。Desktop
因此注入无 Node/IPC 权限的薄适配层：以上游原生 class、`data-chat-agent-filter` 和 `selectAgent()`
补齐入口，并以 Desktop 当前已启用 Agent 为唯一允许列表。它不实现聊天、会话存储或 Agent 路由。

切换时适配层优先选择目标 agent 最近的非 main 会话；没有历史时保留其独立
`agent:<agentId>:main`。当前会话出现原生 Stop 控件时，用户必须确认停止，待控件消失后才派发
切换，禁止在运行中的同一会话里热替换身份。撤销时即使历史会话仍存在，也会隐藏目标 Agent 并
显式导航到 `agent:main:main`；现有会话的 agentId 和内容不迁移。

第一阶段固定验证 `main` 通用助手和 `longhub.agent.hr` HR 助理。详细契约、生命周期和验收见
[../../AGENT_PLATFORM.md](../../AGENT_PLATFORM.md)。

## 普通用户功能与 Skill 开放

后续功能不恢复 OpenClaw 原生设置、Channels、MCP、插件或基础设施导航，而是在 `/chat` 内增加
“智能体”“能力”“我的”三个产品薄入口。会话管理、本机搜索/导出、用户偏好/记忆控制可以默认
开放；文件、图片、语音、知识、只读网页搜索和无代码 Agent 按租户策略开放；企业连接器、自动化和
多 Agent 编排需要管理员授权。完整矩阵见 [../../PRODUCT_FEATURE_POLICY.md](../../PRODUCT_FEATURE_POLICY.md)。

Skill 第一阶段只开放官方签名 Skill 的安装/启停，以及无代码 Content/Workflow Skill。现有
`skill-worker.ts` 使用静态 Map 注册可信实现，尚不具备第三方动态代码安装隔离；在独立 Skill
Registry、Schema、解释器和执行沙箱完成前，不能加载用户脚本、OpenClaw 插件或 MCP 服务。详细设计见
[../../SKILL_PLATFORM.md](../../SKILL_PLATFORM.md)。

共同前置条件和实际版本顺序以 [../../EXECUTION_PLAN_V2.md](../../EXECUTION_PLAN_V2.md) 为准：Desktop
先完成 Feature Policy、产品扩展面和确认中心，再增加 Skill、文件、知识或工作流入口。

文件、麦克风、截图和保存操作必须通过 Main 的单用途请求与一次性能力句柄，不能为新增入口恢复
preload 或通用 IPC。当前 runtime-config 的 `file_upload` 只完成严格解析，尚未形成附件 UI、文件解析、
类型/大小/保留和服务端路由的完整门禁，因此仍按待实现能力管理。

## Tool Bridge 与 Core 权限边界

当前主窗口直接加载 OpenClaw Control UI 且不挂载 LongHub preload，因此历史 Renderer IPC 的
`task.submit`、`packs.install`、文件选择等能力不会自动出现在模型工具中。Agent 切换本身可以
直接复用上游，但业务智能体要执行 LongHub Skill，必须增加受限、版本化的 Tool Bridge。

当前实现使用 OpenClaw 公开 plugin SDK 的 tool factory，从工具运行上下文读取可信的
`agentId`、`sessionKey` 和 `sessionId`。Desktop 每次启动生成 256-bit Bridge 令牌和随机回环端口，
只把 URL/Token 注入 Gateway 子进程；Bridge Host 仅接受 `/v1/execute` JSON 请求并限制 1 MiB，
再转发 Core 专用 `bridge.execute`。Bridge 不执行企业操作，不接受模型传入的 agentId 或权限，也
不向 WebUI 暴露通用 Electron IPC。

Core 的策略来自已验签、当前启用 Profile 和 Pack 原始声明，并由生命周期协调器动态替换，而不是调用方预先算好的
`grantedPermissions`。每次 Bridge 执行时，Core 都会重新检查 Profile、Pack、Bridge 最小权限、
租户/设备安全上限和任务预算，并通过设备凭据在线复验 entitlement 与已安装 Pack 版本状态；
任一来源缺失、过期、撤销、版本吊销或云端不可达都安全失败。`main` 没有 HR grant，即使绕过
工具可见性也会被拒绝。HR 当前只开放只读 `longhub_resume_screen`。

Core 在每次执行前重新计算有效权限：

```text
Profile 声明 ∩ 已安装 Pack 版本声明 ∩ 有效 entitlement
∩ 租户/设备策略 ∩ 用户确认 ∩ 当前任务预算
```

OpenClaw 的工具 allowlist 只是模型可见性控制，不是最终授权。entitlement 到期、撤销或 Pack
停用后，Core 必须立即拒绝新执行；随后 Registry 再从 `agents.list` 移除目标智能体。

Bridge 上下文额外绑定 OpenClaw 生成的 `toolCallId`。需要确认的权限由 Core 创建确认记录，记录
绑定 `agentId + profileVersion + sessionId + toolCallId + permissions + payloadDigest`，五分钟过期且
只能消费一次。模型参数不能携带确认 ID、权限或预算；参数变化、切换智能体、Profile 升级和
重复执行都不能复用旧确认。旧 Renderer `task.submit` 同样不再接受调用方权限，只保留无权限的
历史原型技能；需要企业权限的执行统一进入带可信 Agent 上下文的 Bridge 路径。

## 日志与诊断脱敏

Desktop 生产入口不直接使用 `console.*`，统一通过 `@longhub/observability` 输出结构化事件。Gateway
状态、entitlement 同步、Pack 安装和页面策略失败只记录安全元数据与经过收敛的 Error；设备 Token、
Gateway/Bridge Token、授权码、API Key、请求/响应正文、工具输入输出和用户文件内容禁止进入日志。

OpenClaw CLI 或其他子进程的 stderr/stdout 在组成 Error 前先执行自由文本脱敏，用户可见错误页、激活
错误框和历史 IPC 错误消息也复用同一清理函数，防止日志之外的诊断界面再次暴露凭据。自动脱敏不能
识别任意无标签自然语言秘密，因此生产代码仍不得把用户内容作为普通 `message` 记录。

### 一键诊断导出

固定产品错误页显示“导出诊断信息”链接，目标只能是精确的
`longhub-diagnostics://export/`。Main 只有在当前状态记录确认窗口正在显示龙枢产品状态页时才响应，
正常 OpenClaw 聊天页、query/fragment、凭据、额外路径、其他 host 或协议全部拒绝。错误页继续使用
`default-src 'none'` CSP、无脚本、无 preload、无 Node 和无 IPC；点击只触发 Main 的原生保存对话框。

导出格式固定为 `longhub/diagnostic-export/v1`，只包含：Desktop/OpenClaw/Electron/Node/OS 版本，
打包状态，公开产品错误码，Gateway 阶段与退避次数，运行配置来源/尝试次数/配置版本/过期时间，更新
信任与 pending 阶段，以及 active/installable Agent 数量。版本字段只接受短安全字符，运行配置版本
只接受当前协议的规范时间或 `unconfigured`；自由文本变成 `unknown`/`invalid`，不能进入报告。

导出器不读取控制台日志、OpenClaw 会话、聊天消息、提示词、用户文件、环境变量、Credential Manager、
设备 ID、授权码、Token、Cloud/上游 URL、端口、PID、安装路径或 userData 路径，也不会上传报告。用户
明确选择本地 JSON 位置后，临时文件以随机 UUID、`wx`、`0600` 创建并原子 rename；相对路径、非 JSON、
符号链接和非普通目标拒绝。日志只记录 schema 与字节数，不记录报告内容或用户选择的保存路径。

报告是用户主动分享的明文支持材料，仍会暴露软件/OS 版本、公开错误码和功能数量；这是排障所需的
最小已接受信息面。它不适合作为认证、授权、健康证明或服务端遥测，接收方也不能据此执行管理操作。

### 最小匿名运行指标

自动遥测与用户主动诊断导出是两条独立边界。Desktop 只有在设备完成授权码激活后才创建内存上报器；
公共字段固定为 Desktop/OpenClaw 语义版本、`win32` 与 `x64/arm64`，事件只有启动耗时及 active Agent
数量桶、Gateway 阶段、更新结果和产品页公开短错误码。实际毫秒数、Agent ID/Pack ID、设备/用户/
租户 ID、Cloud/Gateway URL、端口、PID、路径、异常、日志和任何聊天或文件内容都不能进入事件。

上报器最多合并 32 项，五秒后发送；无磁盘队列、无会话标识、无无限重试。HTTP 非 2xx、断网、超时
或进程退出只丢弃当前批次并记录固定 `telemetry.batch_dropped`，不会阻断启动、聊天、更新、退出或
触发产品错误页。服务端仍执行独立严格解析，因此本地类型不是唯一隐私防线。

崩溃率不依赖崩溃转储。`client-run-marker.json` 只含固定 schema 与 `running|clean`：启动读取上一状态后
原子写 `running`，`will-quit` 同步写 `clean`。符号链接、非普通文件、损坏或写入失败只产生固定日志并
安全降级；下一次启动只上报 `clean|unclean`，不上传时间、路径、身份、异常或会话信息。

### 日志轮转与状态目录配额

Desktop 的共享脱敏 Logger 在进程就绪后同时写入 `userData/logs/desktop.jsonl`。每行仍先经过
`@longhub/observability` 递归脱敏，再进入固定 JSONL 文件；单文件最多 5 MiB，连同 active 共保留
5 个文件，总预算约 25 MiB。日志目录和轮转目标必须是龙枢 `userData` 内的真实普通目录/文件，符号
链接、junction 和非普通条目会关闭文件 sink，但不会阻断客户端启动或退化为未脱敏输出。

启动维护器只枚举龙枢明确拥有的 `openclaw`、`packs`、`client-updates`、`logs` 和固定状态文件，统计
普通文件大小但不读取内容、不跟随符号链接，最多扫描 250,000 个条目。8 GiB 是受管状态硬上限：
清理可再生数据后仍超限时，主窗口进入固定 `STORAGE_QUOTA_EXCEEDED / LH-ST-001` 页面；页面不接收
路径或文件名，用户仍可导出既有白名单诊断。若目录条目超过扫描安全上限或无法确认大小，同样安全
阻断，不能把“未完成统计”误判为“未超限”。

状态维护完成后通过所在文件系统的可用块数检查剩余空间，最低保留 256 MiB；低于门槛进入固定
`STORAGE_SPACE_LOW / LH-ST-002`。关键写入即使绕过预检后才遇到 `ENOSPC` 或用户磁盘配额
`EDQUOT`，产品错误分类仍收敛到同一页面，不误报成“模型未配置”。测试使用可注入可用字节数模拟，
不通过真实写满开发机磁盘制造风险。

自动删除候选严格限定为：超过 24 小时的固定命名原子写临时文件、未完成更新下载和 Pack staging，
以及超过 7 天且不再被 pending 更新引用的已完成更新下载。执行前再次检查候选位于允许根目录、不是
符号链接且 realpath 未越界；单个删除失败只累计计数并继续启动。清理报告只记录文件/目录数量、回收
字节、受管状态字节、异常条目和错误数量，不记录路径。

`userData/openclaw` 中的会话、记忆、workspace、agentDir 和 SQLite 状态只计入配额，永不自动删除；
Pack 版本、Registry、Credential 元数据、运行配置、更新 installer 库、完整快照和 failed-state 也不在
候选内。pending 更新公开其快照、目标/回滚安装器和失败状态引用供维护器保护。用户独立的
`~/.openclaw` 不在龙枢 `userData` 下，维护器既不枚举也不修改，因此共存边界保持不变。

## Gateway 运行中恢复与产品错误页

Gateway 的 `running` 只表示子进程已经创建，不代表聊天可用。首次启动和运行中重启都必须以同源
`GET /chat` 的 2xx HTML 响应作为健康门槛；PID、TCP 端口或 JSON 健康响应都不能提前放行原生界面。
每次真实健康后 Supervisor 才清零重启次数，因此阈值表示“连续失败”，不会把数天内互不相关的退出
累计成一次故障。异常退出后立即显示自动恢复页，并按 1s、2s、4s 指数退避；退出码 78 属于配置错误，
停止无意义重试；重启耗尽进入终止错误页。旧进程迟到的健康结果通过 recovery cycle 丢弃，不能覆盖
更新后的错误状态。

Windows `powerMonitor.resume` 触发后，Desktop 立即显示自动恢复状态并重新探测当前 PID 对应的真实
`/chat`，休眠复检最多等待 15 秒。健康则重新加载聊天页并清零连续失败；PID 消失或页面不健康则调用
Supervisor 受控重启。
受控重启会合并并发请求、取消旧退避计时、回收旧进程并重新计算连续失败次数；新进程仍必须通过原有
HTML 健康门槛。休眠复检使用同一 recovery cycle，旧探测的迟到结果不能覆盖更新后的失败状态。

用户页面只接收稳定的 `ProductStatusCode`，再映射到白名单标题、说明、操作建议和短错误码。当前分类
覆盖云端不可达、设备凭据失效、需要激活、后台模型未配置、限流、上游服务不可用、Gateway 配置错误、
重启耗尽、启动超时和 WebUI 加载失败。原始 Error、HTTP 正文、服务 URL、Token、本机路径和用户内容
只允许进入统一脱敏日志，不能作为错误页参数。页面使用 `default-src 'none'` CSP，不含脚本、preload、
Node 或 IPC；恢复成功后仍回到 OpenClaw 原生 `/chat`，不创建第二套业务面板。

更新 pending 期间，进程出现不等于客户端健康。只有主窗口真实加载允许的 `/chat` 后才执行更新健康
标记；错误页和重连页不会误清除 180 秒回滚计时器。

## 客户端更新信任与防回滚

Desktop 更新验证器只接收构建时预置、经发布审批的 Update Ed25519 公钥集合。公钥可以进入安装包，
私钥绝不能进入仓库或客户端；公开 `/client-releases/signing-key` 仅供运维核对，运行时不能用它新增
信任锚。Update key 与 Agent Pack key 使用不同用途域和密钥，避免跨协议签名复用。

每次检查严格验证响应外层、签名 envelope、stable/beta 渠道、win32/x64 和 Cloud 同源下载路径。
各渠道最高 sequence 与完整签名元数据 SHA-256 原子保存在 `userData`：低序列视为重放，同 sequence
不同内容视为 equivocation，状态文件损坏时 fail-closed。即使签名有效，下载完成后仍必须流式核对
实际大小和 manifest SHA-256，验证成功前不能执行安装器。

Electron Main 已接入稳定渠道更新事务，但只有打包内 `update-trusted-keys.json` 为 `approved`、至少包含
一个 Ed25519 公钥并绑定 Authenticode Subject 时才启用。仓库默认清单保持 `pending` 且为空，内部候选
不会在线自举信任；公开构建门禁要求审批字段完整，并核对清单 Subject 与正式构建 Subject 一致。

聊天 WebUI 首次健康加载 30 秒后检查，之后每六小时检查一次。更新元数据验签后使用 Electron 原生
对话框确认下载；下载禁止重定向和覆盖，完成大小/SHA-256 验证及 Windows Authenticode 状态、主体、
可信时间戳复验后，还必须通过 `/client-releases/versions/{current}` 取得当前已安装版本的签名元数据，
把旧安装器下载到 `userData/client-updates/installers/{version}` 并执行相同验证。旧安装器缺失或不可信
时阻止安装新版本。用户无需选择渠道、模型、灰度组或回滚版本。

确认安装后依次停止 Core、Gateway 和 Tool Bridge，保存固定 LongHub userData 快照，并写入严格
`longhub/client-update-pending/v2`。pending 同时绑定 previous/target 版本、两份签名 metadata、两个
安装器绝对路径、快照、启动次数与 `installing_update/rollback_launched` 阶段；v1、未知字段、路径越界、
符号链接或异常文件按失败关闭处理。新版本健康后再次验证目标安装器并提升到可信库存，只保留当前版
和上一版安装器以及最近两个快照。

目标版本每次启动原子增加 attempts；第三次仍未健康，或启动后 180 秒内真实聊天 WebUI 未健康，触发
single-flight 自动回滚。回滚前再次验证旧 metadata 的 Ed25519、安装器大小/SHA-256、Authenticode
主体和时间戳；随后把失败状态移入 `client-updates/failed-states`，幂等恢复 `openclaw`、`packs`、
Registry、信任 key、设备状态和更新 sequence 快照，再以 NSIS `/S` 启动旧安装器。用户独立安装的
OpenClaw 路径不在恢复集合内，不会被读取、覆盖或卸载。

旧版本启动且发现 `phase=rollback_launched` 后写入严格 `last-rollback.json` 并清除 pending。更新验证器
对该记录中的 target version 返回 `rollback_blocked`；后台改变 rollout sequence 不能再次安装同一坏
制品，只有更高版本才恢复提示。失败状态和诊断快照保留供排查。未知 key、状态篡改、旧序列、同序列
异文、跨源 URL、摘要或 Authenticode 不一致均停止更新；损坏恢复状态会阻断启动，避免在未知数据阶段
继续运行或覆盖可恢复证据。

更新 v2 manifest 将 rollout 的 `active/paused`、`basis_points`、256-bit seed 和更新时间全部纳入
Ed25519 签名。Desktop 使用 Credential Manager 内设备身份和签名 seed 计算 `0..9999` bucket；固定
seed 让 5% → 25% → 100% 扩大时 cohort 单调，用户不选择渠道或灰度组。paused 和未命中设备仍会
记录更高 sequence，从而拒绝旧 active 策略重放。灰度只是运营稳定性控制，不替代设备授权。

安装对话框确认后、停掉 Core/Gateway/Bridge 前，协调器再次获取并验证最新 metadata。若版本、摘要、
下载路径发生变化，或策略已经暂停/不再命中，则结果为 withdrawn，当前运行时保持不动；若只是同一
制品扩大灰度并产生更高 sequence，则使用最新签名 metadata 创建 pending 快照。

`rollback_data_strategy` 也是签名字段。当前发布端固定为 `snapshot_required`，因为尚无跨版本状态迁移
向后兼容证明；未来只有完成真实升级→降级迁移演练的版本才能声明 `backward_compatible`。即便声明
兼容，仍保留安装前快照作为诊断和灾难恢复证据。

## 安全边界

- BrowserWindow 保持 `sandbox: true`、`contextIsolation: true`、
  `nodeIntegration: false`。
- OpenClaw Control UI 不挂载 LongHub preload，因此上游页面无法调用套装安装、文件选择
  或任务控制 IPC；后续 Tool Bridge 只暴露固定工具并走 Core 二次授权，不改变这一边界。
- 内嵌 Gateway 每次启动生成 256 位随机共享令牌（可由
  `OPENCLAW_GATEWAY_TOKEN` 覆盖），并通过子进程环境变量传递，不写入仓库或日志。
- Control UI 按 OpenClaw 官方约定从 URL fragment 一次性导入令牌；令牌不会出现在 HTTP
  请求、Referer 或查询参数中。
- WebUI 覆盖地址必须与 Gateway 同源，防止第三方页面读取 fragment 中的管理令牌。
- 主窗口导航只允许当前 Gateway 同源且非设置路由；唯一的 Agent 安装自定义协议必须通过严格解析
  并命中 Desktop 当前候选列表，其他外部来源、自定义协议、额外参数和新窗口全部拒绝。
- 本机已占用 18789 端口时不复用未知 Gateway，改为让操作系统分配空闲回环端口，避免把
  管理 Token 发送给其他进程，同时不阻断客户端启动。
- 上游模型 API Key 永远不进入客户端；设备只持有可撤销的龙枢设备凭据。
- 主界面是本机管理面，不应暴露到公网。复用远程 Gateway 时由部署方负责 TLS 与令牌。

产品模式不复用已占用的本机 Gateway 端口；开发/集成环境只有显式提供
`OPENCLAW_GATEWAY_URL` 时才连接外部 Gateway。显式设置 `OPENCLAW_GATEWAY_PORT` 时保持
严格语义，端口冲突会失败而不会静默改端口。

OpenClaw 首次启动会在自有 SQLite `state_leases` 中持有 `startup-migrations` 租约。龙枢给
首次迁移保留 120 秒；若上次异常退出且同一 `configPath` 已无存活 Gateway，则等待十秒安全
窗口后仅删除这条龙枢专属迁移租约，再继续启动。该恢复不会扫描、修改或连接用户安装的其他
OpenClaw 状态目录。

生产 Cloud API 必须使用 TLS；设备 Token 只保存在当前 Windows 用户的 Credential Manager，
`device.json` 不得再含 Token。UI 隐藏用于产品体验，真正的模型控制边界是 OpenClaw 单模型
allowlist 与云端强制模型覆盖。

内嵌 OpenClaw 2026.7.1-2 的 Node 运行时必须满足 `>=22.22.3 <23`、
`>=24.15.0 <25` 或 `>=25.9.0`；项目通过 `package.json#engines` 声明该约束，
`predist` 应只在这个版本范围内执行。

Desktop 对上游版本、路由、Selector/Stop/模型控件、Gateway RPC 和视觉视口的依赖统一来自
`@longhub/openclaw-compat`。启动前从实际 `openclaw.mjs` 同目录读取 `package.json`；缺失、损坏或
版本不是 `2026.7.1-2` 时不启动未知 Gateway，并进入现有可诊断错误页。契约摘要用于升级审查，
不是制品安全签名；每次上游升级仍必须重跑真实 Gateway、Electron UI 合约和视觉门禁。

页面产品化继续在 sandbox 页面世界中执行，不增加 preload 或 IPC。脚本只遍历兼容契约登记的
品牌、顶栏、侧边会话、欢迎页和运行状态节点，并精确翻译固定属性；聊天消息树不在处理范围内。
MutationObserver 每次应用后丢弃自身产生的记录，避免与 Lit 重渲染形成反馈循环。Main 的导航
白名单只接受 Control UI 当前 `/chat` pathname，安装自定义协议仍由独立严格解析器处理。

## 变更历史

### 2026-07-30 - 规划普通用户功能与 Skill 分级开放

**变更内容**：定义 `/chat` 内三类产品入口、默认/租户/管理员功能边界，以及官方与无代码 Skill 的
首批范围；登记 `file_upload` 和动态 Skill 执行的真实实施缺口。

**变更理由**：客户端需要逐步开放用户价值功能，但不能恢复带模型、凭据和运行时控制的上游管理面。

**影响范围**：Desktop 导航、单用途本机能力、runtime-config、OpenClaw 兼容契约和真实 Electron E2E。

**决策依据**：低风险功能复用原生页面，主机/企业副作用能力继续由 Main、Core 和 Cloud 收敛。

### 2026-07-30 - 增加最小上一进程退出标记

**变更内容**：增加严格本地运行标记，并将上一退出固定枚举接入内存遥测。

**变更理由**：支持匿名异常退出率，同时避免崩溃转储、堆栈和持久遥测队列。

**影响范围**：Electron Main、客户端遥测、状态文件安全与回归测试。

### 2026-07-30 - 增加失败不阻断的最小匿名遥测

**变更内容**：已激活后创建有界内存上报器，接入启动耗时/Agent 数量桶、Gateway 枚举、更新结果和
固定产品公开错误码；五秒合并、最多 32 项，失败丢弃且无本地队列。

**变更理由**：客户端健康趋势需要匿名运行信号，但日志、异常、精确耗时、Agent/Pack ID 或设备身份
都不是最小必要数据，也不能让遥测可用性成为聊天可用性的前置条件。

**影响范围**：Electron Main 生命周期、共享 Observability 契约、Desktop 测试、README 与路线文档。

**决策依据**：白名单事件从产生处即粗粒度化，服务端再做独立严格校验；无重试持久队列避免退出阻塞
和离线期间积累可关联历史。

### 2026-07-30 - 完成 Windows 主机中断稳定性矩阵

**变更内容**：接入 `powerMonitor.resume` 后真实 `/chat` 复检和 Gateway 受控重启；增加 256 MiB
磁盘剩余空间门槛、`ENOSPC/EDQUOT` 固定分类，并汇总强退、断网、重启和端口冲突证据。

**变更理由**：进程仍存在不能证明休眠后的套接字可用，状态目录大小合规也不能证明磁盘仍可安全写入；
这些宿主级故障必须收敛到自动恢复或固定产品错误，不能要求用户配置 Gateway 或模型。

**影响范围**：Electron 电源事件、Gateway Supervisor/Recovery、启动存储检查、产品错误码和稳定性测试。

**决策依据**：复用真实 `/chat` 健康门槛与原有状态机，避免增加第二套恢复逻辑；低磁盘使用预检加
写入错误兜底，测试通过注入故障而不真实耗尽磁盘。

### 2026-07-30 - 增加日志轮转、状态配额与白名单清理

**变更内容**：Desktop 增加 5×5 MiB 脱敏 JSONL 轮转、24 小时临时文件与 7 天更新下载清理、
8 GiB 受管状态硬上限、pending 引用保护和固定 `LH-ST-001` 安全页。

**变更理由**：长时间运行和更新中断会留下日志、下载与原子写残留；无限增长会耗尽磁盘，但直接按
目录大小删除 OpenClaw 数据会破坏聊天、记忆和回滚能力。

**影响范围**：Desktop 日志 sink、启动顺序、客户端更新保护引用、产品错误码与本地状态运维。

**决策依据**：只对白名单可再生制品执行基于年龄的删除；不可再生状态只计量，超限时固定失败，
比递归清理整个 `userData` 更可审计，也继续保证用户原有 `~/.openclaw` 完全隔离。

### 2026-07-30 - 增加一键脱敏诊断导出

**变更内容**：新增严格诊断 v1 schema、内存白名单状态、错误页固定导出导航、原生保存对话框和原子
JSON 写入，并用真实 sandbox Electron 页面验证点击路径。

**变更理由**：固定短错误码能帮助用户理解故障，但技术支持还需要版本和生命周期阶段；直接打包日志
或状态目录会把 Token、聊天和本机路径带出信任边界。

**影响范围**：Desktop 状态记录、产品错误页导航、Main 保存流程、测试、README 与路线文档。

**决策依据**：从源头只构造枚举、版本和计数，比导出后再尝试脱敏自由日志更可审计；报告完全本地、
用户主动选择分享，同时保持主 WebUI 无 preload/IPC。

### 2026-07-30 - 增加运行配置退避、安全缓存与有效期

**变更内容**：Cloud 运行配置增加严格 schema、配置版本、签发/过期时间和 `no-store`；Desktop 增加
三次指数退避、仅瞬时错误可用的同源同设备十分钟缓存，以及在线/缓存共用的严格解析和时钟检查。

**变更理由**：短时网络抖动不应阻断已激活用户启动聊天，但旧配置不能掩盖凭据撤销、协议不兼容或
后台错误，更不能把本地缓存变成授权凭证。

**影响范围**：Cloud runtime-config/OpenAPI、Desktop 启动流程、本地 OpenClaw 状态快照与诊断日志。

**决策依据**：把可用性回退限制在公开固定元数据，并让真正模型请求继续逐次在线授权，可以在不
增加客户端密钥或越权面的前提下覆盖短暂控制面故障。

### 2026-07-30 - 完成 Gateway 运行中恢复与安全错误页

**变更内容**：增加运行中重连协调器、真实 `/chat` HTML 健康探测、连续失败计数复位、固定产品错误
分类和不接收原始诊断的安全状态页。

**变更理由**：原 Supervisor 虽能重启进程，但 Main 只记录状态；运行中崩溃后用户会停留在失效页面，
且原错误页仍会显示清理后的上游文本，无法保证 URL、路径和未知秘密不被展示。

**影响范围**：Gateway 状态事件、Main 窗口恢复、启动健康门槛、更新健康信号、Desktop 测试与文档。

**决策依据**：进程生命周期与产品页面状态分离；只以真实 `/chat` 恢复原生 WebUI，并让 HTML 页面
只能由固定枚举生成，可以同时关闭误健康、迟到探测覆盖和诊断文本泄漏三类风险。

### 2026-07-30 - 完成上一稳定版二进制自动回滚

**变更内容**：增加精确版本回滚制品、当前/上一版安装器库存、pending v2、三次启动失败与 180 秒
健康超时、幂等状态恢复、旧安装器启动和坏版本抑制。

**变更理由**：安装前快照本身不能恢复旧程序；如果没有经过签名与 Authenticode 验证的旧安装器，
自动更新失败后仍会把用户留在无法启动的新二进制上。

**影响范围**：更新签名契约、Cloud 精确版本接口、Desktop 更新协调器与启动流程、OpenAPI、Admin、
恢复状态格式、测试和发布运维文档。

**决策依据**：只有同时具备旧程序、旧状态与坏版本抑制，才能形成闭环；回滚恢复集合固定在 LongHub
userData，保持与用户独立 OpenClaw 的实例隔离。

### 2026-07-30 - 执行签名灰度、暂停与安装前撤回

**变更内容**：Desktop 支持更新 v2 rollout 确定性分桶，paused/未命中时不提示，并在真正停机前
重新验签；下载期间暂停或换版会安全撤回。

**变更理由**：只在首次检查时判断策略会留下竞态窗口，无法阻止已经下载的更新在后台暂停后安装。

**影响范围**：更新验证器、事务协调器、设备身份接入、测试、共享契约和发布文档。

**决策依据**：签名策略和单调 sequence 防止未签名控制面及旧策略重放，二次复验关闭下载时间窗。

### 2026-07-29 - 接入稳定渠道安全自动更新事务

**变更内容**：Electron Main 接入预置信任策略、定时检查、原生双确认、受限下载、Authenticode 复验、
运行时停机、状态快照、NSIS 启动和跨版本健康标记；公开发布门禁同步校验 ASAR 内信任清单。

**变更理由**：把 LH-040-05 的可信元数据边界推进为可执行但默认关闭的更新事务，同时避免在正式
Update 公钥与代码签名证书缺失时以在线 key 或测试 key 降低信任边界。

**影响范围**：Desktop Main、发布资产与门禁、更新恢复状态、单元测试和 0.4.0 路线图。

**决策依据**：稳定渠道先闭环签名、停机和健康确认；灰度/暂停策略与上一安装器二进制回滚独立推进。

### 2026-07-29 - 建立客户端更新签名验证边界

**变更内容**：增加严格元数据验签、渠道/平台绑定、sequence 防回滚状态、同源 URL 收敛和安装包
大小/SHA-256 流式验证。

**变更理由**：客户端后续自动更新必须先具备独立于 TLS、文件名和 Cloud 在线公钥接口的本地信任锚。

**影响范围**：共享 Pack Schema、Desktop 更新模块、Cloud 发布 API、Portal/Admin 数据结构和发布运维。

**决策依据**：预置公钥与持久化最高序列能在更新服务或缓存异常时保持 fail-closed；自动安装另行接入。

### 2026-07-29 - 启用 ASAR 并锁定外置 OpenClaw 运行时

**变更内容**：生产包启用 ASAR；增加生产依赖闭包清单、物理暂存构建、打包布局校验和真实
Core/Worker/Bridge/Gateway 冒烟。

**变更理由**：原包把 26,102 个应用文件全部明文展开，应用边界不可审查；同时独立 Node 又确实
要求 OpenClaw 运行时位于普通文件系统，不能简单把全部文件塞入 ASAR。

**影响范围**：Windows 构建、OpenClaw 升级审查、运行时路径解析、候选包验证和发布耗时。

**决策依据**：Electron 进程链留在 ASAR，独立 Node 闭包显式外置；真实安装目录的四段进程链均通过。

### 2026-07-29 - 统一生产日志与敏感信息脱敏

**变更内容**：Desktop Main 与历史原型改用共享结构化 Logger；子进程错误和用户可见诊断统一清理，
并增加设备/Gateway/API Key/用户文件内容泄露回归测试。

**变更理由**：凭据进入 Credential Manager 后仍可能被异常对象或子进程输出重新带入日志和诊断页面。

**影响范围**：Gateway 生命周期、Selector/Pack 同步、OpenClaw RPC、激活与错误页、历史原型输出。

**决策依据**：共享递归脱敏与调用点最小字段同时使用，比依赖开发者逐条手工遮盖更稳定。

### 2026-07-29 - 拆分内部候选与正式签名构建

**变更内容**：增加品牌审批清单、Windows 发布验证器与签名构建包装器；正式包逐个检查安装器、
主程序和内置 Node 的签名状态，并核对打包资源和图标摘要。

**变更理由**：构建机尚无龙枢证书，临时图标也未获正式审批；必须让默认正式命令安全失败，而不是
继续产出容易误上传的未签名包。

**影响范围**：package scripts、electron-builder 调用、CI secrets、品牌资产、候选包验证和发布手册。

**决策依据**：构建后 Windows 原生验签比只相信 electron-builder 日志更可靠；显式内部模式兼顾
开发测试，同时保持正式发布 fail-closed。

### 2026-07-29 - 增加首次授权码激活窗口

**变更内容**：把设备激活检查放到所有运行时准备之前，新增独立最小 preload 窗口和无人值守核销
入口；正确核销后才启动原生龙枢 WebUI。

**变更理由**：普通用户需要授权码门禁，但不应看到账号、模型或 Gateway 配置，也不能让激活 IPC
污染主 WebUI 的安全边界。

**影响范围**：Desktop 启动顺序、Cloud Client、Electron IPC、安装包静态资源和真实窗口 E2E。

**决策依据**：独立短生命周期窗口兼顾首次激活体验和主聊天页零 preload 的既有隔离承诺。

### 2026-07-29 - 完成品牌、中文化与普通用户导航

**变更内容**：新增 `openclaw-product-ui` 薄层，统一龙枢品牌、图标、中文状态、欢迎文案、输入提示
和可读会话标题；清理悬停 session key，隐藏管理入口，并把窗口导航限制到产品聊天页。

**变更理由**：终端用户无需理解 OpenClaw、Gateway、Provider 或内部会话键，但客户端仍应复用
原生聊天与多 Agent 能力，不能维护另一套聊天面板。

**影响范围**：兼容契约、页面 CSS/脚本注入、BrowserWindow、错误页、安装图标和真实 UI E2E。

**决策依据**：真实 Gateway + Electron 已验证正文与 title 均无基础设施词汇，品牌/中文化在动态
重渲染后保持，Agent 最近会话、停止切换、撤销回退、模型隐藏和无 Node 边界未回归。

### 2026-07-29 - 接入版本化 OpenClaw 兼容契约

**变更内容**：把产品路由、Selector、Gateway RPC、模型/管理入口选择器和 UI 基线迁移到独立
`@longhub/openclaw-compat`，并在 Gateway 启动前核对实际内置 OpenClaw 版本。

**变更理由**：Desktop 继续直接使用原生 Control UI，需要让上游依赖集中、可审查且在版本漂移时
安全失败，避免未知版本静默破坏模型隐藏或 Agent 切换。

**影响范围**：Main 启动预检、产品导航、Selector 策略、配置热更新、真实 UI E2E 和打包验收。

**决策依据**：锁定版真实 Gateway/Electron 回归通过；契约摘要与容差视觉签名能同时发现语义和
明显布局变化，并避免少量动态像素导致并发测试误报。

### 2026-07-29 - 完成已授权未安装 Agent 一键安装

**变更内容**：组合云端 catalog 与 entitlement 向原生 Selector 注入 HR 安装候选；新增固定安装
导航、安装中/失败重试状态，并串联下载、元数据核对、Ed25519 验签、公钥原子持久化、Pack 激活、
真实 Gateway 热更新和专属会话进入。

**变更理由**：全新设备即使已有 HR 授权也不应要求用户打开管理面板或手工安装 Pack；同时不能为
WebUI 恢复 preload、通用 IPC 或让云端目录直接定义本机 Agent 身份。

**影响范围**：Desktop catalog 同步、Selector 薄适配、主窗口导航策略、Cloud Pack 安装事务、
信任存储、Pack active 指针补偿和真实 Gateway/Electron E2E。

**决策依据**：安装导航是候选列表约束的单用途通道；制品身份以客户端锁定映射和签名 Manifest /
Profile 双重收敛，Core 执行仍逐次在线复验、fail-closed。

### 2026-07-29 - 完成 0.3.6 状态连续性与共存验收

**变更内容**：增加同一 userData 上的旧状态启动、Gateway 重启、Pack 升级/回滚连续测试，并同时
拉起用户 OpenClaw 与龙枢内置真实 Gateway；生成并检查内置 Node 25.9.0 的 0.3.6 内部候选包。

**变更理由**：独立单元测试不能证明 Registry、Pack 指针、workspace 和 session 在连续版本变化后
仍指向同一 agent，也不能证明默认端口冲突时不会误连用户原有 OpenClaw。

**影响范围**：候选版测试矩阵、打包运行时门禁、版本升级/回滚证据和发布文档；不改变用户数据格式。

**决策依据**：真实双 Gateway 并行与龙枢重启通过；0.3.5 main 历史、HR USER/session、稳定 agentId
在 Pack 1.0.0 → 2.0.0 → 1.0.0 后均保持，用户 OpenClaw 哨兵内容和路径未被读取或修改。

### 2026-07-29 - 完成原生 Agent Selector 一键切换 E2E

**变更内容**：新增 Selector 允许列表与薄适配层，补齐上游未渲染 Selector、历史 Agent 重新出现、
最近会话恢复、活动执行确认停止和撤销后显式回退 main；新增锁定版 Gateway + Electron UI E2E。

**变更理由**：仅验证 `agents.list` 不能证明用户实际可切换；OpenClaw 的历史会话聚合语义还会让
已撤销 Agent 再次可见，必须在不复制聊天面板的前提下收口真实 UI 行为。

**影响范围**：Control UI 页面策略、Pack 生命周期回调、Agent 会话导航、撤销体验和 UI 验收。

**决策依据**：真实 E2E 已验证 main/HR 可见、最近 HR 会话恢复、执行中先停止再切换，以及保留
HR 历史后 Selector 仍只允许 main；页面继续保持 sandbox 且没有 preload、Node 或 IPC 权限。

### 2026-07-29 - 完成 Pack 运行时启停与 entitlement 实时停用

**变更内容**：新增单写者生命周期协调器、锁定版 Gateway RPC 客户端、30 秒 entitlement 同步、
Core 动态 Bridge policy、Pack 签名复验和 Registry/Gateway/Core 补偿回滚。

**变更理由**：Selector 可见性不是执行授权；停用和撤销必须先关闭 Core 边界，同时不能靠重启
才能更新原生 Agent Selector，也不能为了停用删除用户历史。

**影响范围**：PackInstaller 制品格式、Agent Registry、Core RPC、Gateway `config.patch`、Control UI
回退 main、entitlement 同步和桌面生命周期测试。

**决策依据**：OpenClaw 2026.7.1-2 的真实 `config.get/config.patch/agents.list` RPC 冒烟通过；
配置失败时旧 Selector、Core policy 和 Registry 均可恢复。

### 2026-07-29 - Core 收口完整执行授权交集

**变更内容**：Core 改为持有 Profile/Pack 原始权限来源，在每次 Bridge 执行前在线复验
entitlement 和 Pack 状态、计算租户/设备上限与预算交集，并新增绑定请求摘要的一次性人工确认。
旧 `task.submit` 禁止调用方提交权限。

**变更理由**：工具可见性、Profile 文本、Desktop 预计算权限和调用参数都不能成为最终授权；
撤销、参数替换和确认重放必须在真正执行前由 Core 阻断。

**影响范围**：Core 授权模型、Core RPC、Bridge 可信上下文、云端授权复验和 Desktop 历史任务入口。

**决策依据**：权限来源以显式交集收敛，动态状态执行前复验，确认记录与完整操作绑定并一次性消费。

### 2026-07-29 - 完成 LongHub Tool Bridge POC

**变更内容**：接入官方 Tool Plugin、可信 runtime context、回环 Bridge Host、Core 专用执行入口
和 HR 只读简历初筛工具；配置由 Composer 注入，真实 OpenClaw runtime inspect 已验证加载。

**变更理由**：直接 WebUI 不应取得通用 preload/IPC，但业务 Agent 需要一条身份不可由模型伪造、
权限不可由调用方授予的受限执行链。

**影响范围**：Gateway 插件加载、Desktop 启动顺序、Core RPC、HR 工具 allowlist 和安全测试。

**决策依据**：OpenClaw factory 提供 agent/session 上下文；Core 二次检查关闭仅靠工具可见性的越权路径。

### 2026-07-29 - 接入 main + active Pack 启动时激活

**变更内容**：Gateway 启动前重新读取 active Pack，注册 Profile，落盘独立
workspace/agentDir/session，并把 `main + 已启用 Profile` 写入 `agents.list`。

**变更理由**：Registry 与 Composer 只有接入真实启动顺序，已安装 HR 助理才会出现在原生
Agent Selector；仅有候选配置代码不会改变用户界面。

**影响范围**：Pack active 指针、启动配置、工作区模板、OpenClaw Agent 与 session 路径。

**决策依据**：启动前完整配置原子写入可先完成双 Agent MVP；运行时热加载、回读和失败回滚
继续由后续 pack 生命周期任务统一实现。

### 2026-07-29 - 实现 Agent Registry 与确定性 Config Composer

**变更内容**：实现稳定 agentId、原子 Registry、Pack 所有权保护和 Profile → `agents.list` 编译，
并通过锁定 OpenClaw 版本真实校验生成配置。

**变更理由**：Pack 安装路径、显示名或版本变化不能改变会话归属；配置候选必须在运行时激活前
就具备确定性和隔离上限。

**影响范围**：Pack/Profile 映射、OpenClaw agentId、workspace/agentDir 路径、模型和工具策略。

**决策依据**：持久化稳定映射保护历史会话，确定性完整配置便于 baseHash 原子提交和失败回滚。

### 2026-07-29 - 采用原生多 Agent 支撑一键切换

**变更内容**：增加 Agent Registry、Profile → `agents.list` Config Composer、独立
workspace/agentDir/session、原生 Agent Selector 语义和 LongHub Tool Bridge 边界。

**变更理由**：现有 Pack 只完成安装，直接 WebUI 又没有接入历史 preload；需要补齐从签名
Profile 到可切换 Agent，再到 Core 安全执行的完整链路。

**影响范围**：Pack 激活、OpenClaw 配置、会话隔离、工具接入、权限和 entitlement 撤销。

**决策依据**：复用 OpenClaw 原生多 Agent 能减少 UI 分叉；由 Core 重算权限可以避免把模型
参数或工具可见性误当成安全授权。

### 2026-07-29 - 工作区与助手身份完全隔离

**变更内容**：为内嵌 OpenClaw 显式配置龙枢专属 workspace，预置“龙枢助手”身份并关闭
上游自动 Bootstrap。

**变更理由**：仅隔离 Gateway 状态目录仍会让 OpenClaw 回退读取用户全局 workspace，造成
原有助手名、记忆和提示文件出现在龙枢客户端。

**影响范围**：桌面端运行配置、首次启动身份、工作区记忆与技能边界。

**决策依据**：状态目录、配置路径、Gateway 端口和 workspace 四者都独立，才能允许用户原有
OpenClaw 与龙枢内置实例安全并存。

### 2026-07-29 - 内嵌 OpenClaw 迁移锁自动恢复

**变更内容**：启动前验证同配置 Gateway PID，并自动恢复异常退出遗留的 SQLite 启动迁移
租约；首次迁移等待时间由 30 秒增加到 120 秒。

**变更理由**：升级或强制退出可能中断首次迁移，旧逻辑会在超时、租约重试之间形成循环。

**影响范围**：桌面端 OpenClaw 状态预检、异常恢复和首次启动时限。

**决策依据**：状态目录归龙枢独占；同时使用 `configPath + 活 PID + 心跳安全窗口` 三重条件，
可以只恢复确认失效的龙枢租约，而不影响用户原有 OpenClaw。

### 2026-07-29 - 本机 Gateway 端口冲突自动回退

**变更内容**：内嵌 Gateway 默认优先使用 18789；若已被其他 OpenClaw 或本机程序占用，
自动选择操作系统分配的空闲回环端口，并将实际地址传给 Control UI。

**变更理由**：用户可能已经运行独立 OpenClaw，固定端口冲突不应导致龙枢启动超时。

**影响范围**：桌面端 Gateway 端口选择、启动诊断和 Control UI 连接地址。

**决策依据**：继续拒绝复用未知进程可保持令牌隔离；动态回环端口能在不降低安全性的前提下
保证安装即用。

### 2026-07-28 - 主界面切换为 OpenClaw Control UI

**变更内容**：Electron 主窗口由 LongHub React 面板切换为 Gateway 原生 Control UI，并为
内嵌 Gateway 增加共享令牌和启动失败页。

**变更理由**：客户端应让用户直接使用完整的小龙虾 WebUI，避免功能缩水以及维护两套交互。

**影响范围**：桌面端启动、窗口安全边界、Gateway 认证、开发调试入口。

**决策依据**：OpenClaw 官方将 Control UI 作为 Gateway 的完整管理和聊天界面，并在同端口
提供 HTTP 页面与 WebSocket 协议；直接加载能最大程度保持上游能力和后续升级兼容性。

### 2026-07-29 - 零配置连接与后台统一模型

**变更内容**：入口固定到 `/chat`，补齐显式 Gateway URL/Token 握手；启动前从龙枢云端生成
固定单模型配置，隐藏并拦截用户模型/网关设置入口。

**变更理由**：终端用户应安装即用，不承担 Gateway、API Key 或模型选择工作。

**影响范围**：桌面启动顺序、OpenClaw 状态目录、WebUI 导航策略、设备凭据使用。

**决策依据**：体验层限制与服务端强制策略并用，避免“只隐藏界面但仍可改模型”。

### 2026-07-30 - 修复正式包首次激活 preload 模块格式

**变更内容**：激活 preload 源文件改为 `.cts` 并生成 `.cjs`，Main 只加载 CommonJS 产物；激活页在
Bridge 缺失、IPC 拒绝或 20 秒未返回时恢复按钮并显示固定错误。发布门禁要求 ASAR 含 `.cjs` 且拒绝
残留旧 `.js`。

**变更理由**：sandbox preload 不按应用的 ESM 语义加载，0.4.0 的 `.js` preload 在正式包中未执行；
原 E2E 手工转译为 `.cjs`，因此没有覆盖真实构建路径，页面调用不存在的 Bridge 后永久保持忙碌状态。

**影响范围**：首次授权窗口、preload 构建扩展名、激活 UI 失败恢复、Electron E2E 和 Windows 发布门禁。

**决策依据**：用文件扩展名明确 Electron preload 的 CommonJS 语义，并由 ASAR 级门禁验证真实产物，
比依赖运行环境猜测模块格式稳定；页面兜底保证同类加载异常也不会再表现为无限卡住。

### 2026-07-30 - 统一龙枢产品头像

**变更内容**：以产品方提供的 `longhub-avatar-source.png` 为唯一视觉源，确定性生成 Desktop 的
SVG/PNG/ICO 和 512 像素头像；主 Agent 使用 OpenClaw 原生 `identity.avatar`，Control UI、激活页、
旧 Renderer、Portal、Admin、favicon、窗口与安装包全部使用同一头像。

**变更理由**：原红底“龙”字只是临时占位，而且聊天品牌图和应用图标分别实现，容易出现客户端、
网页和安装包视觉不一致。

**影响范围**：主 Agent workspace/config、产品化 UI 薄层、Desktop 品牌资产、Portal、Admin、
Windows ICO 与发布摘要。

**决策依据**：保留原图内容，仅做 LANCZOS 缩放和格式转换；头像通过 OpenClaw 公开身份字段接入，
不依赖修改上游消息 DOM。品牌清单暂时保持 `temporary`，正式发布仍需要品牌审批记录和代码签名。
