# LH-BILL-001 Cloud Skill 订阅与 Skill entitlement 验收

> 日期：2026-08-09  
> 状态：订阅、用量准入、支付/退款原子结算完成；outbox 消费者接入、故障注入和正式线上演练仍待部署阶段关闭

## 本批次交付

Cloud Skill 商业线已经与 legacy Agent Pack 商品分离：

- `CloudSkillPlanRecord` 描述 `plan_id`、Skill allow-list、价格和公开限制元数据。
- `CloudSkillSubscriptionRecord` 保存账号、租户、计划、周期、到期、取消/退款状态及来源订单。
- `CloudSkillEntitlementRecord` 以精确的 `skill_id + plan_id + subscription_id + user_id + tenant_id`
  表示访问权；旧 `EntitlementRecord.pack_id` 行不会被转换或解释为 Cloud Skill 访问。
- `cloud_skill_plan`、`cloud_skill_plan_skill`、`cloud_skill_subscription`、`cloud_skill_entitlement`
  使用独立 PostgreSQL 表和复合外键/唯一约束。迁移为
  `infrastructure/migrations/020-cloud-skill-billing.sql`；`019-cloud-task-ownership.sql` 保持不变。
- `cloud_skill_execution_reservation` 使用 `infrastructure/migrations/021-cloud-skill-usage.sql`，同时作为
  任务幂等记录和用量账本；`released_at` 只结束并发租约，不删除或冲销已计入的调用/速率用量。
- MemoryStore 与 PgStore 均提供计划目录、订阅幂等（`source_order_id`）、entitlement 发放/撤销、
  user/tenant/Skill/计划过滤、`resolveCloudSkillAccess` 和执行准入/释放接口。
- `023-billing-settlement.sql` 新增 `billing_settlement` 与 `billing_outbox`。支付/退款通过
  `settleOrderPayment` / `settleOrderRefund` 在同一结算边界内提交订单、钱包、履约/撤权和 outbox；
  钱包流水引用 `settlement_id`，订单记录 `refunded_at`，Pack 授权记录 `source_order_id`。
- `Idempotency-Key` 可选但若提供必须是 1–128 个可打印 ASCII 字符；缺省键分别派生为
  `pay:<order_id>` 与 `refund:<order_id>`。相同订单/操作/请求绑定返回 `replayed=true`，同订单的不同键或
  同键的不同绑定返回 `IDEMPOTENCY_CONFLICT`。
- 充值订单在结算端口和 HTTP 层均拒绝余额支付及退款入钱包。Pack 退款只撤本订单的
  `source_order_id` 行；存在来源不明的有效 legacy Pack 行时返回 `REFUND_REQUIRES_RECONCILIATION`，
  不会误撤激活码或其他订单授权。Cloud Skill 退款同事务将 subscription 标记 `refunded` 并撤销其 Skill 行；
  已计入的 `cloud_skill_execution_reservation` 不删除、不冲销。

## HTTP 闭环

- `GET /v1/cloud-skill-plans` 只返回上架计划的公开价格、Skill 列表和限制元数据。
- `POST /v1/orders` 的 `type=cloud_skill_plan` 只接受 `plan_id`，不会填充 `product_id/pack_id`；
  legacy `type=plan` 流程保持原样。
- 订单支付成功后创建 Cloud Skill subscription，并为计划内每个 Skill 创建一条精确 entitlement。
  重放以来源订单和 `(subscription_id, skill_id, plan_id)` 幂等，不重复发放 Pack 授权。
- `/v1/me/cloud-skill-subscriptions`、`/v1/me/cloud-skill-entitlements` 提供账号视图；绑定设备
  只允许同一租户的订阅被解析。
- 取消、退款、过期或暂停会撤销相关 Cloud Skill entitlement；下一次执行解析立即失败，不能靠
  旧 `skill:<skill_id>` Pack 行恢复访问。
- `POST /v1/tasks` 正式只接受 `longhub/cloud-skill-call/v1` envelope，在签发 Executor 凭据前在线解析
  账号/租户/Skill/允许计划 ID。`plan_id` 是顶层候选字段，不是客户端授权；旧 `skillId/planId` 输入只
  用于兼容错误诊断，生产执行会以 `INVALID_TASK` 拒绝。解析出的 `plan_id` 不发送给 Executor；准入成功
  后 Executor 只接收任务、租户、Skill、幂等键、输入摘要和业务 `input`。
- 准入先按 `subscription_id + skill_id + 订阅周期` 检查/计入 `included_calls`，再按
  `subscription_id + tenant_id + user_id + device_id` 检查 UTC 每分钟速率和并发租约。同一设备多个
  Agent 共用速率/并发桶，避免通过 Agent fan-out 绕过限制。
