# Cloud Plugin 设计

## 设计目标

为任意受支持的 OpenClaw 提供一个薄的 Cloud API 客户端。插件负责协议转换、请求生命周期和公开错误；商业授权与执行实现全部留在 Cloud API/Executor。

## 数据流

```text
OpenClaw tool
    |
    v
strict cloud-skill-call/v1
    |
    v
POST /v1/tasks -- GET /v1/tasks/{id} -- POST /v1/tasks/{id}/cancel
    |
    v
Cloud subscription / binding / quota / Executor
```

模块加载时不读取凭据。每次执行从 `LongHub Cloud Plugin/device/<sha256(origin)>` 读取凭据；Windows 以外由共享凭据包明确返回 `UNSUPPORTED_PLATFORM`，不回退环境变量或普通文件。

## 关键决策

- Cloud API origin 是唯一非敏感配置；禁止 `LONGHUB_EXECUTION_BRIDGE_URL`、`LONGHUB_EXECUTION_TOKEN`、enrollment code 和 Manager loopback 协议。
- Windows credential 与 TypeBox 运行时依赖随同一份签名 tgz 打包，安装过程不得从 npm registry 补取代码。
- wire 只发送 `session_key_hash`，原始 session key 不离开进程。
- Bearer、Agent ID、OpenClaw 版本和幂等键分别放在明确的 HTTP header；Cloud API 仅允许 `openclaw-plugin-windows` 设备访问任务接口。
- 轮询、AbortSignal、超时和取消都通过同一个生命周期 controller 管理；超时公开为 `CLOUD_API_TIMEOUT`，调用者取消公开为 `REQUEST_CANCELLED`。
- 结果只包含 Cloud API 的公开 output/error code，不把内部 prompt、凭据、实现包或订阅判断交给 OpenClaw。

## 供应链

发布面是 `longhub-cloud-plugin`，schema 为 `longhub/cloud-plugin-release/v1`。构建脚本只生成可复现 unsigned `tgz` 和 SHA 元数据；Cloud API 绑定文件名、大小、SHA-256、版本和 Ed25519 manifest 签名，并以暂停 rollout 开始。CLI 固定内置公钥，线上 signing-key endpoint 只能供运维核对，不能替换信任根。

## 威胁模型

- Manager 旧凭据：Cloud API 任务路由拒绝 `windows` 平台并记录 `cloud_task.execution_denied`。
- registry/package 替换：CLI 只安装已验签、同字节、同包名/版本的 `npm-pack` 文件。
- token 泄露：token 仅来自 Credential Manager，错误、日志、普通 `device.json` 和命令行参数不包含 token。
- Cloud 越权：插件不自行判断 subscription/entitlement；每次任务由 Cloud API 复验 owner、binding、release 和额度。

## 已知限制

当前仅支持 Windows Credential Manager 和 OpenClaw `2026.7.1-2` 兼容线；新的 OpenClaw 兼容版本必须通过不可覆盖的 Plugin release 发布。生产 Ed25519、正式签名 tgz、Windows Credential Manager、真实 OpenClaw inspect 与直连执行已在 `0.2.1` 门禁中验证，本地测试 key 仍不能作为生产信任根。

## 变更历史

### 2026-08-17 - 0.2.0 独立 Cloud API

删除 Manager Bridge、enrollment 和执行环境兼容代码；改为直连 `/v1/tasks*`，新增取消/超时语义、严格 v1 wire、独立 release surface 和可复现 tgz 构建。

### 2026-08-17 - 0.2.1 OpenClaw 兼容 header

默认发送构建时固定且已经验收的 OpenClaw `2026.7.1-2` 版本 header，避免生产任务因 `unknown` 版本被兼容性门禁拒绝；不新增可被环境变量替换的信任输入。
