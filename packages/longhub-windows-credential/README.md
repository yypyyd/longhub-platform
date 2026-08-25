# `@longhub/windows-credential`

共享的 Windows Credential Manager 适配层，为 Desktop 和独立 Cloud Plugin/CLI 提供隔离的设备凭据读写。

## Namespace

- Cloud Plugin：`LongHub Cloud Plugin/device/<sha256(normalized_cloud_origin)>`
- Desktop：`LongHub Desktop/device/<sha256(normalized_cloud_origin)>`

只保存 `{ deviceId, deviceToken }` 到 Credential Manager；Cloud CLI 的普通 `device.json` 不由本包写入，也不允许包含 token。写入后必须回读确认，失败时恢复旧 credential；删除只在明确 logout 或调用者请求时执行。

## 平台策略

Windows 以外统一抛出 `UNSUPPORTED_PLATFORM`，不回退环境变量、明文配置、registry 或普通文件。PowerShell/C# Win32 bridge 通过 stdin 传输请求，凭据 blob 和托管 byte buffer 在释放前清零。

## 验证

```powershell
pnpm --filter @longhub/windows-credential typecheck
pnpm --filter @longhub/windows-credential test
```

测试覆盖真实 Windows Credential Manager 写入、回读、namespace 隔离、删除和非 Windows fail-closed。
