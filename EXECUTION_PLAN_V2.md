# LongHub Clean-launch 执行计划

> 状态：公网候选已部署并完成生产 E2E；尚未向终端用户开放（2026-08-17）
>
> 首发：Windows LongHub Manager + 用户原生 OpenClaw + LongHub Cloud Skill 订阅

## 当前执行快照（2026-08-17）

已完成并留有可复验证据：

- Ubuntu 原生生产部署已切换到 `/opt/longhub/releases/20260816T163300-hotfix`，
  `/var/www/longhub/releases/20260816T163300-hotfix`；公网 HTTPS、Nginx、PostgreSQL、Cloud API 和
  Executor 均正常。
- 源代码目录和已安装 release 各完成一次完整生产 E2E：账号/Admin 登录、一次性设备配对与重放拒绝、
  Cloud Skill 计划/适配器、pending order、真实私有 Executor、幂等 replay/conflict、跨设备与撤销边界、
  binding reactivation、Executor `SIGSTOP` 取消、运营指标、匿名 billing outbox 和身份清理。
- PostgreSQL 已完成 owner/ACL 保留的逻辑备份、SHA-256、scratch 恢复与权限验证；生产 app 角色只读
  `schema_migrations`，无数据库/schema/序列提升权限。恢复证据存放在服务器 root-only backup 目录。
- 已用 `rollback-release.sh` 回滚到 `20260816T161700` 并回切最终 release；两次完整 health check 和签名
  Executor probe 均通过。
- Manager/native plugin 信任根资产已记录为 approved Ed25519 配置；Manager Windows 候选安装器可在无
  artifact 的候选模式构建，Go test/build 通过。当前候选安装器仍未做可信 Authenticode 签名。

仍然阻断“已开放”判定：真实支付提供商回调/结算 worker、KMS/HSM 私钥托管、生产 native plugin 签名
artifact staging、可信 Authenticode 证书、干净 Windows VM 的安装/托盘/Task/更新回滚，以及完整
Credential Manager/ACL/rotation/revoke 纵向验收。不得把本快照写成外部门禁已完成。

本文是新产品的唯一排期和验收入口。项目从空数据库和全新环境开始，不考虑旧客户端、旧设备、旧订单、
旧表或旧数据迁移。仓库中的早期实现可以继续用于单元测试和安全审计，但 clean-launch runner 不执行历史
SQL，它们也不应进入当前页面、部署或销售流程。

关联基线：

- [总体设计](DESIGN.md)
- [功能与开放策略](PRODUCT_FEATURE_POLICY.md)
- [云端 Skill 平台](SKILL_PLATFORM.md)
- [Cloud API OpenAPI](contracts/openapi/longhub-cloud-v1.yaml)
- [Manager 设计](apps/longhub-manager/DESIGN.md)

## 1. 产品范围冻结

### 1.1 必须交付

- 免费 LongHub Manager：检测/安装/启动/停止/健康/备份/恢复/更新/诊断用户系统原生 OpenClaw。
- LongHub 自有管家页面；不加载、嵌入、iframe 或仿制 OpenClaw Control UI。
- 用户本地模型、Provider、Channels、Agent、插件、MCP、第三方 Skill、脚本和 workspace 全部开放。
- Cloud Skill 目录、签名薄适配器/固定桥接插件、账号、设备绑定、订阅、用量和调用状态。
- Cloud API → 私网 Executor 的在线授权、额度/速率/并发、输入校验、幂等、撤回、审计和错误收敛。
- Windows 正式安装包、代码签名、更新/回滚、生产数据库、真实支付和可复验部署记录。

### 1.2 明确不做

- 不复制 OpenClaw 或 Node 到 LongHub 私有目录，不接管用户已有原生数据。
- 不把本地能力放入 LongHub 收费墙；订阅失效只拒绝 Cloud Skill 任务。
- 不把云端实现、完整提示词、内部模型路由、连接器凭据或长期 Token 下发给客户端。
- 不在新页面、新 API 文档或生产环境提供历史产品销售/授权流程。
- 不为尚未上线的旧设备设计迁移、兼容或回滚步骤。

## 2. 事实基线（本地开发状态）

