# LH-V2-035 OpenClaw 纯内容 Skill 降权导入验收

> 状态：代码完成  
> 日期：2026-07-31

## 结果

- 只读取可证明为纯内容的 `SKILL.md`，转换为用户来源、零权限 Content Skill。
- 脚本、插件、MCP、命令、远程加载、链接和扩展名伪装均拒绝，不继承原 Skill 信任或权限。
- 导入后必须重新选择目标 Agent，并使用当前 owner 身份原子保存。

## 证据

- `apps/longhub-desktop/src/openclaw-content-importer.ts`
- `apps/longhub-desktop/test/nocode-agent-handoff-import.test.ts`
- `packages/longhub-openclaw-compat/tests/compat.test.ts`
