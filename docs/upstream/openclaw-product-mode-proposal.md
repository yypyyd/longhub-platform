# OpenClaw 可嵌入产品模式扩展提案（待外部提交）

> 历史/废弃：本文研究的是旧的内嵌 OpenClaw 页面路线，不属于 clean-launch 首发方案，也不应据此
> 修改 Manager 或重新开放 OpenClaw Control UI。

## 背景

LongHub 直接复用 OpenClaw 原生 `/chat`，不构建平行聊天面板。当前品牌、普通用户导航、固定模型和
Agent Selector 限制由版本化兼容薄层完成；上游 UI 结构变化仍会产生适配成本。

## 建议的最小公开扩展点

1. `productMode` 配置：允许设置产品名、Logo/头像、欢迎语、输入框文案和主题色。
2. `navigationPolicy`：用稳定路由 ID 显示/隐藏设置、文档、命令搜索、频道和系统健康入口。
3. `modelSelectionPolicy`：允许宿主声明模型由服务端固定，UI 不渲染选择器但不改变服务端安全边界。
4. `agentCatalogProvider`：允许宿主向原生 Selector 提供可安装 Agent，并通过窄回调触发安装。
5. 稳定语义属性：关键元素提供 `data-openclaw-role`，避免宿主依赖 CSS 类名或文本。

## 安全边界

这些扩展只控制显示与导航，不替代服务端鉴权、模型覆盖、Pack 验签、entitlement 或工具授权。宿主页面
不应因此获得 Node、preload、通用 IPC、Gateway Token 或任意本地文件权限。

## 建议验收

- 默认配置保持 OpenClaw 现有行为，扩展完全向后兼容。
- `/chat` 流式响应、取消、附件和会话恢复不受影响。
- 禁止路由可被宿主策略稳定拦截，且直接 URL 访问也执行相同策略。
- 语义属性和配置 schema 有版本化契约测试。

本文只准备可审查提案；创建外部 Issue 或向上游发送消息需要仓库地址、账号和明确外部发布授权。