| 领域 | 当前代码/验证 | 上线前仍需完成 |
| --- | --- | --- |
| Manager 本地服务 | Go 回环鉴权、固定 CLI 动作、运行时/备份/Bridge/适配器、插件控制器、一次性设备配对和固定 Windows Task 探测/注册/删除已有实现与测试 | Windows 原生安装态、托盘启动、任务运行态 E2E、升级回滚和正式制品 |
| Manager 管家页 | 自有 HTML/React surface，不嵌入 OpenClaw 页面 | 完整安装向导、状态/诊断 UX、Windows 启动器和安装包 |
| Portal | 新的免费管家 + Cloud Skill 目录/账号/订阅 UI，typecheck/build 已通过 | 连接新 Cloud API、真实支付状态、HTTPS 公网冒烟 |
| Admin | 新导航、Cloud Skill 计划/订阅、薄适配器发布/撤回、用户/设备/审计页面，typecheck/test/build 已通过 | 真实权限配置、生产指标口径和公网冒烟 |
| Cloud API | 计划、目录、适配器、任务、订阅/权益、设备配对、空库 clean-launch 基线和公网生产 E2E 已通过 | KMS、真实外部支付、多实例取消/计量压力和跨区域灾备 |
| Cloud Plugin/Adapter | Schema、签名下载、本机事务和 Ubuntu VMware fixture 闭环已有 | 生产公钥、正式签名制品、Windows ACL/Credential Manager、轮换/撤回 |
| Billing | `cloud_skill_plan` 订单、订阅/权益、额度预留和退款模型已有 | 正式支付、outbox worker、故障恢复、并发/重复回调演练；生产禁止 mock |
| 公网部署 | 原生 Ubuntu clean-launch 已部署，公网 HTTPS/备份恢复/回滚/完整 E2E 已有证据 | KMS/HSM、真实支付、可信 Manager 签名与 Windows VM 门禁关闭后才能开放 |

状态词只用于本计划：`待开始`、`进行中`、`代码完成`、`候选完成`、`已部署`、`已开放`、`阻塞`。代码完成
不代表已部署或已向用户开放；阻塞必须写明外部依赖和下一步。

## 3. 交付顺序与任务表

### 3.1 M0：clean-launch 契约和产品表面

| ID | 任务 | 状态 | 完成定义 |
| --- | --- | --- | --- |
| LH-CL-001 | 冻结产品边界和命名 | 代码完成（本地） | Manager/Portal/Admin/Cloud 文案只描述免费原生管家与 Cloud Skill；旧入口不在导航 |
| LH-CL-002 | API/OpenAPI 对齐 | 代码完成（本地） | 前端和文档使用真实 `/v1/cloud-skill-plans`、`/v1/catalog/skills`、`/v1/skills/{id}/adapter`、`/v1/tasks` |
| LH-CL-003 | 生产关闭旧表面 | 代码完成（本地） | 默认关闭 legacy surface，生产禁止显式开启；旧路径返回 `410 LEGACY_SURFACE_DISABLED` |
| LH-CL-004 | clean 数据库初始化 | 代码完成（本地） | 单一 baseline 只创建新账号、设备、Cloud Skill plan/subscription/entitlement、任务和审计数据；拒绝非空库、旧表/旧列，不导入旧数据 |

### 3.2 M1：免费原生 Manager 0.1

| ID | 任务 | 状态 | 完成定义 |
| --- | --- | --- | --- |
| LH-MGR-001 | 本地服务安全骨架 | 代码完成 | 仅回环绑定；一次性 fragment 令牌、Origin/请求体限制、稳定错误码和无任意命令入口 |
| LH-MGR-002 | 原生 Node/OpenClaw 发现与官方安装 | 进行中 | 检测 PATH/Node 兼容性；固定官方 npm 安装计划；确认、权限、磁盘和失败恢复测试 |
| LH-MGR-003 | Gateway/配置/备份/诊断 | 进行中 | 公开 CLI/RPC 状态与健康；外部实例确认；原子备份/恢复；不写私有数据库 |
| LH-MGR-004 | 自有管家页和 Windows 启动器 | 进行中 | 安装、状态、维护、Skill、账号页面由 LongHub 自己提供；不加载 OpenClaw HTML/iframe |
| LH-MGR-005 | 更新、托盘和崩溃恢复 | 待开始 | 签名 manifest 固定 `product_surface=longhub-manager`，只发布 Manager 安装包；失败回滚、日志脱敏、休眠/重启/磁盘不足回归 |
| LH-MGR-006 | 一次性设备配对 | 代码完成（本地） | Manager 注册设备并把凭据写入系统安全存储，生成 10 分钟一次性码；Portal 原子消费，页面/错误不暴露设备 Token |

M1 发布门槛：Windows 干净虚拟机能完成官方安装/启动/停止/备份恢复；Manager 退出或卸载后 OpenClaw
仍可由官方 CLI 独立启动；无账号时本地能力完整可用；注册 → 系统凭据存储 → 一次性配对码 → Portal
原子消费在真实 clean-launch Cloud 环境纵向通过。

最新本地切片：固定 Windows 自动启动任务的所有权探测、确认门禁注册/删除、有限状态页面和失败关闭回归
已通过，见 [LH-MGR-003 验证记录](docs/validation/LH-MGR-003-windows-task-lifecycle.md)。真实 Windows VM、
托盘、安装器和升级回滚未验收，因此任务状态保持“进行中”。

### 3.3 S1：Cloud Skill 0.1

