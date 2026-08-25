# LH-SKILL-002 Executor 内部边界验收

> 日期：2026-08-09
> 状态：Executor 协议、Cloud Skill 订阅与额度/速率/并发执行点门禁完成；Manager Bridge 与原生目录安装仍进行中

## 覆盖范围

- Cloud API 使用 `lhx1` HMAC 短时凭据，不接受设备/用户 Bearer。
- 凭据绑定 `task_id/tenant_id/skill_id/idempotency_key/input_digest`，默认 60 秒、上限 5 分钟。
- 严格 `longhub/executor-request/v1` 请求体、幂等重放/冲突、请求大小、读取/执行超时和 AbortSignal。
- Cloud API 生产任务只接受严格 `longhub/cloud-skill-call/v1` envelope；旧 camelCase/legacy envelope 仅为
  兼容错误诊断保留，不能创建可执行的生产任务。
- Cloud API 在签发内部凭据前按账号、租户、Skill 和允许 `plan_id` 在线解析 Cloud Skill subscription /
  entitlement；取消、到期、退款、暂停和租户/计划不匹配在执行点返回拒绝。`plan_id` 不进入 Executor 请求体。
- 凭据签发前还必须成功创建 Cloud Skill execution reservation：周期 `included_calls` 按
  `subscription_id + skill_id` 计数，每分钟速率与并发按 `subscription_id + tenant_id + user_id + device_id`
  计数并跨 Agent 共享；`task_id` 重放幂等，释放/租约过期只释放并发、不退款。
- `CLOUD_SKILL_QUOTA_EXCEEDED` 为不可重试 403；`CLOUD_SKILL_RATE_LIMITED` 与
  `CLOUD_SKILL_CONCURRENCY_LIMIT` 为带 `Retry-After` 的 429。PgStore 通过订阅行锁保证横向副本原子性。
- 固定错误码、请求 ID、日志脱敏，不返回 Skill 源码、提示词、内部地址或异常堆栈。
- Cloud API 到 Executor 的请求 deadline 覆盖响应头和响应体读取；响应体通过 Web Stream 有界读取，
  在超过 `executorResponseMaxBytes` 时立即取消上游，不使用 `Response.text()` 先完整缓冲。
- 生产启动缺少 `EXECUTOR_CREDENTIAL_SECRET` 失败关闭，默认监听回环地址。

## 验证命令

```powershell
pnpm --filter longhub-executor typecheck
pnpm --filter longhub-executor test
pnpm --filter longhub-cloud-api typecheck
pnpm --filter longhub-cloud-api test
pnpm exec vitest run test/cloud-skill-usage.test.ts
```

结果：Executor Vitest `6/6`；Cloud API 全套 `133 passed / 8 skipped`（25 个文件通过、PostgreSQL 文件未配置时跳过）；类型检查通过。
Cloud Skill billing 专项 `4/4`、usage/admission 专项 `6/6`、执行级专项 `7/7`，Task ownership `3/3`；安全扫描和真实
PostgreSQL 部署验收不在本次本地证据内。

## 未覆盖项

账号/纯订阅 `skill_id + plan_id` 与用量准入的本批次证据见
[`LH-BILL-001-cloud-skill-billing.md`](./LH-BILL-001-cloud-skill-billing.md)。Manager Bridge、本地适配器
安装事务、真实 PostgreSQL 故障演练、用户用量报表和支付/退款跨实体原子结算仍由后续阶段覆盖；本批次不宣称线上部署。
