# LH-V2-032 Workflow Core 子步骤门禁验收

> 状态：代码完成  
> 日期：2026-07-31

## 结果

- 每个 Workflow 步骤分别经过 Core 身份、entitlement、权限、预算、确认与幂等检查。
- 运行/步骤键防止重试产生重复本机副作用；确认只绑定一个步骤和规范参数。
- 企业策略禁止的外部写入在最终执行边界拒绝，不依赖 UI 隐藏。

## 证据

- `packages/longhub-core/src/workflow-engine.ts`
- `packages/longhub-core/test/workflow-engine.test.ts`
- `packages/longhub-core/test/authorization.test.ts`
