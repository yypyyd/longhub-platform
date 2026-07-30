# LongHub Cloud API

龙枢云端控制面，提供设备身份、授权、套装发布、任务执行、账号计费，以及固定模型网关。

## 设备授权码

设备匿名注册只创建设备身份。未核销有效授权码前，设备只能查询激活状态或提交授权码，不能获取
模型运行配置、调用模型、下载 Pack 或使用其他受保护产品 API。

- `GET /v1/devices/activation`：查询当前设备激活状态。
- `POST /v1/devices/activate`：核销授权码并绑定设备。
- `GET/POST /v1/admin/activation-codes`：管理员查询或创建授权码。
- `POST /v1/admin/activation-codes/{id}/revoke`：撤销授权码及其附带授权。

授权码格式为 `LH-XXXX-XXXX-XXXX-XXXX`。明文只在创建响应中返回一次，数据库只保存 SHA-256
摘要和尾号；管理员可设置有效期、最大设备数和附带 Pack。

已认证的激活状态响应包含调用凭据自己的 `device_id`，用于 Desktop 0.4.0 将旧 `device.json`
Token 安全迁移到 Windows Credential Manager。该 Cloud API 必须先于 Desktop 0.4.0 部署。

## 默认模型网关

管理员在管理后台的“默认模型”页面配置 OpenAI 兼容 Base URL、API Key、接口格式和真实
模型 ID。客户端只获取 `longhub/longhub-default`，并使用设备凭据访问：

- `GET /v1/client/runtime-config`
- `GET /v1/model/models`
- `POST /v1/model/chat/completions`
- `POST /v1/model/responses`

服务端会忽略客户端请求中的 `model`，强制使用后台配置的真实模型 ID。上游 API Key 使用
`MODEL_CONFIG_KEY`（base64/base64url 编码的 32 字节随机值）进行 AES-256-GCM 加密后入库。

`runtime-config` 使用严格 `longhub/runtime-config/v1`，返回 `config_version`、`issued_at`、
`expires_at`，有效期固定十分钟并设置 `Cache-Control: private, no-store`。它只描述客户端固定别名，
不返回设备 Token、真实模型 ID、API Key 或真实上游地址；Desktop 的短期本地缓存也不能替代模型
接口每次执行的设备激活复验。

当前 `features` 只有 `agent_catalog`、`file_upload`、`tool_execution` 三个兼容布尔值，其中
`file_upload` 尚未形成 Desktop 到服务端的完整附件安全链。后续用户功能使用版本化 Feature Policy，
并由产品 API 按同一策略逐请求复验；规划见
[普通用户功能开放策略](../../PRODUCT_FEATURE_POLICY.md) 和
[Skill 开放设计](../../SKILL_PLATFORM.md)；任务顺序以
[V2 执行计划](../../EXECUTION_PLAN_V2.md) 为准。

生产环境必须配置：

```text
MODEL_CONFIG_KEY=<32-byte-base64-key>
KNOWLEDGE_DATA_KEY=<different-32-byte-base64-key>
```

`KNOWLEDGE_DATA_KEY` 专门用于租户知识库正文的 AES-256-GCM 信封加密，租户 ID 作为认证附加数据；
它不得与 `MODEL_CONFIG_KEY` 共用。使用 PostgreSQL 时缺少该密钥或两把密钥相同，Cloud API 会拒绝启动。
首次启用前必须清点历史 `knowledge_document.content`：开发期明文记录需导出、删除并通过管理 API 重新导入，
不能把旧明文直接当作新密文读取；migration 014 会验证 `longhub-kb-v1:` 信封前缀并在发现明文时停止。

默认只接受 HTTPS 公网模型地址。本地开发若确需 HTTP/私网上游，可显式设置
`MODEL_ALLOW_INSECURE_UPSTREAM=true`，生产环境不应启用。

