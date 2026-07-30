# LongHub Cloud API 设计

## 固定模型网关

```text
OpenClaw（longhub-default + 设备 Token）
        │
        ▼
LongHub Cloud /v1/model
  ├─ 校验设备状态
  ├─ 强制覆盖真实 model ID
  ├─ 解密上游 API Key
  └─ 转发 Chat Completions / Responses
        │
        ▼
管理员配置的 OpenAI 兼容上游
```

客户端配置里只有固定 provider/model 和 `${LONGHUB_MODEL_TOKEN}` 环境变量占位符。真实上游
Base URL、模型 ID 和 API Key 不下发。模型列表只返回 `longhub-default`，服务端代理再次强制
覆盖请求体中的 `model`，因此隐藏 UI 不是唯一控制边界。

即使管理员尚未录入上游，运行配置也会下发安全的固定别名，使客户端仍直接进入聊天界面；
此时实际模型请求返回 `MODEL_NOT_CONFIGURED`，完成后台配置后无需重新打包或安装客户端。

运行配置响应采用严格 `longhub/runtime-config/v1`，携带后台配置版本、签发时间和固定十分钟过期时间，
并声明 `Cache-Control: private, no-store`。协议只允许固定 provider、`/v1/model` 同源相对路径和
`longhub-default`，不返回真实模型路由或秘密。Desktop 可以在明确的网络、429/5xx 瞬时故障下使用
同 Cloud、同设备的短期本地缓存，但 401/403 和协议失败必须关闭失败。缓存只是启动配置，不是授权；
每次模型请求仍由 Cloud 重新验证设备激活状态并覆盖真实 model。

## 设备授权码与产品门禁

设备注册与产品授权严格分离。注册接口只签发设备凭据；未激活设备仅能访问
`GET /v1/devices/activation` 和 `POST /v1/devices/activate`。模型配置、模型代理、Pack、任务等
产品接口都复用服务端激活校验，不能靠 Desktop 是否显示页面决定授权。

授权码由 128-bit 加密安全随机数生成并编码为 `LH-XXXX-XXXX-XXXX-XXXX`。服务端规范化输入后
计算 SHA-256，数据库只保存摘要与尾号，明文仅在管理员创建响应中返回一次。核销在存储事务中
原子检查状态、到期时间和最大使用次数，再绑定设备并创建授权码附带的 Pack entitlement。设备
换码时撤销旧码产生的 entitlement，避免旧套餐残留。

撤销或到期状态在每次受保护 API 请求时重新读取，因此已打开会话的新模型请求也会立即失败。
当前应用内防爆破为单实例、按设备十分钟最多五次；生产入口还必须在 nginx/网关增加按 IP 与全局
速率限制。`LONGHUB_ACTIVATION_CODE` 只用于企业无人值守安装和自动化核销，不绕过云端验证。

已通过 Bearer 凭据认证的激活状态会返回该凭据自己的 `device_id`，用于 Desktop 0.4.0 恢复早期
`device.json` 只保存 Token、没有设备 ID 的状态并迁移到 Windows Credential Manager。该字段不接受
设备 ID 参数，也不能查询其他设备；发布顺序固定为 Cloud API 向后兼容上线后再灰度 Desktop。

## 智能体目录与授权

Cloud API 负责声明设备“可以看到和执行哪些智能体”，桌面端负责验签、安装并映射到 OpenClaw。
云端分发单位仍是 Agent Pack，面向用户的切换单位是 Pack 内经过签名的 Agent Profile。

发布接口已要求 `agentTemplate.profilePath` 指向 Agent Profile V1，先校验 Profile、Manifest、能力
权限和引用文件，再对排除自引用 digest 的 Manifest 与全部文件计算摘要并签名。这样客户端不能
在下载后修改 Pack 版本、兼容范围或权限声明而继续通过验签。

第一阶段复用现有 catalog、entitlement、签名下载和撤销接口，向设备返回：

