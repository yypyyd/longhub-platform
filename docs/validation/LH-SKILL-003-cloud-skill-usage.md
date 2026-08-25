# LH-SKILL-003 Cloud Skill 用量与执行准入验收

> 日期：2026-08-09  
> 状态：Memory/Pg 用量准入代码与契约测试完成；真实 PostgreSQL 部署/压力证据尚未完成

## 目标与边界

本验收只覆盖 Cloud Skill 纯订阅模式下的执行准入。它不实现按次收费，也不限制用户本地原生
OpenClaw、Provider、Channels、插件、MCP、第三方 Skill 或工作区。

一次新任务在 Cloud API 签发 Executor 凭据前，必须完成以下顺序：

1. 按 `user_id + tenant_id + skill_id + plan_id` 解析有效订阅和 entitlement；
2. 以 `task_id` 幂等创建 execution reservation；
3. 通过 reservation 同时计入周期调用和当前分钟用量，并取得短时并发租约；
4. 准入成功后才向私网 Executor 发送不含 `plan_id` 的请求。

## 计量语义

| 限制 | 计数键 | 规则 |
|---|---|---|
| `included_calls` | `subscription_id + skill_id + subscription period` | reservation 创建即消耗；释放、失败、取消和租约过期都不退款 |
| `requests_per_minute` | `subscription_id + tenant_id + user_id + device_id + UTC minute` | 同一设备的所有 Agent 共用固定分钟桶 |
| `max_concurrency` | `subscription_id + tenant_id + user_id + device_id` | 只统计未释放且未过期的 reservation；释放或过期后可重新取得 |

相同 `task_id` 且 owner、Skill、计划、订阅断言和 `input_digest` 全部一致时返回原 reservation；任一
绑定不一致返回 `IDEMPOTENCY_CONFLICT`。默认租约为 5 分钟，允许 1 秒至 15 分钟。周期与速率拒绝不
创建新 reservation；并发拒绝返回下一个租约到期的受限 `retry_after_seconds`。

## Store 与数据库

- `MemoryStore` 在单个 JavaScript turn 内完成检查和写入，作为开发/测试确定性实现。
- `PgStore` 使用 `infrastructure/migrations/021-cloud-skill-usage.sql` 的
  `cloud_skill_execution_reservation` 表、`task_id` 唯一约束和事务内订阅行锁，保证横向 Cloud API
  副本不会重复占用周期额度或并发。
- reservation 行同时是幂等索引和耐久用量账本；`released_at` 只释放并发，不删除历史计量。
- 存储异常返回 `STORAGE_UNAVAILABLE`，执行点 fail-closed，不降级为无订阅或仅 Pack entitlement。

## HTTP 错误映射

| Store reason | HTTP | 公共 code | 重试 |
|---|---:|---|---|
| `QUOTA_EXCEEDED` | 403 | `CLOUD_SKILL_QUOTA_EXCEEDED` | 否 |
| `RATE_LIMITED` | 429 | `CLOUD_SKILL_RATE_LIMITED` | 是；`Retry-After` |
| `CONCURRENCY_LIMIT` | 429 | `CLOUD_SKILL_CONCURRENCY_LIMIT` | 是；`Retry-After` |
| `SUBSCRIPTION_INACTIVE` / `SKILL_NOT_ENTITLED` | 403 | `CLOUD_SKILL_SUBSCRIPTION_REQUIRED` | 否 |
| `PLAN_MISMATCH` | 403 | `CLOUD_SKILL_PLAN_MISMATCH` | 否 |
| `IDEMPOTENCY_CONFLICT` | 409 | `IDEMPOTENCY_CONFLICT` | 否 |
| `STORAGE_UNAVAILABLE` | 503 | `CLOUD_SKILL_USAGE_UNAVAILABLE` | 是 |

取消、退款、暂停、到期和租户/计划不匹配会在下一次 reservation 前阻断；已在途任务由执行器边界
和取消流程收口，不会把释放动作误当作额度退款。

## 验证命令与结果

```powershell
pnpm --filter longhub-cloud-api typecheck
pnpm exec vitest run test/cloud-skill-usage.test.ts
pnpm exec vitest run test/cloud-skill-billing.test.ts test/task-ownership.test.ts test/contract.test.ts test/cloud-task.test.ts
```

当前本地结果：Cloud API 类型检查通过；usage/admission `6/6`；billing `4/4`；task ownership `3/3`；
Cloud task + HTTP contract `16/16`。完整 Cloud API 回归为 `122 passed / 8 skipped`，跳过项均为未配置
PostgreSQL 的集成测试。

## 尚未覆盖

- 真实 PostgreSQL 多副本压力、锁等待、故障恢复和 migration 回滚演练；
- 用户/管理员用量查询、额度消耗报表和超额审计专用 API；
- 按次计费与退款结算状态机；
- 多边缘入口之间共享的 HTTP 滥用限流（与 Cloud Skill 用量 reservation 分开）。
