# LongHub Core RPC V1（历史/废弃契约草案）

早期 Electron Main / Renderer / Core / Skill Worker 之间的本地 RPC 契约。传输为 JSON 消息（Electron IPC /
本地 stdio），仅用于历史审计；clean-launch Manager 不实现、迁移或兼容它。

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
| `core.hello` | 版本协商，返回历史 Core RPC 版本与客户端版本 |
| `session.create` | 创建会话 |
| `session.list` | 列出会话 |
| `task.submit` | 提交无企业权限的历史原型任务（可降低但不能抬高预算） |
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

### 历史 Electron Main → Core

| 方法 | 说明 |
| --- | --- |
| `bridge.execute` | 使用 OpenClaw Bridge 注入的可信 Agent/Session/ToolCall 上下文请求企业技能 |
| `bridge.policy.replace` | 生命周期事务整表替换当前有效 Agent Bridge policy；同时使旧待确认记录失效 |
| `confirm.respond` | 转发用户对 Core 待确认记录的批准或拒绝 |

### Core → Skill Worker

| 方法 | 说明 |
| --- | --- |
| `skill.execute` | 执行本地技能，入参含 `skillId`、`input`、`grantedPermissions`、预算 |
| `skill.abort` | 中止执行中的技能 |

## 约束

- Renderer 不得直接访问系统资源；所有敏感操作经 Core 的权限交集计算与人工确认。
- `task.submit`、Bridge 工具参数和 Profile 文本都不得授予权限；需要企业权限的技能只能使用
  `bridge.execute` 可信 Agent/Session/ToolCall 上下文，并由 Core 重新计算授权。
- `confirm.respond` 只处理 Core 已创建的待确认记录；记录绑定 Agent、Profile 版本、Session、
  ToolCall、权限和输入摘要，过期或消费后不可复用。
- 所有方法幂等或可安全重试；`task.submit` 必须携带客户端生成的幂等键。
- 该历史契约不设生产兼容期；若未来需要重新启用，必须创建新的产品决策和主版本。
