# LH-V2-020 会话管理验收

> 状态：代码完成  
> 日期：2026-07-31

## 结果

- `session-management.ts` 基于 OpenClaw 公开会话 API 提供索引、搜索、置顶、重命名、归档和导出。
- 所有操作绑定当前 Agent；导出使用规范化内容，不向产品窗口暴露内部路径。
- “我的”受限产品窗口已接入上述操作，不增加通用 IPC 或 Node 权限。

## 证据

- `apps/longhub-desktop/test/session-management.test.ts`
- `apps/longhub-desktop/test/product-extension-window-e2e.test.ts`
- `pnpm ci:full`：29/29 任务通过；Desktop 60 文件、278 项通过。
