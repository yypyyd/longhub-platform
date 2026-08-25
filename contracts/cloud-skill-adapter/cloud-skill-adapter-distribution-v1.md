# Cloud Skill 薄适配器分发契约 v1

本文定义 Cloud API 到 LongHub Manager 的适配器下载边界。它补充
[`cloud-skill-adapter-v1.md`](./cloud-skill-adapter-v1.md) 的本地安装契约，
不改变 OpenClaw 原生运行时的所有权。

## 端点

```text
GET /v1/skills/{skill_id}/adapter?version={semver}&openclaw_version={semver}
Authorization: Bearer <registered-device-token>
```

`skill_id`、`version` 和 `openclaw_version` 必须使用契约中的 ASCII 标识格式；
服务器不得把 URL、版本或计划交给客户端作为授权依据。`version` 省略时选择当前
已发布且兼容的 active 版本。端点只使用本次 clean launch 新注册的 device +
active account/subscription 门禁，不读取或迁移旧设备授权。

服务器在返回制品前必须重新检查：

1. 设备 active，且客户端/OpenClaw 版本兼容；
2. 设备关联的账号 active，并拥有覆盖该 `skill_id` 的有效 Cloud Skill entitlement；
3. 所选 release 为 active，且版本不可变；
4. 本下载端点不建立也不依赖 Agent-Skill binding；binding 是单独的设备/Agent enrollment，
   并在 Cloud Skill 执行准入点重新校验；
5. 功能策略允许 `skill.catalog`，并且发布记录中的 manifest/file 摘要一致。

## 成功响应

```http
200 OK
Cache-Control: no-store
Content-Type: application/json
```

```json
{
  "adapter": {
    "manifest": {
      "schema_version": "longhub/cloud-skill-adapter/v1",
      "skill_id": "longhub.skill.resume-screen",
      "version": "1.0.0",
      "display": {
        "name": "简历初筛",
        "description": "返回结构化筛选结果",
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
        { "path": "SKILL.md", "sha256": "<64 lowercase hex>", "size": 1234 },
        { "path": "schemas/input.json", "sha256": "<64 lowercase hex>", "size": 456 },
        { "path": "schemas/output.json", "sha256": "<64 lowercase hex>", "size": 789 }
      ],
      "subscription": { "plan_ids": ["longhub-pro"] },
      "permissions": { "requested": ["candidate.read"], "confirmation_class": "none" },
      "compatibility": {
        "manager_min_version": "0.1.0",
        "openclaw_version": "2026.7.1-2"
      },
      "integrity": {
        "algorithm": "sha256",
        "digest": "<canonical-manifest-digest>",
        "signature_key_id": "<adapter-key-id>",
        "signature": "<canonical-ed25519-base64>"
      }
    },
    "files": {
      "SKILL.md": "<standard-base64>",
      "schemas/input.json": "<standard-base64>",
      "schemas/output.json": "<standard-base64>"
    }
  },
  "digest": "<canonical-manifest-digest>",
  "signature_key_id": "<adapter-key-id>"
}
```

`manifest` 必须是签名时使用的原始 JSON 语义；Manager 在本地重新执行严格解析、
Ed25519 验签、文件 size/SHA-256 校验和纯内容检查。`files` 的键集合必须**恰好**是
`SKILL.md`、`schemas/input.json`、`schemas/output.json`，Base64 必须是无空白的标准
canonical 编码。响应中不得出现实现代码、系统提示词、业务规则、内部 endpoint、
Executor 凭据、设备 token 或可执行文件。

Cloud API 应在发布入库时验证每一份文件的摘要，并将 manifest 摘要与文件摘要作为同一
不可变 release 的事务数据；不能在下载请求时从任意 URL 或本地路径读取制品。适配器签名
密钥必须独立于 Manager 更新签名密钥及任何历史制品密钥，客户端只信任 Manager 内置的 pinned 公钥。

## 错误语义

```text
401 UNAUTHORIZED                    设备凭据缺失/无效
403 CLOUD_SKILL_SUBSCRIPTION_REQUIRED 账号或 entitlement 无效
404 SKILL_NOT_FOUND                 无 active/兼容 release（避免暴露历史制品）
410 SKILL_RELEASE_REVOKED           指定版本已撤销
422 OPENCLAW_VERSION_REQUIRED      缺少 openclaw_version 查询参数
422 SKILL_INCOMPATIBLE              Manager/OpenClaw 版本不兼容
413 RESPONSE_TOO_LARGE              响应超过 Manager 适配器大小上限
503 SKILL_DISTRIBUTION_UNAVAILABLE  存储或签名制品暂不可用（可重试）
```

错误响应只返回稳定 `code`、公开 `message`、随机 `request_id` 和 `retryable`；不得
返回文件路径、SQL/对象存储错误、签名私钥或内部堆栈。下载响应应限制在 Manager
`maxSkillAdapterRequestBytes`（20 MiB）以内，超限应返回 413，而不是继续流式读取。

## 与本地安装的顺序

Manager 页面先调用该端点，再把 `manifest` 序列化为 `manifest` 字节、把 `files` 原样
放入 `POST /api/v1/cloud-skill/adapters` 的 Base64 请求，并要求用户确认。Cloud API
只负责授权和分发；最终安装仍由 Manager 的 pinned-key 验签和原子事务完成。任何验签、
摘要、兼容性或用户确认失败都不得修改原生 OpenClaw Skill 目录。