| ID | 任务 | 状态 | 完成定义 |
| --- | --- | --- | --- |
| LH-SKILL-001 | 适配器契约、签名和安装事务 | 代码完成，发布门禁未关闭 | manifest/文件严格校验、Ed25519 验签、兼容/撤回检查、原子升级/回滚/`broken` 状态 |
| LH-SKILL-002 | 原生 Cloud Plugin 与 Manager Bridge | 进行中 | 固定 `longhub_cloud_skill` 工具、可信 Agent/Session 上下文、执行凭据隔离、任务终态轮询 |
| LH-SKILL-003 | Cloud API 执行边界 | 进行中 | `/v1/tasks` 在线校验账号/设备/计划/权益/额度/速率/并发/Schema/幂等；Executor 私网短时凭据 |
| LH-SKILL-004 | 目录、适配器和调用 UX | 进行中 | Portal/Manager 目录详情、安装确认、状态、错误、撤回和用量展示与 API 一致 |
| LH-SKILL-005 | 生产信任与纵向 E2E | 待开始 | 正式公钥/签名制品、Windows Credential Manager/ACL、轮换/撤回、真实 Cloud API→Executor 验收 |

S1 发布门槛：篡改、伪造 Skill ID、重放、跨设备/租户、过期/取消/撤回和重复任务全部拒绝；适配器制品
扫描不含云端实现、完整提示词、内部 URL 或长期凭据。

### 3.4 B1：账号、订阅和真实计费

| ID | 任务 | 状态 | 完成定义 |
| --- | --- | --- | --- |
| LH-BILL-001 | Cloud Skill 计划和订阅模型 | 代码完成 | plan → order → subscription → entitlement 关系、月/年额度和设备/租户绑定可审计 |
| LH-BILL-002 | 正式支付与退款 | 阻塞（支付渠道） | 真实支付回调、订单行锁、幂等键、退款撤销 entitlement、故障恢复和重试 |
| LH-BILL-003 | 用量/额度/并发计量 | 进行中 | 任务 admission 预留/释放 CAS、多实例一致性、按 Skill/计划聚合和运营导出 |
| LH-BILL-004 | Portal 订阅体验 | 进行中 | 计划详情、价格/额度、订单状态、取消和错误透明；支付未接入不调用 mock |

B1 门槛：生产环境没有 mock/余额支付；重复支付或退款不会重复发放/撤销权益；订阅失效不影响本地
OpenClaw。

### 3.5 O1：Portal/Admin 运营闭环

| ID | 任务 | 状态 | 完成定义 |
| --- | --- | --- | --- |
| LH-OPS-001 | Portal clean-launch 发布 | 代码完成（本地） | 新标题、目录、账号/设备/订阅和订单历史；旧产品入口不显示 |
| LH-OPS-002 | Admin clean-launch 发布 | 代码完成（本地） | 计划、订阅/权益、用户、设备、审计和云端模型路由；不出现旧销售入口 |
| LH-OPS-003 | 适配器发布运营 | 代码完成（本地） | Admin 有发布列表、摘要、兼容版本、发布/撤回和审计；不依赖数据库手工操作 |
| LH-OPS-004 | 用量和健康看板 | 进行中 | 已有 Cloud API 运营指标和 Admin 看板；仍需按 Skill/计划聚合调用量、错误、额度和 Executor 健康，不展示逐用户敏感载荷 |

### 3.6 R1：首发部署与上线门禁

| ID | 任务 | 状态 | 完成定义 |
| --- | --- | --- | --- |
| LH-REL-001 | Cloud API 与数据库部署 | 候选完成（生产 E2E 通过） | 空 schema 的 clean-launch baseline、密钥/KMS、Executor 私网、HTTPS、备份和健康检查完成；不得运行历史 migrations |
| LH-REL-002 | Portal/Admin 部署 | 待开始 | 新 dist 与 API 同步发布，CSP/CORS/错误页和公网登录冒烟通过 |
| LH-REL-003 | 首批计划和 Skill 上架 | 待开始 | 至少一个 `listed` plan 及兼容适配器；价格/额度/数据政策已审阅 |
| LH-REL-004 | 全新用户纵向验收 | 待开始 | 下载 → 安装原生 OpenClaw → 绑定设备 → 订阅 → 安装适配器 → 调用/取消完整通过 |
| LH-REL-005 | 上线决策 | 待开始 | 无高危/严重问题；支付、撤回、备份恢复、监控、应急下架和隐私/条款证据齐全 |

## 4. API 与页面依赖

