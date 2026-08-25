# LH-MGR-001 Manager 本地服务安全骨架验收

> 日期：2026-08-09
> 状态：代码完成（原型门禁，不等同于已发布）

## 覆盖范围

- 仅发现系统 PATH 中的原生 `openclaw`，不复制到 LongHub 私有目录。
- `openclaw --version` 与 Node 版本检测；Node 支持区间为 `>=22.22.3 <23`、`>=24.15.0 <25` 或
  `>=25.9.0`。
- 固定官方 `openclaw@2026.7.1-2` npm 安装计划/显式确认接口。
- `status/health/start/stop/restart/doctor/skills list` CLI allowlist。
- HTTP 仅回环、Bearer 管理令牌、回环 Origin、请求体上限和页面不嵌入 OpenClaw Control UI。

## 验证命令

```powershell
$go = 'C:\Users\Administrator\.cache\longhub-go125\go\bin\go.exe'
& $go fmt ./...
& $go test ./...
```

结果：`internal/runtime` 与 `internal/httpapi` 通过；安全扫描未发现 Critical/High/Medium/Low。

## 未覆盖项

配置备份/恢复、Gateway 外部进程识别、托盘启动、Windows 安装包和账号/Cloud Bridge 由后续
`LH-MGR-002`—`LH-MGR-004` 验收记录覆盖。
