# LongHub Manager 设计

## 目标与非目标

目标是提供一个免费的、可移植的 Windows 本地 OpenClaw 管理入口。非目标是执行 Cloud Skill、保存 Cloud token、安装第三方插件，或用订阅状态限制本地 OpenClaw。

## 架构

```text
Windows UI/CLI
      |
      v
Manager HTTP API  ---->  OpenClaw discovery / Gateway / backup / diagnostics
      |
      +---->  Manager release manifest (product_surface=longhub-manager)
```

Cloud API、Cloud Plugin 和 Cloud CLI 不在 Manager 进程依赖图中。这样 Manager 的免费更新、离线本地管理和 Cloud Skill 的收费发布可以分别回滚。

## 路由边界

本地路由只处理 OpenClaw 生命周期、Gateway、备份、诊断和 Manager 更新。所有遗留 `/api/v1/cloud*`、`/api/v1/cloud-skill*` 路由通过统一 handler 返回：

```json
{"code":"CLOUD_SKILL_MOVED_TO_PLUGIN"}
```

响应状态为 `410`，且在鉴权、读取本地凭据或执行任何旧协议前返回。旧设备/订单的历史记录由 Cloud 服务保留，不由 Manager 删除。

## 安全决策

- Manager 不拥有 Cloud 执行 bearer，不写 Cloud pairing 或 enrollment 文件。
- 更新只接受 `longhub-manager` 产品面，文件名、大小、SHA-256 与签名 manifest 必须绑定同一文件。
- 安装 staging 只复制 Manager 文件，构建中不存在 native plugin artifact staging。
- 本地备份和诊断只处理用户明确选择的本地数据，日志不得包含 Cloud token 或旧协议正文。

## 迁移

旧 Manager 仍可启动并管理本地 OpenClaw；用户需要 Cloud Skill 时安装独立 CLI，运行 `longhub-cloud pair`，再让 CLI 安装独立插件。旧 Cloud 路由不保留长期双协议。

## 已知限制

Manager `0.1.1` 的正式 Authenticode 证书和 Windows 安装/E2E 尚未完成，因此不能宣称它是生产签名安装包。Cloud Plugin/CLI 已完成的 Ed25519、Portal 和 OpenClaw E2E 属于独立产品面，不能替代 Manager 门禁。

## 变更历史

### 2026-08-17 - Manager/Cloud 拆分

Manager 升级为 `0.1.1`，移除 Cloud pairing、execution credential、Bridge、enrollment 和插件 artifact，旧 Cloud 入口统一迁移错误。Manager release 固定 `product_surface=longhub-manager`，生产 `0.1.0` 候选继续暂停。
