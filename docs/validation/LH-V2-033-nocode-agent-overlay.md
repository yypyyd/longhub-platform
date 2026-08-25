# LH-V2-033 无代码 Agent 覆盖层验收

> 状态：代码完成  
> 日期：2026-07-31

## 结果

- 用户覆盖层与签名 Agent Profile 分文件保存，不修改或重签官方 Profile。
- 只允许显示级和内容级字段；模型、权限、工具、插件、MCP、Gateway 与凭据字段不可表达。
- owner hash 与 Agent 双重绑定，跨 owner 导入重新生成用户来源身份。

## 证据

- `apps/longhub-desktop/src/nocode-agent-overlay.ts`
- `apps/longhub-desktop/src/nocode-workspace-service.ts`
- `apps/longhub-desktop/test/nocode-workspace-service.test.ts`
