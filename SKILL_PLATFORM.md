# LongHub Cloud Skill 平台

当前产品边界：免费 Manager 管理本地 OpenClaw；收费 Cloud Skill 由独立 `longhub-cloud` CLI 和 `@longhub/openclaw-cloud-plugin` 提供。用户本地模型、Provider、Channels、Agent、插件、MCP、第三方 Skill 和工作区不受订阅限制。

## Skill 类型

| 类型 | 安装位置 | 执行位置 | LongHub 处理 |
| --- | --- | --- | --- |
| 用户/第三方本地 Skill | 原生 OpenClaw | 用户本机 | 不收费、不阻断 |
| Cloud Plugin | OpenClaw plugin registry | Cloud API -> Executor | CLI 验签安装；插件直连 `/v1/tasks*` |
| Cloud Executor | 不安装到用户机器 | LongHub 私网 | 保存私有实现、提示词、连接器和计量规则 |

Cloud Plugin 只暴露 `longhub_cloud_skill`，不包含业务实现、内部提示词、模型路由、连接器秘密或长期凭据。它从独立 Windows Credential Manager namespace 读取 device token。

## 直连调用契约

```text
OpenClaw tool
  -> strict longhub/cloud-skill-call/v1
  -> POST /v1/tasks
  -> GET /v1/tasks/{task_id} (poll)
  -> POST /v1/tasks/{task_id}/cancel (cancel/timeout)
```

请求带 `Authorization: Bearer <device_token>`、`Idempotency-Key`、`X-LongHub-Agent-ID` 和 `X-LongHub-OpenClaw-Version`；原始 session key 只在进程内哈希。Cloud API 重新检查设备平台、账号、binding、订阅、release、策略、额度、速率和并发。

Manager `windows` 设备不能访问任务；只有 `openclaw-plugin-windows` 设备可以执行。Cloud API 返回稳定公开错误，插件不接收 Skill 实现或计费判断。

## 发布与安装

Plugin 和 CLI 使用独立的 product surface、schema、release 目录和 Ed25519 key。CLI 固定内置 Plugin 公钥，验证 manifest、文件名、版本、包名、大小、SHA-256、兼容性和 tgz 字节，再用 `npm-pack:<verified-file>` 安装；未知 key、同版本覆盖、未签名包、未经 LongHub 验证的 registry 包全部拒绝。

每个新版本以 paused/0% rollout 发布；撤回保留历史审计和制品 bytes。Portal 只展示已满足 product surface 和 rollout 门禁的 release。

## 数据与隐私

默认不上传本地 OpenClaw 会话、workspace、Provider/API key 或第三方 Skill。Cloud API/Executor 只保存任务所需公开结果、摘要、用量和审计；token 不写入普通文件、环境变量、日志或命令行。

## 发布门禁

Cloud Plugin `0.2.1` 与 Cloud CLI `0.1.2` 已通过生产 Ed25519、Cloud/Portal/Linux deployment、Credential Manager 和真实 Windows/OpenClaw 配对、安装、更新、执行 E2E。CLI logout/revoke 是每次最终发布验收的清理步骤。Manager `0.1.0` candidate 保持 paused，`0.1.1` 在正式 Authenticode 和 Windows 安装门禁完成前也不得激活。
