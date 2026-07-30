# 2026-07-30 服务端更新验收

目标：`154-9-26-158.sslip.io`（`154.9.26.158`）

## 上线范围

- 更新 Cloud API、Executor、Portal 和 Admin Web。
- PostgreSQL 容器与持久化卷原位保留；启动时补齐模型运营、遥测、知识库和 Pack 审核表。
- 新增独立 `KNOWLEDGE_DATA_KEY` 与持久化 Client Update Ed25519 签名密钥；原模型、管理员和数据库凭据保留。
- Desktop 已发布激活热修复 `LongHub-Setup-0.4.1.exe` 内部候选；历史安装包全部删除，下载目录仅保留最新版与签名索引。

## 验收结果

- Portal、Admin HTTPS：200。
- 未授权 runtime-config：401。
- Admin metrics/model-config/knowledge/pack-reviews/devices：200。
- 后台模型配置已启用且加密就绪，上游连接测试：200 / `ok=true`。
- 旧 PostgreSQL 原位升级已补齐模型作用域、运行策略和额度列；设备 runtime-config 返回真实配置版本，
  `/v1/model/models` 与真实 Chat Completions 均为 200，实测回复 `MODEL_OK`。
- Cloud API、Executor 重启次数：0；PostgreSQL healthy。
- `knowledge_document_content_encrypted` 约束已验证；16 台设备和 2 条 entitlement 保留。
- Admin 新增“租户知识库”和“第三方审核”页面资源已上线。
- 最新安装包公网下载：200；大小 `160539761` 字节；SHA-256
  `5b4a737c10e4d9eb6ae723290e40e5b7d58f4488390f88f8925c5d49450261ad`。
- Client Update 索引仅 1 条 `0.4.1` 记录，并由 `longhub-update-2026-07-30` 签名；安装器自身为内部未签名候选。
- 修复 sandbox 激活 preload 被作为 ESM `.js` 打包后无法加载、提交按钮永久停在“正在激活”的问题；生产产物改为 CommonJS `.cjs`，页面增加 IPC 缺失与 20 秒超时恢复。

## 部署处置

- Docker Hub 元数据访问超时时，改用已运行 LongHub 镜像作为离线构建基底；最终构建上下文 1.5 MB。
- 首次 PEM 写入被 Compose 折叠，健康检查在清理备份前发现；使用结构化 YAML 多行值修复后 Cloud 稳定启动。
- 上线验证通过后，数据库/配置临时备份、旧 Web 目录、未完成上传和回滚镜像标签均已删除。
- 修复安装包发布时继承 `0640` 导致 nginx 返回 403 的问题：公开链接建立前固定为 `0644`；回归测试 7/7、类型检查通过，修复镜像已上线。
- 0.4.1 激活相关类型检查、单元、Cloud 请求、真实 Electron 窗口和发布门禁共 17/17 通过；ASAR 明确拒绝残留旧 preload。
- 修复旧模型配置保存的 `features` 空值、`CREATE TABLE IF NOT EXISTS` 不升级旧表，以及 PostgreSQL
  `BIGINT` 回读为字符串三项兼容问题；默认策略已成功保存为全局、设备并发 100。
- 本次生成的是服务器本地持久化密钥，不替代正式生产 KMS，因此 1.0 KMS 外部门槛保持未完成。
