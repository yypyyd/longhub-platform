# LH-V2-021 可恢复会话删除验收

> 状态：代码完成  
> 日期：2026-07-31

## 结果

- 会话删除先进入带明确保留期的回收状态，可恢复且不改变 Agent 归属。
- 永久删除使用一次性、目标绑定的显式确认；过期、重放或对象变化均拒绝。
- 存储维护不会按配额自动删除会话或回收记录。

## 证据

- `apps/longhub-desktop/src/session-management.ts`
- `apps/longhub-desktop/test/session-management.test.ts`
- `pnpm ci:full` 通过。
