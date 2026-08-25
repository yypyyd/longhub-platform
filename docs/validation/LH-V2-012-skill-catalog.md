# LH-V2-012 官方 Skill Catalog 与签名引用分发验收

> 状态：代码完成  
> 日期：2026-07-31

## 已完成

- Cloud Store 的 Memory/PostgreSQL 实现均保存不可覆盖的 Skill Release、发布方、兼容矩阵、runtime 类型和撤销时间。
- 新增 `017-skill-release.sql`，并用真实 PostgreSQL 16 验证发布、重复版本、严格回读、列表和撤销。
- `GET /v1/catalog/skills` 与详情端点只返回未撤销、Desktop/OpenClaw 兼容的引用。
- `skill.catalog` Feature Policy 缺失时安全失败；禁用、紧急停用、范围和现有授权规则继续逐请求在线复验。
- 引用分发使用 `skill:<skill_id>` entitlement。当前过渡期复用 `entitlement.pack_id` 存逻辑资源 ID，不把它解释为 Agent Pack。
- Skill 使用独立 Ed25519 密钥；启动时验证公私钥匹配，并拒绝与 Agent Pack/客户端更新 key ID 或实际公钥复用。
- 管理发布覆盖上传者提供的 integrity，按严格 Package 重算摘要和签名；同 ID/version 永不覆盖，跨发布方接管拒绝。
- 撤销后指定版本引用立即返回 410；发布/撤销写入审计。引用响应不包含 URL、脚本、插件或本地代码制品。
- OpenAPI 增加目录、详情、签名公钥、引用、管理发布/撤销路径及严格 Skill Package/响应 Schema。

## 自动化证据

- `@longhub/pack-schema`：4 文件 26 项通过，含独立签名摘要覆盖测试。
- Cloud 专项：Skill Catalog、OpenAPI 契约与 HTTP 路由指标 3 文件 15 项通过。
- Cloud 回归：20 文件 107 项通过；PostgreSQL 条件测试在普通内存回归中按设计跳过。
- 真实 `postgres:16-alpine`：`pg-store.test.ts` 8 项全部通过，包含 `skill_release` 合同。
- OpenAPI 由 PyYAML 成功解析：51 paths、43 schemas。

## 边界

目录可见和引用 entitlement 都不授予执行权限。Desktop 仍须在 013/014 中复验签名、Registry owner、
Agent binding、Core 权限和 Worker/CloudRef allowlist，并以补偿事务修改 Gateway/Core/Registry。生产
Skill 私钥必须由 KMS 下发；本地自动生成密钥只允许开发和测试。
