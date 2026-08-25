# LongHub clean-launch PostgreSQL 基线

这是 LongHub 尚未上线环境使用的首发数据库基线。它只描述免费原生
LongHub Manager 与 Cloud Skill 云端服务；不会导入、升级或兼容旧 Pack 产品。

## 使用方式

在仓库根目录执行：

```powershell
$env:DATABASE_URL = "postgres://..."
node apps/longhub-cloud-api/scripts/migrate.mjs --dry-run
node apps/longhub-cloud-api/scripts/migrate.mjs
```

也可以在 `apps/longhub-cloud-api` 包目录执行：

```powershell
pnpm db:migrate -- --dry-run
pnpm db:migrate
```

runner **只**读取本目录下、按 `NNNN-name.sql` 命名的直接子文件；不接受迁移目录
参数或环境变量覆盖，也不会读取 `infrastructure/migrations` 根目录中的历史 SQL。
当前 clean launch 是单一最终基线，迁移器独立固定
`0001-clean-launch-baseline.sql` 的 version/name 与 SHA-256；文件缺失、增加其他 SQL 或摘要
变化都会在建立数据库连接前失败。任何有意 schema 变更都必须同时经过代码审查更新固定清单，
不能通过直接替换 SQL 改写动态参考。
它在首次执行前要求 `public` schema 真正为空，或只包含合法的
`schema_migrations` 表及 PostgreSQL 自动生成的主键索引、row type 和 row type array。
检查不再局限于 `pg_tables`：额外 view、materialized view、foreign table、sequence、
function/procedure、domain、enum、复合/自定义 type、extension、用户 trigger/rule/policy
等 public 对象都会 fail-closed。

基线已存在或执行完成后，runner 只接受下列预期表、
`cloud_task_event_event_id_seq`/`feature_policy_revision_seq` 两个预期 sequence、精确的
PK/UNIQUE/FK/CHECK 约束、精确的约束索引/普通索引，以及 PostgreSQL 自动 row types。
它会在同一连接的 `pg_temp` 中执行受信 clean-launch SQL，并立即回滚，再用同一 PostgreSQL
版本产生的结构化 catalog 签名逐项对比 public：列顺序、引用表/列、外键动作、CHECK
表达式、索引方法/键顺序/唯一性/排序/谓词和有效状态任一漂移都会 fail-closed；不能用同名但
不同定义的对象蒙混通过。对象清单来自 `pg_catalog`，不会把 `pg_catalog`/`pg_toast` 中的
系统对象误判成 public 漂移。任一业务表已出现但基线不完整时也会拒绝继续。advisory lock、
逐文件 checksum 和单文件事务语义保持不变。

`--dry-run` 只连接数据库并列出待执行文件，不创建持久对象、不写入版本记录。完整性检查会在
事务内创建 session-local 的 `pg_temp` 参考对象并回滚；public schema 不发生写入。

正常迁移结果中的 `applied` 只列出本轮实际执行并提交的文件；无变更重跑返回空数组，不把历史
已应用迁移重复报告为本轮执行。

## 当前基线

`0001-clean-launch-baseline.sql` 是单一最终基线。允许的业务表为：

- 身份与审计：`account_user`、`auth_session`、`admin_account`、`audit_log`、`device`、
  `device_pairing_challenge`
- 任务：`cloud_task`、`cloud_task_event`
- Cloud Skill 商业线：`cloud_skill_plan`、`cloud_skill_plan_skill`、
  `billing_order`、`cloud_skill_subscription`、`cloud_skill_entitlement`
- 执行授权与计量：`cloud_agent_skill_binding`、`cloud_skill_execution_reservation`
- 制品：`cloud_skill_adapter_release`、`manager_release`
- Executor 路由与策略：`model_gateway_config`、`feature_policy`、
  `client_telemetry_hourly`、`model_request_hourly`、`http_route_hourly`、
  `feature_policy_emergency_observation`、`model_usage_aggregate`
- 支付 provider 结算事实：`billing_settlement`、`billing_outbox`

另有内部版本表 `schema_migrations`、由 `cloud_task_event.event_id BIGSERIAL` 自动生成的
`cloud_task_event_event_id_seq`，以及显式的 `feature_policy_revision_seq`。

以下名称在首发基线中明确不存在：

`activation_code`、`entitlement`、`pack_release`、`pack_review`、`skill_release`、
`product`、`wallet_txn`、`knowledge_document`。

同样不会创建历史列：

- `account_user.balance_fen`
- `device.activation_code_id`、`device.activated_at`
- `device.device_token`（首发只保存 `device_token_hash`；明文凭据仅在注册/轮换响应中返回一次）
- `model_gateway_config.assistant_name`、`assistant_avatar_path`、`welcome_message`、
  `quick_tasks`、`features`
- `billing_order.product_id`、`billing_order.pack_id`

## 重要切换说明

`PgStore.init()` 只读取并校验 clean-launch schema/version、表列和序列，不会自举或
修复 DDL。部署必须先运行本 runner，再启动 API；缺少基线或存在旧表/旧列时服务会
fail-closed。

正式支付 provider 的回调、退款和 outbox worker 尚未冻结。基线中的
`billing_settlement`/`billing_outbox` 只保存 provider-backed 结算事实（`method='provider'`），不提供余额钱包
或 mock 支付；接入真实 provider 时应通过后续迁移扩展，而不是重新引入旧表。

## 当前代码切换状态

首发 PgStore 已切换为只访问本基线字段：旧 Pack/activation/product/wallet/knowledge
方法统一 fail-closed；账号、设备（含一次性 pairing challenge）、Cloud Skill 计划/
订阅/权益、任务、遥测和模型策略使用 clean-launch 表。设备只持久化
`device_token_hash`，明文凭据仅在注册或轮换响应中出现一次。

支付 provider 的回调、退款和 outbox worker 尚未冻结，当前结算入口返回
`SETTLEMENT_UNAVAILABLE`，不会写入余额或模拟支付数据。接入真实 provider 时应通过
后续迁移扩展，而不是重新引入旧表。
- 目前 `client-release-routes.ts` 仍以 `CLIENT_RELEASE_DIR/releases.json` 保存 Manager
  制品，尚未消费本基线的 `manager_release` 表；上线前要么完成数据库发布记录切换，
  要么明确把该表延后到后续迁移并从允许集合移除，不能出现双写漂移。表中 `arch`、
  `size`、`url_path` 对齐当前 `ClientReleaseRecord.manifest` 命名，真正切换时仍需
  绑定 artifact 存储 ACL 和签名 envelope 的完整校验。
- 生产 bootstrap 不要求 `KNOWLEDGE_DATA_KEY`，部署环境也不得保留该退役密钥；知识库表已不在本基线。
  未来若重新引入知识能力，必须作为独立可选模块定义全新的 schema 和密钥边界。

这些缺口是有意记录的审查项，不是 runner 的绕过条件；即使 schema smoke 通过，
也应先完成 provider、Manager 制品记录和可选知识库模块的独立上线决策。

历史 SQL 保留在 `infrastructure/migrations` 仅供离线审计。本 runner 不会执行它们；部署
脚本也不得把历史目录作为参数传入。
