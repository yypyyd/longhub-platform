# LongHub Skill 开放与生态设计

> 状态：执行基线  
> 适用基线：LongHub Desktop 0.4.1 / OpenClaw 2026.7.1-2  
> 更新日期：2026-07-30

本文件定义 Skill 类型、供应链和运行边界，不再承担版本排序；实际实施顺序以
[EXECUTION_PLAN_V2.md](EXECUTION_PLAN_V2.md) 为唯一依据。

## 一、结论

龙枢可以允许普通用户自行安装 Skill，但“安装 Skill”不能等同于“在用户电脑上运行任意代码”。
首批开放范围固定为：

1. 用户从龙枢官方目录安装、启用和停用经过平台签名的 Skill。
2. 用户创建或导入不含代码的提示词、知识说明、表单和受限工作流 Skill。
3. 用户把 Skill 显式绑定到一个或多个已安装智能体；默认不跨智能体共享。
4. 工作流可以组合用户已经获准使用的官方 Skill，但每次调用仍由 Core 独立鉴权和确认。

企业连接器、第三方云端可执行 Skill 和本地可执行 Skill 分阶段开放。任意脚本、原生程序、
OpenClaw 插件或 MCP 服务不能因用户点击“安装”就取得网络、文件、凭据或企业系统权限。

## 二、开放矩阵

| 类型 | 普通用户能否自行安装 | 执行位置 | 首次开放条件 | 当前决策 |
|---|---|---|---|---|
| 官方内容 Skill | 可以 | OpenClaw Agent workspace | 平台签名、兼容校验、绑定指定 Agent | 第一批开放 |
| 用户自建内容 Skill | 可以 | 配置解释层 | 无代码、无权限、大小与字段上限、本机来源标记 | 第一批开放 |
| 用户受限工作流 | 可以 | Core 编排器 | 固定 DSL、无任意表达式、只能调用已授权 Skill、步数/时长预算 | 第一批开放 |
| 官方只读 Skill | 可以 | Worker 或 Cloud | 平台签名、Core 鉴权、数据范围明确、可撤销 entitlement | 第一批开放 |
| 官方写操作 Skill | 可以安装 | Worker 或 Cloud | 管理员允许、逐次人工确认、幂等和审计 | 受控开放 |
| 企业连接器 Skill | 用户可申请或启用 | Cloud/凭据代理 | 租户管理员配置连接器和权限，用户看不到长期凭据 | 受控开放 |
| 第三方内容 Skill | 可以 | 配置解释层 | 自动扫描、来源展示、内容审核、无代码 | 第二批开放 |
| 第三方云端代码 Skill | 仅管理员批准后 | 隔离云端执行器 | 审核、签名、SBOM、资源/网络隔离、短时凭据代理 | 后续开放 |
| 第三方本地 WASM Skill | 仅管理员批准后 | 专用沙箱进程 | 无默认网络/文件、能力句柄、资源上限、终止与清理验证 | 商用后评估 |
| 任意 JS/Python/PowerShell/npm/GitHub 包 | 不可以 | 不适用 | 无 | 禁止直接开放 |
| 任意 EXE/DLL、OpenClaw 插件、MCP 服务 | 不可以 | 不适用 | 无 | 禁止直接开放 |

“可以安装”只代表制品进入本机 Skill Registry；只有同时满足 Agent 绑定、版本兼容、有效授权、
租户/设备策略、当前任务预算和必要的用户确认，Core 才允许执行。

## 三、普通用户、企业管理员与平台的权限边界

### 普通用户可以做

- 浏览经过策略筛选的 Skill 目录，查看发布方、用途、数据访问范围、执行位置和收费说明。
- 安装、升级、停用和卸载官方 Skill 或无代码 Skill。
- 选择 Skill 绑定的智能体，查看该智能体当前启用的能力。
- 创建提示词、知识说明、结构化表单和受限工作流。
- 对一次具体的写入、发送、删除或企业数据变更进行确认或拒绝。
- 导出自己创建的无代码 Skill；导入后仍标记为本机用户来源，不获得平台签名身份。

### 企业管理员控制

