# LH-036-07 原生 Agent Selector E2E 与隔离报告

> 验收日期：2026-07-29  
> LongHub Desktop：0.3.6  
> OpenClaw：2026.7.1-2  
> 范围：`main + longhub.agent.hr`

## 结论

LH-036-07 通过。用户在 OpenClaw Control UI 内可直接切换“龙枢助手”和“HR 助理”；首次进入 HR
会恢复最近历史，没有历史时使用独立 `agent:<hrAgentId>:main`。活动执行中不会热换身份，必须确认
停止并等待原生 Stop 状态结束。entitlement 撤销或 Pack 停用后，HR 历史仍保留，但 HR 不再是
可选 Agent，当前页面明确回退 `agent:main:main`。

## 真实 UI 场景

自动化使用锁定版 OpenClaw Gateway、真实 `/chat` Control UI 和独立 Electron BrowserWindow，按
1200 × 800 产品窗口运行：

| 场景 | 预期 | 结果 |
|---|---|---|
| Gateway `agents.list` 返回 main + HR | 页面出现两个可读名称 | 通过 |
| 上游首次只渲染 default agent | 薄适配层补齐原生样式 Selector | 通过 |
| 首次点击 HR | 进入 `HR 最近会话`，不是 main 会话 | 通过 |
| HR 无历史 | 使用 `agent:<hrAgentId>:main` | 通过 |
| 当前会话有活动执行 | 先保持原 Agent，确认并触发 Stop | 通过 |
| Stop 结束 | 才完成目标 Agent 切换 | 通过 |
| HR 撤销但历史仍存在 | Selector 不再显示 HR | 通过 |
| 当前 HR 被撤销 | URL 明确进入 `agent:main:main` | 通过 |

测试入口：`apps/longhub-desktop/test/openclaw-selector-e2e.test.ts`；Electron 驱动器：
`apps/longhub-desktop/test/fixtures/openclaw-selector-runner.cjs`。

## 隔离矩阵

| 边界 | main | HR | 证据 |
|---|---|---|---|
| 身份 | 内置“龙枢助手”文件 | 签名 Profile 的 HR 身份文件 | Composer/activation 测试与真实 UI 名称 |
| workspace | `openclaw/workspace` | `openclaw/workspaces/<hrAgentId>` | 路径断言、独立模板落盘 |
| agentDir | `agents/main/agent` | `agents/<hrAgentId>/agent` | Composer 与 Gateway 配置校验 |
| 会话 | `agent:main:*` | `agent:<hrAgentId>:*` | 点击 E2E、最近会话恢复、不可改绑 |
| session store | `agents/main/sessions` | `agents/<hrAgentId>/sessions` | 激活和停用保留测试 |
| memory | 当前 Agent scope | 当前 HR Agent scope | `memory` scope 与跨会话工具拒绝断言 |
| 工具可见性 | 不含 HR 企业工具 | 仅签名 Profile 允许的 HR 工具 | Composer allowlist 与 runtime inspect |
| 最终执行权 | Core policy 无 HR grant | Profile/Pack/entitlement 交集 | Bridge/Core 授权与撤销测试 |

Selector 只决定可见性和会话导航，不是安全授权。即使用户持有旧 HR URL 或页面尚未同步，Core
仍在每次工具执行前在线复验 entitlement，并在无法确认时 fail-closed。

## 上游兼容发现

OpenClaw 2026.7.1-2 有两个需要锁版测试的行为：

1. `agents.list` 已包含多个 Agent 时，聊天启动状态仍可能只渲染 default agent，导致原生 Selector
   暂时不存在。
2. Selector 会从历史会话重新枚举 Agent，因此只从 `agents.list` 删除 HR 不能保证其从 UI 消失。

LongHub 适配层只做三件事：使用上游原生 class/语义属性补齐入口、调用上游 `selectAgent()`、按
Desktop 已启用集合过滤选项。它不复制聊天页、不保存 transcript，也不获得 preload、Node 或 IPC。

## 后续门禁

- OpenClaw 版本变化时必须重跑本 E2E，并检查 `data-chat-agent-filter`、`selectAgent()`、Stop 控件和
  session URL 语义。
- LH-036-08 继续验证 Gateway 重启、Pack 升级/回滚、客户端升级和已有 OpenClaw 共存后的稳定性。
- 0.3.7 将该薄层纳入统一 `openclaw-compat` 版本与截图基线，避免选择器变化静默进入发布版。