- 相同 `task_id` 且绑定字段与 `input_digest` 一致时返回同一预留；冲突返回 `IDEMPOTENCY_CONFLICT`。
  默认租约五分钟（允许 1 秒至 15 分钟），释放或租约过期只释放并发占用。`QUOTA_EXCEEDED` 映射为
  `CLOUD_SKILL_QUOTA_EXCEEDED`/403；速率、并发拒绝映射为对应 429 并返回 `Retry-After`。
- PgStore 在事务中锁定所属订阅行，跨 Cloud API 副本保持计数/幂等一致；MemoryStore 仅用于单进程开发/测试。

## 自动化证据

```powershell
pnpm --filter longhub-cloud-api typecheck
pnpm exec vitest run test/cloud-skill-billing.test.ts
pnpm exec vitest run test/cloud-skill-usage.test.ts
pnpm exec vitest run test/billing-settlement.test.ts
pnpm exec vitest run test/task-ownership.test.ts test/contract.test.ts test/cloud-task.test.ts
pnpm exec vitest run
```

当前工作树结果：

| 门禁 | 结果 |
|---|---|
| Cloud API TypeScript | 通过 |
| Cloud Skill billing 专项 | 4/4 通过 |
| Cloud Skill usage/admission 专项 | 6/6 通过 |
| Task ownership | 3/3 通过 |
| Cloud task + HTTP contract | 16/16 通过 |
| Billing settlement 专项（MemoryStore + HTTP） | 6/6 通过 |
| PostgreSQL 16 临时实例 settlement smoke | payment/refund 并发重放、Cloud 撤权、Pack 来源隔离通过 |
| Cloud API 全量 | 27 个测试文件通过、PostgreSQL 条件测试在无数据库时跳过；146 项通过、8 项跳过 |
| Executor 协议专项 | 6/6 通过（由 `LH-SKILL-002` 记录） |

专项测试还覆盖：严格 v1 才能触达 Executor、计划/Skill 计划 ID 不匹配、用户/租户不匹配、兼容失败、
Release 撤回、quota/rate/concurrency HTTP 映射与 Retry-After、reservation 存储异常 503、取消/超时释放
并发租约、过期/退款失效、旧 Pack entitlement 不得充当 Cloud Skill entitlement，以及未授权任务在执行点
返回稳定 403。

## 2026-08-17 生产部署证据

公网 `154-9-26-158.sslip.io` 的已安装 release 生产 E2E 已通过真实 PostgreSQL：创建并重复更新 Cloud
Skill 计划、先创建 pending order 再 seed operator subscription/entitlement、执行私有 Skill、验证
binding/adapter 撤销与 reactivation，并读取匿名 billing outbox summary 与 Cloud Skill operational
metrics。账号、设备、计划、订阅和绑定在测试末尾清理；不会把测试行当作生产用户数据。

PostgreSQL 的 PgStore 计划集合 delta 更新、clean-launch Feature Policy 和真实数据库权限探针均通过；
owner/ACL 保留的逻辑备份已恢复到 scratch 数据库，验证了 `schema_migrations`、计划/adapter/subscription/
task/binding 记录和 `longhub_app` 的 DML-only 边界。备份与恢复证据记录在部署 backup 目录。

这组证据不等于支付提供商已接入：真实支付回调、退款、结算 outbox consumer、claim/ack/retry/DLQ、告警
和外部故障注入仍是上线阻断；生产环境继续禁止用 mock 或余额支付冒充真实结算。

## 已关闭的额度边界与剩余工作

本批次已在 Cloud API 执行点完成 `included_calls` 周期计数、UTC 每分钟速率、设备并发租约、任务幂等
预留和撤销/到期的 fail-closed 门禁。PgStore 用订阅行锁和唯一 `task_id` 约束保证多副本原子性；
MemoryStore 提供同一语义用于开发测试。释放或租约过期不会退回调用/速率用量，因此重试不会产生免费执行。

仍未纳入本批次、且生产发布前必须关闭的项目：

1. 面向用户/管理员的用量查询、额度消耗和超额审计报表；
2. `billing_outbox` 的生产消费者、重试告警、死信处置和幂等下游投递；结算事实已经同事务落库，
   但本批次不宣称 worker 已上线；
3. 真实 PostgreSQL 环境的迁移演练、故障注入和跨副本压力证据（本地临时 PostgreSQL 已完成 payment/
   refund 并发 smoke test）；
4. 多边缘 Nginx 节点的共享 HTTP 滥用限流（与 Skill 用量准入分开）。

本批次不限制用户本地 OpenClaw、Provider、Channels、插件、MCP 或第三方 Skill；失效订阅只阻断
LongHub Cloud Skill 新执行。
