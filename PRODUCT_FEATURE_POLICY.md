# LongHub 管家功能与开放策略

> 状态：clean-launch 当前基线（尚未上线）
>
> 更新：2026-08-11
>
> 适用范围：免费 LongHub Manager、Portal/Admin 自有页面和 LongHub Cloud Skill

本文件只规定 LongHub 自己的产品表面和云端服务准入，**不是 OpenClaw 能力封锁清单**。用户在原生
OpenClaw 中的模型、Provider、Channels、Agent、插件、MCP、第三方 Skill、脚本和工作区不受 LongHub
账号、订阅或本文件的 Feature Policy 限制。生产部署按全新产品初始化，不设计旧设备迁移。

## 1. 总体原则

1. **免费管家**：下载、安装引导、运行状态、Gateway 管理、备份、更新和诊断不收费，不要求登录。
2. **原生安装**：OpenClaw 和 Node 使用官方方式安装在用户自己的系统环境；LongHub 不复制运行时或数据。
3. **自有页面**：LongHub 只提供自己的管家页面，不加载、嵌入、iframe 或仿制 OpenClaw Control UI。
4. **本地开放**：Feature Policy 只作用于 LongHub 页面和云端 Skill，不得阻断用户直接运行的 OpenClaw。
5. **云端收费**：只有 LongHub Cloud Skill 需要账号、订阅和在线 entitlement；云端实现永不下发。
6. **透明处理**：每次云端调用前展示发送字段、处理位置、保留期、价格、额度、权限和副作用。
7. **故障隔离**：云端不可用、订阅过期或账号退出时，本地 OpenClaw 继续可用。
8. **服务端为最终边界**：页面隐藏按钮不是安全控制；Cloud API 每次任务都重新校验身份、权益和输入。

## 2. 功能开放矩阵

### 2.1 LongHub 自有管家功能

| 功能 | 状态 | 约束 |
| --- | --- | --- |
| 安装/检测 Node 与 OpenClaw | 免费开放 | 固定官方安装计划；展示版本、权限和确认信息 |
| Gateway 状态、健康、启停、重启 | 免费开放 | 仅公开 CLI/RPC；外部实例必须确认，无法证明所有权则拒绝 |
| 原生配置备份/恢复 | 免费开放 | 有界本地备份、校验后原子恢复，不上传配置正文 |
| 更新、诊断、脱敏导出 | 免费开放 | 只处理 LongHub 白名单范围，不读取 Provider Key/会话正文 |
| Cloud Skill 目录与详情 | 免费开放 | 只展示已发布且兼容的 Skill 及其数据/收费说明 |
| 薄适配器安装/停用/升级/回滚/卸载 | 免费开放 | 验签、摘要、兼容性和用户确认；不落地云端实现 |
| 账号、设备、订阅、用量 | 免费访问 | 仅云端服务需要账号；本地 OpenClaw 不以登录为前置 |

### 2.2 用户原生 OpenClaw

| 能力 | LongHub 策略 | 说明 |
| --- | --- | --- |
| 模型与 Provider | 不限制 | 用户按 OpenClaw 官方方式配置；LongHub 不强制默认模型或代理 |
| Channels | 不限制 | 不因订阅状态隐藏或停用渠道 |
| Agent、Workspace、Sessions | 不限制 | 数据归用户和 OpenClaw；LongHub 仅提供可选状态/备份 |
| 插件、MCP、脚本、本地工具 | 不限制 | 用户自行承担第三方代码和凭据风险 |
| 第三方/自建 Skill | 不限制 | 可提示来源、权限和兼容性，但不建立 LongHub 收费门槛 |
| OpenClaw 官方更新/卸载 | 不限制 | LongHub 可提供便利入口，用户也可直接使用官方工具 |

“不限制”不代表 LongHub 为第三方制品提供安全担保。LongHub 管家自己的安装、诊断和写操作仍须最小
权限、固定 Schema、备份和明确确认。

### 2.3 LongHub Cloud Skill

| 能力 | 状态 | 服务端要求 |
| --- | --- | --- |
| 浏览目录/详情 | 免费 | 返回用途、输入/输出、发布方、兼容版本、数据位置和计划要求 |
| 下载签名薄适配器 | 免费（设备需注册） | 仅返回 manifest、Schema 和纯内容文件；`no-store`、验签和撤回检查 |
| 调用云端 Skill | 订阅开放 | 账号、设备、Skill 版本、计划、entitlement、额度、速率、并发和幂等复验 |
| 写入/发送/删除类 Skill | 订阅 + 一次性确认 | 显示目标、参数摘要、费用/额度影响并审计 |
| 试用或赠送额度 | 可选运营 | 由服务端 entitlement 授予，不能由客户端伪造 |
| 停用/升级/回滚/卸载适配器 | 免费 | 只影响该适配器，不删除本地会话、workspace 或其他 Skill |

## 3. 页面信息架构

### 3.1 Manager（本机管家）

```text
首页
├─ 原生 OpenClaw：发现、安装、版本、Gateway 健康
├─ 运行维护：启停、备份/恢复、更新、诊断
├─ 云端 Skill：目录、适配器、启停、调用状态、用量
└─ 账号与隐私：设备、订阅、数据说明、脱敏导出
```

Manager 页面由 LongHub 自己提供；它不复制 OpenClaw 导航、不承载聊天工作台，也不把用户的本地配置
改写成 LongHub 专属格式。

