# Manager 0.1.1 / Cloud Plugin 0.2.1 / Cloud CLI 0.1.2 迁移

## 产品变化

`LongHub Manager 0.1.1` 是免费的本地 OpenClaw 管理器。`@longhub/openclaw-cloud-plugin 0.2.1` 和 `longhub-cloud 0.1.2` 是独立收费发布线；Cloud Skill 订阅只控制 Cloud API 执行，不限制本地 OpenClaw。

## 用户迁移

1. 保留或升级现有 Manager；它仍可管理 Gateway、备份、诊断和自身更新。
2. 从 Portal 下载已签名 `longhub-cloud` CLI，Windows 上运行 `longhub-cloud pair`。
3. 在 Portal 账号页提交 CLI 输出的短时 pairing code。
4. 运行 `longhub-cloud install` 安装已验签的 Cloud Plugin；需要升级时运行 `longhub-cloud update`。
5. 查看状态用 `longhub-cloud status`；退出用 `longhub-cloud logout`。只有服务端撤销成功后本地 token 才会删除。

旧 Manager Bridge/enrollment 路由不再迁移为长期双协议，统一返回 `410 CLOUD_SKILL_MOVED_TO_PLUGIN`。旧 Manager `windows` 设备历史记录、订单和审计保留，但 Cloud API 任务接口拒绝其 bearer，并记录 `cloud_task.execution_denied`。

## 凭据迁移

Cloud Plugin/CLI 使用 `LongHub Cloud Plugin/device/<sha256(cloud_origin)>` Credential Manager namespace。普通 `device.json` 只允许指纹和 device ID，token 不会复制过去。Windows 以外平台明确失败，不使用环境变量或明文文件回退。

## 发布与回滚

Manager `0.1.0` 候选继续 paused；`0.1.1` 代码已完成，但在正式 Authenticode 和 Windows 安装验收前也不得激活。Plugin `0.2.1` 与 CLI `0.1.2` 已使用独立生产 Ed25519 key 签名，并完成 Cloud API、Portal、Windows Credential Manager、CLI install/update 和真实 OpenClaw 执行 E2E，当前生产 rollout 为 active。所有后续版本仍必须先 paused，通过门禁后再 rollout；版本不可覆盖，撤回保留历史 bytes 和审计。

不可覆盖补丁版本用于记录真实客户端兼容修复：CLI `0.1.1` 修复 Windows `openclaw.cmd` 启动，`0.1.2` 对齐 OpenClaw inspect provenance；Plugin `0.2.1` 固定已经验收的 OpenClaw 版本 header。旧 `0.1.0/0.1.1/0.2.0` 发布记录保持 paused，不覆盖原字节。

## 验收清单

- `go test ./...` 和 workspace typecheck/lint/build/test。
- Windows Credential Manager 真实写入、回读、回滚和删除。
- CLI pair/status/logout/install/update，含篡改、未知 key、包名/版本/大小/SHA 拒绝和回滚。
- Plugin 直连 `/v1/tasks*`，验证 bearer、Agent ID、OpenClaw version、幂等、轮询、取消和超时。
- Portal 配对、独立 CLI 下载、OpenClaw runtime inspect 和真实工具执行。
- Manager `windows` bearer 调用 `/v1/tasks*` 必须返回 `403 CLOUD_PLUGIN_DEVICE_REQUIRED`。
- CLI logout 先完成服务端 revoke，再清除 Credential Manager；网络失败必须保留凭据。
- Linux Nginx/systemd/deployment 检查与 `git diff --check`。
