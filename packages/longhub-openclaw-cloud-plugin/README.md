# `@longhub/openclaw-cloud-plugin` 0.2.1

这是独立发布的 OpenClaw Cloud Skill 插件。它把 `longhub_cloud_skill` 工具直接连接到 LongHub Cloud API，不依赖 LongHub Manager，也不使用 Manager Bridge、loopback enrollment 或执行 token 环境变量。

## 运行方式

插件从 Windows Credential Manager 读取 `device_id/device_token`，Cloud API origin 只来自非敏感配置，默认值为生产 origin；测试可以通过 `CloudSkillClientOptions.baseUrl` 注入回环地址。插件直接调用：

- `POST /v1/tasks`
- `GET /v1/tasks/{task_id}`
- `POST /v1/tasks/{task_id}/cancel`

请求使用严格 `longhub/cloud-skill-call/v1` JSON，包含 `session_key_hash` 而不是原始 session key，并发送设备 Bearer、`Idempotency-Key`、`X-LongHub-Agent-ID` 和 `X-LongHub-OpenClaw-Version`。创建后轮询到终态；取消或超时会尝试调用 cancel endpoint。

Cloud API 是订阅、entitlement、Agent-Skill binding、release、额度、速率、并发和 Executor 授权的唯一最终来源。插件只返回公开结果和稳定错误码，不保存 Skill 实现、云端凭据或计费判断。

## 安装

插件必须使用 LongHub 验证过的签名 `tgz`，由独立 CLI 执行下载、验签和 `openclaw plugins install npm-pack:<verified-file>`。未经 LongHub manifest 验证的 npm registry 包不得安装。

```powershell
longhub-cloud pair
longhub-cloud install
```

## 构建与验证

```powershell
pnpm typecheck
pnpm test
pnpm artifact:pack
```

`artifact:pack` 会运行两次 `pnpm pack`，要求字节、大小和 SHA-256 完全一致，并输出 `release/<surface>/<version>/release-candidate.json`。候选包未签名，签名和初始暂停状态由 Cloud API 发布面生成。`0.2.1` 已由生产 Plugin key 签名并通过真实 Windows/OpenClaw 直连执行；本地构建仍不得冒充生产签名包。

## 目录

```text
src/client.ts                 Cloud API task client、轮询、取消和脱敏错误
src/protocol.ts               严格 cloud-skill-call/v1 wire 与上下文校验
src/tool-factory.ts           OpenClaw tool factory
scripts/build-artifact.mjs    独立 cloud-plugin 可复现 tgz 构建入口
openclaw.plugin.json          插件 ID、工具和兼容性声明
```