- Pack ID、版本、摘要、签名和下载位置。
- Agent Profile 的展示摘要与兼容范围；完整 Profile 仍随 Pack 验签。
- entitlement 状态、作用域、到期时间和策略版本。
- 后台逻辑模型策略 ID；不返回真实模型、Base URL 或 API Key。

设备 Selector 只显示“已安装且 entitlement 有效”的 Profile。云端返回的展示信息用于目录和安装
引导，不能替代客户端对 Pack 内 Profile、摘要和签名的校验。后续 catalog 应支持 tenant/user/device
作用域、分类、灰度版本和最低客户端版本。

授权撤销必须同时影响可见性和执行权：客户端同步后从 Selector 停用目标 Profile；更关键的是
Core/Cloud Skill 在每次企业能力执行前验证最新 entitlement 或短时可撤销授权证明，使已经打开的
聊天页面也不能继续执行。不能把“从 UI 隐藏智能体”当成撤销完成。

V1 允许普通只读能力使用最长 60 秒的授权缓存；高风险写操作必须在执行前在线复验。后续推送
撤销事件用于缩短界面和缓存刷新延迟，但不能取代执行点校验。云端不可达、设备凭据失效或缓存
过期时，企业执行默认安全失败。

## Feature Policy、Skill 与用户能力

当前 `longhub/runtime-config/v1` 的 `features` 只有 `agent_catalog`、`file_upload` 和 `tool_execution`。
它们是既有兼容字段，不足以表达文件保留、知识范围、联网、语音、自动化、企业渠道、角色和费用等
策略；其中 `file_upload` 尚未被 Desktop 完整消费，不能仅因后台值为 `true` 就认定附件链已开放。

后续 `longhub/feature-policy/v2` 使用稳定 `feature_id`、作用域、受众、开放模式、资源限制、数据策略、
entitlement、客户端兼容范围、有效期和紧急停用。Cloud 的功能 API 必须按同一策略逐请求复验，不能
只返回按钮可见性。离线缓存不得授权企业写入、自动化、连接器或第三方代码执行。

Cloud 同时承担 Skill Catalog、发布方命名空间、签名/审核/撤回、租户策略、Connector Broker、短时
凭据和第三方云端执行门禁。普通用户自建的无代码 Skill 不取得平台发布方身份；企业连接器长期凭据
不返回 Desktop 或 Skill。详细范围见 [../../PRODUCT_FEATURE_POLICY.md](../../PRODUCT_FEATURE_POLICY.md)
和 [../../SKILL_PLATFORM.md](../../SKILL_PLATFORM.md)。

实际实施顺序以 [../../EXECUTION_PLAN_V2.md](../../EXECUTION_PLAN_V2.md) 为准；Cloud 必须先完成
Feature Policy V2 与逐请求复验，之后才为 Skill、文件、知识和工作流开放产品 API。

## 安全边界与威胁模型

- 上游 API Key：使用 `MODEL_CONFIG_KEY` 进行 AES-256-GCM 加密，数据库只保存带随机 IV 和
  认证标签的密文；管理 API 永不回显明文。主密钥只存在于服务进程环境。
- 租户知识正文：使用独立 `KNOWLEDGE_DATA_KEY` 做 AES-256-GCM 信封加密，tenant ID 进入 AAD，避免
  密文跨租户替换；PostgreSQL 模式缺少密钥或与模型密钥相同时 fail-closed。开发期历史明文必须重新导入。
- 客户端身份：模型与运行配置接口均要求有效且状态为 active 的设备 Bearer 凭据。
- 运行配置缓存：响应本身禁止中间缓存；Desktop 本地只缓存固定公开元数据并绑定 Cloud origin、设备
  ID 与十分钟有效期。认证失败、协议错误、跨设备、跨 Cloud、损坏或过期时不能回退。
- 产品激活：设备凭据不代表授权；受保护接口还必须确认绑定授权码仍有效、未撤销且未过期。
- 授权码泄露：数据库不保存明文；高熵随机值避免摘要被可行地离线穷举，核销接口另有限速。
- 智能体授权：catalog 可见不代表可执行；Pack 下载、激活和每次受控能力执行都必须验证有效
  entitlement，客户端传入的 Pack/Profile/permission 字段不可信。
