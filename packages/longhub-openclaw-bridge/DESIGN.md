# LongHub OpenClaw Bridge 设计

## 目标与非目标

目标是让 OpenClaw 原生 Agent 直接调用 LongHub 技能，同时维持龙枢的授权边界：模型只提交业务参数，运行时身份由 OpenClaw 注入，最终技能准入和权限由 Core 决定。

本模块不执行企业业务操作、不读取 Pack、不决定 entitlement、不向 WebUI 暴露 Electron IPC，也不把工具可见性当作最终授权。权限交集与人工确认由 Core 负责；Selector 实时停用属于 `LH-036-06`。

## 调用链

```text
模型选择工具
  → OpenClaw 校验 TypeBox 业务参数
  → Tool Factory 闭包绑定 runtime agentId/sessionKey/sessionId，执行时绑定 toolCallId
  → Bridge Client（Bearer 随机令牌，127.0.0.1）
  → Desktop ToolBridgeHost（单一路由、限 1 MiB）
  → Core RPC bridge.execute
  → Core 在线复验 entitlement/Pack 状态并计算完整权限、确认和预算交集
  → Skill Worker 以 Core 计算的最小权限执行
```

## 组件职责

- `protocol.ts`：共享 RPC 类型、严格解析器、工具名到技能和最小权限的静态契约。
- `tool-factory.ts`：读取 OpenClaw 的可信工具上下文；字段缺失时返回 `null`；业务 schema 不包含身份或权限。
- `client.ts`：只连接字面量主机 `127.0.0.1`，携带本次启动令牌并设置超时。
- `index.ts`：使用公开的 `openclaw/plugin-sdk/plugin-entry` 注册可选工具。
- Desktop `ToolBridgeHost`：随机端口、单一路由、Bearer 校验、请求大小限制，再转发 Core。
- Core `executeBridgeSkill`：保留 Profile/Pack/租户/设备原始来源，在线复验动态授权并计算最终 grant。

## 信任边界

| 数据 | 来源 | 是否信任 | 处理 |
|---|---|---:|---|
| 工具业务参数 | 模型 | 否 | OpenClaw schema 与 Bridge 运行时双重校验 |
| `agentId/sessionKey/sessionId/toolCallId` | OpenClaw Tool Factory context | 是（当前进程边界内） | 闭包绑定，不出现在工具参数中 |
| `skillId` | 工具实现常量 | 有限信任 | Core 再按 Agent Profile policy 检查 |
| 权限、确认与预算 | Core 策略和确认记录 | 是 | 调用方协议中不存在这些字段 |
| Bridge URL/Token | Desktop 每次启动生成 | 是 | 仅注入 Gateway 子进程环境，不写配置文件 |

OpenClaw runtime context 不能抵御本机管理员、被篡改的 OpenClaw 或被替换的插件代码；这些属于客户端制品完整性与代码签名边界。它能抵御正常运行时中模型通过工具参数伪造身份和权限。

## 关键决策

| 日期 | 决策 | 理由 |
|---|---|---|
| 2026-07-29 | 使用 OpenClaw 公开 Tool Factory API | 可取得每次运行的 agent/session 上下文，避免依赖上游内部实现 |
| 2026-07-29 | 工具名统一为小写字母、数字和下划线 | 避免点号工具名在模型/运行时中的兼容问题 |
| 2026-07-29 | 使用随机令牌保护的回环 HTTP POC | 跨 Gateway 与 Electron/Core 进程，易测试且不开放局域网接口 |
| 2026-07-29 | Core 增加独立 `bridge.execute` | 现有 `task.submit` 允许调用方传权限，不适合作为 Bridge 安全入口 |
| 2026-07-29 | 第一版只开放简历初筛 | 避免写操作绕过确认，并避免 JD 工具递归进入同一 OpenClaw Agent |

## 安全措施

- Plugin manifest 声明 `contracts.tools`，工具为 optional，只有 HR Agent allowlist 能看到。
- `main` 没有 HR 工具 allowlist；即使绕过可见性，Core policy 也没有 `main` grant。
- 参数解析拒绝所有额外字段，因此 `agentId`、`sessionId`、`sessionKey`、`permissions` 无法混入业务输入。
- Bridge 只绑定 `127.0.0.1`，端点客户端拒绝主机名、IPv6 或远程地址替代。
- 令牌至少 32 字节并使用常量时间比较；请求不缓存，限制 1 MiB。
- Profile 必须已验签、安装校验并激活，Desktop 才会生成 Core policy。
- Bridge 契约只授予每个技能的最小权限；Profile 的宽权限集合不能直接扩大 grant。

## 后续演进

- `LH-036-06`：授权撤销和 Pack 停用实时更新 Core policy，不依赖重启。
- 写工具：接入 OpenClaw/LongHub 原生确认交互后再开放 `offer_letter`。
- L2 工具：为 JD 起草设计非递归执行路径；不得从当前 HR 工具再次创建同一 HR Agent 会话。
- 生产加固：代码签名、插件制品摘要验证、凭据迁移和日志脱敏。
