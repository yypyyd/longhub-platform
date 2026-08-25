# LH-V2-030 Content Skill 验收

> 状态：代码完成  
> 日期：2026-07-31

## 结果

- 共享 Schema 严格限制内容、来源、大小与字段；用户 Skill 默认零权限且无代码入口。
- 工作台支持创建、导入、导出，并在跨设备/owner 导入时重新生成用户身份。
- 官方/第三方冒充、权限、脚本、插件、MCP、远程加载和未知字段均拒绝。

## 证据

- `packages/longhub-pack-schema/src/user-content-skill.ts`
- `apps/longhub-desktop/src/nocode-workspace-service.ts`
- `apps/longhub-desktop/test/nocode-workspace-service.test.ts`