- 哪些发布方、分类和 Skill 可以被本租户发现、安装或执行。
- 企业连接器、数据范围、只读/写入权限、费用和并发上限。
- 是否允许用户创建、导入、分享或发布无代码 Skill。
- 第三方 Skill 的试用、灰度、停用、撤销和数据保留策略。

### 龙枢平台控制

- `skill_id`、版本、发布方身份、签名、审核状态、兼容矩阵和撤回状态。
- 可执行制品扫描、SBOM、许可证、秘密检测和安全测试。
- Cloud Executor、Worker 和 Tool Bridge 的能力上限。
- 风险分类、默认权限、确认规则、紧急停发和全局撤销。

普通用户始终不能配置真实模型、Provider、API Key、Gateway、后台服务地址或长期企业凭据。

## 四、Skill 类型与制品模型

### 4.1 Content Skill

只包含以下声明式内容：

- 名称、描述、图标、分类和示例任务。
- 提示词片段和操作说明。
- 用户提供的知识说明或对已授权知识库的引用。
- 输入表单 Schema 和输出展示 Schema。

Content Skill 不得包含脚本、动态表达式、远程 URL 加载、插件路径、模型配置、权限声明或秘密。
用户自建内容保存在目标 Agent 的用户覆盖层，不修改官方 Pack 和签名 Profile。

### 4.2 Workflow Skill

工作流采用版本化、严格 Schema 的 DSL，只允许：顺序、受限条件分支、固定次数循环、人工确认节点、
调用已安装 Skill 和组合 JSON 结果。禁止 `eval`、模板代码执行、递归、自定义解释器和后台常驻任务。

工作流本身不能授予权限。每个子 Skill 都使用自己的稳定 ID、可信 Agent/Session/ToolCall 上下文，
由 Core 逐次复验 entitlement、权限交集、预算和确认。工作流最多 20 步、深度 3，并受总时长、
Token、费用和并发预算约束；具体上限可由后台向下收紧。

### 4.3 Connector Skill

连接器只引用后台登记的逻辑 `connector_id`。长期凭据只保存在云端密钥服务或企业受管凭据代理中；
Skill 只能取得单次、短时、最小范围的能力令牌，不能读取或回显原始凭据。只读动作可按租户策略
免逐次确认，写入、发送、付款、删除和权限变更必须确认并具备幂等键和审计记录。

### 4.4 Executable Skill

第三方可执行代码优先只在隔离 Cloud Executor 运行，不直接下发 Windows 主机。未来本地执行只考虑
受限 WASM/WASI 制品，并且默认没有网络、文件系统、环境变量、进程、注册表、剪贴板和凭据权限。
宿主资源必须以一次性能力句柄显式注入；未完成独立安全评审前不进入普通用户开放范围。

## 五、Skill Package V1 与现有 Agent Pack 的关系

当前 Agent Pack 是智能体的签名、安装和回滚单位，Skill Worker 中的实现仍随客户端或官方 Pack
构建，不能冒充已经支持动态代码安装。开放计划分两步：

1. 第一阶段继续由 Agent Pack 携带官方 Skill 实现，用户只安装/启停 Skill 引用和本机内容覆盖层。
2. 第二阶段新增独立 `longhub/skill-package/v1`，用于内容、工作流和云端执行引用；不得复用
   Agent Profile 字段承载任意代码入口。

Skill Package V1 至少包含：

```text
schemaVersion
skill: id / version / type / publisher / display
compatibility: minDesktopVersion / openclawVersion / runtimeApiVersion
binding: allowedAgentProfileIds / defaultEnabled
inputs / outputs: schema references
capabilities: requiredSkillIds / connectorIds
permissions: requested / confirmationClass
runtime: content / workflow / cloudRef（V1 不含本地原生入口）
limits: size / steps / duration / concurrency / cost
integrity: digest / signatureKeyId / signature
```

`skill_id` 一经发布不可被另一个发布方接管。不同 Agent 对同一 Skill 分别保存绑定和启用状态；
卸载 Skill 不删除 Agent 会话、记忆或用户文件。升级失败继续使用上一可运行版本，撤销后立即阻断
新执行，但保留只读历史和审计证据。

## 六、安装、绑定、执行和撤销流程

