# LH-040-10 运行配置指数退避、安全缓存与有效期验收记录

> 日期：2026-07-30  
> 状态：代码与自动化验收完成；未部署、未重打候选  
> 线上版本：0.3.7（保持不变）

## 目标

降低短时 Cloud 控制面抖动对客户端启动的影响，同时保持授权撤销、协议升级和模型统一配置的安全
边界。恢复成功后仍直接进入 OpenClaw 原生 `/chat`，用户不选择模型、Provider、Gateway 或灰度组；
不新增业务面板、主 WebUI preload、Node 或通用 IPC。

## 实现结果

### 版本化运行配置

- Cloud `GET /v1/client/runtime-config` 返回严格 `longhub/runtime-config/v1`、`config_version`、
  `issued_at` 和 `expires_at`，有效期固定十分钟，并设置 `Cache-Control: private, no-store`。
- 在线响应和本地缓存复用同一白名单解析器，只接受精确字段集合、固定 `longhub` Provider、
  `/v1/model`、`longhub-default`、受限接口类型和整数 token 上限。
- 未知字段、非规范 ISO 时间、倒置或超过十分钟的有效期、未来签发、已过期响应、外部 base path 和
  token 配置越界在 Gateway 启动前失败，不能带着不兼容配置继续运行。

### 指数退避与回退条件

- 默认最多请求三次，按 500ms、1s 指数退避并加入最多 25% jitter；请求超时为五秒，禁止重定向。
- 只有网络/超时、HTTP 429 和 5xx 被视为瞬时错误；全部尝试耗尽后才允许读取缓存。
- HTTP 401/403、其他非瞬时状态、成功响应的协议/schema 错误和严格校验失败不重试，也绝不读取
  旧缓存掩盖凭据撤销、激活失效或客户端协议不兼容。

### 设备绑定安全缓存

- 缓存位于龙枢独立 `userData/openclaw/runtime-config-cache.json`，会随现有更新状态快照恢复，但不会
  读取、写入或复制用户 `~/.openclaw`。
- 缓存记录绑定规范化 Cloud origin 与设备 ID，同时受配置自身过期时间和本地十分钟最大年龄限制；
  跨设备、跨 Cloud、损坏 JSON、未知字段、符号链接、非普通文件、时钟异常或过期均 fail-closed。
- 临时文件带进程 ID 和随机 UUID，以 `wx`、`0600` 独占创建后 rename；失败时清理临时文件。
  缓存写失败不会阻断本次已经通过严格校验的在线启动。
- Main 只记录 `source`、尝试次数、`config_version` 和 `expires_at`，不记录 Token、响应正文或本机缓存内容。

## 安全决策

- 缓存只包含公开的固定模型别名和路由元数据，不包含设备 Token、授权码、上游 API Key、真实上游
  地址或真实模型 ID。
- 缓存不是身份、激活状态或授权证明。从缓存启动后，OpenClaw 的每次模型请求仍从 Credential Manager
  取得设备凭据并访问 Cloud；Cloud 逐请求复验授权码/设备状态并强制覆盖真实 model。
- 本地同一用户或管理员理论上可以修改自己可写目录中的缓存；严格 parser 固定 provider、model 与
  同源 base path，使修改不能把客户端转向任意外部上游。本地管理员完全控制进程不在该缓存边界承诺内。
- 时钟显著回拨、未来缓存时间或有效期异常时选择停止启动，而不是延长旧配置寿命。

## 自动化证据

- `openclaw-runtime.test.ts`：严格字段、固定同源路径、规范时间、有效期/token 上限、401/403 与
  429/5xx 分类、重定向禁止和单模型 allowlist。
- `runtime-config-resolver.test.ts`：三次指数退避、在线写缓存、Token 不落盘、瞬时错误回退、401/403
  禁止回退、过期/跨设备/跨 Cloud/损坏/符号链接拒绝、写失败不中断和临时文件清理。
- `model-gateway.test.ts` 与 `device-activation.test.ts`：schema/version/十分钟 TTL、`private, no-store`、
  激活门禁和模型代理继续强制覆盖真实 model。
- 真实 Gateway 冒烟和双实例共存测试继续验证版本化配置可生成有效 OpenClaw 配置并直达 `/chat`。

## 验证结果

- 本轮运行配置定向测试：Desktop 28 项、Cloud 9 项通过。
- 全仓 61 个测试文件、294 项通过；4 项 PostgreSQL 外部环境测试按条件跳过。
- Desktop 全量为 39 个文件、180 项通过；真实 Gateway、Electron、Selector、激活和双实例共存均通过。
- 17 个 workspace 的 `typecheck`、`lint`、`build` 全部通过；`git diff --check` 通过。
- Desktop 安全扫描 52 个文件、Cloud 安全扫描 15 个文件，Critical/High/Medium/Low 均为 0。
- Desktop 与 Cloud 质量门禁通过；仅报告既有 `main.ts`、Memory/Pg Store、Server 超过 500 行的结构性
  告警，本轮重试与缓存逻辑已拆入独立模块。
- 变更门禁通过；OpenAPI、根/模块 README、Desktop/Cloud DESIGN、ROADMAP 与本记录已同步。

## 未包含范围

- 本项只完成 runtime-config 的 v1 schema；0.5.0 计划中的“客户端兼容范围”、ETag、紧急禁用开关、
  多租户/套餐模型策略和配置推送仍未完成，因此对应路线项保持未勾选。
- 缓存只提高客户端启动阶段对短时控制面故障的容忍度，不缓存模型响应，不提供离线聊天，也不放宽
  企业工具在线 entitlement 复验。
- 正式 Update 公钥、Authenticode 证书和正式图标仍未取得；当前 Node 24.14.0 低于打包下限
  24.15.0，因此未重打候选。
- 线上 0.3.7 未被覆盖；本轮未连接生产、未上传安装包、未改变 rollout，也未创建或删除线上备份。
