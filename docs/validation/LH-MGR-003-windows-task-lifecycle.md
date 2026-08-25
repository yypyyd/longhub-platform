# LH-MGR-003 Windows 自动启动任务生命周期切片验收

> 日期：2026-08-16
> 状态：本地代码切片通过；真实 Windows 安装态门禁未关闭

## 覆盖范围

- 只查询和管理固定任务 `\LongHub\OpenClaw Gateway`。
- owner marker 固定为 `longhub/manager-gateway/v1`，Action 只接受绝对原生
  `openclaw`/`openclaw.cmd`/`openclaw.exe` 与精确参数 `gateway run`。
- 注册不使用覆盖参数；同名外部任务不会被覆盖或删除。
- 注册后重新验证完整身份；无法证明时保留现场，不执行按名称的盲删回滚。
- 删除前重新证明完整身份，任务缺失按幂等成功处理。
- HTTP 只接受 `task-status`、`enroll-task`、`remove-task` 固定动作；写操作要求
  `confirm: true`，底层 Windows/调度器错误不进入页面响应。
- 管家页展示 `enrolled`、`not_enrolled`、`conflict`、`unsupported`、`unavailable`
  五种有限状态，并按状态启用注册或移除按钮。

## 安全边界

- 页面不能提交任务名、路径、命令、参数、触发器或 XML。
- 只读状态不返回任务 XML、本机命令路径、触发器、PID、端口或调度器诊断。
- Scheduled Task 只提供自动启动注册和删除，不替代 Gateway 官方 CLI 的
  `start/stop/restart`，也不按 PID/端口结束进程。
- 本机同一用户仍可直接修改自己的系统任务；本切片保护的是 Manager 的远程页面输入、误识别和误删除边界，
  不把同一 OS 用户视为隔离租户。

## 自动化验证

```powershell
cd apps/longhub-manager
go test -count=1 ./...
go vet ./...
node C:\Users\Administrator\.codex\skills\ccg\tools\verify-security\scripts\security_scanner.js apps/longhub-manager
```

结果：

- Manager 11 个 Go 包全部通过 uncached tests。
- `go vet ./...` 通过。
- 安全扫描覆盖 66 个文件，Critical/High/Medium/Low 均为 0。
- 页面脚本通过 Node 语法检查。
- `go test -race ./...` 未执行：当前 Windows Go 环境未启用 CGO；这不是通过结果，后续 CI 仍需提供
  race-enabled runner。

新增/强化的回归包括：

- 注册后身份漂移不会触发按名称删除。
- 同名外部任务不能覆盖或删除。
- `task-status` 对缺失、已注册、外部冲突、不支持和探测失败做稳定收敛。
- 已取消的状态请求不会访问 Task Scheduler。
- HTTP 未确认写操作不会触发系统变更，私有调度器错误不会泄漏。
- 管家页包含固定任务状态和确认控件。

## 本机只读页面验证

本轮在 `127.0.0.1` 启动当前 Manager，仅执行页面加载和只读 `task-status`：

- API 返回 `state=not_enrolled`、`supported=true`。
- 页面显示“未启用”，只启用“启用自动启动”，移除按钮保持禁用。
- 慢插件/云端请求不会阻塞本地 Runtime 和自动启动状态落屏。
- 默认桌面视口与 `390x844` 移动视口均无横向溢出；按钮无实际重叠；浏览器控制台无错误或警告。
- 未点击 `enroll-task` 或 `remove-task`，本轮没有创建、修改或删除真实 Windows 任务。

## 未关闭门禁

- 在干净 Windows VM 中使用正式安装态验证任务创建、注销登录/重登触发、运行态识别和删除。
- 验证权限拒绝、任务查询/创建超时、不同系统语言和系统重启。
- 设计并验证受信 Windows launcher 从 Credential Manager 注入 Gateway 恢复材料。
- 完成托盘、Manager 安装器、代码签名、更新失败回滚和卸载数据保留。

因此 `LH-MGR-003` 和 `LH-MGR-004` 继续保持“进行中”，本记录不能作为候选完成、已部署或已开放证据。
