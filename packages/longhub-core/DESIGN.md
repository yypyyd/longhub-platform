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
- 敏感确认绑定 Agent、Profile 版本、Session、ToolCall、权限和规范化输入摘要，五分钟过期且
  一次性消费。
- 旧 `task.submit` 只能执行零权限技能；调用方预算只能降低，不能抬高 Core 上限。
- Bridge policy 可由可信 Desktop Core RPC 动态整表替换；Pack 停用/撤销时先更新 Core，再移除
  OpenClaw Selector，保证已打开会话没有执行窗口。

## 安全边界与威胁模型

防御模型伪造身份/权限、Profile 越权声明、Pack/Profile 不一致、授权撤销后的继续执行、确认重放、
参数替换和预算抬高。云端复验不可达、策略字段缺失或交集不足时全部拒绝执行。

Skill Worker 仍需检查 Core 下发的权限；签名只验证 Pack 来源与完整性，不能证明业务逻辑安全。

## 已知限制

- 当前只向 OpenClaw 暴露只读简历初筛，因此确认事件尚未接入 Control UI 的交互卡片。
- 租户/设备策略当前使用 Desktop 产品安全上限；后台持久化策略管理将在后续控制面任务扩展。
- entitlement Selector 同步默认 30 秒轮询；Core 仍逐次在线复验，因此同步延迟不会放宽执行授权。
- 受限 Workflow 和可见多 Agent DAG 尚未实现。未来工作流本身不能携带权限或把一次确认传给多个
  步骤；Core 必须为每个子 Skill 分别复验可信上下文、entitlement、权限、预算和确认。
- 跨 Agent 摘要转交只能传递用户确认的内容，不能继承来源 Agent 的权限、记忆或确认记录。详细边界见
  [../../PRODUCT_FEATURE_POLICY.md](../../PRODUCT_FEATURE_POLICY.md) 和
  [../../SKILL_PLATFORM.md](../../SKILL_PLATFORM.md)。
- 实施顺序以 [../../EXECUTION_PLAN_V2.md](../../EXECUTION_PLAN_V2.md) 为准；确认中心先于任何写入型
  Workflow，多 Agent 编排不进入 1.0 范围。

## 变更历史

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
