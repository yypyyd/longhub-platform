# LongHub Cloud OpenAPI V1

这是 Portal、Admin、Cloud CLI、Cloud Plugin 与 Cloud API 的 REST 契约。Manager 是免费本地产品，Cloud Plugin/CLI 是独立收费 release surface；本文件不把 Plugin artifact 放进 Manager 安装包，也不把订阅门禁下发到本地 OpenClaw。

## 产品面

| surface | 版本 | 文件/接口 |
| --- | --- | --- |
| `longhub-manager` | `0.1.1` | Manager `.exe` client release |
| `longhub-cloud-plugin` | `0.2.1` | `/v1/cloud-plugin-releases/*`、`/downloads/cloud-plugin/*` |
| `longhub-cloud-cli` | `0.1.2` | `/v1/cloud-cli-releases/*`、`/downloads/cloud-cli/*` |

每个 manifest 都绑定版本、固定文件名、大小、SHA-256、兼容性、product surface、签名 key ID 和 Ed25519 signature。客户端信任根是构建时固定 key；`signing-key` 只供运维核对。

## 设备与任务

注册支持 `windows` 与 `openclaw-plugin-windows`。CLI 使用 `/v1/devices/self` 和 `/v1/devices/self/revoke`，配对码由 `/v1/devices/pairing/challenge` 生成。只有 `openclaw-plugin-windows` bearer 可调用 `/v1/tasks*`；旧 Manager 设备收到 `CLOUD_PLUGIN_DEVICE_REQUIRED`。

严格任务 wire 为 `longhub/cloud-skill-call/v1`。Cloud API 负责订阅、Agent-Skill binding、release、额度、速率、并发和 Executor 授权；本地 OpenClaw 能力不受这些门禁影响。

## 兼容与迁移

旧 Manager Bridge/enrollment 路由不属于当前契约；Manager 旧入口返回 `410 CLOUD_SKILL_MOVED_TO_PLUGIN`。旧设备和订单数据保留服务端审计，但不保留长期双协议。

YAML 已用结构化解析器检查，并验证所有 `$ref` 指向已声明 schema。生产 API smoke、Windows Credential Manager、CLI 安装/更新和真实 OpenClaw E2E 已通过；后续变更仍须在 CI 重跑 OpenAPI、contract 与生产 smoke。
