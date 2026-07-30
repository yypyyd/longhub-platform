# LH-040-13 Windows 主机中断与资源不足稳定性验收记录

> 日期：2026-07-30  
> 范围：LongHub Desktop 0.4.0 工作区  
> 发布状态：仅完成代码与本地验证；未部署、未重打候选、未覆盖线上 0.3.7

## 验收结论

强制退出、断网、休眠恢复、系统重启、端口冲突和磁盘不足均已进入确定性自动化场景。故障结果只会
进入自动恢复、严格缓存或固定产品错误，不会让用户配置 Gateway、Token、Provider 或模型，也不会
扫描或删除用户原有 `~/.openclaw`。

## 场景矩阵

| 场景 | 验证方式 | 预期结果 |
| --- | --- | --- |
| Gateway 强制退出 | 真实 Node 子进程异常退出 | 1s/2s/4s 限频重启；真实 `/chat` 健康后才复位 |
| 断网 | fetch 网络错误和 5xx 故障注入 | 最多三次退避；只回退同源、同设备、未过期缓存 |
| 休眠恢复 | 调用与 `powerMonitor.resume` 相同的恢复入口 | 先显示恢复页并复检 `/chat`；不健康或无 PID 时受控重启 |
| 系统重启 | 新建 Store/进程并复用同一 userData | pending、Agent、workspace 和会话连续；坏更新继续按阈值回滚 |
| 端口冲突 | 真实回环 Server 占用首选端口 | 分配新的回环端口；不连接、不复用、不终止未知服务 |
| 磁盘不足 | 注入 255 MiB 可用空间及 `ENOSPC` | 固定 `STORAGE_SPACE_LOW / LH-ST-002`，不删除不可再生状态 |

## 新增实现

- `GatewayRuntimeRecovery.handleHostResume` 不接受“旧 PID 还活着”作为健康证据，最多 15 秒等待真实
  HTML `/chat`；cycle 会丢弃休眠前探测的迟到结果。
- `GatewaySupervisor.restart` 合并并发请求，取消旧退避、回收旧进程并重置宿主级重启后的连续失败计数。
- Main 在 app ready 后监听 `powerMonitor.resume`，退出时移除监听；主 WebUI 继续无 preload/Node/IPC。
- 存储预检在 8 GiB 状态上限外再要求 256 MiB 文件系统可用空间；无法确认空间时安全阻断。
- `ENOSPC` 和 `EDQUOT` 即使发生在预检后的关键写入，也分类为固定 `LH-ST-002`。

## 测试层级说明

强退和端口冲突使用真实本机进程/端口；既有候选连续性 E2E 使用真实 Gateway 和同一 userData 多次启动。
断网、resume 和磁盘不足使用可控故障注入，避免主动断开开发机网络、让 Windows 真实休眠或写满磁盘。
这三种注入调用生产代码同一入口，不使用绕过产品逻辑的测试专用恢复实现。

## 验证结果

```text
定向：5 个测试文件、50 项通过
Desktop：42 个测试文件、211 项通过
全仓：64 个测试文件、325 项通过，4 项 PostgreSQL 条件跳过
17 个 workspace：test、typecheck、lint、build 全部通过
安全扫描：严重/高/中/低风险均为 0
质量门禁：通过；保留 main.ts 既有文件长度提醒
变更门禁与 git diff --check：通过（仅既有 CRLF 提示）
```

## 发布阻断项

- 当前 Node 24.14.0 低于 Desktop 打包要求 24.15.0，本轮不重打安装包。
- 正式代码签名证书、正式图标与正式 Update 公钥仍未提供。
- 本轮不部署到 `154.9.26.158`，线上继续保持 0.3.7。
