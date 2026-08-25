# `longhub/cloud-skill-call/v1`

LongHub 原生 OpenClaw 薄适配器与本机 Manager Bridge、再到 Cloud API 的调用协议。
它只携带公开 Skill 标识、受信运行时上下文和最小业务输入；云端实现、设备凭据和 Executor 凭据永不
进入适配器或模型上下文。

## 本机 Bridge 请求

适配器只向固定回环端点 `POST /api/v1/cloud-skill/execute` 发送严格 JSON：

```json
{
  "request_id": "req-01",
  "skill_id": "longhub.skill.resume-screen",
  "skill_version": "1.0.0",
  "plan_id": "longhub-pro",
  "agent_id": "main",
  "session_key": "agent:main:main",
  "tool_call_id": "call-01",
  "input": { "requiredKeywords": ["TypeScript"], "resumeText": "..." },
  "idempotency_key": "idem-01"
}
```

`agent_id`、`session_key` 和 `tool_call_id` 必须由 OpenClaw 运行时上下文提供，模型参数不能覆盖。Bridge
在离开本机前只发送 `SHA-256(session_key)`，不把原始 session key 传给 Cloud API 或 Executor。`input`
单独校验，不能把身份字段合并进业务输入。

`plan_id`（可选）只是适配器声明的候选套餐；Manager 不把它当作授权来源，Cloud API 必须根据设备账号的
有效 entitlement 再次解析并拒绝不匹配的计划。适配器不需要为了放行而携带设备或订阅令牌。

请求中禁止 URL、凭据、任意命令、内部服务地址和未知字段；`idempotency_key` 同时出现在 HTTP
`Idempotency-Key` 头和 Cloud API 请求体绑定字段中。

## Manager → Cloud API 请求

```json
{
  "schema_version": "longhub/cloud-skill-call/v1",
  "request_id": "req-01",
  "kind": "skill.execute",
  "skill_id": "longhub.skill.resume-screen",
  "skill_version": "1.0.0",
  "plan_id": "longhub-pro",
  "agent_id": "main",
  "tool_call_id": "call-01",
  "session_key_hash": "<64 位小写 SHA-256>",
  "idempotency_key": "idem-01",
  "input": { "requiredKeywords": ["TypeScript"], "resumeText": "..." }
}
```

Cloud API 使用设备凭据识别 `tenant_id/device_id`，并在 `/v1/tasks` 执行点再次校验：

- `skill_id + plan_id` 的有效订阅和 Skill entitlement；
- Skill 版本撤回、兼容性、账号/设备状态和 Feature Policy；
- `tenant_id + device_id + agent_id + idempotency_key` 的任务归属和幂等；
- 计划公开的周期额度、每分钟速率和并发限制，并在签发 Executor 凭据前创建一次执行预留。

执行预留的稳定语义如下：

- `included_calls` 按 `subscription_id + skill_id + 当前订阅周期` 计数；创建预留立即消耗一次，
  释放或租约过期不会退款。
- `requests_per_minute` 和 `max_concurrency` 按
  `subscription_id + tenant_id + user_id + device_id` 计数；同一设备的多个 Agent 共用桶，按 UTC
  分钟窗口计算。
- `task_id` 是预留的幂等键。同一任务且所有绑定字段（含 `input_digest`）一致时重放返回原预留；
  绑定冲突返回 `IDEMPOTENCY_CONFLICT`。预留租约默认五分钟，允许范围为 1 秒至 15 分钟；到期会
  fail-closed 地释放并发占用，但保留用量记录。
- `CLOUD_SKILL_QUOTA_EXCEEDED` 返回 HTTP 403 且不可重试；
  `CLOUD_SKILL_RATE_LIMITED` / `CLOUD_SKILL_CONCURRENCY_LIMIT` 返回 HTTP 429 和 `Retry-After`；
  存储不可用返回可重试的稳定错误。计量失败不得降级为无订阅执行。

PostgreSQL Store 在事务中锁定所属订阅行并依靠 `task_id` 唯一约束，保证多 Cloud API 副本的准入计数
和幂等一致；MemoryStore 仅作为单进程开发/测试实现。当前是纯订阅模式，不做按次扣费或用户用量报表。

`plan_id` 不由客户端单独授予权限：Cloud API 根据当前有效 entitlement 解析允许计划集合；适配器只能声明
自己支持的公开计划集合。正式 v1 envelope 使用顶层 `plan_id` 作为候选计划，服务端只在该候选同时属于
Skill 的计划 allow-list 且 entitlement 有效时放行；否则返回稳定 `CLOUD_SKILL_SUBSCRIPTION_REQUIRED`
或 `CLOUD_SKILL_PLAN_MISMATCH`。clean launch 只接受本契约的顶层 snake_case 字段；`input` 中的
`skill_id`、`skillId`、`plan_id`、`planId` 或任何身份/授权元数据均在执行前以 `INVALID_TASK` 拒绝，
不做旧 envelope 解析或兼容。解析出的计划和用量预留 ID 都不发送给 Executor；Executor 只接收绑定后的
任务、租户、Skill、幂等键、输入摘要和已按 Skill Schema 校验的业务 `input`。

## 响应

Bridge 只向适配器返回受限业务结果或稳定公开错误：

```json
{ "ok": true, "result": { "matches": [] } }
```

失败时只返回 `code/message/retryable/request_id` 等公开字段。不得返回设备 Token、订阅 Token、Cloud URL、
Executor 凭据、源码、完整提示词、内部模型路由、堆栈、依赖版本或原始请求全文。

## 重放与故障

同一归属下重放相同幂等键必须返回同一任务；不同设备、租户或 Agent 即使复用幂等键也必须创建不同任务，
且不能读取、取消或订阅他人的任务。订阅到期、取消、退款、撤销、周期额度耗尽、速率超限或并发已满只
阻断新的云端执行；在途任务可完成或被取消，释放只影响并发，不影响已计量用量。上述状态不影响用户本地
OpenClaw、Provider、Channels、插件、MCP、第三方 Skill 和工作区。