- 越权选模：客户端提交的 model 字段不可信，代理始终替换为后台配置值。
- SSRF：生产默认只允许 HTTPS，拒绝 URL 内嵌凭据、查询、fragment 及显式本机/私网 IP。
  管理写操作需要 ops/super 权限并写入审计日志。
- 资源滥用：代理限制请求体为 8 MiB，上游请求五分钟超时，客户端断开会中止上游请求。
- 浏览器攻击：上游响应按流透传，不在管理页面渲染；管理 API Key 输入使用 password 控件，
  留空不会覆盖已有密钥。
- 日志与审计：控制台结构化字段和自由错误文本统一脱敏；Memory/Pg 审计存储前再次递归清理，禁止
  记录 Authorization、设备 Token、API Key、授权码、模型消息、工具输入输出或用户文件内容。
- 匿名遥测：`longhub/client-telemetry/v1` 使用精确键集合和固定枚举，拒绝任何身份字段、自由文本或
  扩展标签。已激活设备 Bearer 只参与认证和每小时限流，Store 只接收 UTC 小时聚合；PostgreSQL 表
  没有设备、用户、租户、会话或原始 JSON 列，并用 CHECK 约束事件和值组合。

生产部署必须在 TLS 后提供 Cloud API；否则设备 Token 可能被网络中间人窃取并滥用模型额度。

遥测限流当前是单 Cloud 进程内每设备 120 批/小时，适合当前单实例部署。扩展为多实例时应迁移到
共享限流器，但共享键仍只能用于短期滥用控制，不能写入聚合事实表。小时聚合不用于认证、授权、
设备画像或逐用户追踪；管理查询和运营面板不在 LH-040-14 范围。

LH-040-15 的看板只读取最近 24 小时聚合。模型代理在收到上游响应头时记录 API 类型、固定结果和 TTFB
桶；这不是完整流完成时间。指标写入失败只发出固定 `model.metrics_dropped`，不得影响模型响应。看板
不提供逐设备明细，空样本比率返回 `null`。

## 客户端更新元数据供应链

客户端安装包使用独立于 Agent Pack 的 Update Ed25519 密钥与用途域
`longhub-client-update-v2\n`。签名载荷是严格 `longhub/client-update/v2` manifest 的 canonical JSON，
覆盖全局单调 sequence、版本、stable/beta 渠道、win32/x64、文件名、实际字节数、SHA-256、同源相对
下载路径、发布时间、显式数据回滚策略，以及 rollout 的状态、基点、固定 seed 和更新时间。Admin 上传请求中的
Content-Length 只是辅助检查，最终摘要和大小来自流式读取。

Cloud 以临时文件接收，完成校验后用 hard link 建立不可覆盖目标，再原子替换 `releases.json`。发布前
重新读取索引，避免并发上传复用 sequence 或丢失刚完成的版本；失败清理只删除本请求实际创建的
目标，不能删除竞态中由另一请求创建的同名文件。旧未签名索引记录只告警并忽略，不能自动使用当前
密钥重签，因为服务端无法证明旧摘要和发布时序的来源。

新上传版本默认暂停且灰度为 0。只有当前渠道最新版本可以更新 rollout；每次更新保留该版本随机生成
的 256-bit seed、分配更高全局 sequence 并重新签署完整 manifest。Desktop 用
`SHA-256(domain + seed + deviceId) mod 10000` 本地分桶，因此 5% → 25% → 100% 扩大时已命中设备
不会退出 cohort，暂停/恢复也不会随机换组。灰度是稳定性控制而非授权边界，本地高权限用户理论上
可以修改身份争取命中；制品真实性、设备授权和模型权限仍由各自安全边界保证。

暂停必须返回“签名的 paused manifest”，不能简单返回 null 或依赖未签名数据库字段。Desktop 看到
更高 sequence 后持久化防回滚状态，即使缓存重放旧 active 元数据也会拒绝；在用户确认安装后、停止
运行时前还会再次获取并验签，下载期间暂停或换版会返回 withdrawn，不创建快照或关闭当前聊天。

