# Cloud API 设计

## 边界

```text
Portal/Admin/Cloud CLI/Cloud Plugin
              |
              v
          Cloud API
     / account / device / release
              |
       task admission + billing
              |
              v
          Executor (private)
```

Manager 是独立免费产品，不在该执行数据流中。Cloud API 不向 Manager 或 Plugin 下发 Skill 实现、系统提示词、上游 API key 或 Executor 私密凭据。

## 设备策略

注册平台用于区分产品权限，不是账号订阅。`windows` 设备可以进行 Manager 相关注册、策略和 telemetry 操作；任务创建、查询、取消和 SSE 统一经过 `authenticateCloudTaskDevice`，只有 `openclaw-plugin-windows` 放行。被拒绝请求使用稳定 403，不查询任务内容，避免旧 bearer 继续获得执行能力；拒绝写入最小审计事件。

撤销由 `/v1/devices/self/revoke` 完成，服务端先持久化 revoked 状态并记录 audit，再使 bearer 失效。历史设备、订单和审计不删除。

## 任务准入

严格 `longhub/cloud-skill-call/v1` 请求在 Cloud API 中解析。幂等键、tenant/device/agent owner、输入摘要和 admission placeholder 先持久化；订阅、binding、release、feature policy、额度、速率和并发全部通过后才写入完整输入并启动 worker。任务 worker 使用短时 `longhub/executor-credential/v1`，设备 bearer 不转发给 Executor。

取消使用 Store CAS，只允许 `pending/running -> cancelled`，并 abort 本机 worker。轮询和 SSE 只允许同一 owner；跨设备返回 `TASK_NOT_FOUND`。撤销或订阅失效不会停止本地 OpenClaw。

## 独立发布面

Plugin 与 CLI 各自使用 release index、目录、schema、product surface 和 Ed25519 key。上传时流式计算大小/SHA-256，服务器签名 manifest，并以 paused/0% rollout 开始。版本不可覆盖，撤回只改变可见性并保留 bytes、manifest 和审计。`signing-key` endpoint 只用于人工核对，客户端信任根固定在 CLI build 中。

## 安全决策

- 生产禁止 MemoryStore、开发 signing key、未经 LongHub 验证的 npm artifact 和旧 legacy surface。
- Token、API key、任务 input 和 Executor 响应只在必要边界存在，并经过日志/审计脱敏。
- 公共 release 下载只服务记录中精确的固定文件名，撤回版本返回 410。
- 订阅只控制 Cloud API 执行，不影响本地 OpenClaw。

## 已知限制

生产 PostgreSQL migration、正式 Ed25519 key、Authenticode Manager 安装包、Windows VM CLI/Plugin E2E 和真实 Portal 配对仍是候选发布门禁；当前测试 key 和 unsigned candidates 不代表生产签名。

## 变更历史

### 2026-08-17 - 独立 Cloud Plugin/CLI

加入 Plugin/CLI release API、设备 self/revoke 和 Cloud task 平台 gate；Manager `windows` bearer 失去任务执行权限，Cloud Plugin 直接调用 `/v1/tasks*`。