控制台日志统一经过 `@longhub/observability` 结构化脱敏，审计详情在 Memory/PostgreSQL 存储前再次
清理。设备 Token、Authorization、API Key、授权码和请求/响应正文不得写入日志或审计数据。

## 匿名客户端运行指标

`POST /v1/client/telemetry` 只接受已激活设备和严格 `longhub/client-telemetry/v1`。单批最多 32 项、
16 KiB、事件时间必须在服务端前后十五分钟内；每个设备凭据每小时最多 120 批。Bearer 只用于鉴权和
进程内滥用控制，不会写入遥测表。

服务端不保存逐设备原始事件，而是立即按 UTC 小时、Desktop/OpenClaw 版本、win32 架构和固定枚举值
累加 `client_telemetry_hourly`。该表没有 device/user/tenant/session 字段，也没有 JSON、自由文本或任意
标签列。聊天、提示词、回答、文件、工具输入输出、URL、端口、PID、本机路径和异常一律不在契约内。

`model_request_hourly` 由模型代理自身记录上游结果和响应头 TTFB 桶；`GET /v1/admin/metrics` 只从该表与
客户端小时聚合生成近 24 小时健康摘要。指标写入失败不阻断代理，接口不返回逐设备遥测。

完整设计与威胁模型见 [DESIGN.md](DESIGN.md)。

## 客户端安装包签名分发

管理员通过 `POST /v1/admin/client-releases` 上传 `LongHub-Setup-x.y.z.exe`。Cloud 在流式接收时计算
实际大小和 SHA-256，分配全局单调发布序列，并使用与 Agent Pack 完全分离的 Ed25519 Update 密钥
签署版本、渠道、平台、架构、文件名、摘要、下载路径、发布时间和数据回滚策略。公开端只返回严格 envelope：

- `GET /v1/client-releases/latest?channel=stable`
- `GET /v1/client-releases/versions/{version}?channel=stable`（升级前准备当前版本回滚安装器，不执行灰度）
- `GET /v1/client-releases/signing-key`（仅供运维核对，不是 Desktop 信任自举接口）

生产环境必须配置：

```text
CLIENT_UPDATE_SIGNING_KEY_ID=<当前更新签名 key ID>
CLIENT_UPDATE_SIGNING_PRIVATE_KEY_PEM=<Ed25519 PKCS8 PEM，仅来自密钥服务>
CLIENT_UPDATE_SIGNING_PUBLIC_KEY_PEM=<对应 Ed25519 SPKI PEM>
CLIENT_UPDATE_TRUSTED_PUBLIC_KEYS_JSON=<历史 key ID 到公钥 PEM 的 JSON，可选>
CLIENT_RELEASE_DIR=/var/lib/longhub/client-releases
```

`CLIENT_RELEASE_DIR` 必须与 Nginx 下载 alias 一致，并由 Cloud API 服务用户写、Nginx 共享组只读；
生产目录应使用受控共享组和 setgid，不能改成全局可写。
旧版未签名 `releases.json` 不会自动重签或公开，必须由管理员重新上传原始安装包。

新上传的 v2 元数据默认 `paused`。管理员通过
`PATCH /v1/admin/client-releases/{version}/rollout` 将当前渠道最新版本调整为 5%、25%、100% 或
再次暂停；状态、基点、固定 cohort seed 和策略时间都包含在 Ed25519 签名中，每次变更分配更高
sequence。Desktop 使用稳定设备 ID 本地确定性分桶，并在停机安装前重新验签，后台暂停后不会继续
执行已经下载但尚未安装的包。Portal 只在 100% active 时提供通用下载入口。
当前上传默认签署 `rollback_data_strategy=snapshot_required`。Desktop 在安装新版本前必须通过精确版本
接口准备当前版本的可信安装器；Cloud 缺少该版本的严格签名记录时，更新事务失败关闭，不能只依赖
客户端磁盘上来源不明的旧 `.exe`。旧版未签名记录仍需由管理员重新上传原始安装包后才能进入回滚链。
