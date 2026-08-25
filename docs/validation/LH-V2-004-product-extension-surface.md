# LH-V2-004 Product Extension Surface V1 验收

> 状态：代码完成  
> 日期：2026-07-30

## 冻结契约

- Schema：longhub/product-extension-surface/v1
- OpenClaw 入口：longhub-extension://open/agents、/skills、/account
- 签名资源 origin：longhub-product://app
- 子窗口路由：/agents、/skills、/account、/confirmations
- IPC：context-read、window-close；006 追加 confirmation-read/approve/deny 三个单用途 channel
- 摘要：50EE109D6EA808160143517B0466C41D0A2DB8A5ECA3746A1702A898B4D46939

窗口参数固定为 contextIsolation=true、sandbox=true、nodeIntegration=false、webSecurity=true 和
allowRunningInsecureContent=false。动作请求严格包含 schema_version、UUID window_id、route entry、
固定 action 和 43 字符 base64url nonce；nonce 必须由窗口持有者一次性消费。

## 自动化证据

| 门禁 | 结果 |
|---|---|
| @longhub/openclaw-compat typecheck/build | 通过 |
| compat 契约测试 | 1 文件、9 项通过 |
| 入口相似 URL/参数/凭据拒绝 | 通过 |
| 独立 origin 固定路由导航 | 通过 |
| 跨窗口、字段走私和 nonce 重放拒绝 | 通过 |

## 威胁模型

| 威胁 | 契约控制 |
|---|---|
| 聊天内容伪造设置或任意入口 | 只解析三个固定 scheme/host/path，拒绝 query、fragment 和凭据 |
| 主 WebUI 获取本机能力 | 主窗口保持无 preload/Node/IPC，只允许入口导航 |
| 子窗口跳转 Cloud/网页/设置 | 独立 origin 加四路由精确白名单 |
| 跨窗口 confused deputy | window_id、entry、action 同时绑定 |
| 重放 | 32 字节 nonce 一次性消费 |
| Renderer 字段走私 | 严格字段集合，未知字段拒绝 |
| Cloud 替换产品页面 | 资源 origin 只允许签名应用资产，不接收远端 HTML |
| UI 绕过授权 | Feature Policy 与 Core 保持最终执行复验 |

## 后续实现约束

004 冻结契约，不声称三个产品入口已经可见。005 必须使用本契约注册 secure/standard scheme、创建
真实 sandbox BrowserWindow、实现最小 preload 并完成直接路由和视觉 E2E；006 在 confirmations 路由
实现可信确认载荷。任何新增 IPC 或 capability handle 都需要升级契约并补威胁测试。
