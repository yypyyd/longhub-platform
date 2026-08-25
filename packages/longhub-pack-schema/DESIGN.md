# @longhub/pack-schema 设计

> 状态：有效  
> 更新日期：2026-07-30

## 职责

本包是 Agent Pack、Agent Profile、Skill Package 和客户端更新元数据的共享严格解析边界。Cloud、
Manager、Console 与测试必须导入同一实现，不能复制宽松 Schema。

## Skill Package V1 边界

Skill Package V1 只描述三种运行形态：随受信客户端构建的 `builtin`、只含受限内容/工作流引用的
`declarative`、以及只保存服务逻辑 ID 的 `cloudRef`。它没有 URL、命令、脚本、可执行文件、插件、
MCP、模型、Gateway、环境变量或凭据字段；所有对象逐层 `strict()`。

`publisher.namespace` 必须拥有 `<namespace>.skill.*`，已存在 ID 的 publisher 不能变更。非 `longhub`
发布方不能声明 `builtin`，防止第三方把目录记录映射到本机静态 Worker 实现。写入、发送、删除、支付
及未来未知动作统一要求 `per_execution`，Package 只能声明所需权限，不能授予权限。

声明式入口只能是 Pack 内安全相对路径；Content 只允许 Markdown/JSON，Workflow 只允许 JSON。
CloudRef 只保存 `serviceId + apiVersion`，不保存可由发布输入控制的 URL。0.8 已冻结独立严格的
Content Skill 与 Workflow DSL Schema：默认零权限、owner 来源重签、静态 DAG 和资源上限；脚本、插件、
MCP、远程加载、循环、递归及动态代码均无可表达字段。

## 信任与完整性

Schema 校验只证明结构符合边界，不证明发布者身份。Catalog 发布还必须把 `signatureKeyId` 绑定到已
登记 publisher 公钥，重算 SHA-256、验证 Ed25519 签名，并检查审核、兼容、entitlement 和撤回状态。

## 变更历史

### 2026-08-11 - 固定 Manager 更新制品身份

**变更内容**：Windows 更新 manifest 只接受 `LongHub-Manager-Setup-{version}.exe` 及对应同源下载路径。

**变更理由**：免费 Manager 的更新制品必须在文件名层与已废弃 Desktop/通用客户端制品明确分离。

**影响范围**：共享更新 Schema、Cloud 发布签名、OpenAPI、Nginx 下载白名单和历史 Desktop 更新回归。

**决策依据**：`product_surface=longhub-manager` 与专用文件名同时进入严格 Schema 和 Ed25519 载荷；旧名称
不能被新上传或新签名路径接受。

### 2026-07-31 - 冻结用户 Content Skill 与 Workflow DSL

**变更内容**：新增严格用户内容 Skill、来源、导入导出和受限 Workflow DAG Schema。

**变更理由**：无代码创建与兼容导入必须可组合，同时不能扩大 Skill Package 的本机代码信任边界。

**影响范围**：Manager 无代码工作台、Core Workflow Engine、OpenClaw 内容降权导入。

### 2026-07-30 - 冻结 Skill Package V1 与 Publisher Namespace

**变更内容**：新增严格 Skill Package Schema、三态 runtime、限制/兼容/权限/签名字段和命名空间所有权
校验。

**变更理由**：官方 Skill 自助安装必须先区分“启用内置实现”“安装声明式内容”“保存 CloudRef”，不能
把安装语义扩展成任意本地代码执行。

**影响范围**：0.6 Skill Registry/Catalog/事务/UI、0.8 Content/Workflow Schema 与供应链门禁。

**决策依据**：所有发布输入逐层拒绝未知字段；本地代码入口没有可表达字段；ID 与 publisher 前缀及
已有所有者双重绑定。
