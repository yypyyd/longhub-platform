# Feature Policy V2

> 当前 clean-launch 仅用于 LongHub Manager 自有页面与 Cloud Skill 目录/任务；不限制用户原生 OpenClaw。
> 项目尚未上线，不为旧客户端、旧设备或历史数据提供迁移/兼容入口。

## 标识与传输

- Schema：longhub/feature-policy/v2
- 客户端端点：GET /v1/client/feature-policy
- 最大响应：64 KiB UTF-8
- 最大有效期：5 分钟
- Manager 最长刷新间隔：30 秒
- 历史 runtime-config v1 不属于 clean-launch 当前入口，不提供字段兼容承诺

## 文档

| 字段 | 类型 | 约束 |
|---|---|---|
| schema_version | string | 固定 longhub/feature-policy/v2 |
| policy_version | string | 1—128 字节受限 ID |
| issued_at / expires_at | string | 规范 ISO 瞬时；expires_at 必须更晚且间隔不超过 5 分钟 |
| features | array | 最多 64 条严格 FeaturePolicyEntry |

每条 FeaturePolicyEntry 使用 `min_manager_version` / `max_manager_version` 约束 Manager 版本；不接受
任何旧字段或兼容别名。

FeaturePolicyEntry 包含 feature_id、enabled、scope、可选 scope_id、audience、mode、risk_level、limits、
data_policy、required_entitlements、required_permissions、Manager 版本范围和 emergency_disabled。

Skill 相关入口分为 `skill.catalog`（目录/详情/引用）和 `skill.execute`（每次云端执行）。
Cloud API 对 `skill.execute` 在创建任务时在线复验；策略缺失时由独立的订阅/entitlement 门禁决定，
显式关闭或紧急停用仍会阻断执行。

global 禁止 scope_id；tenant、plan、device 和 agent 必须提供 scope_id。未知字段、未知 feature、重复的
feature/audience/scope/target、非法版本或非法授权标识符均拒绝。

## 合并

只合并与 Cloud/Registry 确定的 audience、scope_id 和 Manager 版本匹配的记录：

- enabled 与 data_policy 布尔允许项采用 deny-wins。
- emergency_disabled 任一为 true 即立即关闭。
- mode 与 risk_level 取最高风险。
- limits 与 retention_days 逐项取最小。
- processing_location 取更本地的位置。
- required_entitlements 和 required_permissions 取并集，调用方必须满足每一项。

required 表示必要条件，不是允许集合，禁止取交集。未来若新增 allowed 集合，allowed 才取交集。

## 失败语义

无匹配策略、策略未生效、过期、未知或损坏时不得授权。访问判定稳定返回 POLICY_NOT_FOUND、
FEATURE_DISABLED、EMERGENCY_DISABLED、MISSING_ENTITLEMENT 或 MISSING_PERMISSION；错误不得包含
Token、用户内容、本机路径或策略原文。

## 信任边界

HTTP/Admin/缓存内容不可信，必须严格解析。scope、audience、Agent 和授权集合只能来自设备认证、
Agent Registry、Tool Bridge 可信运行上下文与 Core 计算结果，不能接受模型或页面自报值。UI 可见性
不是授权；Cloud 在每次受保护业务调用时使用同一算法在线复验。
