# LH-037-02 龙枢 UI 产品化验收

> 验收日期：2026-07-29  
> LongHub Desktop：0.3.6 内部候选  
> OpenClaw：2026.7.1-2  
> 当前兼容契约 SHA-256：`0A59AE77AED4081717E57A5211150F62A1C15569BBF0F92EE0714EE5E903F030`

## 结论

LH-037-02 通过。客户端仍直接使用锁定版原生 Control UI，但窗口、页面、欢迎区和错误页已统一为
龙枢品牌与中文体验。普通用户看不到 OpenClaw、Gateway、Token、Provider、模型 ID 或内部
`agent:` 会话键；管理导航、命令搜索、设置/文档入口及管理员欢迎建议不可见。Agent Selector、
最近会话、执行中停止、撤销回退和无 Node/preload/IPC 边界保持正常。

## 产品体验矩阵

| 检查项 | 结果 |
|---|---|
| 窗口与文档标题为“龙枢” | 通过 |
| 侧边栏、移动顶栏、面包屑品牌为“龙枢” | 通过 |
| 页面、主助手和应用使用统一龙枢头像 | 通过 |
| `html.lang` 为 `zh-CN` | 通过 |
| `Main Session` 显示为“龙枢助手会话” | 通过 |
| `Done`、`responding` 等运行状态中文化 | 通过 |
| 会话正文与悬停标题均不显示 `agent:` key | 通过 |
| 管理导航、设置/文档、命令搜索不可见 | 通过 |
| 频道配置、系统健康管理员建议不可见 | 通过 |
| 模型控件和真实模型 ID 不可见 | 通过 |
| Main 直接路由仅允许当前同源 `/chat` | 通过 |
| 页面没有 Node、preload 或通用 IPC | 通过 |

## 实现边界

- `openclaw-product-ui` 只处理兼容契约登记的品牌、顶栏、侧边会话、欢迎页、运行状态和固定属性，
  不遍历或替换聊天消息。
- 产品 CSS 隐藏普通用户不需要的 UI；Main 的严格 pathname 白名单阻止手工进入其他同源管理页，
  因此隐藏不是唯一边界。
- `agent:` key 仍保留为 OpenClaw 内部路由标识，但从正文和 session link `title` 中清除。
- 页面继续 sandbox、`contextIsolation=true`、`nodeIntegration=false`，产品化脚本不引入 preload。
- MutationObserver 会丢弃脚本自身产生的记录，避免与上游 Lit 重渲染形成 CPU 反馈循环。

## 图标与视觉

当前头像源为 `apps/longhub-desktop/assets/longhub-avatar-source.png`，PNG/ICO/SVG 由
`scripts/build-icon.py` 确定性缩放和转换。它用于 OpenClaw 原生主 Agent 头像、Control UI 品牌图、
激活页、BrowserWindow、Windows 应用、NSIS 快捷方式、Portal 和 Admin。正式品牌审批和代码签名
仍是公开发布阻断项。

固定 1200 × 800 视口、420 × 220 稳定区域继续通过 LH-037-01 的容差视觉签名。语义断言独立验证
品牌、语言、基础设施词汇、隐藏入口、会话标题和 Agent Selector，不能仅靠颜色相似通过。

## 自动化证据

- `openclaw-product-ui.test.ts`：固定品牌/语言、登记节点、无 `innerHTML`/正文扫描和无 preload 安装。
- `openclaw-product-policy.test.ts`：只允许当前产品聊天 pathname，拒绝设置、任务、Agent 和跨源路由。
- `openclaw-selector-e2e.test.ts`：真实 Gateway + Electron 验证品牌、中文、图标、会话 key、导航、
  模型隐藏、Agent 切换、停止与撤销回退。
- `openclaw-candidate-continuity-e2e.test.ts`：用户独立 OpenClaw 共存、重启与历史状态连续性。

## 全仓验证

- `pnpm test`：26/26 tasks 通过。
- Desktop：25 个测试文件、98 项测试通过。
- `pnpm typecheck`：29/29 tasks 通过。
- `pnpm lint`：29/29 tasks 通过。

## 0.3.6 内部候选包

产品化源码进入候选包后，已使用 Node 25.9.0 重新执行 NSIS 打包并回读 `win-unpacked`：

| 检查项 | 结果 |
|---|---|
| 安装包 | `apps/longhub-desktop/release/LongHub-Setup-0.3.6.exe` |
| 大小 | 159,860,891 bytes |
| SHA-256 | `30995DECF827C689DA76007995B8608BCC8E775BBCF366E67EC538CC2C1596B3` |
| 产品程序 | `龙枢.exe`，ProductName 为“龙枢” |
| 内置 Node | 25.9.0 |
| 内置 OpenClaw | 2026.7.1-2 |
| 兼容层 | 0.1.0，package 与 dist 存在 |
| 产品 UI | `dist/openclaw-product-ui.js` 存在 |
| 产品图标 | PNG 与 ICO 均存在，构建日志无默认 Electron 图标提示 |
| Tool Bridge | manifest 与 dist 存在 |

构建日志仍提示未配置代码签名且 ASAR 未启用；候选包只用于内部验证。

## 后续

下一项为 LH-040-01：配置 Windows 代码签名证书，并在正式视觉稿确定后替换临时图标。0.3.7 的
断网、限流等完整状态页矩阵仍需后续补齐；向上游提交产品模式扩展需求需要单独外部授权。
