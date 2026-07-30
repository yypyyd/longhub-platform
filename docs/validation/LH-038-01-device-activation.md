# LH-038-01 首次授权码激活验收

> 状态：通过  
> 客户端：LongHub Desktop 0.3.7  
> 日期：2026-07-29

## 验收目标

- 全新设备必须先输入后台签发的授权码，不能直接进入龙枢聊天页。
- 激活成功后才准备模型配置、Core、OpenClaw Gateway 和原生 `/chat`。
- 用户不登录个人账号，不选择模型、Provider、API Key 或 Gateway。
- 授权码撤销、到期或达到使用次数后由服务端阻断，不把 UI 隐藏当作授权边界。
- 激活窗口的临时 IPC 权限不能进入主 OpenClaw WebUI。

## 实现边界

```text
设备注册/复用
  → GET /v1/devices/activation
  → 未激活：独立 Electron 激活窗口
  → POST /v1/devices/activate
  → 成功后：运行配置 → Core → Gateway → 原生 /chat
```

Cloud API 只为未激活设备开放状态查询和核销。授权码为 128-bit 随机值，数据库只保存规范化值的
SHA-256 与尾号；明文仅在管理员创建响应中返回一次。核销事务原子检查状态、有效期和最大设备数，
并创建授权码附带的 Pack entitlement。撤销授权码会使绑定设备失去产品 API 访问权。

Desktop 激活窗口为 `sandbox=true`、`contextIsolation=true`、`nodeIntegration=false`，最小 preload
只提供 `longhubActivation.submit(code)`。Main 校验 sender webContents ID 和精确页面 URL；成功或
关闭后移除 IPC handler。主 OpenClaw 窗口仍无 preload、Node 或 LongHub IPC。

## 自动化证据

### Cloud API

`apps/longhub-cloud-api/test/device-activation.test.ts` 覆盖：

- 注册未激活设备无法获取模型配置。
- 正确、错误授权码与最大使用次数。
- 撤销后模型访问立即失败。
- 明文和摘要不在列表/响应中回显。
- Pack entitlement 随授权码附带。
- 设备换码后不继承旧码套餐。

定向结果：4/4 通过；原有 Cloud API 测试 48 项通过。

### Desktop

- `activation-code-input.test.ts`：3/3 通过。
- `pack-distribution.test.ts` 的 Cloud Client 激活接口：6/6 通过。
- `activation-window-e2e.test.ts`：真实 Electron 1/1 通过。

真实窗口 E2E 验证：

- 520 × 620 逻辑窗口、中文标题/设备信息、授权码输入和激活按钮可见。
- 格式错误不会调用核销函数；有效格式但错误的码显示服务端错误。
- 正确授权码关闭窗口并返回成功。
- 另一个 BrowserWindow 调用相同 channel 被 `激活请求来源无效` 拒绝。
- 页面只暴露 `submit`，`window.process` 和 `window.require` 均不存在。

视觉检查使用真实 Electron `capturePage()`；Windows DPI 缩放下逻辑窗口仍为 520 × 620，卡片、
Logo、中文说明、输入框、主按钮和设备号均完整，无横向溢出或文字遮挡。

### 构建与既有链路

- `longhub-cloud-api` build 通过。
- `longhub-admin-web` build 通过。
- `longhub-desktop` build 通过。
- 全仓 Turbo：test 26/26、typecheck 29/29、lint 29/29、build 17/17 任务通过；Desktop 27 个
  测试文件、103 项测试通过。
- Desktop 分发、Bridge entitlement、Agent provisioning、Config Composer 与 Runtime activation
  定向回归均通过。

内部候选包：

- 文件：`apps/longhub-desktop/release/LongHub-Setup-0.3.7.exe`
- 大小：159,865,897 bytes
- SHA-256：`A9F4BD3255ED0E95B2F6E8F3474741D9BEC96284E8DACC78BCA85E01F2372BD1`
- 内置 Node：25.9.0
- 已核对 `activation.html/css/js`、`activation-preload.js` 和 `activation-window.js` 均进入安装包。
- Authenticode 状态：`NotSigned`，因此只能作为内部候选，不得公开发布。

## 威胁模型与已知限制

- 设备注册不等于授权；所有受保护 API 必须在服务端复验激活状态。
- 高熵随机码和摘要存储用于降低数据库泄露后的离线恢复风险；不能把人为选择的短口令作为授权码。
- 当前激活尝试限流是单 API 实例、按设备十分钟五次。生产 nginx/网关仍需按 IP 和全局共享限流。
- 设备 Token 仍位于 `device.json`；Windows Credential Manager 迁移属于 LH-040-02。
- 已打开会话期间撤销授权，模型与受保护 API 会立即拒绝，但本机 Gateway 不会被强制关闭；客户端
  在下次启动显示激活页，运行中自动回退属于后续体验优化。
- `LONGHUB_ACTIVATION_CODE` 仅用于企业无人值守安装和自动化，仍走同一核销接口，不是绕过开关。

## 结论

LH-038-01 满足“首次输入授权码、以后直接进入、普通用户不配置模型”的当前产品决策。下一安全
优先项是生产入口共享限流、设备凭据迁移 Credential Manager，以及安装包代码签名。