```text
Skill Catalog + tenant policy
          ↓
Desktop Skill Center（目录薄层，不是新的聊天工作台）
          ↓
下载/导入 → Schema → 摘要/签名 → 审核状态 → 兼容 → 权限预览
          ↓
本机 Skill Registry → 用户选择目标 Agent → Config Composer 生成可见工具
          ↓
OpenClaw Tool Bridge 注入可信 Agent/Session/ToolCall
          ↓
Core 复验 Skill/Pack/entitlement/租户/设备/预算/确认
          ↓
Content Interpreter / Workflow Engine / Skill Worker / Cloud Executor
```

安装事务必须满足：

1. Catalog 只返回当前设备、租户和版本可见的候选。
2. 下载后验证严格 Schema、摘要、发布签名、审核/撤回状态和完整依赖图。
3. 安装页明确显示执行位置、数据访问、写操作、费用和发布者，不使用笼统的“完全访问”。
4. 用户选择目标 Agent；默认只绑定当前 Agent，不提供无提示的“全部智能体”。
5. Registry 与 Agent 配置原子更新并回读；失败恢复原状态。
6. Core policy 先收紧后放开：停用/撤销先阻断执行，再隐藏工具；启用先验权，再展示工具。
7. 执行前在线复验；UI 中可见不代表执行已授权。
8. 升级、回滚、停用、撤回和卸载都保留稳定 `skill_id` 与审计链。

## 七、文件、网络、知识和跨 Agent 边界

- 用户自建 Skill 默认没有文件访问。读取文件只能使用当前会话附件或文件选择器签发的一次性句柄；
  不能接受模型生成的任意路径。写文件必须再次确认目标和覆盖行为。
- 内容/工作流 Skill 默认没有网络。网络只能通过已登记 Connector 或 Cloud Skill 发起，并受域名、
  方法、响应大小、超时和速率白名单约束。
- Skill 不直接读取 Credential Manager、环境变量、Gateway Token、设备 Token 或模型 Key。
- Skill 只能读取当前 Agent 明确挂载的知识范围；私人记忆和原始 transcript 不跨 Agent 自动共享。
- 一个 Skill 绑定多个 Agent 时，每个绑定分别鉴权和计量，不能把 A Agent 的确认复用给 B Agent。
- Agent 或 Skill 的提示词都不是授权来源；内容中声称“允许访问全部文件”没有任何权限效果。

## 八、OpenClaw Skill 兼容导入

用户导入现有 OpenClaw Skill 时先进入隔离解析区：

- 只有 Markdown/JSON、提示词、说明和静态资源的内容可以转换为用户来源的 Content Skill。
- 引用了脚本、shell、npm、Python、二进制、插件、MCP、远程下载或未知工具的内容只显示风险报告，
  不安装、不执行，也不能通过重命名扩展名绕过扫描。
- 转换过程丢弃模型、Provider、Gateway、环境变量和全局 workspace 配置。
- 转换后的 Skill 必须重新选择目标 Agent，且默认零权限、无网络、无文件访问。

因此，“兼容导入”不是信任原有 Skill，而是把可证明为纯内容的部分降权转换为龙枢格式。

## 九、现有底座与实施缺口

### 已可复用

- Agent Pack 摘要、Ed25519 签名、原子安装、升级、回滚和撤销。
- Agent Registry、独立 workspace/agentDir/session 和稳定 Agent 映射。
- Tool Bridge 的可信 Agent/Session/ToolCall 上下文。
- Core 的权限交集、在线 entitlement 复验、预算和一次性人工确认。
- Cloud Catalog、租户/设备策略、Pack 审核、安全扫描和审计。
- 本机 Skill Worker 与隔离 Cloud Executor 的进程边界。

### 必须新增

- 独立 Skill Registry、Agent-Skill Binding 和稳定发布方命名空间。
- `Skill Package V1`、Content/Workflow Schema、依赖锁和兼容矩阵。
- Skill Catalog/详情/安装/升级/撤回 API，以及管理后台审核和租户策略。
- 无代码解释器和受限工作流引擎；不能直接把用户内容加载为 JavaScript。
- 文件一次性能力句柄、Connector Broker 和短时凭据代理。
- 安装/启停入口的 OpenClaw UI 薄层及版本化 UI 合约。
- Skill 级用量、费用、失败率、确认率和撤销审计。
- 第三方云端执行的租户隔离、出网策略、SBOM 和供应链门禁。

