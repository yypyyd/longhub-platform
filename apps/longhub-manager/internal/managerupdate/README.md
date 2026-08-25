# Manager 签名更新事务

`managerupdate` 是 LongHub Manager 的受信更新边界。它只接受
`longhub/client-update/v2`、`product_surface=longhub-manager` 的 Ed25519 签名元数据，
并在确认后下载、校验、暂存和启动同版本 Windows 安装器。

## 特性

- 严格 manifest：拒绝未知字段、错误产品面、降级版本、超大包和路径不一致。
- 信任锚：公钥随 Manager 二进制预置；网络接口的公钥不会自举信任。
- 下载完整性：只跟随固定 HTTPS/回环地址，不跟随重定向，校验大小和 SHA-256。
- 原子 pending：目标和回滚安装器、签名元数据写入用户私有目录，重启后可恢复。
- 有界回滚：目标版本连续三次未通过健康窗口时，只启动签名且摘要匹配的旧安装器。

## 约束

本模块不会升级用户的原生 OpenClaw、读取或快照 `.openclaw` 数据，也不会执行页面传入的
命令、URL、文件名或版本。没有经过发布审批的信任清单保持 `pending` 并 fail-closed。

## 使用

```go
keys := map[string]ed25519.PublicKey{"manager-update-2026": publicKey}
client, _ := managerupdate.NewClient("https://longhub.example", keys, nil)
store, _ := managerupdate.NewRecoveryStore(updateRoot, keys)
coordinator, _ := managerupdate.NewCoordinator(managerupdate.CoordinatorOptions{
    Client: client, RecoveryStore: store, CurrentVersion: "0.1.0",
    Channel: "stable", Identity: "manager-device-identity",
    UpdateRoot: updateRoot, RecoveryInstaller: recoveryInstaller,
})
status, _ := coordinator.Refresh(ctx)
```

下载与安装由 Manager 回环 API 通过 `confirm: true` 触发；HTTP 层不暴露私有路径、签名原文或
安装器参数。

## 文件

- `manifest.go`：manifest 校验、canonical payload、Ed25519、版本和灰度。
- `client.go`：最新/精确版本查询与固定下载。
- `state.go`：签名 pending 状态的原子读写和健康恢复。
- `coordinator.go`：检查、下载、安装和回滚编排。

相关模块：[Manager 设计](../../DESIGN.md)、[执行计划](../../../../EXECUTION_PLAN_V2.md)。
