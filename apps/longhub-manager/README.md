# LongHub Manager 0.1.1

LongHub Manager 是免费的 Windows 本地 OpenClaw 管理器。它只管理用户自己机器上的 OpenClaw、Gateway、备份恢复、诊断和 Manager 自身更新；本地 OpenClaw 的模型、Provider、Channels、Agent、插件、MCP、工作区和第三方 Skill 不因 LongHub 账号或 Cloud Skill 订阅而受限。

## 不包含的能力

Manager 安装包不包含 Cloud Skill、Cloud Plugin `tgz`、插件 artifact、Bridge、enrollment、执行凭据或 Cloud pairing 代码。Cloud Skill 是独立收费产品，由独立的 `@longhub/openclaw-cloud-plugin` 和 `longhub-cloud` CLI 提供。

历史 `/api/v1/cloud/pairing*` 与 `/api/v1/cloud-skill/*` 路由只返回 HTTP `410` 和 `CLOUD_SKILL_MOVED_TO_PLUGIN`。这些请求不读取凭据、不执行旧协议、不改变本地状态。

## 本地职责

- 发现、安装、启动、停止和重启系统原生 OpenClaw。
- 检查 Gateway、计划任务和本地运行时健康状态。
- 创建和恢复本地备份，导出诊断信息。
- 从只允许 `product_surface=longhub-manager` 的 release manifest 更新 Manager。

## 构建与测试

```powershell
go test ./...
go build ./cmd/longhub-manager
```

安装脚本不会创建或暂存 `artifacts` 目录，也不会读取 `NativePluginArtifactDirectory` 或 `INCLUDE_NATIVE_PLUGIN_ARTIFACT`。正式开放前仍须完成 Authenticode 签名、Windows VM 安装/E2E 和发布门禁；当前 Manager `0.1.0` 候选保持 `paused`。

## 目录

```text
cmd/longhub-manager/   本地 Manager 入口
internal/httpapi/      本地 HTTP API 与 410 迁移响应
internal/openclaw/     OpenClaw 生命周期、Gateway 和备份能力
installer/             仅 Manager 的 Windows 安装 staging
scripts/               Manager 构建与发布辅助脚本
```
