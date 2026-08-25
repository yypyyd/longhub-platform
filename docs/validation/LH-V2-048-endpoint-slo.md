# LH-V2-048 端点级 SLO 量测载体验收

> 状态：代码完成  
> 日期：2026-07-30  
> 部署状态：未部署

## 已完成

- 所有 `/v1/*` 请求进入匿名 `cloud_api` 小时聚合；Feature Policy、runtime-config、Skill Catalog、
  下载、版本检查和 health probe 另有固定 route ID。
- 延迟桶精确覆盖 300 ms、800 ms、3 s、5 s 判据；管理看板返回每路由请求数、5xx 数/率、直方图、
  P95 桶与上界。`gte_5s` 溢出不能伪装为精确达标值。
- `GET /v1/admin/metrics` 返回与 V2 7.1 对齐的 SLO reading 和 pass/fail/no_data；无样本为 null。
- `GET /v1/health` 无认证且只返回 `status=ok`，不泄漏版本、主机、数据库或依赖详情。
- 紧急策略从 Admin 写入到受保护 API 第一次真实 503 拒绝按 `(policy_id, revision)` 去重记录；没有
  请求就保持 no_data，不记录触发设备/租户。
- Memory 与 PostgreSQL 共用 Store 契约；migration 016 增加小时直方图和紧急观察表。
- OpenAPI 严格声明 health、Admin metrics、固定桶、nullable 和 no_data 语义。

## 自动化证据

| 门禁 | 结果 |
|---|---|
| Cloud typecheck | 通过 |
| HTTP route classifier/桶边界 | 2 项通过 |
| Admin SLO/P95/no-data | 3 项通过 |
| Feature Policy 真实 HTTP/首次拒绝去重 | 12 项通过 |
| Cloud 全量 | 19 文件、103 项通过；PostgreSQL 7 项因本机无实例跳过 |
| OpenAPI YAML 解析 | 通过 |

## 月可用率口径

- 来源：至少两个独立外部区域，每 60 秒经公网 TLS 请求 `/v1/health`。
- 窗口：UTC 自然月；成功探测数 / 计划探测数，区域同时失败仍分别计入，不用业务流量替代。
- 失败：DNS/TLS/连接错误、超时、非 2xx 或响应 Schema 错误。
- 计划维护：计入不可用，防止通过维护窗口美化 SLO。
- 外部探测尚未部署或样本缺失：看板固定 `null/no_data`，不得填 0 或 100%。

## 仍需后续验证

本机没有 PostgreSQL 16，新增 Pg 聚合、ON CONFLICT 累加和 revision 去重随 LH-V2-002 的 7 项 Pg
集成门禁一起待真实环境执行。外部探测和生产看板读数要在部署/046 灰度观察期形成，不影响本项代码完成。
