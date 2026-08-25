# LongHub Cloud API

Cloud API 是收费 Cloud Skill 的服务端控制面。它管理账号、设备注册和配对、Cloud Skill 订阅/entitlement、Agent-Skill binding、任务准入、额度/速率/并发、Executor 授权、审计以及独立 Plugin/CLI release。它不安装或限制用户本地 OpenClaw。

## 产品身份

- 免费 Manager：`product_surface=longhub-manager`，只下载 Manager 安装包。
- Cloud Plugin：`product_surface=longhub-cloud-plugin`，schema `longhub/cloud-plugin-release/v1`。
- Cloud CLI：`product_surface=longhub-cloud-cli`，schema `longhub/cloud-cli-release/v1`。

Manager `0.1.0` 候选保持 `paused`。所有 Plugin/CLI 新版本上传后也必须从 paused 开始，只有管理员显式 rollout 才可被公开 latest 选中；当前生产 Plugin `0.2.1` 和 CLI `0.1.2` 已通过门禁并 active。版本不可覆盖，撤回保留审计和历史记录。

## 设备与执行边界

`POST /v1/devices/register` 接受 `windows`（Manager）和 `openclaw-plugin-windows`（Cloud Plugin）两个平台。`GET /v1/devices/self` 与 `POST /v1/devices/self/revoke` 提供 CLI 状态和撤销。只有 `openclaw-plugin-windows` bearer 可以访问 `/v1/tasks*`；旧 Manager 设备访问任务时返回 `403 CLOUD_PLUGIN_DEVICE_REQUIRED`，并记录 `cloud_task.execution_denied`，但设备历史记录和本地 Manager 能力不删除。

任务接口是：

```text
POST /v1/tasks
GET  /v1/tasks/{task_id}
POST /v1/tasks/{task_id}/cancel
GET  /v1/tasks/{task_id}/events
```

任务 owner 固定为 tenant/device/agent，幂等键按 owner 分区。Cloud API 最终复验订阅、binding、release、策略和用量，然后通过短时 Executor credential 调用私网 Executor。

## Release API

公共接口：

```text
GET /v1/cloud-plugin-releases/latest
GET /v1/cloud-plugin-releases/versions/{version}
GET /v1/cloud-plugin-releases/signing-key   # 仅运维核对
GET /v1/cloud-cli-releases/latest
GET /v1/cloud-cli-releases/versions/{version}
GET /v1/cloud-cli-releases/signing-key      # 仅运维核对
```

管理接口分别位于 `/v1/admin/cloud-plugin-releases` 和 `/v1/admin/cloud-cli-releases`，支持上传、`PATCH .../{version}/rollout`、撤回和审计。下载路径固定为 `/downloads/cloud-plugin/<filename>` 与 `/downloads/cloud-cli/<filename>`。

## 开发与测试

```powershell
pnpm --filter longhub-cloud-api typecheck
pnpm --filter longhub-cloud-api test
```

生产必须使用 PostgreSQL、独立 Plugin/CLI Ed25519 key、release 目录和 Executor credential；缺少生产配置时 fail closed。默认测试使用 MemoryStore，不代表生产可用性。
