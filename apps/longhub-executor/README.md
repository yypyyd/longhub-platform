# LongHub Executor

协议细节见 [executor-credential-v1](../../contracts/cloud-skill-adapter/executor-credential-v1.md)。

LongHub Executor 是云端 Skill 的最小执行边界。它不是客户端功能，也不接受
OpenClaw、设备或用户 Token；唯一调用方是 Cloud API 的内部转发路径。

## 运行

生产/跨进程运行必须在 Cloud API 与 Executor 两边注入同一随机密钥：

```powershell
$env:EXECUTOR_CREDENTIAL_KEY_ID = "executor-2026-01"
$env:EXECUTOR_CREDENTIAL_SECRET = "<32-64-byte-base64url-secret>"
$env:EXECUTOR_CREDENTIAL_TRUSTED_KEYS_JSON = '{"executor-2025":"<old-base64url-secret>"}' # 轮换重叠窗口可选
$env:EXECUTOR_BIND_HOST = "127.0.0.1" # 默认值；跨主机时改为仅私网可达地址
```

然后分别启动 Cloud API 和 Executor。没有显式密钥时，`bootstrap` 会拒绝启动。
`createExecutorServer()` 的进程内随机密钥只用于契约测试和本地嵌入测试，不能用于
两个独立进程之间的调用。

生产进程通过 `src/main.ts` 注入 Executor 制品内的固定私有 Registry。Registry 为空时生产
启动同样会失败；`createExecutorServer()` 未注入 Registry 时则保持空集合并对所有 Skill 返回
`SKILL_NOT_FOUND`，避免测试/嵌入调用意外获得生产实现。

## 请求边界

`POST /execute` 必须同时满足：

- `x-longhub-executor-credential: <lhx1...>`（不接受客户端/设备 `Authorization: Bearer`）。
- `Idempotency-Key` 与请求体中的 `idempotency_key` 相同。
- `content-type: application/json`，请求体默认不超过 1 MiB，读取超时默认 10 秒。
- 请求体严格使用 `longhub/executor-request/v1`，包含 `task_id`、`tenant_id`、`skill_id`、
  `input_digest` 和 `input`，不得增加字段。

Cloud API 签发的凭据有效期默认 60 秒，并绑定任务、租户、Skill、幂等键和输入摘要。
执行器只按租户 + 幂等键缓存结果；同一请求重试会返回相同结果，不同任务/输入复用幂等键会返回
`IDEMPOTENCY_CONFLICT`。

## 固定错误码

错误响应统一为 `{ code, message, request_id, retryable }`。消息不会包含输入、Skill 源码、
完整提示词、堆栈、内部地址或凭据。主要边界码为：

`CREDENTIAL_REQUIRED`、`CREDENTIAL_INVALID`、`CREDENTIAL_EXPIRED`、`CREDENTIAL_BINDING_MISMATCH`、
`REQUEST_TOO_LARGE`、`REQUEST_TIMEOUT`、`IDEMPOTENCY_CONFLICT`、`EXECUTION_TIMEOUT`。

进程入口默认只绑定 `127.0.0.1`。如果 Cloud API 与 Executor 分主机部署，必须显式设置
`EXECUTOR_BIND_HOST` 为防火墙保护的私网地址，并在网络层禁止公网访问。

## 服务端私有 Skill Registry

生产 allowlist 定义在 `src/private-skills/registry.ts`，当前最小首发实现为：

- `longhub.skill.salary-band`：只接受 `{ "level": 1..10 }`，对象不得有额外字段。

Registry 是构建时固定的只读表，不读取请求、页面配置或任意环境变量中的模块路径。增加、移除或
替换 Skill 必须修改受审计的服务端源码、重新构建并部署 Executor。未知 Skill 一律失败闭合为
`SKILL_NOT_FOUND`；实现输入错误统一为 `SKILL_INPUT_INVALID`，响应不回显输入、实现异常、提示词、
凭据或堆栈。

`src/private-skills/` 只属于 Executor 服务端制品，不通过包根入口导出，也不能复制进 Manager、
OpenClaw 插件或公开适配器。客户端适配器只携带公开调用契约和 Cloud API 路由信息。
