# LH-040-09 Gateway 运行时恢复与产品化错误页验收记录

> 日期：2026-07-30  
> 状态：代码与自动化验收完成；未部署、未重打候选  
> 线上版本：0.3.7（保持不变）

## 目标

补齐 Supervisor 与用户主窗口之间的运行时闭环。Gateway 异常退出后，客户端应限频恢复并向用户显示
安全、可理解的固定状态；恢复成功仍直接进入 OpenClaw 原生 `/chat`，不新增业务面板，也不让原始
异常、模型配置或基础设施信息进入页面。

## 实现结果

### 连续失败与真实健康

- Supervisor 在每次异常退出、退避开始时发出 `restarting`，默认按 1s、2s、4s 指数退避。
- 退出码 78 明确归类为配置错误，不执行无意义重试；超过重启上限进入 `failed`。
- `running` 只代表子进程存在。首次启动和运行中恢复都要求同源 `GET /chat` 返回 2xx 且
  `content-type` 为 HTML；单纯 PID、TCP 端口、JSON 或 5xx 均不算健康。
- 只有真实健康后才清零 Supervisor 计数，因此阈值表示连续失败，不累计互不相关的历史退出。
- 进程退出会立即终止探测；recovery cycle 丢弃旧进程迟到结果，终止错误页不会被旧成功结果覆盖。

### 主窗口恢复

- 运行中退出立即显示“正在恢复聊天服务”，不要求用户修改模型、Gateway 或 Token。
- 新进程真实健康后自动重新加载现有 OpenClaw 原生 `/chat`，再恢复产品 UI 和 Selector 薄策略。
- 配置错误显示 `LH-GW-002`，重启耗尽显示 `LH-GW-003`；健康进程无法提供聊天页时显示服务不可用。
- 更新 pending 期间，状态页不会触发 `markHealthy`；仍只有允许的真实 `/chat` 加载完成才能清除
  180 秒自动回滚计时器。

### 产品错误分类与泄漏边界

稳定分类覆盖：

- 云端不可达 `LH-CL-001`；
- 设备凭据失效 `LH-AU-001`；
- 设备需要激活 `LH-AU-002`；
- 后台模型未配置 `LH-MD-001`；
- 限流 `LH-UP-001` 与上游服务不可用 `LH-UP-002`；
- Gateway 配置、重启耗尽、启动超时及 WebUI 加载失败。

状态页函数只接受上述枚举，不能接收 Error 或自由文本。HTML 仅含白名单中文文案和短错误码，使用
`default-src 'none'` CSP，不含脚本。测试把 Bearer Token、Windows 用户路径和上游 URL 放入原始异常，
确认页面均不包含这些值。主 OpenClaw BrowserWindow 继续保持 `sandbox=true`、
`contextIsolation=true`、`nodeIntegration=false`，且没有 preload 或新增 IPC。

## 自动化证据

- `product-error-page.test.ts`：错误分类、固定回退、白名单页面、CSP 和敏感文本不泄漏。
- `gateway-runtime-recovery.test.ts`：重连状态、真实健康恢复、终止分类、迟到结果隔离、HTML 门槛和中止。
- `gateway-supervisor.test.ts`：退避状态、配置错误不重试、重启耗尽与健康后连续失败复位。
- Desktop 全量测试、类型检查、Lint 和构建通过；全仓验证与三项质量门禁结果见下节。

## 验证结果

- 定向新增/相关测试：3 个文件、26 项通过。
- 全仓 60 个测试文件、271 项通过；4 项 PostgreSQL 外部环境测试按条件跳过。
- 17 个 workspace 的 `typecheck`、`lint`、`build` 全部通过；Desktop 全量为 38 个文件、157 项通过。
- Desktop 安全扫描 51 个文件，Critical/High/Medium/Low 均为 0。
- Desktop 质量门禁通过；只有既有 `main.ts` 超过 500 行的结构性警告，本轮新增恢复与页面逻辑已拆为
  两个独立纯模块，未继续把分类和状态机堆入 Main。
- 变更门禁和 `git diff --check` 通过；README、DESIGN、ROADMAP 与本记录已同步。

## 未包含范围

- 本项不增加通用诊断导出、日志轮转、运行配置离线缓存或遥测上报；这些仍按 0.4.0 路线推进。
- OpenClaw 聊天正文中的单次模型错误仍由锁定版原生 UI 呈现；本项的安全页面负责 Desktop 启动与
  Gateway 生命周期边界，不通过 preload/IPC 拦截聊天内容。
- 正式 Update 公钥、Authenticode 证书和正式图标仍未取得；当前 Node 24.14.0 低于打包下限
  24.15.0，因此未重打候选。
- 线上 0.3.7 未被覆盖；本轮未连接生产、未上传安装包、未改变 rollout，也未创建或删除线上备份。
