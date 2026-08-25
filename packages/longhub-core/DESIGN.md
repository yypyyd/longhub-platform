# LongHub Core 设计

## 设计目标

Core 是本地执行的最终安全边界。任何来自模型、Renderer、Profile 文本或 Tool 参数的权限与预算
都不可信；Core 只接受可信上下文和经过签名校验后编译出的原始策略来源。

## 方案选择

采用“静态声明 + 执行前动态复验”：Profile、Pack、租户和设备上限作为独立集合保留，Core 不接收
Desktop 预先计算的 `grantedPermissions`；entitlement 与 Pack 吊销状态由 Core 子进程每次执行前
在线复验。相比只传最终权限，这能保留决策来源并在 Core 内 fail closed。

## 关键决策

- Bridge 工具上下文包含 OpenClaw 注入的 Agent、Session 和 ToolCall 标识。
- 有效权限是 Bridge 最小需求在 Profile、Pack、租户和设备集合中的交集；entitlement 是执行门。
- Bridge 预算来自策略并受 Core 全局上限收敛，模型不能提交预算。
- 敏感确认绑定 Agent、Skill、Profile 版本、Session、ToolCall、权限、规范化输入摘要和可信展示
  载荷，五分钟过期且一次性消费。
- 旧 `task.submit` 只能执行零权限技能；调用方预算只能降低，不能抬高 Core 上限。
- Bridge policy 可由可信 Desktop Core RPC 动态整表替换；Pack 停用/撤销时先更新 Core，再移除
  OpenClaw Selector，保证已打开会话没有执行窗口。

## 安全边界与威胁模型

防御模型伪造身份/权限、Profile 越权声明、Pack/Profile 不一致、授权撤销后的继续执行、确认重放、
参数替换和预算抬高。云端复验不可达、策略字段缺失或交集不足时全部拒绝执行。

Skill Worker 仍需检查 Core 下发的权限；签名只验证 Pack 来源与完整性，不能证明业务逻辑安全。

## 已知限制

- 已以录用通知书写工具贯通确认中心；其他写 Skill 必须先增加受信展示声明和独立验收，不能自动继承。
- 租户/设备策略当前使用 Desktop 产品安全上限；后台持久化策略管理将在后续控制面任务扩展。
- entitlement Selector 同步默认 30 秒轮询；Core 仍逐次在线复验，因此同步延迟不会放宽执行授权。
- 受限 Workflow Engine 已实现静态 DAG 顺序执行、逐步骤可信上下文、entitlement、权限、预算、确认
  与幂等检查；工作流本身不能携带权限或把一次确认传给多个步骤。任意代码、循环和递归仍不在边界内。
- 跨 Agent 摘要转交只能传递用户确认的内容，不能继承来源 Agent 的权限、记忆或确认记录。详细边界见
  [../../PRODUCT_FEATURE_POLICY.md](../../PRODUCT_FEATURE_POLICY.md) 和
  [../../SKILL_PLATFORM.md](../../SKILL_PLATFORM.md)。
- 实施顺序以 [../../EXECUTION_PLAN_V2.md](../../EXECUTION_PLAN_V2.md) 为准；确认中心先于任何写入型
  Workflow，多 Agent 编排不进入 1.0 范围。

## 变更历史

### 2026-07-31 - 实现受限 Workflow 逐步骤执行边界

**变更内容**：新增受限 Workflow Engine，对静态验证后的步骤逐一执行 Core policy、预算、确认与幂等
检查，并拒绝企业策略禁止的外部写入。

**变更理由**：用户组合能力不能成为新的权限来源，也不能因重试或一次确认造成重复副作用。

**影响范围**：Core Runtime、Workflow DSL、Desktop 无代码工作台和跨 Agent 转交。

### 2026-07-30 - Confirmation Center V1 可信绑定

**变更内容**：确认请求增加 skillId 和 Core 计算的 display；display 与真实参数一起进入 binding，
严格解析子进程事件，并以五分钟一次性状态机处理批准、拒绝、过期、重放和策略纪元替换。

**变更理由**：只有参数摘要无法向用户可信展示实际动作；若展示不进入 binding，确认 UI 可与执行参数
分离并形成确认伪造。

**影响范围**：Core 授权原语、Bridge execute、Core RPC 事件和 Desktop 确认中心。

### 2026-07-30 - 约束用户工作流与多 Agent 编排授权

**变更内容**：明确受限 Workflow 每个子 Skill 逐次鉴权、确认和计量，跨 Agent 转交不继承权限。

**变更理由**：用户组合能力不能把工作流变成新的权限来源，也不能破坏现有 Agent 隔离。

**影响范围**：Core 任务图、Bridge policy、确认记录、预算和后续 Workflow Engine。

### 2026-07-29 - 支持运行时策略撤销

**变更内容**：CoreRuntime 增加 Bridge policy 整表替换，Core 子进程新增白名单
`bridge.policy.replace` RPC。

**变更理由**：Pack 手工停用不等于云端 entitlement 撤销，二者都必须让已打开会话立即失去工具授权。

**影响范围**：Core Runtime、Desktop Core RPC 和 Pack 生命周期事务。

### 2026-07-29 - 完整授权交集

**变更内容**：增加独立权限来源交集、在线 entitlement 复验、预算收敛和一次性人工确认。

**变更理由**：执行权限必须由 Core 决定，不能信任可被调用方控制的权限、确认或预算参数。

**影响范围**：Core Runtime、Core RPC、Desktop Bridge 策略与云端复验。
