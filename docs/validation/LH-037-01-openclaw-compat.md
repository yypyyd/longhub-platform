# LH-037-01 OpenClaw 版本化兼容层验收

> 验收日期：2026-07-29  
> LongHub Desktop：0.3.6 内部候选  
> OpenClaw：2026.7.1-2  
> 兼容契约：`longhub/openclaw-compat/v1`

## 结论

LH-037-01 通过。OpenClaw 精确版本、产品路由、Agent Selector、Stop 控件、模型与管理入口、
Gateway RPC、`replacePaths` 和固定 UI 基线已经集中到 `@longhub/openclaw-compat`。Desktop 会从
实际内置 `openclaw.mjs` 同目录回读版本；缺失、损坏或版本漂移时拒绝启动未知 Gateway，并进入
可诊断错误页。真实 Gateway + Electron UI 合约和容差视觉签名均通过。

## 兼容契约

| 项目 | 锁定值 |
|---|---|
| OpenClaw | `2026.7.1-2` |
| 聊天入口 | `/chat` |
| Gateway RPC | `config.get`、`config.patch`、`agents.list` |
| 原子替换路径 | `agents.list` |
| UI 视口 | 1200 × 800 |
| 稳定截图区域 | 420 × 220 |
| LH-037-01 初始契约 SHA-256 | `3C7D21B6EA8C4C73BFE8F4D7015B391DDEAE2F71D8081258240C80DE59240157` |

LH-037-02 将品牌、中文化和普通用户导航语义加入同一 v1 契约后，当前摘要更新为
`0A59AE77AED4081717E57A5211150F62A1C15569BBF0F92EE0714EE5E903F030`；初始摘要保留为本项历史证据。

契约摘要用于审查字段变化，不代替锁文件、制品签名或供应链校验。任何摘要更新都必须附真实
Gateway、真实 UI 和升级说明审查证据。

## UI 合约结果

| 检查项 | 结果 |
|---|---|
| Agent Selector 可见并显示中文 Agent 名称 | 通过 |
| 模型控件可见数量为 0 | 通过 |
| 受限管理导航可见数量为 0 | 通过 |
| `selectAgent()` 宿主方法存在 | 通过 |
| 页面无 Node、preload 或通用 IPC | 通过 |
| 最近会话恢复、执行中停止、撤销回退 main | 通过 |
| 固定区域容差视觉签名 | 通过 |

LH-037-01 验收时，合约把以下已知缺口固定为可失败断言：品牌仍出现 `OpenClaw`、`html.lang` 为
`en`、页面出现 `Main Session`。这些缺口现已由 LH-037-02 修复；页面和悬停标题均不显示内部
`agent:` 会话键。

## 视觉基线

稳定区域的派生签名为：

```text
meanRgb: [245, 242, 239]
darkRatio: 0.0011
lightRatio: 0.9619
edgeDensity: 0.0223
```

允许 RGB 每通道 ±4、`darkRatio` ±0.01、`lightRatio` ±0.06、`edgeDensity` ±0.03。采用容差签名是
为了屏蔽并发负载引起的少量动态像素漂移；Agent Selector、模型入口、导航和宿主语义仍使用精确
合约断言，不能仅靠视觉相似通过。

## 自动化证据

- `packages/longhub-openclaw-compat/tests/compat.test.ts`：精确版本、真实包回读、损坏/漂移诊断、
  产品 CSS 来源和契约摘要，共 5 项测试。
- `apps/longhub-desktop/test/openclaw-selector-e2e.test.ts`：真实 Gateway + Electron 的 Agent 切换、
  产品 UI 合约和容差视觉签名。
- `apps/longhub-desktop/test/openclaw-product-policy.test.ts`：模型与受限管理入口策略。
- `apps/longhub-desktop/test/openclaw-gateway-smoke.test.ts`：锁定版 Gateway、固定模型和 `/chat`。
- `apps/longhub-desktop/test/openclaw-runtime.test.ts`：内置运行时路径、版本预检与隔离。

## 全仓验证

- `pnpm test`：26/26 tasks 通过；Desktop 24 个测试文件、96 项测试通过。
- `pnpm typecheck`：29/29 tasks 通过。
- `pnpm lint`：29/29 tasks 通过。
- 定向真实 UI E2E：1/1 通过。

## 0.3.6 内部候选包

源码进入候选包后已使用 Node 25.9.0 重新执行 NSIS 打包并回读 `win-unpacked`：

| 检查项 | 结果 |
|---|---|
| 安装包 | `apps/longhub-desktop/release/LongHub-Setup-0.3.6.exe` |
| 大小 | 159,777,237 bytes |
| SHA-256 | `C4A5BD9C44EE175747E8AD3174EC598CC7FEE0516F04FE149042090DE5B10BA9` |
| 内置 Node | 25.9.0 |
| 内置 OpenClaw | 2026.7.1-2 |
| `@longhub/openclaw-compat` | 0.1.0，`package.json` 与 `dist/index.js` 存在 |
| Tool Bridge | manifest 与 `dist/index.js` 存在 |
| Desktop | `dist/main.js` 与兼容策略编译产物存在 |

构建日志仍提示未配置代码签名、使用默认 Electron 图标且 ASAR 未启用；这些不影响内部候选验收，
但继续阻断公开发布。

## 后续

LH-037-02 已完成品牌、中文化、普通用户导航和可读会话标题，并保持模型隐藏、Agent 切换、
安全边界与兼容门禁。向上游提出可复用产品模式扩展需求仍需获得外部提交授权；公开发布继续受
Windows 代码签名证书和正式视觉稿门禁约束。
