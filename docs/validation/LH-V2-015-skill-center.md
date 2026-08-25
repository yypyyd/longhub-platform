# LH-V2-015 Skill Center 验收

> 状态：代码完成  
> 日期：2026-07-31

## 结论

- “能力”子窗口展示发布方、执行位置、权限、确认类别和费用上限，并要求显式选择目标 Agent。
- 固定 IPC 只允许 read/install/enable/disable/upgrade/rollback/uninstall，动作请求绑定一次性 nonce。
- Renderer 保持 sandbox、无 Node、无通用 IPC；错误只显示固定状态，不透传 Cloud/Gateway 原始文本。
- Cloud 引用由预置信任根验签；在线签名公钥不能成为自身的信任来源。

## 证据

Skill Catalog/Center 专项 3 项、Product Extension 契约测试和真实 Electron E2E 通过。E2E 覆盖双 Agent、
权限/费用/runtime 预览、首次 Gateway 失败三方恢复、关闭重开、成功重试以及最终 enabled 状态。
