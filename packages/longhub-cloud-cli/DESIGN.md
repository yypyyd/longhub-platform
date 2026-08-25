# Cloud CLI 设计

## 设计目标

把 Cloud Plugin 的配对、凭据、签名制品下载和 OpenClaw 安装从免费 Manager 中完全拆出，形成可独立升级、撤回和审计的 Windows 发布面。

## 组件

```text
longhub-cloud
  ├─ WindowsCredentialManager  LongHub Cloud Plugin namespace
  ├─ Cloud API client           register/challenge/self/revoke/release
  ├─ artifact verifier          Ed25519 + identity + bytes + tgz package
  └─ OpenClaw runner             npm-pack install/update + runtime inspect
```

## 凭据生命周期

注册平台固定为 `openclaw-plugin-windows`。写入后立即回读验证；失败时尝试恢复旧 credential，绝不因回读失败删除原状态。`logout` 先调用 `/v1/devices/self/revoke`，只有收到成功响应才删除本地 credential；网络失败保留旧 credential 并返回明确错误。

CLI 的 Windows credential 与 tar 运行时依赖全部打进同一份签名 tgz。安装 CLI 或由 CLI 安装 Plugin 时都不允许从 npm registry 补取 LongHub 或第三方运行时代码。

## 供应链决策

CLI release 使用 `longhub-cloud-cli` 产品面和独立 signing key；Plugin release 使用另一套 key。CLI 内置公钥是信任根，线上 key endpoint 不能更新它。每个版本不可覆盖，manifest 的 filename、size、SHA-256、URL、package name/version 和签名绑定同一份 tgz 字节。

## 更新事务

`update --force` 先 inspect 当前版本并下载/验签当前版本作为 rollback artifact，再下载最新版本。目标安装或后置 inspect 失败时强制安装 rollback artifact；rollback inspect 失败返回 `PLUGIN_UPDATE_ROLLBACK_FAILED`，不删除当前可用文件，也不激活未验证包。

## 安全边界

token 不进入环境变量、日志、普通文件或命令行参数。下载使用 HTTPS（回环测试可用 HTTP），响应有大小上限，redirect 禁止。OpenClaw 子进程使用 `shell:false`，stderr/stdout 有上限，安装只接受 CLI 生成的 `npm-pack:` 路径。

## 已知限制

CLI 只支持 Windows Credential Manager；Linux/非 Windows 明确失败。生产 Plugin 公钥已固定进 `0.1.2`，CLI/Plugin 独立签名 tgz、真实 Credential Manager 和 OpenClaw inspect 已通过生产 E2E；正式 Manager Authenticode 不属于 CLI 信任链。

## 变更历史

### 2026-08-17 - 0.1.0 独立 CLI

新增 pair/status/logout/install/update，加入设备撤销、签名发布面、不可覆盖版本、原子暂存、运行时后置校验与失败回滚。

### 2026-08-17 - 0.1.1 Windows OpenClaw 启动

Windows 上通过已验证的 `ComSpec` 显式执行 `openclaw.cmd`，拒绝控制字符和 cmd 元字符，并保持用户输入不进入 shell 拼接。

### 2026-08-17 - 0.1.2 真实 inspect 契约

后置校验对齐 OpenClaw 实际 JSON：插件身份和状态来自 `plugin`，安装 provenance 来自根级 `install`，工具名来自 `tools[].names`，任何 diagnostics 都阻断激活。