公开 `/client-releases/latest` 只返回 manifest、key ID 和签名；管理审计字段不能混入签名 envelope。
`/client-releases/signing-key` 只用于运维核对。Desktop 的信任锚随正式安装包预置，绝不能从同一
可能被劫持的更新服务自举。Nginx 只暴露严格版本化 `.exe`，不暴露索引、上传临时文件或目录列表。

公开 `/client-releases/versions/{version}?channel=stable` 只返回精确版本的严格签名 envelope，不执行
rollout 判断，也不参与 Desktop 的最高 sequence 推进。它的唯一用途是让更新前的 Desktop 取得当前
已安装版本的可信回滚安装器；指定版本不存在、属于其他渠道、历史记录未签名或签名密钥不受信任时
返回失败，Desktop 必须停止新版本安装。上传端当前固定签署 `snapshot_required`，只有完成真实迁移
降级证明后才允许引入 `backward_compatible` 发布流程。

密钥轮换顺序固定为：先发布同时信任旧/新公钥的 Desktop，再把新公钥加入 Cloud 历史信任清单，
随后切换当前签名私钥，最后在覆盖降级与回滚窗口后移除旧公钥。当前 key ID 若映射到不同公钥、
Update 与 Pack 复用同一 key、私钥与声明公钥不匹配、历史索引出现未知 key 或签名被改写，Cloud
均 fail-closed。私钥不得进入仓库、日志、镜像层或客户端下载清单。

## 已知限制

- 模型与知识数据密钥暂不支持无停机在线重加密；轮换前需按 Runbook 导出或重新录入受保护数据。
- URL 校验不能完全消除恶意公网域名的 DNS rebinding；只有受信任管理员可修改上游地址，
  后续可增加解析后 IP 固定与出站网络 ACL。
- 设备速率、并发和日/月 Token 额度当前由单进程协调；多实例生产扩量前需迁移到共享限流/计量设施。
- entitlement 的 Selector 体验仍以设备轮询为主、尚无推送；Core 已在每次企业能力执行前在线复验，
  因而撤销会立即阻断新执行，但界面移除最多受轮询周期影响。
- Catalog 已提供结构化 Profile 摘要、搜索、能力分类和 Desktop 兼容过滤；更大规模检索仍需专用索引。
- 激活尝试限流当前保存在单个 API 进程内存中，多实例生产部署必须增加共享/IP 级入口限流。
- Desktop 0.4.0 已将设备 Token 迁入 Windows Credential Manager；Cloud 仍应把凭据视为高敏感值，
  不在响应错误、日志和审计详情中回显。
- 授权在会话已打开时撤销，模型与受保护 API 会立即拒绝，但客户端不会在运行中关闭本机 Gateway；
  激活页在下次启动显示，后续可增加运行中回退体验。
- rollout 索引当前由单个 Cloud API 进程原子改写；多写实例部署前需要共享事务存储或单写者发布服务。
- 灰度不能召回已经完成安装的版本；Desktop 依靠本地健康阈值自动回滚，Cloud 仍需通过监控和暂停
  rollout 阻止更多设备进入坏版本。

## 变更历史

### 2026-07-30 - 规划 Feature Policy V2 与 Skill 控制面

**变更内容**：登记现有三个布尔开关的表达与消费缺口，定义后续 Feature Policy、Skill Catalog、
Connector Broker、第三方云端执行和逐请求复验职责。

**变更理由**：新增用户功能会同时影响数据、费用和外部副作用，不能继续用少量 UI 布尔值承担授权。

**影响范围**：runtime-config、产品 API、Store/OpenAPI、Catalog、Connector、Executor、审计和后台。

**决策依据**：显示策略与执行授权共用稳定 ID，但服务端仍是最终边界；高风险离线时安全失败。

### 2026-07-30 - 加密租户知识正文并补齐生态运营面

