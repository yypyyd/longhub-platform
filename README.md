# LongHub Platform

当前独立产品线是免费 `LongHub Manager 0.1.1`、收费 `@longhub/openclaw-cloud-plugin 0.2.1`、独立 `longhub-cloud CLI 0.1.2` 和 Cloud API。Cloud API、Portal、Admin、Plugin 与 CLI 已完成生产部署和真实 Windows/OpenClaw E2E；Manager 代码已完成，但正式 Authenticode 与安装包激活仍保持暂停。

## 产品边界

- Manager 只管理本地 OpenClaw、Gateway、备份恢复、诊断和自身更新。
- Cloud Plugin 直接调用 Cloud API `/v1/tasks*`，不经过 Manager Bridge。
- Cloud CLI 负责 Windows 配对、Credential Manager、插件签名验签和 OpenClaw 安装/更新。
- 订阅只控制 Cloud API 执行；用户本地模型、Provider、Channels、Agent、插件、MCP、第三方 Skill、工作区和会话不受限。

```text
LongHub Manager (free, local)
  └─ native OpenClaw / Gateway / backup / diagnostics / manager update

longhub-cloud CLI + Cloud Plugin (paid, independent)
  └─ Credential Manager -> Cloud API -> subscription/binding/quota -> Executor
```

Manager 安装包不包含 Cloud Skill、插件 `tgz`、Bridge、enrollment、execution credential 或 artifact staging。旧 Manager Cloud 入口返回 `410 CLOUD_SKILL_MOVED_TO_PLUGIN`。

## 开发检查

```powershell
go test ./apps/longhub-manager/...
pnpm typecheck
pnpm lint
pnpm build
pnpm test
git diff --check
```

Cloud Plugin/CLI 的 `artifact:pack` 只生成 unsigned、可复现 candidate，生产签名只能由服务端独立 Ed25519 私钥完成。生产签名 manifest、Linux deployment、Portal 配对、Windows Credential Manager、CLI 安装/更新和真实 OpenClaw 执行 E2E 已通过；Manager 在获得受信任 Authenticode 证书并通过 Windows 安装门禁前不得激活。

## 文档

- [Manager](apps/longhub-manager/README.md)
- [Cloud Plugin](packages/longhub-openclaw-cloud-plugin/README.md)
- [Cloud CLI](packages/longhub-cloud-cli/README.md)
- [Cloud API](apps/longhub-cloud-api/README.md)
- [Portal](apps/longhub-portal/README.md)
- [Admin](apps/longhub-admin-web/README.md)
- [迁移说明](docs/operations/LONGHUB-MANAGER-CLOUD-MIGRATION.md)
- [发布说明](docs/operations/LONGHUB-CLOUD-RELEASE-2026-08.md)
