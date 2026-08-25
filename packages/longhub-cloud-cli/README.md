# `longhub-cloud` CLI 0.1.2

`longhub-cloud` 是收费 Cloud Skill 的独立 Windows CLI。它不属于免费的 Manager 安装包，负责 Cloud Plugin 设备生命周期和已验证插件制品的安装更新。

## 命令

```text
longhub-cloud pair      注册/读取设备凭据，生成短时 Portal 配对码
longhub-cloud status    查询设备、绑定和服务可达状态
longhub-cloud logout    服务端撤销成功后删除本地凭据
longhub-cloud install   验签并安装最新 Cloud Plugin
longhub-cloud update    验签、安装并在失败时回滚当前版本
```

`pair` 只打印设备 ID、过期时间、短时配对码和 Portal 地址，不打印 device token。设备 token 只保存在 Windows Credential Manager 的 `LongHub Cloud Plugin/device/<sha256(origin)>` 项中；普通 `device.json` 只保存 schema、指纹和设备 ID。非 Windows 平台明确返回 `UNSUPPORTED_PLATFORM`。

## 制品信任

CLI 使用构建时固定的 Ed25519 公钥，拒绝未知 key、签名/manifest 篡改、版本覆盖、错误包名、错误文件名、大小、SHA-256、URL path、兼容性或非 `longhub-cloud-plugin` 产品面。线上 signing-key endpoint 不能替换该信任根，也不能通过未经 LongHub 验证的 npm registry 包安装。

安装/更新流程把同一份已验证 `tgz` 原子暂存，调用 `openclaw plugins install npm-pack:<verified-file>`，然后 inspect 插件 ID、版本、global/npm/tgz 来源和唯一 `longhub_cloud_skill` 工具。更新失败会先恢复已验签的当前版本；回滚失败则明确返回 `PLUGIN_UPDATE_ROLLBACK_FAILED`。

## 构建与测试

```powershell
pnpm typecheck
pnpm test
pnpm artifact:pack
```

`artifact:pack` 输出独立 `longhub-cloud-cli` release candidate、`SHA256SUMS` 和上传路径，默认 rollout 为 paused。签名由 Cloud API CLI release surface 生成，未配置批准生产 key 前不开放下载。
