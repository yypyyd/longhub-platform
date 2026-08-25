# LH-V2-013 Skill Runtime 语义验收

> 状态：代码完成  
> 日期：2026-07-31

## 结论

- `builtin` 只允许随 Desktop 构建的固定 Worker implementation ID，用户动作显示为“启用”，不下载代码。
- `declarative` 只接受受约束 Markdown/JSON 数据入口，动作显示为“安装”，不提供脚本解释器。
- `cloudRef` 只保存 allowlist 中的逻辑 service ID，动作显示为“安装引用”，不接受任意 URL。
- Worker 的可执行集合直接由 `BUILTIN_WORKER_IMPLEMENTATIONS` 导出，未知 runtime 或实现均失败关闭。

## 证据

`skill-runtime-policy.test.ts` 5 项通过；共享 Skill Package 测试覆盖 native、脚本、插件、MCP/URL 等未知
字段拒绝。Node 25.9 Desktop 全量 261 项通过。

## 边界

OpenClaw plugin tools 仍是随包静态实现；当前通过 Core Bridge policy 隐藏和阻断未启用 builtin，不把
Registry 状态宣称为动态安装任意 Gateway 插件。
