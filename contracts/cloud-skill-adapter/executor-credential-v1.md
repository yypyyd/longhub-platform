# Cloud API → Executor 内部凭据 v1

该协议只用于 LongHub Cloud API 与私网 Cloud Executor 之间的服务身份认证，不得发给客户端、OpenClaw
模型、原生 Skill 或浏览器。它解决“客户端不能直连执行器”，不替代账号、订阅、租户和 Skill entitlement
的业务判定；这些判定必须在 Cloud API 执行点完成后才签发凭据。

## 请求

`POST /execute` 必须包含：

- `content-type: application/json`
- `x-longhub-executor-credential: lhx1.<payload>.<hmac>`
- `Idempotency-Key`，且与请求体的 `idempotency_key` 完全一致

请求体严格为 `longhub/executor-request/v1`：

```json
{
  "schema_version": "longhub/executor-request/v1",
  "task_id": "task-123",
  "tenant_id": "tenant-a",
  "skill_id": "longhub.skill.resume-screen",
  "idempotency_key": "req-123",
  "input_digest": "<sha256(input)>",
  "input": { "resume": "..." }
}
```

`input_digest` 使用稳定 JSON（对象键排序、数组顺序不变）计算 SHA-256。凭据 payload 严格包含：

```text
schema_version / credential_id / key_id / task_id / tenant_id / skill_id
idempotency_key / input_digest / issued_at / expires_at
```

HMAC-SHA-256 密钥由 Secret Manager 注入，凭据默认 60 秒有效，最大 5 分钟；允许不超过 10 秒的时钟
偏差。每个凭据只绑定一个任务、Skill、租户、幂等键和输入摘要。

## 响应与错误

成功只返回受限的业务 `output` 和请求 ID。失败统一返回：

```json
{ "code": "CREDENTIAL_BINDING_MISMATCH", "message": "稳定公开文案", "request_id": "...", "retryable": false }
```

公开错误码包括 `CREDENTIAL_REQUIRED`、`CREDENTIAL_INVALID`、`CREDENTIAL_EXPIRED`、
`CREDENTIAL_BINDING_MISMATCH`、`IDEMPOTENCY_CONFLICT`、`REQUEST_TOO_LARGE`、`EXECUTION_TIMEOUT`、
`SKILL_INPUT_INVALID` 和 `SKILL_EXECUTION_FAILED`。不得回传源码、完整提示词、内部 URL、模型名、
依赖版本、堆栈、凭据或原始输入。

## 部署边界

- Executor 默认只监听回环地址；跨进程部署必须放在私网 ACL/mTLS 或等价服务网格后。
- 生产启动缺少 `EXECUTOR_CREDENTIAL_SECRET` 时必须失败关闭；开发随机密钥只允许同进程测试。
- 多副本部署不能依赖进程内幂等 Map，必须迁移共享幂等存储/队列并保留租户绑定。
- 轮换密钥时使用新的 `key_id`，短窗口内由 Cloud API 和 Executor 同时信任旧/新密钥，完成后撤销旧钥。
