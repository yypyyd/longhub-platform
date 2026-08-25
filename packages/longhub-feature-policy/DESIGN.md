# Feature Policy V2 设计

## 设计目标

- 为普通用户功能提供端云共用、严格且确定性的策略契约。
- 保证任何下层策略只能维持或收紧上层约束，不能放宽。
- clean launch 只接受 Manager 版本字段，旧 Desktop 字段必须严格拒绝。
- 让紧急关闭、授权缺失、版本不匹配和策略缺失都安全失败。

## 非目标

- 不在本包内存储策略或认证管理员。
- 不以 UI 隐藏代替 Cloud 最终执行复验。
- 不授予 entitlement 或 permission。
- 不处理第三方动态代码、脚本、MCP 或插件。

## 方案

    Admin / Store
          |
          v
    严格 Feature Policy 文档
          |
          +---- Cloud 执行点：解析 -> 按可信请求上下文合并 -> 复验授权
          |
          +---- Manager：解析 -> 按可信本机上下文合并 -> 控制产品入口

schema.ts 负责边界校验与规范化；resolution.ts 负责作用域筛选、合并、SemVer 和稳定访问判定。Cloud 与
Manager 均引用同一包，避免 JavaScript/SQL/UI 各自解释策略。

## 关键决策

### 独立端点与严格字段

Feature Policy 使用独立的 /v1/client/feature-policy 端点。顶层、entry、limits 和 data_policy 均拒绝
未知字段；feature_id 为封闭枚举。新增功能需要同时升级 Schema、OpenAPI、Admin 与客户端。

### scope_id 绑定目标

global 策略禁止 scope_id；tenant、plan、device 和 agent 策略必须提供 scope_id。没有目标 ID 的 agent
策略无法证明属于哪个 Agent，会导致跨 Agent 放宽，因此在解析阶段拒绝。

### 合并只能收紧

| 维度 | 规则 |
|---|---|
| enabled | 任一 false 即 false |
| emergency_disabled | 任一 true 即 true，并强制 enabled 为 false |
| mode | default < tenant_controlled < admin_approved，取最高 |
| risk_level | 任一 high 即 high |
| limits | 每个存在的维度取最小值 |
| processing_location | platform_region < tenant_region < device_local，取更本地 |
| retention_days | 取最小值 |
| export/deletion allowed | 任一 false 即 false |
| required_entitlements / required_permissions | 取并集，调用方必须逐项满足 |

required 字段表示每层新增的必要条件，因此必须取并集。若未来加入 allowed 集合，allowed 才能取交集；
把 required 取交集会让不同层的要求互相消失，是授权绕过。

### 缺失与过期不授权

无适用策略返回 undefined，访问判定为 POLICY_NOT_FOUND。文档尚未生效或已过期时直接抛出
FEATURE_POLICY_UNAVAILABLE，调用方不得回退到默认开启。Manager 后续只可对低风险 UI 使用未过期缓存；
Cloud 受保护执行必须在线复验。

## 信任边界与威胁模型

### 不可信输入

- Cloud/Admin 持久化内容、HTTP 响应和缓存文件。
- audience、scope_id、Agent ID、entitlement 和 permission 的调用方自报值。
- 未知 feature、超大 JSON、重复记录、过长 TTL 和宽松时间格式。

### 可信输入

- Cloud 认证中间件确定的设备、租户、套餐和管理员 audience。
- Manager Registry 与 Tool Bridge 运行上下文确定的 Agent。
- Core 计算出的有效 entitlement 和 permission 集合。

### 防护

- Schema 精确字段、封闭枚举、规范 ISO 时间、受限 ID/SemVer 和 64 KiB 响应上限。
- 非全局 scope_id 强制绑定；重复目标策略拒绝，避免数组顺序影响结果。
- deny-wins、最小上限、必要条件并集、紧急关闭优先。
- 稳定拒绝码不包含 Token、用户内容、本机路径或策略原文。

## 已知限制

- 该包只定义合并语义；Store 的并发控制、审计和数据库约束在 LH-V2-002 实现。
- Manager 的 30 秒刷新、缓存和紧急失效由客户端集成层实现。
- processing_location 使用“越本地越收紧”的固定顺序；若功能无法在最终位置执行，调用方必须关闭功能，
  不得静默改回云端。
- 当前响应上限依赖 parseFeaturePolicyJson；直接调用对象解析的可信内部代码应确保上游已有请求体上限。

## 变更历史

### 2026-08-11 - clean launch 迁移到 Manager 版本契约

**变更内容**：将策略条目的 `min_desktop_version`、`max_desktop_version` 和解析上下文的
`desktop_version` 分别替换为 `min_manager_version`、`max_manager_version`、`manager_version`。

**变更理由**：当前正式客户端是 LongHub Manager，且产品尚未上线，不需要维护旧 Desktop 设备兼容面。

**影响范围**：严格 Schema、策略解析上下文、版本筛选、测试和调用示例。

**决策依据**：旧字段不提供别名，输入中出现旧字段会被精确键校验拒绝，避免长期存在双契约。

### 2026-07-30 - 冻结 Feature Policy V2 核心契约

**变更内容**：完成严格 Schema、目标作用域、确定性合并、SemVer、访问判定及边界测试。

**变更理由**：Skill、文件、知识和工作流需要同一安全底座，且旧 runtime-config v1 不能原地扩展。

**影响范围**：后续 Cloud Store/Admin/OpenAPI、Manager 策略刷新和所有受保护业务入口。

**决策依据**：下层策略不得放宽上层约束；必要授权条件必须累加；缺失或过期策略必须安全失败。
