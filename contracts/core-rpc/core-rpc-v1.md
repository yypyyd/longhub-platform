# LongHub Core RPC V1（冻结契约草案）

Desktop Main / Renderer / Core / Skill Worker 之间的本地 RPC 契约。传输为 JSON 消息（Electron IPC / 本地 stdio），仅开放白名单方法。

## 通用约定

- 请求：`{ "rpc": "1.0", "id": "<uuid>", "method": "<方法名>", "params": { ... } }`
- 成功响应：`{ "rpc": "1.0", "id": "<uuid>", "result": { ... } }`
- 错误响应：`{ "rpc": "1.0", "id": "<uuid>", "error": { "code": "<string>", "message": "<string>", "retryable": <bool> } }`
- 通知（无响应）：省略 `id`。
- 版本协商：连接建立后首个调用必须是 `core.hello`。

## 方法白名单

### Renderer → Main（UI 网关）

| 方法 | 说明 |
| --- | --- |
| `core.hello` | 版本协商，返回 Core RPC 版本与 Desktop 版本 |
| `session.create` | 创建会话 |
| `session.list` | 列出会话 |
| `task.submit` | 提交用户任务（含预算） |
| `task.cancel` | 取消任务 |
| `task.get` | 查询任务状态 |
| `pack.list` | 列出已安装套装 |
| `pack.install` | 安装/升级套装（授权→下载→验签→暂存→自检→原子切换） |
| `pack.rollback` | 回滚到上一个可用版本 |
| `pack.enable` / `pack.disable` | 启停套装 |
| `confirm.respond` | 人工确认应答（批准/拒绝敏感操作） |

### Main/Core → Renderer（事件通知）

| 事件 | 说明 |
| --- | --- |
| `event.task` | 任务进度事件，负载见 `contracts/events/task-event.v1.schema.json` |
| `event.confirm.request` | 请求人工确认（写文件、发消息、改企业数据、付款、删除） |
| `event.pack` | 套装安装/升级/回滚进度 |

### Core → Skill Worker

| 方法 | 说明 |
| --- | --- |
| `skill.execute` | 执行本地技能，入参含 `skillId`、`input`、`grantedPermissions`、预算 |
| `skill.abort` | 中止执行中的技能 |

## 约束

- Renderer 不得直接访问系统资源；所有敏感操作经 Core 的权限交集计算与人工确认。
- 所有方法幂等或可安全重试；`task.submit` 必须携带客户端生成的幂等键。
- 破坏性变更需提升主版本（`rpc: "2.0"`）并保留 V1 兼容期。