```text
Portal ── /v1/cloud-skill-plans ───────────────┐
Portal ── /v1/me + /v1/me/devices + /v1/me/devices/pair ─┤
Portal ── /v1/me/cloud-skill-* + /v1/orders ──┤
                                                ▼
Manager ─ /v1/devices/register ─ /v1/devices/pairing/challenge
        └ /v1/catalog/skills ─ /v1/skills/{id}/adapter ─ /v1/tasks
                                                │
                                                ▼
Admin ── /v1/admin/cloud-skill-plans
       └─ /v1/admin/cloud-skill-subscriptions
       └─ /v1/admin/cloud-skill-adapters（发布/撤回）
```

前端不得猜测或拼接未在 OpenAPI 中定义的产品路径。Cloud Skill 目录返回 404/非 JSON 时，页面显示可解释
的“服务正在升级/暂时不可用”，不得回退到旧商品目录。支付通道未配置时，订阅按钮保持只读。

## 5. 统一完成定义

任何任务只有同时满足下列条件才可标为“代码完成”：

1. 实现和契约已更新，未知字段、越权和错误边界有测试；
2. 本地单元/契约/集成测试通过，并记录命令和环境；
3. 页面、API、Admin 操作和隐私说明同步；
4. 失败、重试、取消、回滚和审计路径有可复验证据；
5. 不把本地能力收费、不复制 OpenClaw、不暴露云端实现；
6. “已部署/已开放”另需线上健康、数据库和公网冒烟证据。

## 6. 发布验证矩阵

| 层级 | 检查 |
| --- | --- |
| 质量 | `pnpm --filter longhub-portal typecheck/build`；`pnpm --filter longhub-admin-web typecheck/test/build`；Manager `go test ./...` |
| 契约 | OpenAPI 路径、Schema、错误码、Idempotency-Key、SSE/取消和版本兼容 |
| 安全 | 适配器签名/篡改、SSRF/重定向、凭据不落盘、跨设备/租户、权限和审计 |
| 本机 | Windows 干净 VM、Node/npm、Gateway 外部所有权、备份恢复、升级失败回滚、卸载数据保留 |
| 云端 | PostgreSQL 空库 baseline/schema smoke/事务、Executor 短时凭据、KMS、outbox、限额/并发和故障恢复 |
| 产品 | Portal/Admin/Manager 无旧入口；无账号本地运行；订阅失效只影响 Cloud Skill |
| 上线 | HTTPS/CSP/CORS、密钥注入、备份、监控、应急撤回、真实支付和条款/隐私页面 |

## 7. 风险与处理

| 风险 | 处理 | 阻断级别 |
| --- | --- | --- |
| 正式适配器信任公钥和签名制品未准备 | 外部签名服务生成 manifest；公钥未批准时 fail closed | 上线阻断 |
| Windows 安装/凭据/ACL 尚未完成 | 在干净 Windows VM 完成安装态和 Credential Manager 回归 | 上线阻断 |
| 真实支付/退款未接入 | 保持 Portal 只读；完成事务、outbox、重复回调和退款撤权演练 | 上线阻断 |
| 生产 Cloud/Executor 尚未纵向验证 | 私网部署、短时凭据、KMS、多实例取消和租户隔离 E2E | 上线阻断 |
| 目录无 listed plan | 部署后由 Admin 创建并审阅至少一个计划和适配器 | 开放阻断 |
| 上游 OpenClaw CLI/RPC 漂移 | 版本化能力矩阵；未知版本进入诊断，不静默改写 | 发布阻断 |

## 8. 下一步顺序

1. 在空的生产 `public` schema 上运行单一 clean-launch baseline，确认无旧表/旧列且旧表面关闭。
2. 完成正式签名公钥/适配器制品、Windows Manager 安装态和 Credential Manager/ACL E2E。
3. 接入真实支付/退款与 outbox，完成订阅取消、撤回和重复回调验证。
4. 完成 Admin 适配器发布列表/撤回和用量聚合页面。
5. 部署 Cloud API/Executor，再部署 Portal/Admin dist；创建首批 `listed` Cloud Skill plan。
6. 执行全新用户纵向冒烟，收集监控/审计/隐私证据后再决定开放。

## 9. 历史/废弃路线（不上线）

早期 Electron/内嵌 Control UI、独立私有 OpenClaw、Agent/HR Pack、授权码、旧商品、钱包/充值、强制默认
模型和把 Feature Policy 锁成本地总开关的任务已冻结。它们不再是本计划的前置，也不提供迁移或旧设备兼容
操作；详细完成记录只见 [ROADMAP.md](ROADMAP.md) 的归档说明。

## 10. 变更记录

### 2026-08-11 — clean launch 重新基线

确认项目尚未上线，删除旧设备兼容假设；前台、后台、Cloud API 和 Manager 均只围绕免费原生管家与
Cloud Skill 订阅排期。历史销售和本地能力限制不再出现在当前任务。

### 2026-08-09 — 免费原生管家与云端 Skill

冻结原生安装、自有页面、本地开放和云端实现保密四条边界；客户端收费从本地/套装能力转为云端 Skill
订阅。
