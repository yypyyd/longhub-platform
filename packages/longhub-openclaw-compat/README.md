# LongHub OpenClaw Compat

## 模块定位

`@longhub/openclaw-compat` 是 LongHub Desktop 与锁定版 OpenClaw 之间的版本化兼容契约。它集中
声明精确上游版本、产品路由、必要 DOM 语义、Gateway RPC 方法、`replacePaths` 和固定 UI 视口。

## 为什么存在

Desktop 直接复用 OpenClaw Control UI，但部分产品行为仍依赖上游路由、DOM 属性和 RPC 细节。
这些依赖若分散在 Main、CSS 和 Selector 脚本中，上游升级可能静默破坏模型隐藏、Agent 切换或
配置热更新。兼容模块把依赖变成可审查、可哈希、可测试的单一事实来源。

## 核心职责

- 精确锁定并在运行时核对 OpenClaw 版本。
- 管理 `/chat`、普通用户原生路由白名单、受限控制面路由和产品导航选择器。
- 管理 Agent Selector、Stop 控件、会话宿主和模型控件语义。
- 管理龙枢品牌节点、中文 UI chrome、普通用户隐藏入口和可读会话标题语义。
- 管理 `config.get/config.patch/agents.list` 与 `replacePaths` 契约。
- 提供确定性兼容契约摘要和固定 1200 × 800 UI 基线参数。
- 冻结官方原生侧边栏的开放矩阵、Agents/Skills 只读控件边界和单 Agent 常显 Selector；旧扩展窗口契约
  只保留确认、文件和个人数据等 OpenClaw 没有安全原生面的受限能力，不再承担主导航。

它不实现聊天、Pack 生命周期、模型授权或 Core 权限，也不把 UI 隐藏当作安全授权。

## 依赖关系

模块只依赖 Node 标准库；开发测试使用精确版本 `openclaw@2026.7.1-2`。LongHub Desktop 的路由、
Selector、Control UI 地址、Gateway 客户端和启动预检依赖本模块。

## 快速使用

```ts
import {
  inspectOpenClawInstallation,
  OPENCLAW_COMPAT_CONTRACT,
  parseProductExtensionEntryUrl,
  productExtensionRoute,
} from "@longhub/openclaw-compat";

const info = inspectOpenClawInstallation("C:/LongHub/resources/app/node_modules/openclaw/openclaw.mjs");
console.log(info.actualVersion, OPENCLAW_COMPAT_CONTRACT.routes.chatPath);

// 新产品入口只通过严格解析后的固定 ID 打开受限子窗口。
parseProductExtensionEntryUrl("longhub-extension://open/agents");
productExtensionRoute("agents"); // longhub-product://app/agents
```

验证：

```powershell
pnpm --filter @longhub/openclaw-compat typecheck
pnpm --filter @longhub/openclaw-compat test
```

详细设计和升级纪律见 [DESIGN.md](DESIGN.md)。