**变更内容**：新增独立 `KNOWLEDGE_DATA_KEY` AES-256-GCM 信封加密和 tenant AAD；管理后台增加知识文档与
第三方 Pack 审核页面，拒绝记录不保留危险文件正文，OpenAPI 补齐设备运营、知识查询和审核发布路径。

**变更理由**：列表脱敏不能保护数据库与备份中的企业正文，已实现的生态 API 也必须能由后台完成运营闭环。

**影响范围**：Cloud 启动门禁、知识写入/检索、Admin Web、OpenAPI、测试与密钥轮换 Runbook。

**决策依据**：知识数据与模型凭据使用不同用途密钥；GCM 认证与租户 AAD 同时保护机密性、完整性和租户绑定。

### 2026-07-30 - 增加匿名健康指标与运营看板

**变更内容**：增加上一退出、模型请求结果/TTFB 聚合和近 24 小时管理看板。

**变更理由**：让稳定性与上游质量可观察，同时不采集聊天内容或建立设备画像。

**影响范围**：模型代理、Memory/Pg Store、Admin metrics、OpenAPI 与管理页面。

### 2026-07-30 - 增加严格匿名客户端小时聚合

**变更内容**：新增已激活设备 `POST /v1/client/telemetry`、120 批/小时限流、严格共享 v1 解析器和
`client_telemetry_hourly` 聚合表；Memory/Pg Store 只接收固定聚合行。

**变更理由**：运营需要了解版本、启动、Gateway、更新和固定错误分布，但逐设备事件、自由标签或日志
会形成不必要的画像与内容泄露面。

**影响范围**：Cloud Server/Store、PostgreSQL migration 006、Observability、OpenAPI 和隐私测试。

**决策依据**：认证身份停留在请求限流层，事件在写入前转为无身份 UTC 小时聚合，并用数据库 CHECK
约束事件和值组合；管理面板和更细指标继续留待独立设计。

### 2026-07-30 - 版本化运行配置并明确短期缓存边界

**变更内容**：runtime-config 增加严格 schema/version、签发/过期时间和 `private, no-store`；契约固定
十分钟有效期，并与 Desktop 的瞬时故障退避和设备绑定缓存配套。

**变更理由**：配置必须能被客户端明确判断兼容与过期，同时不能让代理缓存或本地旧值掩盖授权失败。

**影响范围**：模型网关响应、OpenAPI、Desktop 启动兼容性、缓存与回归测试。

**决策依据**：缓存内容不含秘密且不承载授权，模型接口继续逐请求复验，兼顾短时可用性与撤销时效。

### 2026-07-30 - 提供自动回滚所需的精确版本制品

**变更内容**：v2 签名载荷加入数据回滚策略，新增公开精确版本 metadata 接口，上传默认声明
`snapshot_required`，Admin 显示该策略。

**变更理由**：Desktop 第一次自动更新前通常没有当前版本安装器，不能在新版本失败后临时信任任意
本地 `.exe`；旧制品必须从同一离线信任链重新取得。

**影响范围**：共享 Schema、客户端发布索引/API、OpenAPI、Desktop 回滚库存和运维发布前置条件。

**决策依据**：精确版本查询与 latest/rollout 分离，既允许取旧制品，又不会把历史版本重新暴露为更新。

### 2026-07-30 - 将灰度与暂停纳入 v2 更新签名

**变更内容**：更新 manifest 升级到 v2，加入签名 rollout；上传默认暂停，管理 API 可按基点灰度、
扩大或暂停，Portal 收敛通用下载，Desktop 固定分桶并在停机前复验。

**变更理由**：未签名发布开关可被旧 active 响应绕过；下载后不复验则无法及时响应运营暂停。

**影响范围**：Pack Schema、Cloud 发布索引和管理 API、Admin/Portal、Desktop 更新事务与 OpenAPI。

**决策依据**：固定 seed 保证 cohort 单调，策略变更递增 sequence 复用现有防回滚边界；灰度不冒充授权。

