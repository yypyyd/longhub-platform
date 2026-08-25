# `longhub/cloud-skill-adapter/v1`

LongHub 云端 Skill 的本地薄适配器契约。适配器可以安装到用户原生 OpenClaw 的 Skill 目录，
但只负责把请求交给 LongHub Manager/Cloud API；它不是云端 Skill 的实现制品。

## 设计目标

- LongHub 客户端免费，云端 Skill 通过订阅授权。
- 实现源码、完整提示词、业务规则、内部模型路由、连接器凭据和风控阈值不进入客户端。
- 适配器可被用户读取和备份；这不构成云端实现的分发。
- 适配器不能把调用凭据、服务 URL 或内部错误交给 OpenClaw 模型。

## 严格 manifest

```json
{
  "schema_version": "longhub/cloud-skill-adapter/v1",
  "skill_id": "longhub.skill.resume-screen",
  "version": "1.0.0",
  "display": {
    "name": "简历初筛",
    "description": "根据已授权的简历输入返回结构化筛选结果",
    "category": "hr"
  },
  "service": {
    "service_id": "longhub.cloud.resume-screen",
    "api_version": "1.0",
    "entry": "local-longhub-bridge"
  },
  "schemas": {
    "input": "schemas/input.json",
    "output": "schemas/output.json"
  },
  "files": [
    { "path": "SKILL.md", "sha256": "<64-lowercase-hex>", "size": 1234 },
    { "path": "schemas/input.json", "sha256": "<64-lowercase-hex>", "size": 456 },
    { "path": "schemas/output.json", "sha256": "<64-lowercase-hex>", "size": 789 }
  ],
  "subscription": {
    "plan_ids": ["longhub-pro"]
  },
  "permissions": {
    "requested": ["candidate.read"],
    "confirmation_class": "none"
  },
  "compatibility": {
    "manager_min_version": "0.1.0",
    "openclaw_version": "2026.7.1-2"
  },
  "integrity": {
    "algorithm": "sha256",
    "digest": "<canonical-manifest-digest>",
    "signature_key_id": "<approved-key-id>",
    "signature": "<ed25519-signature>"
  }
}
```

生产实现必须拒绝未知字段、路径穿越、任意 URL、脚本、插件、MCP、环境变量和模型配置字段。

## 本地调用协议

适配器向本机 Manager Bridge 发起 `longhub/cloud-skill-call/v1` 请求（完整字段见
[cloud-skill-call-v1](cloud-skill-call-v1.md)）。Bridge 从可信 OpenClaw
上下文取得 `agentId`、`sessionKey` 和 `toolCallId`，适配器或模型不能自行覆盖这些字段。

请求至少包含：

```text
request_id / idempotency_key
skill_id / skill_version
agent_id / session_key / tool_call_id（由 Bridge 注入）
input（按已签名 Schema 校验）
```

Bridge 不向适配器或 OpenClaw 返回设备 Token、订阅 Token、Cloud URL 或 Executor 凭据。

通用 OpenClaw 插件使用独立的 execution-only 本机令牌（建议由 Manager 的一次性 Gateway enrollment
兑换后注入 `LONGHUB_EXECUTION_TOKEN` 和固定的 `LONGHUB_EXECUTION_BRIDGE_URL`）。该令牌只允许固定的
`/api/v1/cloud-skill/execute` 路由；管理页面 Bearer 不得写入 OpenClaw 配置、环境变量或插件参数。
令牌轮换/撤销后，旧令牌必须立即失效；插件在兑换失败时 fail-closed，不回退到管理令牌或设备令牌。

## Cloud API 与 Executor 边界

1. Cloud API 对账户、设备、订阅、Skill、Agent、配额、并发、策略和幂等性做逐请求复验。
2. Cloud API 向 Executor 签发单任务、单 Skill、短时内部凭据。
3. Executor 只接受内部网络请求和短时凭据，不公开公网路由。
4. Executor 的响应只能是成功结果或固定错误码；不得返回源码、完整提示词、堆栈、内部地址和秘密。
5. 订阅失效、设备撤销、Skill 撤回或策略紧急关闭时，Cloud API 在执行点拒绝请求。

## 不可变语义

- 用户可以安装、停用、解绑、删除、备份和查看本地适配器，也可以在自己的电脑上修改它。
- 本地文件修改不会改变官方 Skill 的云端实现、订阅规则或权限：Manager 验证摘要/签名/版本，Cloud API
  在每次执行重新验证 Release、设备、Agent 绑定、订阅和配额；篡改后的本地文件应被拒绝安装或启用。
- `agent_id`、`session_key` 和 `tool_call_id` 只能由受支持的通用 OpenClaw Tool Plugin 在运行时产生；
  它们是审计/幂等元数据，不是抵御本机操作者或被修改插件的独立认证因素。服务端授权不得仅依赖请求体
  中的这些字符串。
- 升级必须验证新 manifest 签名和版本兼容性；失败继续使用上一版本适配器。
- 同一 Skill 在不同 Agent 上分别绑定、授权和计量。
