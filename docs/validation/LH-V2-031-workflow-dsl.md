# LH-V2-031 受限 Workflow DSL 验收

> 状态：代码完成  
> 日期：2026-07-31

## 结果

- Workflow 只表达静态、有限步骤 DAG 和受信 Skill 引用，逐层严格解析。
- 验证器限制步骤、深度、输入和预算，拒绝循环、递归、动态代码与未知动作。
- 工作流不携带权限，不能把一次确认复用到多个步骤。

## 证据

- `packages/longhub-pack-schema/src/workflow-dsl.ts`
- `packages/longhub-pack-schema/test/user-content-workflow.test.ts`
- `packages/longhub-core/test/workflow-engine.test.ts`