### 2026-07-29 - 建立客户端更新签名与防回滚元数据

**变更内容**：增加独立 Update Ed25519 密钥、严格更新 manifest、流式摘要、单调序列、历史公钥轮换、
公开/管理 API 与受限 Nginx 下载路径。

**变更理由**：HTTPS 和版本文件名不能防止源站、索引或缓存被篡改，也不能识别旧版本元数据重放。

**影响范围**：Cloud 启动环境、安装包上传、Portal 下载、Admin 发布、OpenAPI 和生产文件权限。

**决策依据**：离线预置信任锚、独立用途域、完整制品绑定和客户端持久化最高序列组成端到端信任链。

### 2026-07-29 - 增加控制台与审计日志脱敏

**变更内容**：Cloud 控制台继续使用共享结构化 Logger，Memory/Pg 审计落库前增加统一递归脱敏。

**变更理由**：未来新增异常或审计字段时不能依赖每个路由手工排除设备 Token、API Key 和用户内容。

**影响范围**：Cloud 错误日志、管理审计、内存测试存储和 PostgreSQL 持久化。

**决策依据**：输出与落库两道边界能覆盖普通日志和长期审计数据，同时保留设备 ID、事件 ID 等运营元数据。

### 2026-07-29 - 增加设备授权码门禁

**变更内容**：增加高熵授权码创建、原子核销、设备绑定、Pack entitlement 附带和撤销；设备注册后
未激活不能访问模型与产品 API。

**变更理由**：匿名设备注册是身份引导，不是商业授权；授权撤销必须在服务端立即生效。

**影响范围**：设备记录、授权与 entitlement 数据、管理 API、模型/Pack/任务鉴权和 PostgreSQL 迁移。

**决策依据**：摘要存储、有限使用次数、服务端逐请求复验和原子事务共同降低泄露、超用与竞态风险。

### 2026-07-29 - 明确智能体目录与实时授权边界

**变更内容**：定义 Pack/Profile 分发关系、entitlement 对 Selector 可见性和能力执行的双重控制，
并要求撤销后阻断已打开会话的新执行。

**变更理由**：一键切换不能只在桌面端生成多个 Agent；后台必须统一决定不同企业和设备可以
使用哪些智能体，并让撤销成为真正的安全控制。

**影响范围**：catalog、entitlement、客户端同步、Core/Cloud Skill 执行授权与审计。

**决策依据**：UI 可见性存在缓存和绕过可能，最终执行点的实时校验才能关闭撤销窗口。

### 2026-07-29 - 新增后台统一模型配置与 OpenAI 兼容代理

**变更内容**：新增模型配置表、管理 API/页面、设备运行配置以及 Chat Completions/Responses
代理；API Key 加密持久化。

**变更理由**：客户端应开箱即用，用户不需要也不允许自行配置网关、API Key 或模型。

**影响范围**：Cloud API、PostgreSQL、管理后台、桌面端 OpenClaw 启动配置。

**决策依据**：服务端持钥并强制覆盖模型能同时满足易用性、密钥保护和统一运营策略。

### 2026-07-30 - 旧模型配置表执行启动时幂等升级

**变更内容**：PgStore 初始化在建表后幂等补齐模型作用域、运行策略和额度列及约束；读取模型配置时
把 PostgreSQL `BIGINT` 显式转换为安全整数；Admin 部分更新兼容旧记录缺失 `features`。

**变更理由**：`CREATE TABLE IF NOT EXISTS` 不会给旧表增加新列，Admin 默认展示掩盖了真实缺列；设备
策略解析因此返回 `unconfigured`，而部分保存又会分别触发空值异常和字符串额度校验失败。

**影响范围**：PostgreSQL 启动迁移、模型策略解析、Admin 保存、设备运行配置、模型代理和部署验收。

**决策依据**：迁移放进存储初始化并保持 `ADD COLUMN IF NOT EXISTS`，可保证新建与原位升级使用同一
schema；在数据库边界归一化数值类型，避免业务校验依赖驱动对 `BIGINT` 的字符串表示。