### 3.2 Portal（公开前台）

```text
产品介绍（免费管家） → 下载 → Cloud Skill 目录 → 登录/注册
                         └→ 设备绑定 → 订阅/权益 → 订单与取消
```

Portal 的销售对象只有 Cloud Skill 计划。真实支付通道未配置时，按钮只能展示“尚未开通”，不得调用
开发用模拟结算。

### 3.3 Admin（运营后台）

```text
看板 · 用户 · 设备 · Cloud Skill 计划 · 订阅/权益
     · 云端模型路由 · 适配器发布 · 客户端版本 · 审计
```

Admin 可以配置 Cloud Skill 计划的 Skill 集合、月/年价格、额度、速率和并发；不能用后台开关修改用户
本地 Provider、模型、Channels、插件、MCP 或第三方 Skill 的可用性。

## 4. Feature Policy 语义

Feature Policy 的作用域必须显式标注为 `longhub_ui` 或 `cloud_skill`。它可以控制目录是否展示、某个云端
Skill 是否可调用、计划的额度/速率/并发和高风险确认条件；它不能作为本地 OpenClaw 的总开关。

策略合并规则：

- 缺失、未知、过期或签名不正确的云端策略默认拒绝对应云端请求；本地 OpenClaw 不受影响。
- 下层（设备/用户）只能收紧云端限制，不能放宽服务端全局上限。
- `required_confirmations` 取并集；额度、速率、并发取更严格值；撤回/停用为 deny-wins。
- 客户端缓存仅用于展示最近状态，不能在离线时授权付费 Cloud Skill 执行。
- 错误向用户映射为稳定代码（例如 `AUTH_REQUIRED`、`SUBSCRIPTION_REQUIRED`、`QUOTA_EXCEEDED`、
  `SKILL_REVOKED`、`CONFIRMATION_REQUIRED`、`TEMPORARILY_UNAVAILABLE`），不透传内部地址、模型、堆栈或凭据。

## 5. 数据与隐私

### 本地默认不上传

- 安装、启动、停止、更新、备份和第三方 Skill 管理不需要账号。
- LongHub 不上传会话、workspace、Provider Key、环境变量、MCP 配置或第三方 Skill 源码，除非用户
  主动选择诊断文件或发起 Cloud Skill 调用。
- 本地日志、备份和临时制品留在用户选择的位置；清理只处理 LongHub 自身白名单。

### 云端调用前告知

每个 Skill 详情和首次调用前显示：字段/附件、大小限制、处理地点、第三方连接器、保存期限、删除方式、
订阅价格/周期/额度/并发、失败重试规则、权限和可能的外部副作用。

### 凭据与日志

- 账号/设备 Token 使用系统安全存储；适配器不持有长期 Token。
- Provider/API Key 只由原生 OpenClaw 管理；LongHub 字段采用只写语义，不回显。
- Cloud/Executor 日志脱敏，不记录完整提示词、原始业务输入、路径、Token、内部 URL 或长期连接器凭据。
- 用户可查看调用历史、用量和公开错误码；审计保留期和删除入口在隐私页公布。

## 6. 对外接口约定

```text
GET  /v1/cloud-skill-plans
GET  /v1/catalog/skills
GET  /v1/catalog/skills/{skillId}
GET  /v1/skills/{skillId}/adapter?version=&openclaw_version=
GET  /v1/cloud-skill/bindings
POST /v1/cloud-skill/bindings
DELETE /v1/cloud-skill/bindings/{bindingId}
POST /v1/tasks
GET  /v1/tasks/{taskId}
GET  /v1/tasks/{taskId}/events
POST /v1/tasks/{taskId}/cancel
GET  /v1/me/cloud-skill-subscriptions
GET  /v1/me/cloud-skill-entitlements
POST /v1/me/cloud-skill-subscriptions/{id}/cancel
```

账号、设备和 Admin 端点见 [平台总体设计](DESIGN.md) 与 OpenAPI。所有任务请求都绑定设备/账号、Skill
版本、Agent/Session 摘要、`Idempotency-Key` 和严格输入 Schema；Executor 不可被客户端直接访问。

## 7. 首发验收优先级

### P0：免费原生管家

- Windows 干净环境发现或安装官方 OpenClaw。
- 自有页面完成状态、Gateway、备份/恢复、诊断和更新提示。
- 无账号/订阅时本地 OpenClaw 仍完整可用。

### P1：Cloud Skill Center

- 目录、详情、验签、安装、停用、升级、回滚、卸载闭环。
- 适配器扫描证明不含云端实现、完整提示词、内部地址或长期凭据。

### P2：账号与订阅

- 设备绑定、计划展示、真实支付、订阅/权益、取消/退款和用量可复验。
- 订阅失效立即阻断 Cloud API 任务，不能影响本地 OpenClaw。

### P3：首批商业 Skill

每个 Skill 具备独立版本、Schema、数据政策、计划绑定、额度/并发、审计、撤回和云端实现隔离证据。

## 8. 历史/废弃基线（不上线）

旧文档曾把内嵌页面、强制模型、限制本地设置、授权码、HR/Agent Pack、旧商品和钱包/充值列为产品能力。
这些内容仅保留为审计背景，当前 Portal、Admin、Manager 和 Cloud API 不得按其流程实现或部署。