当前 `Skill Worker` 使用静态 Map 注册随产品构建的 TypeScript Skill，现有 Pack 扫描也只是基础规则。
在上述缺口完成前，不能宣称已经支持第三方动态代码安装。

## 十、能力成熟度与验收（非版本顺序）

### 层级 A：官方 Skill 自助安装

- 官方签名目录、详情、安装/启停/升级/回滚和 Agent 绑定。
- 用户能看到权限与执行位置，但看不到模型或基础设施设置。
- 撤销后已打开会话也不能继续执行。

### 层级 B：用户无代码 Skill

- 创建/导入 Content Skill 和受限 Workflow Skill。
- 默认零权限、无网络、无任意文件；可组合已授权官方 Skill。
- 导出包保留用户来源标记，不能伪装成官方或第三方审核制品。

### 层级 C：企业连接器和第三方云端 Skill

- 租户管理员审批，凭据代理，写操作确认，隔离执行和完整审计。
- 发布方签名、审核、SBOM、安全扫描、灰度和紧急撤回闭环。

### 暂不进入当前计划

- 第三方本地原生代码、任意 OpenClaw 插件、用户自建 MCP 服务和后台常驻进程。
- 本地 WASM 只有在独立沙箱评审、逃逸测试、资源滥用测试和故障恢复完成后才能重新立项。

每个阶段必须验证：跨 Agent 隔离为 0 串用、伪造权限 100% 拒绝、撤销阻断、安装失败原子恢复、
升级回滚、恶意包拒绝、敏感操作确认不可重放、模型与凭据不泄露，以及锁定版 OpenClaw UI E2E。

## 十一、关键设计决策

| 日期 | 决策 | 理由 | 影响 |
|---|---|---|---|
| 2026-07-30 | 开放 Skill 安装，但不开放任意代码执行 | “可安装”是产品能力，不应自动扩大主机信任边界 | 首批只做官方签名与无代码 Skill |
| 2026-07-30 | Skill 必须显式绑定 Agent | 防止身份、记忆、数据和权限跨 Agent 串用 | 绑定、授权和用量都按 Agent 分开 |
| 2026-07-30 | 用户工作流只能组合已授权 Skill | 让用户可定制流程，同时保持 Core 是最终授权点 | 每个子调用逐次鉴权、确认和计量 |
| 2026-07-30 | 第三方代码优先云端隔离执行 | 云端更容易统一限制网络、资源、凭据和紧急撤回 | 本地任意代码继续禁止 |
| 2026-07-30 | Skill Center 作为原生 WebUI 薄层 | 保持直接聊天体验，避免重新出现平行工作台 | UI 适配进入 OpenClaw 兼容门禁 |

## 十二、变更历史

### 2026-07-30 - 实施顺序迁入 V2 执行计划

**变更内容**：保留 Skill 安装与安全设计，将 Feature Policy、扩展入口、确认中心、官方 Skill 和
无代码能力的实际前置关系统一交由 `EXECUTION_PLAN_V2.md` 管理。

**变更理由**：Skill 设计不能先于共同策略和确认底座独立排期。

**影响范围**：Skill Schema、Desktop/Cloud/Core 实施顺序与发布门禁。

### 2026-07-30 - 建立 Skill 分级开放基线

**变更内容**：定义官方、用户无代码、连接器、第三方云端和本地可执行 Skill 的开放矩阵，明确
制品、安装、Agent 绑定、权限、文件/网络、兼容导入、撤销和分阶段验收规则。

**变更理由**：用户自行安装 Skill 是产品扩展性的关键，但现有 Worker 只支持静态可信实现；若把
内容安装和任意代码执行混为一体，会绕过 Agent 隔离、Core 权限和主机安全边界。

**影响范围**：Pack/Skill Schema、Desktop Registry 与 UI、Core/Worker、Cloud Catalog/审核、
Connector、Executor、权限、计量和 OpenClaw 兼容测试。

**决策依据**：优先复用现有签名、授权、Tool Bridge 和云端执行底座；从低风险声明式能力开始，
按安全证据逐级扩大，而不是向普通用户暴露底层运行时。
