# @longhub/core

LongHub 的本地执行内核，负责白名单 RPC、任务状态、技能调度、预算上限和最终授权决策。

它存在于 Desktop/Main 与 Skill Worker 之间，确保模型、Renderer、Profile 文本和工具参数都不能
自行授予企业权限。需要权限的 OpenClaw 工具必须携带运行时注入的可信 Agent/Session/ToolCall
上下文，经 Core 复验 entitlement、计算权限交集并按需完成人工确认后才能执行。

## 核心职责

- 管理本地任务和事件状态。
- 计算 Profile、Pack、entitlement、租户、设备、确认和预算的执行交集。
- 接受 Desktop 生命周期协调器原子替换当前有效 Bridge policy；停用 Agent 的旧会话立即失去授权。
- 将最终权限和收敛后的预算传给隔离 Skill Worker。
- 对写权限 Skill 只接受签名内置声明，由 Core 从已绑定业务参数计算动作、对象、接收方、数据范围和
  费用展示载荷；展示载荷与 Agent/Profile/Session/ToolCall/权限/参数摘要一起绑定并一次性消费。
- 拒绝未知 RPC 方法及调用方提交的权限。

不负责 OpenClaw UI、Pack 下载、签名校验或云端策略配置；这些由 Desktop 和 Cloud API 负责，
Core 只消费经过验证的静态声明并在执行前复验动态授权。

受限 Workflow 已以 Core 为最终边界：静态验证后的每个子 Skill 分别复验身份、授权、预算与确认，
执行记录按 workflow/run/step 幂等；跨 Agent 摘要不继承来源权限或记忆。规划与验收见
[普通用户功能开放策略](../../PRODUCT_FEATURE_POLICY.md) 和
[Skill 开放设计](../../SKILL_PLATFORM.md)；任务顺序以
[V2 执行计划](../../EXECUTION_PLAN_V2.md) 为准。

## 依赖关系

Desktop 的 Core 子进程使用本包，Skill Worker 实现 `SkillExecutor`；本包不依赖 Electron。

## 快速使用

```ts
const runtime = new CoreRuntime({
  executor,
  bridgePolicy,
  verifyBridgeEntitlement: async () => ({ active: true, expiresAt: "2099-01-01T00:00:00.000Z" }),
  onEvent() {},
});

runtime.replaceBridgePolicy(nextPolicy);
```
