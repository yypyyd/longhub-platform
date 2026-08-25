# Native Runtime / Gateway Manager

`internal/runtime` 只管理用户系统原生的 Node.js/OpenClaw。它不复制运行时到 LongHub 目录、不读取
OpenClaw 私有数据库，也不按端口或未知 PID 强制结束进程。

## 当前能力

- `NativeAdapter` 优先通过 `PATH` 发现 `openclaw`、`node` 和 `npm`；Windows 下还检查用户 npm 全局 shim
  目录，必要时通过固定的 `npm prefix -g` 只读解析全局安装位置。它检查版本兼容性，并执行固定的官方
  npm 安装计划和公开 CLI 白名单动作。
- `GatewayManager` 通过 `OpenClawGatewayController` 调用固定的
  `openclaw gateway status/health/start/stop/restart`，把已存在的 Gateway 标记为
  `running_external`，只有本次 Manager 明确启动成功后才标记为 `running_managed`。
- `ControlWithLaunchHooks` 在同一个 `actionMu` 临界区内、且仅在确实要执行 `start/restart` 时调用上层
  prepare/finalize；拒绝、状态查询、stop 和幂等 start 不触发。LongHub 用它把一次性 enrollment 的
  `.env` 写入/回滚与固定 CLI 启动命令绑定，runtime 本身不接触任何凭据或配置内容。
- 停止/重启需要显式确认；外部 Gateway 未确认时只读展示，不执行任何命令。Manager 重启后会丢弃本地
  所有权标记，避免误停用户自行启动的进程。
- `GatewayController` 是跨平台 seam。`WindowsProcessController` 已提供固定 Scheduled Task ownership probe
  和确认门禁下的注册/删除事务：只操作 `\LongHub\OpenClaw Gateway`，并要求 owner marker 精确为
  `longhub/manager-gateway/v1`、Action 为绝对原生 `openclaw`/`openclaw.cmd`/`openclaw.exe` 加精确参数
  `gateway run`。注册不使用覆盖参数，注册后重新证明完整契约；删除前也重新证明所有权。任务缺失视为
  external；同名任务的路径、marker、Action 或 XML 不匹配时保持 unknown，绝不覆盖或删除。
- 注册后若无法重新证明所有权，Manager 返回固定失败且保留现场，不执行按名称回滚，避免删除在竞争窗口中
  被其它本机进程替换的任务。Scheduled Task 不检查 PID/端口，也不负责启动、停止或强杀 Gateway；运行中
  的 Gateway 生命周期继续委托 OpenClaw 官方 CLI。非 Windows 构建明确返回 unsupported。

## 管家 HTTP 控制契约

`POST /api/v1/runtime/control` 只接受严格 JSON `{ "action": "...", "confirm": true|false }`，动作固定为：

- `status`、`health`：只读，返回有界的 `GatewayStatus`，不会把原始 CLI 输出交给页面。
- `task-status`：只读返回固定任务的 `enrolled`、`not_enrolled`、`conflict`、`unsupported` 或
  `unavailable`，不返回任务 XML、本机命令路径、触发器或调度器诊断。
- `start`、`stop`、`restart`：经过 `GatewayManager` 的所有权/确认门禁；只有实际会改变状态时才执行动作，
  页面必须明确发送 `confirm: true`。Manager 进程启动前已存在的实例标记为 `running_external`，未确认时停止/重启返回
  `EXTERNAL_GATEWAY_CONFIRMATION_REQUIRED`。
- `enroll-task`、`remove-task`：注册或删除上述固定的 Windows 自动启动任务，必须明确发送 `confirm: true`；
  页面不能传入任务名、路径、命令、参数、触发器或 XML。
- `doctor`、`skills`：只读诊断/技能列表，沿用受限 CLI 输出。

未知字段、尾随 JSON 或不在白名单内的动作会在执行命令前拒绝。生命周期错误只返回稳定代码
（例如 `USER_CONFIRMATION_REQUIRED`、`OPENCLAW_NOT_INSTALLED`、`GATEWAY_STATUS_UNAVAILABLE`），不返回
底层命令的原始诊断内容。

## 使用示例

```go
manager := runtime.NewGatewayManager(runtime.OSCommandRunner{})
status := manager.Discover(ctx)
if status.State == runtime.GatewayInstalledStopped {
    started, err := manager.Start(ctx, true) // UI 必须先取得用户确认
    _ = started
    _ = err
}

taskProbe := runtime.NewWindowsProcessController()
ownership, err := taskProbe.InspectOwnership(ctx) // 只读固定任务，不接受页面传入路径
_ = ownership
_ = err

status, err = manager.EnrollScheduledTask(ctx, true) // 固定任务注册，同样要求用户确认
_ = status
_ = err
```

页面/模型不能传入命令、参数、PID、端口、任务名或工作区路径。ownership probe 已接入
`GatewayManager` 状态判定：Windows 上，当进程本地所有权未知且 Gateway 正在运行时，Manager 会做一次
有界只读探测；只有固定任务契约完整验证通过才把状态升级为 `running_managed`，探测失败、unknown、
unsupported 或身份不匹配一律保持 `running_external`。探针不会替代确认门禁——停止/重启仍要求
`confirm: true`，也不会把现有原生 `\OpenClaw Gateway` 任务认作 LongHub 所有。真实 Windows
验收必须覆盖任务不存在、合法任务注册/删除和 stopped/running、同名伪造、注册后身份漂移、权限拒绝、
查询超时和非 Windows 构建。
若未来 Action 改为 Manager-owned wrapper，必须升级 marker/契约版本并重新做安全评审，不能在 v1 marker
下放宽 Action 匹配。
