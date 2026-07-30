# LH-040-02 Windows Credential Manager 设备凭据迁移

> 状态：已完成  
> 客户端：LongHub Desktop 0.4.0  
> 日期：2026-07-29

## 目标

设备 Token 不再以明文保存在 `userData/device.json`，改由当前 Windows 用户的 Credential Manager
保存；升级时不丢失已有设备、授权码状态和 Pack entitlement。

## 实现与安全决策

- 使用 Win32 `CredReadW`、`CredWriteW`、`CredDeleteW` 管理 Generic Credential，不引入需要针对
  Electron ABI 重编译的原生 npm 依赖。
- Target 为规范 Cloud URL 的 SHA-256：`LongHub Desktop/device/<digest>`，不泄露服务地址。
- 固定适配程序使用隐藏、无 Profile、非交互 PowerShell；Token 只走 stdin，不放入命令行和错误消息。
- Credential Blob 保存设备 ID 与 Token；Blob 大小、返回输出、执行时间和字段长度均有限制。
- `device.json` V2 只保存 `schema_version`、fingerprint 与 `idsByBaseUrl`。
- 迁移顺序固定为：读取旧凭据 → 写 Credential Manager → 回读 → constant-time 比较 → 原子重写文件。
- 写入失败、超时、回读不一致、JSON 损坏或旧设备 ID 无法恢复时保留旧文件，不注册新设备、不删除
  旧 Token。多个 Base URL 必须全部写入并回读成功后才一次性清空旧文件。
- 已认证的 `/v1/devices/activation` 响应增加 `device_id`，用于恢复早期只保存 Token 的客户端；该值
  只描述调用凭据自己，不扩大设备查询权限。上线必须先部署兼容 Cloud API，再发布 Desktop 0.4.0。

Credential Manager 防止普通文件读取、备份和误收集诊断包直接泄露 Token；它不能抵御已取得同一
Windows 用户会话权限的恶意程序或本机管理员。这一边界已记录在 Desktop DESIGN。

## 自动化证据

- `device-credential-store.test.ts`：5/5 通过。
  - 旧 Token 成功迁移并从文件删除。
  - 缺少设备 ID 时通过已认证云端状态恢复。
  - 写入失败和回读不一致时旧文件保持原样。
  - 首次注册只落非敏感元数据，两个并发调用只注册一次。
  - 多 Base URL 全量迁移，所有条目成功后才清空旧文件。
- `windows-credential-manager.test.ts`：2/2 通过。
  - Target 规范化、稳定且不包含原 URL。
  - 当前 Windows 主机真实 Credential Manager 写入、读取、删除成功，测试条目已清理。
- Cloud API 全量：49 passed，4 skipped（PostgreSQL 外部环境条件测试）。
- Desktop 单 worker 全量：30 个测试文件、114 项测试全部通过。
- 全仓 `typecheck`、`lint`、`build` 通过；变更、安全和质量门禁通过。

真实 `dist:internal` 已生成并通过发布后置门禁：

- 安装包：`LongHub-Setup-0.4.0.exe`
- 大小：159,873,363 bytes
- SHA-256：`AFB7B3DB9D33A8218B46A5EB725CBDBA6B481231B5B3045B2D866F17B4537C7C`
- blockmap SHA-256：`BFEFEFFB58C24C05FA7876F2453530B66499E950793758DC98FE4F96465EBF93`
- 解包应用包含 `device-credential-store.js` 与 `windows-credential-manager.js`。
- 使用安装包内置 Node 直接加载解包后的模块，真实 Credential Manager 写入、回读、删除成功且无残留条目。
- 内置 Node：v25.9.0，OpenJS Foundation Authenticode 与 Microsoft 时间戳均为 `Valid`。
- 安装包与主程序仍为未签名内部候选；正式构建继续被临时品牌门禁拒绝。

## 发布检查

- Desktop 版本进入 0.4.0，不能覆盖已经上线的 0.3.7 安装包。
- Cloud API 必须先上线 `device_id` 兼容字段，再灰度 Desktop。
- 升级测试应确认 Credential Manager 中出现 LongHub 条目，`device.json` 不包含 `deviceToken`、
  `tokensByBaseUrl` 或实际 Token，原设备激活状态和 entitlement 保持不变。
- 卸载是否删除设备 Credential 必须由产品数据保留策略决定；当前升级与普通卸载不主动删除，避免重装
  产生新设备并丢失授权。

> 注：本页哈希对应 LH-040-02 当时的内部候选。同名 0.4.0 安装包已在 LH-040-03 完成后重打，当前
> 候选哈希与打包验收见 [LH-040-03 日志脱敏记录](LH-040-03-log-redaction.md)。
