# LH-V2-002 Cloud Feature Policy 验收

> 状态：代码完成  
> 日期：2026-07-30  
> 部署状态：未部署

## 已完成

- CloudStore 新增 Feature Policy list/upsert，Memory 与 PgStore 均保持稳定 policy_id 和递增 revision。
- PostgreSQL 015 迁移、目标唯一约束、作用域检查、revision sequence 和并发容量锁。
- Admin GET/POST 严格请求体、RBAC、64 KiB/64 条上限及最小审计详情。
- GET /v1/client/feature-policy 按设备、租户、有效套餐和受众过滤，保留 Agent 目标。
- runtime-config v1 未增删字段；Feature Policy 使用独立响应与 30 秒 ETag 窗口。
- Agent Catalog 与知识查询在策略存在时逐请求复验；禁用、紧急关闭、缺 entitlement/permission 均拒绝。
- 修复 PgStore 全新初始化时在 entitlement 建表前先 ALTER 的既有顺序错误。

## 本地证据

| 门禁 | 结果 |
|---|---|
| @longhub/feature-policy | 13 项通过；typecheck/build 通过 |
| longhub-cloud-api typecheck/build | 通过 |
| longhub-cloud-api 全量测试 | 19 文件、103 项通过；无数据库 URL 时 7 项条件跳过 |
| PostgreSQL 16 合同 | Docker `postgres:16-alpine`，1 文件、7 项全部通过 |
| OpenAPI YAML 解析 | 43 条路径、34 个 Schema |
| Feature Policy HTTP 专项 | 11 项通过 |

## 直接绕过证据

- agent.catalog=false 时直接 GET /v1/catalog/packs 返回 FEATURE_DISABLED。
- emergency_disabled=true 时返回可重试 FEATURE_EMERGENCY_DISABLED。
- 缺必要 Pack entitlement 时返回 FEATURE_ACCESS_DENIED；授予后下一次请求立即通过。
- 查询参数和伪造 x-longhub-permissions 不进入可信 permission 集合。
- 未激活设备不能取得 Feature Policy。

## 未关闭

当前记录闭环本地代码与 PostgreSQL 16 合同，不构成已部署证据；部署后仍需按候选/生产门禁保存迁移与
回滚结果。
