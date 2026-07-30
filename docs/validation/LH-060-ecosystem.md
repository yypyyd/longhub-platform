# LH-060 知识与能力生态验收记录

日期：2026-07-30

- Agent Catalog 支持关键词、能力分类、版本列表和 Desktop 兼容过滤；下载仍逐请求校验设备 entitlement。
- 企业知识文档按租户存储，正文使用独立数据密钥 AES-256-GCM 加密并绑定租户 AAD；管理列表不回传正文，
  设备查询只检索自身租户并返回标题、来源与引用片段，测试直接断言 Store 中不存在原文；migration 014
  会拒绝不带 `longhub-kb-v1:` 信封的数据库记录。
- Capability 可声明 `dependsOn`；联合 Pack 校验拒绝缺失依赖、重复能力与循环依赖。
- 第三方 Pack 先经过 Manifest/Profile 联合校验和固定危险模式扫描，只有无发现的 submitted 记录可由
  ops/super 审批、云端重新计算摘要、签名并发布；发布与撤回均审计且版本不可覆盖。HTTP E2E 已覆盖
  submit → approve → publish → 重复批准拒绝，管理后台提供元数据列表、提交和批准入口；被扫描拒绝的
  Pack 只保留 Manifest 元数据和固定 findings，危险文件正文不会进入审核表或备份。
- 会话云同步完成边界评估，1.0 默认不启用，详见 `docs/design/session-cloud-sync-policy.md`。
- 套餐/授权沿用现有 Product/Order/Entitlement，模型日月用量、估算标记和成本已进入管理报表。

知识库当前是确定性文本检索基线，不是向量数据库；独立企业数据密钥已进入代码门禁，生产仍需 KMS、
索引服务、恶意文件解析沙箱和删除/备份保留证明。第三方扫描是准入门槛之一，不替代人工审查和隔离运行。
