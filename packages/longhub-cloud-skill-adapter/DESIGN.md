# Cloud Skill Adapter 设计说明

## 职责

为原生 OpenClaw 中的 LongHub Skill 提供最小、可验签的本地描述和 Bridge 边界。它是声明制品，不是执行
实现；Manager/Cloud API 负责账号、订阅、租户、Agent、额度、幂等和短时凭据。当前包已完成 manifest
Schema/摘要/签名能力，但面向新 Manager 的通用 OpenClaw Tool Plugin、执行专用本地凭据和原生目录安装
事务仍由 `LH-SKILL-001A`/`LH-SKILL-001` 实现，不得以冻结 Desktop Bridge 的旧 Core RPC 代码替代。

## 关键决策

### 2026-08-09 - 严格公开 manifest

**变更内容**：固定 `longhub/cloud-skill-adapter/v1` 的十个顶层字段，所有对象严格拒绝未知字段；schema
引用只能是安全相对 JSON 路径。

**变更理由**：签名对象如果允许任意 URL、脚本或隐藏字段，客户端会变成可复制实现或任意代码入口。

**影响范围**：Catalog 分发、Manager 安装事务、原生 OpenClaw Skill 目录和后续 Bridge 实现。

### 2026-08-09 - 云端实现不下发

**变更内容**：摘要/签名只覆盖公开元数据；私有提示词、业务规则、凭据和内部路由不得进入 manifest 或
客户端返回值。

**变更理由**：LongHub 的商业资产是云端 Skill，而不是免费管家本身。

## 已知限制

该包不执行 Skill，也不负责网络认证和订阅结算；这些职责必须留在 Manager Bridge/Cloud API/Executor。
本机用户可以读取或修改声明制品；验签失败、未知版本或服务端撤销时不得安装/启用，且修改不能获得云端
实现、凭据或额外权限。
