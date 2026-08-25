# LH-V2-034 跨 Agent 摘要转交验收

> 状态：代码完成  
> 日期：2026-07-31

## 结果

- 转交先生成可预览摘要，再由用户对目标 Agent 与摘要内容进行一次确认。
- 只传确认后的摘要，不传原始 transcript、记忆、权限、entitlement 或历史确认记录。
- 目标变化、取消、过期和确认重放均拒绝。

## 证据

- `apps/longhub-desktop/src/agent-handoff.ts`
- `apps/longhub-desktop/test/nocode-agent-handoff-import.test.ts`
- `apps/longhub-desktop/test/product-extension-window-e2e.test.ts`
