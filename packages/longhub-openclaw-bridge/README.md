# LongHub OpenClaw Bridge

LongHub OpenClaw Bridge 是龙枢内置的 OpenClaw 工具插件。它把模型发起的原生工具调用转发给 LongHub Core，同时确保 `agentId`、`sessionKey`、`sessionId` 和 `toolCallId` 只来自 OpenClaw 运行时，而不是模型参数。

## 当前能力

- 注册只读 `longhub_resume_screen` 和写权限 `longhub_offer_letter`，仅供已授权的 HR Agent 使用。
- 工具参数只包含业务输入；身份、会话、权限、确认和预算字段均不在 schema 中。
- Factory 缺少任一可信上下文字段时不创建工具（fail closed）。
- 通过随机启动令牌保护的 `127.0.0.1` HTTP RPC 调用 Desktop，再由 Desktop 转发到 Core。
- Core 按已验签 Profile/Pack 原始声明和在线 entitlement 复验重新计算权限与预算，调用方不能授予权限。
- 录用通知工具的候选人、岗位、薪资和日期经过严格解析；Core 根据受信声明生成展示载荷，Desktop
  确认期间保持同一个 ToolCall 等待，批准后只重试完全相同的绑定请求。
- 对业务参数、RPC 请求和返回错误使用严格、有限大小的数据结构。

## 运行方式

Desktop 在 Gateway 启动前完成以下配置：

1. 将本包目录加入 `plugins.load.paths`，启用 `longhub-tool-bridge`。
2. 只在 HR Agent 的 `tools.allow` 中加入 `longhub_resume_screen`；`main` 不开放该工具。
3. 启动仅监听 `127.0.0.1` 的 Bridge Host，并生成 256-bit 随机令牌。
4. 只通过 Gateway 子进程环境变量注入 `LONGHUB_BRIDGE_URL` 与 `LONGHUB_BRIDGE_TOKEN`。
5. Core 保留 Profile/Pack/租户/设备权限来源，在每次执行前在线复验 entitlement 与 Pack 版本。

本包不要求用户填写 URL、令牌、模型或权限配置。

## API 概览

| API | 用途 |
|---|---|
| `createLongHubToolFactory()` | 从 OpenClaw factory 上下文绑定可信身份并创建工具 |
| `createLongHubBridgeClient()` | 创建仅允许回环 HTTP 端点的受限 RPC 客户端 |
| `parseBridgeExecuteRequest()` | 严格解析 `skillId/input/context` 请求 |
| `parseResumeScreenInput()` | 校验简历初筛输入并拒绝额外身份或权限字段 |
| `parseOfferLetterInput()` | 校验录用通知四个业务字段并拒绝 approved/身份/权限等额外字段 |
| `LONGHUB_BRIDGE_SKILL_PERMISSIONS` | 声明当前 Bridge 可调用技能及其最小权限 |

## 开发验证

```powershell
pnpm --filter @longhub/openclaw-bridge test
pnpm --filter @longhub/openclaw-bridge typecheck
pnpm --filter @longhub/openclaw-bridge plugin:validate
```

## 当前限制

录用通知书已作为 Confirmation Center V1 的真实写权限验收载体；Feature Policy 必须在线允许
skill.catalog 才会进入 Core policy，离线缓存不会开放写工具。JD 起草仍存在从 OpenClaw 回调
OpenClaw 的递归风险，薪酬带宽依赖云端技能，这两项继续保持关闭。

详细边界见 [DESIGN.md](DESIGN.md)。
